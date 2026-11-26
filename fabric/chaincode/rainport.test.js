const assert = require('node:assert/strict');
const {test} = require('node:test');
const {TestPeer, fixture} = require('./test-peer.cjs');
const {tier} = require('./races');

test('authenticates roles and seeds inventory once', async () => {
  const blank = new TestPeer();
  assert.deepEqual(await blank.invoke('A', 'GetWallets'), {});
  await assert.rejects(blank.invoke('A', 'Initialize', '[]'), /BootstrapAdminOnly/);
  const {db, initialize, wallets} = await fixture();
  const {assets, balances, orders, history} = await db.snapshot();
  assert.equal(assets.length, 21);
  assert.deepEqual(await db.invoke('A', 'GetWallets'), wallets);
  assert.equal(orders.length, 6);
  assert.equal(balances['托管'], 46);
  assert.equal(balances.C, 9954);
  assert.equal(history.length, 1);
  assert.equal((await db.invoke('A', 'GetTransaction', history[0].h)).fn, 'Initialize');
  await assert.rejects(initialize(), /AlreadyInitialized/);
  await assert.rejects(db.action('Unregistered', 'buy', 5, 38), /UnregisteredIdentity/);
  await assert.rejects(db.action('B', 'fit', 1, 1, 0), /NotYourChassis/);
});

test('retains completed historical races and removes unilateral referee awards', async () => {
  const {db, wallets} = await fixture();
  const id = '0x' + 'a'.repeat(64), checksum = '0x' + 'b'.repeat(64);
  await assert.rejects(db.action('裁判', 'start', id, wallets.A, 1), /SignedDuelRequired/);
  await assert.rejects(db.action('裁判', 'confirm', id, wallets.A, 1, 90000, checksum, checksum), /SignedDuelRequired/);
  await assert.rejects(db.action('A', 'draw', id, wallets.A), /SignedDuelRequired/);
  const saved = {stage: 3, config: [1, 2, 7, 4], rank: 1, prize: 22, totalMs: 90000};
  db.state.set('race:' + id + ':' + wallets.A, {version: 1, value: Buffer.from(JSON.stringify(saved))});
  assert.deepEqual(await db.invoke('A', 'GetRace', id, wallets.A), saved);
  assert.equal(await db.action('B', 'draw', id, wallets.A), 22);
  assert.equal((await db.snapshot()).assets.length, 21);
});

test('retires legacy races in progress, preserves unsigned rewards as unminted, and observes the original lock owner', async () => {
  const {db, wallets} = await fixture();
  const id = '0x' + '7'.repeat(64), checksum = '0x' + '8'.repeat(64);
  const raceKey = 'race:' + id + ':' + wallets.A;
  const before = await db.invoke('A', 'GetAsset', '1');
  const seed = (key, value) => db.state.set(key, {version: ++db.height, value: Buffer.from(JSON.stringify(value))});
  const started = {stage: 1, startTime: db.seconds, config: [1, 2, 7, 4], prize: 0, tx: ['old-start']};
  seed(raceKey, started);
  seed('asset:1', {...before, busy: db.seconds + 300, activeRace: raceKey});
  await assert.rejects(db.action('A', 'fit', 1, 1, 0), /CarRacing/);
  db.seconds += 300;
  // Even if the original server went offline, the old lock expires by its chain timestamp.
  await db.action('A', 'fit', 1, 1, 0);
  await db.action('裁判', 'abandon', id, wallets.A);
  const released = await db.invoke('A', 'GetAsset', '1');
  assert.equal(released.busy, 0);
  assert.equal(released.activeRace, undefined);

  // A stage-2 race had already released its car. A later lock on that car is unrelated.
  seed(raceKey, {...started, stage: 2, summary: checksum, replay: checksum, tx: ['old-start', 'old-confirm']});
  const later = {...released, busy: db.seconds + 600, activeRace: 'another-race'};
  seed('asset:1', later);
  await assert.rejects(db.action('裁判', 'draw', id, wallets.A), /SignedDuelRequired/);
  await db.action('裁判', 'abandon', id, wallets.A);
  const closed = await db.invoke('A', 'GetRace', id, wallets.A);
  assert.equal(closed.stage, 4);
  assert.equal(closed.summary, checksum);
  assert.equal(closed.replay, checksum);
  assert.equal(closed.prize, 0);
  assert.deepEqual(closed.tx.slice(0, 2), ['old-start', 'old-confirm']);
  await db.action('裁判', 'abandon', id, wallets.A);
  assert.deepEqual(await db.invoke('A', 'GetRace', id, wallets.A), closed);
  assert.deepEqual(await db.invoke('A', 'GetAsset', '1'), later);
  assert.equal((await db.snapshot()).assets.length, 21);
});

test('locks listings, settles four assets atomically, and prevents stale fits', async () => {
  const {db, wallets} = await fixture();
  await assert.rejects(db.action('A', 'fit', 1, 1, 3, 9), /SlotChanged/);
  const id = await db.action('A', 'list', 3, 1, 500, 2000);
  await assert.rejects(db.action('A', 'list', 2, 7, 30, 2000), /AssetListed/);
  await assert.rejects(db.action('A', 'fit', 1, 1, 0), /CarListed/);
  await assert.rejects(db.action('B', 'buy', id, 400), /PriceChanged/);
  const before = await db.snapshot();
  await db.action('B', 'buy', id, 500);
  const after = await db.snapshot();
  assert.equal(after.balances.A - before.balances.A, 490);
  assert.equal(after.balances.B - before.balances.B, -500);
  assert.equal(after.balances['手续费'], 10);
  assert.deepEqual(after.assets[0].parts, [2, 7, 4]);
  const order = after.orders[id - 1];
  assert.equal(order.hashes.length, 2);
  assert.equal(after.transfers.length, 4);
  assert(after.transfers.every(t => t.hash === order.hashes[1] && t.to === wallets.B));
  assert(order.ids.every(token => after.assets[token - 1].owner === wallets.B));
});

test('keeps serial asks separate, refunds escrow, and matches the highest bid', async () => {
  const {db, wallets} = await fixture();
  const original = await db.snapshot();
  const bidId = await db.action('B', 'bid', 16, 52, 2000);
  await db.action('港务车队', 'close', 1);
  const serial = await db.action('港务车队', 'list', 2, 14, 48, 2000);
  let state = await db.snapshot();
  assert.equal(state.balances['托管'], original.balances['托管'] + 52);
  assert.equal(state.orders[serial - 1].status, 1);
  await db.action('C', 'list', 1, 20, 50, 2000);
  state = await db.snapshot();
  assert.equal(state.orders[bidId - 1].paid, 52);
  assert.equal(state.assets[19].owner, wallets.B);
  const id = await db.action('B', 'bid', 16, 40, 1200);
  await assert.rejects(db.action('C', 'close', id), /NotYourOrder/);
  db.seconds = 1200;
  await db.action('裁判', 'close', id);
  assert.equal((await db.snapshot()).balances.B, state.balances.B);
});

test('two competing proposals read the same order; only the first commits', async () => {
  const {db, wallets} = await fixture();
  const id = await db.action('A', 'list', 2, 19, 111, 2000);
  const [first, second] = await Promise.all(['B', 'C'].map(role =>
    db.simulate(role, 'Execute', 'buy', JSON.stringify([id, 111]))));
  first.commit();
  assert.throws(() => second.commit(), /MVCC_READ_CONFLICT/);
  const s = await db.snapshot();
  assert.equal(s.assets[18].owner, wallets.B);
  assert.deepEqual([s.balances.B, s.balances.C], [9889, 9954]);
  assert.equal(first.event[1].h, first.tx);
  assert.equal(s.transfers.length, 1);
});

test('encodes each documented rank bucket over all 10,000 rolls', () => {
  const distribution = rank => {
    const counts = [0, 0, 0, 0, 0];
    for (let roll = 0; roll < 10000; roll++) counts[tier(rank, roll)]++;
    return counts;
  };
  assert.deepEqual(distribution(1), [0, 2000, 5000, 2850, 150]);
  assert.deepEqual(distribution(2), [1000, 4500, 3400, 1050, 50]);
  assert.deepEqual(distribution(5), [3000, 5500, 1200, 290, 10]);
  assert.deepEqual(distribution(8), [5500, 4000, 400, 98, 2]);
});
