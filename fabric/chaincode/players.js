const {createHash, createPublicKey, verify} = require('node:crypto');
const {uint, requireThat, balanceKey} = require('./ledger');
const market = require('./market');

const playerID = /^player:[a-f0-9]{64}$/;
const signingContext = 'rainport.player.action.v1';
const profileKey = id => 'player:' + id;
const marketOperations = {
  fit: [3, 4], list: [4], bid: [3], buy: [2], close: [1]
};

function decodeBytes(value, size) {
  requireThat(typeof value === 'string' && value.length === Math.ceil(4 * size / 3), 'InvalidPlayerSignature');
  const bytes = Buffer.from(value, 'base64url');
  requireThat(bytes.length === size && bytes.toString('base64url') === value, 'InvalidPlayerSignature');
  return bytes;
}

// Both the browser and the verifier order object fields before hashing.
function verifyEnvelope(envelope) {
  requireThat(envelope && typeof envelope === 'object', 'InvalidPlayerSignature');
  const {domain, id, publicKey, nonce, action, args, signature} = envelope;
  requireThat(typeof id === 'string' && playerID.test(id) && typeof domain === 'string' &&
    domain.length > 0 && domain.length <= 256 && uint(nonce) && typeof action === 'string' &&
    /^[a-zA-Z]{1,48}$/.test(action) && Array.isArray(args), 'InvalidPlayerSignature');
  const raw = decodeBytes(publicKey, 65);
  requireThat(raw[0] === 4 && id === 'player:' + createHash('sha256').update(raw).digest('hex'), 'InvalidPlayerKey');
  const bytes = decodeBytes(signature, 64);
  const payload = JSON.stringify([signingContext, domain, id, nonce, action, args], (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
  let key;
  try {
    key = createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url')}});
  } catch {
    throw Error('InvalidPlayerKey');
  }
  requireThat(verify('sha256', Buffer.from(payload), {key, dsaEncoding: 'ieee-p1363'}, bytes), 'InvalidPlayerSignature');
}

async function domain(db) {
  const meta = await db.meta();
  if (meta.playerDomain) return meta.playerDomain;
  // Channels initialized by an earlier chaincode already have an immutable initialization receipt.
  const init = (await db.history()).find(tx => tx.fn === 'Initialize');
  requireThat(init, 'NotInitialized');
  return 'rainport:' + init.h;
}

async function get(db, id) {
  requireThat(typeof id === 'string' && playerID.test(id), 'InvalidPlayerId');
  const profile = await db.load(profileKey(id));
  if (!profile) return {id, registered: false, nonce: 0};
  return {...profile, registered: true, balance: await db.balance(id)};
}

async function register(db, id, publicKey, args) {
  requireThat(args.length === 0, 'InvalidArguments');
  const starterCar = await db.issue(id, 0, 0);
  for (const [slot, model] of [1, 3, 5].entries()) {
    const part = await db.issue(id, model, 0);
    await market.fit(db, id, [starterCar, slot, part]);
  }
  db.save(balanceKey(id), 1000);
  return {id, publicKey, starterCar, registeredTx: db.stub.getTxID()};
}

async function execute(db, envelope, duelOperations) {
  verifyEnvelope(envelope);
  const {id, publicKey, nonce, action, args} = envelope;
  const expectedDomain = await domain(db);
  requireThat(envelope.domain === expectedDomain, 'WrongPlayerDomain');
  let profile = await db.load(profileKey(id));
  requireThat(nonce === (profile?.nonce || 0) + 1, 'InvalidPlayerNonce');
  let result;
  if (action === 'register') {
    requireThat(!profile, 'PlayerAlreadyRegistered');
    profile = await register(db, id, publicKey, args);
    const meta = await db.meta();
    if (!meta.playerDomain) db.save('meta', {...meta, playerDomain: expectedDomain});
    result = {id, starterCar: profile.starterCar};
  } else {
    requireThat(profile?.publicKey === publicKey, 'UnknownPlayer');
    if (Object.hasOwn(marketOperations, action)) {
      requireThat(marketOperations[action].includes(args.length) && args.every(uint), 'InvalidArguments');
      result = await market[action](db, id, args);
    } else {
      requireThat(Object.hasOwn(duelOperations, action) && args.length === duelOperations[action].n, 'InvalidArguments');
      result = await duelOperations[action].run(db, id, args, envelope);
    }
  }
  db.save(profileKey(id), {...profile, nonce});
  await db.commit(action, id, args, result);
  return result === undefined ? {ok: true} : result;
}

module.exports = {verifyEnvelope, domain, get, execute};
