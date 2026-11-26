const {createHash} = require('node:crypto');
const {HASH, REFEREE, identity, parse, Ledger, requireThat, uint, assetKey} = require('./ledger');
const {award} = require('./races');
const individual = require('./individual');

const playerID = /^player:[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const raceKey = id => 'duel:' + id;
const logsKey = id => 'duel-logs:' + id;
const activeKey = id => 'active-duel:' + id;
const ended = race => race.status === 'settled' || race.status === 'closed';
const gridLanes = {2: [-0.35, 0.35], 3: [-0.55, 0, 0.55], 4: [-0.6, -0.2, 0.2, 0.6]};
const sizedArray = (value, count) => Array.isArray(value) && value.length === count;
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

async function unlockPlayer(db, race, player) {
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

async function unlock(db, race) {
  for (const player of race.manifest.players) await unlockPlayer(db, race, player);
}

async function close(db, race, reason) {
  race.status = 'closed';
  race.reason = reason;
  await unlock(db, race);
  return save(db, race);
}

function checkManifest(m) {
  const lanes = Array.isArray(m?.players) && gridLanes[m.players.length];
  requireThat(m && typeof m.id === 'string' && HASH.test(m.id) && m.physicsVersion === 4 &&
    typeof m.verifierHash === 'string' && digestPattern.test(m.verifierHash) &&
    uint(m.seed) && m.seed <= 0xffffffff && m.stepMs === 10 && m.initial?.step === 0 &&
    lanes && sizedArray(m.initial.lanes, lanes.length) && lanes.every((x, i) => m.initial.lanes[i] === x),
    'InvalidDuelManifest');
  requireThat(m.finishPolicy === individual.policy || (m.finishPolicy === undefined && m.players.length === 2),
    'UnsupportedFinishPolicy');
  for (const p of m.players) {
    requireThat(p && typeof p.id === 'string' && playerID.test(p.id) && Array.isArray(p.config) &&
      p.config.length === 4 && p.config.every(uint) && Array.isArray(p.spec) && p.spec.length === 3 &&
      p.spec.every((model, i) => model === 1 + i * 2 || model === 2 + i * 2), 'InvalidDuelPlayer');
  }
  requireThat(new Set(m.players.map(p => p.id)).size === m.players.length, 'DuplicateDuelPlayer');
}

async function lockPlayer(db, p, race) {
  requireThat(await db.load('player:' + p.id), 'UnregisteredPlayer');
  const active = await db.load(activeKey(p.id));
  if (active) {
    const previous = await get(db, active);
    requireThat(previous.deadline <= db.time, 'DriverRacing');
    if (previous.inputHashes) await unlock(db, previous);
    else await close(db, previous, 'expired');
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
  requireThat(manifest.finishPolicy === individual.policy, 'IndividualRaceRequired');
  const count = manifest.players.length;
  const race = {manifest, manifestHash, startedAt: db.time, deadline: db.time + 600,
    status: 'racing', reason: null, commitments: Array(count).fill(null), commitProofs: Array(count).fill(null),
    confirmations: Array(count).fill(null), results: null, resultHash: null, prizes: Array(count).fill(0), tx: []};
  individual.initialize(race);
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
  if (race.manifest.finishPolicy === individual.policy) {
    requireThat(race.inputHashes && race.inputHashes[i] === digest, 'DuelInputHashMismatch');
    requireThat(race.playerStatus[i] === 'eligible' || race.playerStatus[i] === 'claimed', 'DuelRewardUnavailable');
  } else {
    requireThat(race.status === 'racing', 'DuelNotRacing');
    if (db.time >= race.deadline) return close(db, race, 'expired');
  }
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
  requireThat(!race.manifest.finishPolicy, 'IndividualRaceRequiresAnchoring');
  if (!ended(race) && db.time >= race.deadline) return close(db, race, 'expired');
  const count = race.manifest.players.length;
  requireThat(race.manifest.players.every((_, i) => race.commitments[i]),
    count === 2 ? 'BothCommitmentsRequired' : 'AllCommitmentsRequired');
  requireThat(sizedArray(logs, count), 'InvalidDuelLog');
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
  const players = race.manifest.players;
  requireThat(sizedArray(results, players.length) && players.every((player, i) => {
    const r = results[i];
    return r && r.id === player.id && uint(r.rank) && r.rank >= 1 && r.rank <= 8 &&
      uint(r.totalMs) && r.totalMs > 0 && r.totalMs <= 240000;
  }), 'InvalidDuelResult');
  // The verifier keeps grid order for identical millisecond times. AI cars
  // can occupy any of the gaps between these strictly increasing human ranks.
  const finishOrder = [...results].sort((a, b) => a.totalMs - b.totalMs);
  requireThat(finishOrder.every((r, i) => !i || finishOrder[i - 1].rank < r.rank), 'InvalidDuelRanking');
}

async function confirm(db, actor, [id, inputHashes, results, resultHash], envelope) {
  const race = await get(db, id);
  const i = seat(race, actor);
  if (race.manifest.finishPolicy === individual.policy) {
    const changed = await individual.claim(db, race, i, [id, inputHashes, results, resultHash], envelope, hash);
    return changed ? save(db, race) : receipt(race);
  }
  requireThat(race.status === 'review' || race.status === 'settled', 'DuelNotInReview');
  if (race.status === 'review' && db.time >= race.deadline) return close(db, race, 'expired');
  checkResults(race, results);
  const players = race.manifest.players;
  requireThat(sizedArray(inputHashes, players.length) && players.every((_, i) =>
    typeof inputHashes[i] === 'string' && digestPattern.test(inputHashes[i])) &&
    typeof resultHash === 'string' && digestPattern.test(resultHash), 'InvalidDuelDigest');
  const proof = {envelope, inputHashes, results, resultHash, tx: db.stub.getTxID()};
  const expected = hash({id, manifestHash: race.manifestHash, inputHashes, results});
  const matches = resultHash === expected && inputHashes.every((h, j) => h === race.commitments[j]);
  if (race.status === 'settled') {
    requireThat(matches && race.resultHash === resultHash, 'DuelAlreadySettled');
    return receipt(race);
  }
  if (!matches || race.confirmations.some(previous => previous && previous.resultHash !== resultHash)) {
    race.disagreement = proof;
    return close(db, race, 'disagreement');
  }
  if (race.confirmations[i]) return receipt(race);
  race.confirmations[i] = proof;
  if (players.every((_, j) => race.confirmations[j])) {
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
  const i = seat(race, actor);
  if (race.manifest.finishPolicy === individual.policy) {
    return individual.refuse(db, race, i, envelope) ? save(db, race) : receipt(race);
  }
  if (race.status === 'closed') return receipt(race);
  requireThat(!ended(race), 'DuelAlreadySettled');
  race.refusal = {envelope, tx: db.stub.getTxID()};
  return close(db, race, db.time >= race.deadline ? 'expired' : 'refused');
}

async function withdraw(db, actor, [id], envelope) {
  const race = await get(db, id);
  const i = seat(race, actor);
  requireThat(race.manifest.finishPolicy === individual.policy, 'UnsupportedFinishPolicy');
  if (race.withdrawalProofs[i]) return receipt(race);
  requireThat((race.status === 'racing' || race.status === 'anchored') && db.time < race.deadline, 'DuelNotRacing');
  race.withdrawalProofs[i] = {envelope, tx: db.stub.getTxID()};
  race.playerStatus[i] = 'withdrawn';
  await unlockPlayer(db, race, race.manifest.players[i]);
  return save(db, race);
}

const playerActions = {
  duelCommit: {n: 2, run: commitInputs},
  duelConfirm: {n: 4, run: confirm},
  duelRefuse: {n: 1, run: refuse},
  duelWithdraw: {n: 1, run: withdraw}
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

async function anchorDuelInputs(ctx, id, hashesJSON, withdrawalsJSON) {
  const db = new Ledger(ctx.stub);
  const {wallets} = await db.meta();
  requireThat(identity(ctx).id === wallets[REFEREE], 'RefereeOnly');
  const race = await get(db, id);
  requireThat(race.manifest.finishPolicy === individual.policy, 'UnsupportedFinishPolicy');
  const changed = individual.anchor(race, parse(hashesJSON, 'InvalidDuelDigest'),
    parse(withdrawalsJSON, 'InvalidDuelWithdrawals'), hash);
  if (!changed) return receipt(race);
  const result = save(db, race);
  await db.commit('AnchorDuelInputs', REFEREE, [id], result);
  return result;
}

async function publishDuelRecords(ctx, id, logsJSON) {
  const db = new Ledger(ctx.stub);
  const race = await get(db, id);
  requireThat(race.manifest.finishPolicy === individual.policy && race.inputHashes, 'DuelInputsNotAnchored');
  const logs = parse(logsJSON, 'InvalidDuelLog');
  requireThat(sizedArray(logs, race.manifest.players.length), 'InvalidDuelLog');
  for (const [i, log] of logs.entries()) {
    checkLog(log);
    requireThat(hash(log) === race.inputHashes[i], 'DuelInputHashMismatch');
  }
  if (race.resultHash) return receipt(race);
  requireThat(race.status === 'anchored', 'DuelInputsNotAnchored');
  await individual.publish(db, race, logs, hash);
  db.save(logsKey(id), logs);
  await unlock(db, race);
  const result = save(db, race);
  await db.commit('PublishDuelRecords', identity(ctx).id, [id], result);
  return result;
}

async function expireDuel(ctx, id) {
  const db = new Ledger(ctx.stub);
  const race = await get(db, id);
  if (ended(race)) return receipt(race);
  requireThat(db.time >= race.deadline, 'DuelStillOpen');
  if (race.inputHashes) {
    // An anchored record can still be published and claimed after a service interruption.
    await unlock(db, race);
    await db.commit('ExpireDuel', identity(ctx).id, [id], receipt(race));
    return receipt(race);
  }
  const result = await close(db, race, 'expired');
  await db.commit('ExpireDuel', identity(ctx).id, [id], result);
  return result;
}

async function getDuel(ctx, id) {
  const db = new Ledger(ctx.stub);
  return {...await get(db, id), logs: await db.load(logsKey(id))};
}

module.exports = {playerActions, openDuel, getDuel, revealDuel, anchorDuelInputs, publishDuelRecords, expireDuel};
