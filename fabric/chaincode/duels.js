const {createHash} = require('node:crypto');
const {HASH, REFEREE, identity, parse, Ledger, requireThat, uint, assetKey} = require('./ledger');
const {award} = require('./races');

const playerID = /^player:[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const raceKey = id => 'duel:' + id;
const logsKey = id => 'duel-logs:' + id;
const activeKey = id => 'active-duel:' + id;
const ended = race => race.status === 'settled' || race.status === 'closed';
const pair = value => Array.isArray(value) && value.length === 2;
const receipt = race => ({id: race.manifest.id, status: race.status, prizes: race.prizes});

function hash(value) {
  const json = JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  return createHash('sha256').update(json).digest('hex');
}

async function get(db, id) {
  requireThat(typeof id === 'string' && HASH.test(id), 'InvalidDuelID');
  const race = await db.load(raceKey(id));
  requireThat(race, 'UnknownDuel');
  return race;
}

function save(db, race) {
  race.tx.push(db.stub.getTxID());
  db.save(raceKey(race.manifest.id), race);
  return receipt(race);
}

async function unlock(db, race) {
  for (const player of race.manifest.players) {
    if (await db.load(activeKey(player.id)) === race.manifest.id) db.save(activeKey(player.id), null);
    if (player.config[0]) {
      const car = await db.asset(player.config[0]);
      if (car.activeRace === raceKey(race.manifest.id)) {
        delete car.activeRace;
        car.busy = 0;
        db.save(assetKey(car.id), car);
      }
    }
  }
}

async function close(db, race, reason) {
  race.status = 'closed';
  race.reason = reason;
  await unlock(db, race);
  return save(db, race);
}

function checkManifest(m) {
  requireThat(m && typeof m.id === 'string' && HASH.test(m.id) && m.physicsVersion === 4 &&
    typeof m.verifierHash === 'string' && digestPattern.test(m.verifierHash) &&
    uint(m.seed) && m.seed <= 0xffffffff && m.stepMs === 10 && m.initial?.step === 0 &&
    pair(m.initial.lanes) && m.initial.lanes[0] === -0.35 && m.initial.lanes[1] === 0.35 &&
    pair(m.players), 'InvalidDuelManifest');
  for (const p of m.players) {
    requireThat(p && typeof p.id === 'string' && playerID.test(p.id) && Array.isArray(p.config) &&
      p.config.length === 4 && p.config.every(uint) && Array.isArray(p.spec) && p.spec.length === 3 &&
      p.spec.every((model, i) => model === 1 + i * 2 || model === 2 + i * 2), 'InvalidDuelPlayer');
  }
  requireThat(m.players[0].id !== m.players[1].id, 'DuplicateDuelPlayer');
}

async function lockPlayer(db, p, race) {
  requireThat(await db.load('player:' + p.id), 'UnregisteredPlayer');
  const active = await db.load(activeKey(p.id));
  if (active) {
    const previous = await get(db, active);
    requireThat(previous.deadline <= db.time, 'DriverRacing');
    await close(db, previous, 'expired');
  }
  db.save(activeKey(p.id), race.manifest.id);
  if (!p.config[0]) {
    requireThat(p.config.every(value => value === 0) && p.spec.every((v, i) => v === 1 + i * 2),
      'InvalidBorrowedCar');
    return;
  }
  const car = await db.asset(p.config[0]);
  requireThat(car.owner === p.id && car.model === 0 && !car.lock && car.busy <= db.time, 'CarUnavailable');
  for (const [i, token] of car.parts.entries()) {
    requireThat(token > 0 && token === p.config[i + 1], 'DuelConfigChanged');
    const part = await db.asset(token);
    requireThat(part.owner === p.id && !part.lock && part.mount === car.id && part.model === p.spec[i],
      'DuelConfigChanged');
  }
  Object.assign(car, {busy: race.deadline, activeRace: raceKey(race.manifest.id)});
  db.save(assetKey(car.id), car);
}

async function open(db, manifest) {
  checkManifest(manifest);
  const existing = await db.load(raceKey(manifest.id));
  const manifestHash = hash(manifest);
  if (existing) {
    requireThat(existing.manifestHash === manifestHash, 'DuelAlreadyExists');
    return receipt(existing);
  }
  const race = {manifest, manifestHash, startedAt: db.time, deadline: db.time + 600,
    status: 'racing', reason: null, commitments: [null, null], commitProofs: [null, null],
    confirmations: [null, null], results: null, resultHash: null, prizes: [0, 0], tx: []};
  for (const p of manifest.players) await lockPlayer(db, p, race);
  return save(db, race);
}

function seat(race, player) {
  const i = race.manifest.players.findIndex(p => p.id === player);
  requireThat(i >= 0, 'NotDuelParticipant');
  return i;
}

async function commitInputs(db, actor, [id, digest], envelope) {
  const race = await get(db, id);
  const i = seat(race, actor);
  requireThat(typeof digest === 'string' && digestPattern.test(digest), 'InvalidInputHash');
  requireThat(race.status === 'racing', 'DuelNotRacing');
  if (db.time >= race.deadline) return close(db, race, 'expired');
  if (race.commitments[i] === digest) return receipt(race);
  requireThat(!race.commitments[i], 'InputsAlreadyCommitted');
  race.commitments[i] = digest;
  race.commitProofs[i] = {envelope, tx: db.stub.getTxID()};
  return save(db, race);
}

function checkLog(log) {
  requireThat(Array.isArray(log) && log.length <= 8192, 'InvalidDuelLog');
  let priorStep = 0;
  for (const [index, row] of log.entries()) {
    requireThat(Array.isArray(row) && row.length === 5, 'InvalidDuelInput');
    const [seq, step, gas, brake, steering] = row;
    requireThat(seq === index + 1 && uint(step) && step >= priorStep && step < 24000 &&
      (gas === 0 || gas === 1) && (brake === 0 || brake === 1) && [-1, 0, 1].includes(steering),
      'InvalidDuelInput');
    priorStep = step;
  }
}

async function reveal(db, id, logs) {
  const race = await get(db, id);
  if (!ended(race) && db.time >= race.deadline) return close(db, race, 'expired');
  requireThat(race.commitments.every(Boolean) && pair(logs), 'BothCommitmentsRequired');
  for (const [i, log] of logs.entries()) {
    checkLog(log);
    requireThat(hash(log) === race.commitments[i], 'DuelInputHashMismatch');
  }
  if (race.status === 'review' || race.status === 'settled') return receipt(race);
  requireThat(race.status === 'racing', 'DuelClosed');
  db.save(logsKey(id), logs);
  race.status = 'review';
  return save(db, race);
}

function checkResults(race, results) {
  requireThat(pair(results) && results.every((r, i) => r && r.id === race.manifest.players[i].id &&
    uint(r.rank) && r.rank >= 1 && r.rank <= 8 && uint(r.totalMs) && r.totalMs > 0 && r.totalMs <= 240000),
    'InvalidDuelResult');
  const [a, b] = results;
  requireThat(a.rank !== b.rank && (a.totalMs <= b.totalMs) === (a.rank < b.rank), 'InvalidDuelRanking');
}

async function confirm(db, actor, [id, inputHashes, results, resultHash], envelope) {
  const race = await get(db, id);
  const i = seat(race, actor);
  if (race.status === 'settled' && race.resultHash === resultHash) return receipt(race);
  requireThat(race.status === 'review', 'DuelNotInReview');
  if (db.time >= race.deadline) return close(db, race, 'expired');
  checkResults(race, results);
  requireThat(pair(inputHashes) && inputHashes.every(h => typeof h === 'string' && digestPattern.test(h)) &&
    typeof resultHash === 'string' && digestPattern.test(resultHash), 'InvalidDuelDigest');
  const proof = {envelope, inputHashes, results, resultHash, tx: db.stub.getTxID()};
  const expected = hash({id, manifestHash: race.manifestHash, inputHashes, results});
  if (inputHashes.some((h, j) => h !== race.commitments[j]) || resultHash !== expected ||
      race.confirmations.some(previous => previous && previous.resultHash !== resultHash)) {
    race.disagreement = proof;
    return close(db, race, 'disagreement');
  }
  if (race.confirmations[i]) return receipt(race);
  race.confirmations[i] = proof;
  if (race.confirmations.every(Boolean)) {
    race.status = 'settled';
    race.results = results;
    race.resultHash = resultHash;
    for (const [j, r] of results.entries()) race.prizes[j] = await award(db, id, r.id, r.rank);
    await unlock(db, race);
  }
  return save(db, race);
}

async function refuse(db, actor, [id], envelope) {
  const race = await get(db, id);
  seat(race, actor);
  if (race.status === 'closed') return receipt(race);
  requireThat(!ended(race), 'DuelAlreadySettled');
  race.refusal = {envelope, tx: db.stub.getTxID()};
  return close(db, race, db.time >= race.deadline ? 'expired' : 'refused');
}

const playerActions = {
  duelCommit: {n: 2, run: commitInputs},
  duelConfirm: {n: 4, run: confirm},
  duelRefuse: {n: 1, run: refuse}
};

async function openDuel(ctx, manifestJSON) {
  const db = new Ledger(ctx.stub);
  const {wallets} = await db.meta();
  requireThat(identity(ctx).id === wallets[REFEREE], 'RefereeOnly');
  const manifest = parse(manifestJSON, 'InvalidDuelManifest');
  const result = await open(db, manifest);
  await db.commit('OpenDuel', REFEREE, [manifest.id], result);
  return result;
}

async function revealDuel(ctx, id, logsJSON) {
  const db = new Ledger(ctx.stub);
  const result = await reveal(db, id, parse(logsJSON, 'InvalidDuelLog'));
  await db.commit('RevealDuel', identity(ctx).id, [id], result);
  return result;
}

async function expireDuel(ctx, id) {
  const db = new Ledger(ctx.stub);
  const race = await get(db, id);
  if (ended(race)) return receipt(race);
  requireThat(db.time >= race.deadline, 'DuelStillOpen');
  const result = await close(db, race, 'expired');
  await db.commit('ExpireDuel', identity(ctx).id, [id], result);
  return result;
}

async function getDuel(ctx, id) {
  const db = new Ledger(ctx.stub);
  return {...await get(db, id), logs: await db.load(logsKey(id))};
}

module.exports = {playerActions, openDuel, getDuel, revealDuel, expireDuel};
