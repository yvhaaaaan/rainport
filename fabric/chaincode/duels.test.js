const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {fixture} = require('./test-peer.cjs');
const {verifyEnvelope} = require('./players');

const raceId = '0x' + 'c'.repeat(64);
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)).digest('hex');
const officialHash = createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'verifiers/individual-v1.mjs'))).digest('hex');

async function setup(count = 2, individual = count > 2) {
  const {db} = await fixture();
  const {createPlayerKey, signPlayerAction} = await import('../../player-keys.mjs');
  const {domain} = await db.invoke('A', 'GetPlayerDomain');
  const keys = await Promise.all(Array.from({length: count + 1}, () => createPlayerKey()));
  async function envelope(i, action, args) {
    const {nonce} = await db.invoke('A', 'GetPlayer', keys[i].id);
    return signPlayerAction(keys[i], domain, nonce + 1, action, args);
  }
  async function act(i, action, args) {
    const signed = await envelope(i, action, args);
    return db.invoke('裁判', 'PlayerAction', JSON.stringify(signed));
  }
  const players = [];
  for (let i = 0; i < keys.length; i++) {
    const {starterCar} = await act(i, 'register', []);
    const car = await db.invoke('A', 'GetAsset', String(starterCar));
    players.push({id: keys[i].id, config: [starterCar, ...car.parts], spec: [1, 3, 5]});
  }
  const lanes = {2: [-0.35, 0.35], 3: [-0.55, 0, 0.55], 4: [-0.6, -0.2, 0.2, 0.6]}[count];
  const manifest = {id: raceId, initial: {lanes, step: 0}, physicsVersion: 4,
    players: players.slice(0, count), seed: 828, stepMs: 10, verifierHash: 'd'.repeat(64)};
  if (individual) Object.assign(manifest, {finishPolicy: 'individual-v1', verifierHash: officialHash});
  const raw = manifest.players.map((_, i) => [[1, i * 4, 1, 0, 0]]);
  const hashes = raw.map(hash);
  const open = m => db.invoke('裁判', 'OpenDuel', JSON.stringify(m));
  const state = () => db.invoke('A', 'GetDuel', raceId);
  const reveal = logs => db.invoke('A', 'RevealDuel', raceId, JSON.stringify(logs));
  async function seedLegacyOpen() {
    // The previously released chaincode wrote these records on OpenDuel.
    // Read and resume them through the upgraded contract's real entry points.
    const save = (key, value) => db.state.set(key, {version: ++db.height, value: Buffer.from(JSON.stringify(value))});
    const key = 'duel:' + raceId, deadline = db.seconds + 600;
    save(key, {manifest, manifestHash:hash(manifest), startedAt:db.seconds, deadline,
      status:'racing', reason:null, commitments:[null,null], commitProofs:[null,null], confirmations:[null,null],
      results:null, resultHash:null, prizes:[0,0], tx:['0'.repeat(64)]});
    for (const player of manifest.players) {
      save('active-duel:' + player.id, raceId);
      const car = await db.invoke('A','GetAsset',String(player.config[0]));
      save('asset:' + car.id, {...car, busy:deadline, activeRace:key});
    }
  }
  async function review() {
    await seedLegacyOpen();
    await open(manifest);
    for (const [i, digest] of hashes.entries()) await act(i, 'duelCommit', [raceId, digest]);
    await reveal(raw);
  }
  // Keys are inserted in canonical order for this independently computed signature.
  async function decision(ms = 87003) {
    const {manifestHash} = await state();
    const results = manifest.players.map((p, i) => ({id: p.id, rank: i + 1, totalMs: ms + i * 222}));
    return [raceId, hashes, results, hash({id: raceId, inputHashes: hashes, manifestHash, results})];
  }
  const anchor = (h = hashes, w = Array(count).fill(null)) =>
    db.invoke('裁判', 'AnchorDuelInputs', raceId, JSON.stringify(h), JSON.stringify(w));
  const publish = (logs = raw) => db.invoke('B', 'PublishDuelRecords', raceId, JSON.stringify(logs));
  return {db, manifest, players, act, open, state, reveal, review, decision, envelope, raw, hashes, anchor, publish,
    seedLegacyOpen};
}

test('resumes pre-upgrade two-player manifests while requiring the individual policy for new races', async () => {
  const {db, manifest, act, open, state, reveal, raw, hashes, seedLegacyOpen} = await setup();
  await assert.rejects(db.invoke('A', 'OpenDuel', JSON.stringify(manifest)), /RefereeOnly/);
  await assert.rejects(open(manifest), /IndividualRaceRequired/);
  assert.equal((await db.invoke('A', 'GetAsset', String(manifest.players[0].config[0]))).busy, 0);
  await seedLegacyOpen();
  await open(manifest);
  await assert.rejects(open({...manifest, seed: 0}), /DuelAlreadyExists/);
  await assert.rejects(open({...manifest, id:'0x'+'a'.repeat(64), finishPolicy:'individual-v1', verifierHash:officialHash}),
    /DriverRacing/);
  await assert.rejects(act(0, 'fit', [manifest.players[0].config[0], 1, 0]), /CarRacing/);
  await assert.rejects(act(2, 'duelCommit', [raceId, hashes[0]]), /NotDuelParticipant/);
  await act(0, 'duelCommit', [raceId, hashes[0]]);
  await assert.rejects(act(0, 'duelCommit', [raceId, hashes[1]]), /InputsAlreadyCommitted/);
  await assert.rejects(reveal(raw), /BothCommitmentsRequired/);
  await act(1, 'duelCommit', [raceId, hashes[1]]);
  await assert.rejects(reveal([raw[0], []]), /DuelInputHashMismatch/);
  await assert.rejects(reveal([[[2, 0, 1, 0, 0]], raw[1]]), /InvalidDuelInput/);
  assert.equal((await state()).logs, null);
  await reveal(raw);
  assert.deepEqual((await state()).logs, raw);
  for (const proof of (await state()).commitProofs) verifyEnvelope(proof.envelope);
});

for (const count of [3, 4]) {
  test(count + ' individually verified seats bind immutable records and allow independent, idempotent claims', async () => {
    const {db, manifest, act, open, state, reveal, raw, hashes, anchor, publish, envelope} = await setup(count);
    const repeated = structuredClone(manifest);
    repeated.players[count - 1] = repeated.players[0];
    await assert.rejects(open(repeated), /DuplicateDuelPlayer/);
    await assert.rejects(open({...manifest, players: manifest.players.slice(1)}), /InvalidDuelManifest/);
    await assert.rejects(open({...manifest, initial: {step: 0, lanes: [...manifest.initial.lanes].reverse()}}),
      /InvalidDuelManifest/);
    await assert.rejects(open({...manifest, players: [...manifest.players, null, null, null]}), /InvalidDuelManifest/);
    const missing = structuredClone(manifest);
    missing.players[count - 1] = null;
    await assert.rejects(open(missing), /InvalidDuelPlayer/);
    await assert.rejects(open({...manifest, verifierHash: '7'.repeat(64)}), /UnknownOfficialVerifier/);
    await assert.rejects(open({...manifest, finishPolicy: undefined}), /UnsupportedFinishPolicy/);
    const invalidCar = structuredClone(manifest);
    invalidCar.players[count - 1].config[0] = manifest.players[0].config[0];
    await assert.rejects(open(invalidCar), /CarUnavailable/);
    for (const p of manifest.players) assert.equal((await db.invoke('A', 'GetAsset', String(p.config[0]))).busy, 0);
    await open(manifest);
    for (const [i, p] of manifest.players.entries()) {
      await assert.rejects(act(i, 'fit', [p.config[0], 0, 0]), /CarRacing/);
    }
    await assert.rejects(act(count, 'duelWithdraw', [raceId]), /NotDuelParticipant/);
    await assert.rejects(db.invoke('A', 'AnchorDuelInputs', raceId, JSON.stringify(hashes), '[]'), /RefereeOnly/);
    await assert.rejects(reveal(raw), /IndividualRaceRequiresAnchoring/);
    await assert.rejects(publish(raw), /DuelInputsNotAnchored/);
    await assert.rejects(anchor(hashes.slice(1)), /InvalidDuelDigest/);
    await assert.rejects(anchor([...hashes.slice(0, -1), null]), /InvalidDuelDigest/);
    await assert.rejects(anchor(hashes, [{id: manifest.players[0].id, step: 0}, ...Array(count-1).fill(null)]),
      /WithdrawalNotAuthorized/);
    await anchor();
    await anchor();
    await assert.rejects(anchor([...hashes].reverse()), /RecordsAlreadyAnchored/);
    await assert.rejects(publish(raw.slice(1)), /InvalidDuelLog/);
    await assert.rejects(publish([...raw, raw[0]]), /InvalidDuelLog/);
    await assert.rejects(publish([...raw].reverse()), /DuelInputHashMismatch/);
    await assert.rejects(publish([...raw.slice(0, -1), null]), /InvalidDuelLog/);
    await publish();
    const view = await state();
    assert.deepEqual(view.logs, raw);
    assert.deepEqual(view.inputHashes, hashes);
    assert.deepEqual(view.commitments, Array(count).fill(null));
    assert.deepEqual(view.playerStatus, Array(count).fill('eligible'));
    const {verifyDuel} = await import('../../duel-verifier.mjs');
    const results = verifyDuel(manifest, raw, view.withdrawals);
    assert.deepEqual(view.results, results);
    assert.equal(view.resultHash, hash({id:raceId, manifestHash:view.manifestHash,
      inputHashes:hashes, withdrawals:view.withdrawals, results}));
    const args = [raceId, hashes, results, view.resultHash];
    await assert.rejects(act(0, 'duelConfirm', args), /OwnCommitmentRequired/);
    await assert.rejects(act(0, 'duelCommit', [raceId, hashes[1]]), /DuelInputHashMismatch/);
    await act(0, 'duelCommit', [raceId, hashes[0]]);
    for (const malformed of [[...results].reverse(), results.slice(1), [...results, results[0]],
      [...results.slice(0, -1), null], results.map(r => ({...r, rank: 1}))]) {
      await assert.rejects(act(0, 'duelConfirm', [raceId, hashes, malformed, view.resultHash]), /DuelResultMismatch/);
    }
    const signed = JSON.stringify(await envelope(0, 'duelConfirm', args));
    const [a, b] = await Promise.all([0,1].map(() => db.simulate('裁判', 'PlayerAction', signed)));
    a.commit();
    assert.throws(() => b.commit(), /MVCC_READ_CONFLICT/);
    const claimed = await state();
    assert.deepEqual(claimed.playerStatus, ['claimed', ...Array(count - 1).fill('eligible')]);
    assert.equal(claimed.confirmations.filter(Boolean).length, 1);
    verifyEnvelope(claimed.confirmations[0].envelope);
    await act(0, 'duelConfirm', args);
    assert.deepEqual((await state()).confirmations, claimed.confirmations);
    assert.deepEqual((await state()).prizes, claimed.prizes);
    await act(1, 'duelRefuse', [raceId]);
    assert.equal((await state()).playerStatus[1], 'refused');
    await assert.rejects(act(1, 'duelConfirm', args), /DuelRewardUnavailable/);
    db.seconds = view.deadline + 1;
    await db.invoke('A', 'ExpireDuel', raceId);
    for (let i = 2; i < count; i++) {
      await act(i, 'duelCommit', [raceId, hashes[i]]);
      await act(i, 'duelConfirm', args);
    }
    const final = await state();
    assert.equal(final.status, 'settled');
    assert.deepEqual(final.results, results);
    assert.equal(final.prizes[0], claimed.prizes[0]);
    assert.equal(final.confirmations.filter(Boolean).length, count - 1);
    for (const p of manifest.players) assert.equal((await db.invoke('A', 'GetAsset', String(p.config[0]))).busy, 0);
  });
}

test('one finisher can claim after signed withdrawals, a timeout and an in-flight quit without releasing a newer car lock', async () => {
  const {db, manifest, players, raw, act, open, state, anchor, publish} = await setup(4);
  await open(manifest);
  const [quit, offline, late, finisher] = manifest.players;
  await act(0, 'duelWithdraw', [raceId]);
  await act(0, 'duelWithdraw', [raceId]);
  const next = {...manifest, id:'0x'+'1'.repeat(64), players:[quit, players[4]],
    initial:{step:0, lanes:[-0.35,0.35]}};
  await open(next);
  const logs = [[], [], raw[2], raw[3]], inputHashes = logs.map(hash);
  const withdrawals = [{id:quit.id, step:0}, null, null, null];
  await anchor(inputHashes, withdrawals);
  // The signed quit arrives after the recording is anchored and the car already crossed the line.
  await act(2, 'duelWithdraw', [raceId]);
  await anchor(inputHashes, withdrawals);
  await assert.rejects(publish(logs), /RaceTimeLimitNotReached/);
  db.seconds += 240;
  await publish(logs);
  const view = await state();
  assert.deepEqual(view.playerStatus, ['withdrawn', 'dnf', 'withdrawn', 'eligible']);
  assert.deepEqual(view.results[0], {id:quit.id, rank:null,totalMs:null,dnfStep:0});
  assert.deepEqual(view.results[1], {id:offline.id, rank:null,totalMs:null,dnfStep:24000});
  assert.equal(view.results[2].id, late.id);
  assert.ok(view.results[2].rank > 0);
  assert.equal(view.results[3].id, finisher.id);
  const args = [raceId,inputHashes,view.results,view.resultHash];
  await act(3, 'duelCommit', [raceId,inputHashes[3]]);
  await act(3, 'duelConfirm', args);
  assert.equal((await state()).status, 'settled');
  assert.equal((await state()).confirmations.filter(Boolean).length, 1);
  await assert.rejects(act(2, 'duelConfirm', args), /DuelRewardUnavailable/);
  const stillRacing = await db.invoke('A', 'GetAsset', String(quit.config[0]));
  assert.equal(stillRacing.activeRace, 'duel:' + next.id);
  assert.ok(stillRacing.busy > db.seconds);
});

test('a driver quitting after crossing but before anchor cannot veto another result', async () => {
  const {manifest, raw, hashes, act, open, anchor, publish, state} = await setup(2, true);
  await open(manifest);
  await act(1, 'duelWithdraw', [raceId]);
  await anchor(hashes, [null, null]);
  await publish(raw);
  const view = await state();
  assert.ok(view.results[1].rank > 0);
  assert.deepEqual(view.playerStatus, ['eligible', 'withdrawn']);
  await act(0, 'duelCommit', [raceId, hashes[0]]);
  await act(0, 'duelConfirm', [raceId, hashes, view.results, view.resultHash]);
  assert.equal((await state()).status, 'settled');
});

test('requires two independent approvals and mints each prize at most once under concurrent retries', async () => {
  const {db, manifest, act, state, review, decision, envelope} = await setup();
  await review();
  const args = await decision();
  await act(0, 'duelConfirm', args);
  assert.equal((await state()).status, 'review');
  const before = (await db.snapshot()).assets.length;
  await act(0, 'duelConfirm', args);
  assert.equal((await db.snapshot()).assets.length, before);
  const signed = JSON.stringify(await envelope(1, 'duelConfirm', args));
  const [first, second] = await Promise.all([1, 2].map(() => db.simulate('裁判', 'PlayerAction', signed)));
  first.commit();
  assert.throws(() => second.commit(), /MVCC_READ_CONFLICT/);
  const settled = await state();
  assert.equal(settled.status, 'settled');
  assert.equal(settled.resultHash, args[3]);
  assert.deepEqual(settled.results, args[2]);
  assert.ok(settled.prizes[0] > 0);
  assert.equal((await db.snapshot()).assets.length, before + settled.prizes.filter(Boolean).length);
  assert.equal((await db.invoke('A', 'GetAsset', String(manifest.players[1].config[0]))).busy, 0);
  for (const proof of settled.confirmations) verifyEnvelope(proof.envelope);
  await act(1, 'duelConfirm', args);
  assert.deepEqual((await state()).prizes, settled.prizes);
  const item = await db.invoke('A', 'GetAsset', String(settled.prizes[0]));
  assert.deepEqual([item.origin, item.first, item.originRank], [raceId, manifest.players[0].id, 1]);
  await act(0, 'list', [2, item.id, 68, db.seconds + 86400]);
  const order = (await db.snapshot()).orders.at(-1);
  await act(1, 'buy', [order.id, 68]);
  assert.equal((await db.invoke('A', 'GetAsset', String(item.id))).owner, manifest.players[1].id);
  const sold = await db.invoke('A', 'GetOrder', String(order.id));
  assert.equal((await db.invoke('A', 'GetTransaction', sold.hashes.at(-1))).fn, 'buy');
});

for (const reason of ['expired', 'refused', 'disagreement']) {
  test('closes with no rewards and unlocks both cars when ' + reason, async () => {
    const {db, manifest, act, state, review, decision} = await setup();
    await review();
    const args = await decision();
    await act(0, 'duelConfirm', args);
    const before = (await db.snapshot()).assets.length;
    if (reason === 'expired') {
      await assert.rejects(db.invoke('A', 'ExpireDuel', raceId), /DuelStillOpen/);
      db.seconds = (await state()).deadline;
      await db.invoke('A', 'ExpireDuel', raceId);
    } else if (reason === 'refused') await act(1, 'duelRefuse', [raceId]);
    else await act(1, 'duelConfirm', await decision(87004));
    const record = await state();
    assert.equal(record.status, 'closed');
    assert.equal(record.reason, reason);
    assert.deepEqual(record.prizes, [0, 0]);
    await assert.rejects(act(1, 'duelConfirm', args), /DuelNotInReview/);
    for (const p of manifest.players) assert.equal((await db.invoke('A', 'GetAsset', String(p.config[0]))).busy, 0);
    assert.equal((await db.snapshot()).assets.length, before);
  });
}
