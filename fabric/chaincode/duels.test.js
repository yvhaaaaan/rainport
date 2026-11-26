const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {test} = require('node:test');
const {fixture} = require('./test-peer.cjs');
const {verifyEnvelope} = require('./players');

const raceId = '0x' + 'c'.repeat(64);
const raw = [[[1, 0, 1, 0, 0], [2, 90, 1, 0, -1]], [[1, 4, 1, 0, 0]]];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashes = raw.map(hash);

async function setup() {
  const {db} = await fixture();
  const {createPlayerKey, signPlayerAction} = await import('../../player-keys.mjs');
  const {domain} = await db.invoke('A', 'GetPlayerDomain');
  const keys = await Promise.all([createPlayerKey(), createPlayerKey(), createPlayerKey()]);
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
  const manifest = {id: raceId, initial: {lanes: [-0.35, 0.35], step: 0}, physicsVersion: 4,
    players: players.slice(0, 2), seed: 828, stepMs: 10, verifierHash: 'd'.repeat(64)};
  const open = m => db.invoke('裁判', 'OpenDuel', JSON.stringify(m));
  const state = () => db.invoke('A', 'GetDuel', raceId);
  const reveal = logs => db.invoke('A', 'RevealDuel', raceId, JSON.stringify(logs));
  async function review() {
    await open(manifest);
    await act(0, 'duelCommit', [raceId, hashes[0]]);
    await act(1, 'duelCommit', [raceId, hashes[1]]);
    await reveal(raw);
  }
  // Keys are inserted in canonical order for this independently computed signature.
  async function decision(ms = 87003) {
    const {manifestHash} = await state();
    const results = manifest.players.map((p, i) => ({id: p.id, rank: i + 1, totalMs: ms + i * 222}));
    return [raceId, hashes, results, hash({id: raceId, inputHashes: hashes, manifestHash, results})];
  }
  return {db, manifest, act, open, state, reveal, review, decision, envelope};
}

test('pins registered drivers and their fitted cars before accepting both input commitments', async () => {
  const {db, manifest, act, open, state, reveal} = await setup();
  await assert.rejects(db.invoke('A', 'OpenDuel', JSON.stringify(manifest)), /RefereeOnly/);
  const swapped = structuredClone(manifest);
  swapped.players[0].spec[1] = 4;
  await assert.rejects(open(swapped), /DuelConfigChanged/);
  assert.equal((await db.invoke('A', 'GetAsset', String(manifest.players[0].config[0]))).busy, 0);
  await open(manifest);
  await assert.rejects(open({...manifest, seed: 0}), /DuelAlreadyExists/);
  await assert.rejects(open({...manifest, id: '0x' + 'a'.repeat(64)}), /DriverRacing/);
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
