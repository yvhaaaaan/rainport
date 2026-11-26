const assert = require('node:assert/strict');
const {test} = require('node:test');
const {fixture} = require('./test-peer.cjs');
const {verifyEnvelope} = require('./players');

async function setup() {
  const {db} = await fixture();
  const {createPlayerKey, signPlayerAction} = await import('../../player-keys.mjs');
  const [alice, bob] = await Promise.all([createPlayerKey(), createPlayerKey()]);
  const {domain} = await db.invoke('裁判', 'GetPlayerDomain');
  const sign = (key, nonce, action, args = []) => signPlayerAction(key, domain, nonce, action, args);
  const submit = envelope => db.invoke('裁判', 'PlayerAction', JSON.stringify(envelope));
  const profile = key => db.invoke('裁判', 'GetPlayer', key.id);
  return {db, alice, bob, sign, submit, domain, profile, signPlayerAction};
}

test('verifies browser signatures, ledger domain, actor and nonce before granting assets', async () => {
  const {db, alice, bob, sign, submit, domain, profile, signPlayerAction} = await setup();
  assert.equal(alice.privateKey.extractable, false);
  assert.notEqual(alice.id, bob.id);
  assert.deepEqual(await profile(alice), {id: alice.id, nonce: 0, registered: false});
  const registration = await sign(alice, 1, 'register');
  await assert.rejects(db.invoke('A', 'PlayerAction', JSON.stringify(registration)), /RefereeOnly/);
  await assert.rejects(submit({...registration, id: bob.id}), /InvalidPlayerKey/);
  await assert.rejects(submit({...registration, action: 'close'}), /InvalidPlayerSignature/);
  await assert.rejects(submit(await signPlayerAction(alice, domain + 'x', 1, 'register', [])), /WrongPlayerDomain/);
  await assert.rejects(submit(await sign(alice, 2, 'register')), /InvalidPlayerNonce/);
  const {starterCar} = await submit(registration);
  await assert.rejects(submit(registration), /InvalidPlayerNonce/);
  await assert.rejects(submit(await sign(alice, 2, 'register')), /PlayerAlreadyRegistered/);
  const player = await profile(alice);
  assert.equal(player.nonce, 1);
  assert.equal(player.publicKey, alice.publicKey);
  const car = await db.invoke('A', 'GetAsset', String(starterCar));
  assert.equal(car.owner, alice.id);
  assert.equal(car.parts.filter(Boolean).length, 3);
  assert.equal((await db.invoke('A', 'GetTransaction', player.registeredTx)).w, alice.id);
  const login = await sign(alice, 0, 'login', [{z: 'last', a: 'first'}]);
  assert.doesNotThrow(() => verifyEnvelope({...login, args: [{a: 'first', z: 'last'}]}));
  await assert.rejects(submit(login), /InvalidPlayerNonce/);
});

test('two player inventories, signed market trades, provenance and competing nonces', async () => {
  const {db, alice, bob, sign, submit, profile} = await setup();
  const {starterCar} = await submit(await sign(alice, 1, 'register'));
  await submit(await sign(bob, 1, 'register'));
  const car = await db.invoke('A', 'GetAsset', String(starterCar));
  const [part, secondPart] = car.parts;
  await submit(await sign(alice, 2, 'fit', [car.id, 0, 0, part]));
  await assert.rejects(submit(await sign(bob, 2, 'list', [2, part, 75, 1600])), /NotOwner/);
  const listing = await submit(await sign(alice, 3, 'list', [2, part, 75, 1600]));
  const purchase = await sign(bob, 2, 'buy', [listing, 75]);
  const competing = await Promise.all([1, 2].map(() => db.simulate('裁判', 'PlayerAction', JSON.stringify(purchase))));
  competing[0].commit();
  assert.throws(() => competing[1].commit(), /MVCC_READ_CONFLICT/);
  const asset = await db.invoke('A', 'GetAsset', String(part));
  const order = await db.invoke('A', 'GetOrder', String(listing));
  assert.deepEqual([asset.owner, asset.first, order.buyer, order.paid], [bob.id, alice.id, bob.id, 75]);
  const receipt = await db.invoke('A', 'GetTransaction', order.hashes.at(-1));
  assert.equal(receipt.transfers[0].from, alice.id);
  assert.equal(receipt.transfers[0].to, bob.id);
  assert.equal((await profile(bob)).balance, 925);
  await submit(await sign(alice, 4, 'fit', [car.id, 1, 0, secondPart]));
  const ask = await submit(await sign(alice, 5, 'list', [1, secondPart, 40, 1600]));
  await submit(await sign(bob, 3, 'bid', [12, 50, 1600]));
  assert.equal((await db.invoke('A', 'GetOrder', String(ask))).paid, 40);
  assert.equal((await db.invoke('A', 'GetAsset', String(secondPart))).owner, bob.id);
});

test('derives the signing domain on channels initialized before player registration existed', async () => {
  const {db, alice, sign, submit, domain} = await setup();
  const metaEntry = db.state.get('meta');
  const meta = JSON.parse(metaEntry.value);
  delete meta.playerDomain;
  metaEntry.value = Buffer.from(JSON.stringify(meta));
  assert.deepEqual(await db.invoke('A', 'GetPlayerDomain'), {domain});
  await submit(await sign(alice, 1, 'register'));
  assert.equal(JSON.parse(db.state.get('meta').value).playerDomain, domain);
});
