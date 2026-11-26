const assert = require('node:assert/strict');
const {test} = require('node:test');
const {AbiCoder, keccak256} = require('ethers');
const {contracts: [Rainport]} = require('./index');
const {tier} = require('./races');

// In-memory test peer. Simulations see the last committed values, and commit
// only when their read versions still match. This is not a Fabric network.
class TestPeer {
  constructor() {
    this.chaincode = new Rainport();
    this.state = new Map();
    this.height = 0;
    this.counter = 0;
    this.seconds = 1000;
  }

  async simulate(actor, fn, ...args) {
    const tx = (++this.counter).toString(16).padStart(64, '0');
    const reads = new Map(), writes = new Map();
    let event;
    const ctx = {
      clientIdentity: {
        getID: () => 'x509::' + actor,
        getMSPID: () => 'Org1MSP',
        assertAttributeValue: (key, value) => actor === 'Admin' && key === 'rainport.admin' && value === 'true'
      },
      stub: {
        getTxID: () => tx,
        getTxTimestamp: () => ({seconds: this.seconds}),
        getCreator: () => ({idBytes: Buffer.from(nonAdminPem)}),
        getState: async key => {
          const current = this.state.get(key);
          reads.set(key, current?.version);
          return current?.value ?? Buffer.alloc(0);
        },
        putState: async (key, value) => writes.set(key, value),
        setEvent: (name, bytes) => { event = [name, JSON.parse(bytes)]; },
        getStateByRange: async (start, end) => {
          const entries = [...this.state.entries()].filter(([k]) => k >= start && k < end);
          return {
            next: async () => entries.length
              ? {value: {value: entries.shift()[1].value}, done: false}
              : {done: true},
            close: async () => {}
          };
        }
      }
    };
    const result = await this.chaincode[fn](ctx, ...args);
    return {result, event, tx, commit: () => {
      for (const [key, version] of reads) {
        assert.equal(this.state.get(key)?.version, version, 'MVCC_READ_CONFLICT');
      }
      if (writes.size) this.height++;
      for (const [key, value] of writes) this.state.set(key, {value, version: this.height});
    }};
  }

  async invoke(actor, fn, ...args) {
    const proposal = await this.simulate(actor, fn, ...args);
    proposal.commit();
    return proposal.result;
  }

  action(actor, fn, ...args) {
    return this.invoke(actor, 'Execute', fn, JSON.stringify(args));
  }

  snapshot() {
    return this.invoke('A', 'Snapshot');
  }
}

// A fixed public-only TLS certificate generated for this test, with OU=client.
const nonAdminPem = `-----BEGIN CERTIFICATE-----
MIIByTCCAW+gAwIBAgIUbUrAOD91o9hS0tJteq7C3tQjw90wCgYIKoZIzj0EAwIw
OjEPMA0GA1UECgwGRmFicmljMQ8wDQYDVQQLDAZjbGllbnQxFjAUBgNVBAMMDXJh
aW5wb3J0LXRlc3QwHhcNMjYxMTI2MDMyMjUxWhcNMzYxMTIzMDMyMjUxWjA6MQ8w
DQYDVQQKDAZGYWJyaWMxDzANBgNVBAsMBmNsaWVudDEWMBQGA1UEAwwNcmFpbnBv
cnQtdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABKkSyDn+AMBLhHM2K2Na
joLpEgsj2N3uOtuOKb/dHA+6g6l6jEEhP1EM/eH6nae2Ak/40H6QIVvVTKuQO2xf
+8ajUzBRMB0GA1UdDgQWBBSjQ8rguVWT1ol10j2OmF/2HmRs3DAfBgNVHSMEGDAW
gBSjQ8rguVWT1ol10j2OmF/2HmRs3DAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIQDampi0lVhTCpvrqW5OxmpSur2bs7inItwkwgOXKdnpCwIgGlZO
HOBg7HidnTKIJM6MgpOEi40J7MefQG0AaXAWSks=
-----END CERTIFICATE-----`;

async function fixture() {
  const db = new TestPeer();
  const roles = ['裁判', 'A', 'B', 'C', '港务车队', '手续费'];
  const bindings = await Promise.all(roles.map(async role => ({
    role, id: (await db.invoke(role, 'WhoAmI')).id
  })));
  const initialize = () => db.invoke('Admin', 'Initialize', JSON.stringify(bindings));
  await initialize();
  const {wallets} = await db.snapshot();
  return {db, initialize, wallets};
}

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

test('locks actual race config, validates clock and awards one stable part', async () => {
  const {db, wallets} = await fixture();
  const id = '0x' + 'a'.repeat(64), checksum = '0x' + 'b'.repeat(64);
  await assert.rejects(db.action('A', 'start', id, wallets.A, 1), /RefereeOnly/);
  await db.action('裁判', 'start', id, wallets.A, 1);
  await assert.rejects(db.action('A', 'fit', 1, 1, 0), /CarRacing/);
  await assert.rejects(db.action('A', 'draw', id, wallets.A), /ConfirmFirst/);
  await assert.rejects(db.action('裁判', 'confirm', id, wallets.A, 1, 90000, checksum, checksum), /InvalidClock/);
  const race = await db.invoke('A', 'GetRace', id, wallets.A);
  assert.deepEqual(race.config, [1, 2, 7, 4]);
  assert.equal(race.configHash, keccak256(AbiCoder.defaultAbiCoder()
    .encode(['uint256[4]', 'uint16', 'uint16'], [race.config, 1, 1])));
  db.seconds += 93;
  await db.action('裁判', 'confirm', id, wallets.A, 1, 90000, checksum, checksum);
  const prize = await db.action('A', 'draw', id, wallets.A);
  assert.equal(prize, 22);
  assert.equal(await db.action('B', 'draw', id, wallets.A), prize);
  const item = await db.invoke('A', 'GetAsset', String(prize));
  assert.deepEqual([item.owner, item.origin, item.originRank], [wallets.A, id, 1]);
  assert.equal((await db.invoke('A', 'GetRace', id, wallets.A)).tx.length, 3);
  assert.equal((await db.snapshot()).assets.length, 22);
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
