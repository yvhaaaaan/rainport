const {FEES, ESCROW, uint, requireThat, assetKey, orderKey} = require('./ledger');

const MODEL = 1;
const SERIAL = 2;
const CAR = 3;
const BID = 4;
const OPEN = 1;
const SOLD = 2;
const CANCELLED = 3;
const EXPIRED = 4;

function free(asset, time) {
  requireThat(!asset.lock, 'AssetListed');
  requireThat(!asset.mount, 'PartMounted');
  requireThat(asset.busy <= time, 'CarRacing');
  requireThat(asset.parts.every(part => !part), 'CarAssembled');
}

async function fit(db, actor, [id, slot, partId, expectedSlot]) {
  const car = await db.asset(id);
  requireThat(car.owner === actor && car.model === 0 && uint(slot) && slot < 3, 'NotYourChassis');
  requireThat(!car.lock, 'CarListed');
  requireThat(car.busy <= db.time, 'CarRacing');
  const old = car.parts[slot];
  if (expectedSlot !== undefined) requireThat(old === expectedSlot, 'SlotChanged');
  if (partId) {
    const part = await db.asset(partId);
    requireThat(part.owner === actor && part.model > 0 && Math.floor((part.model - 1) / 2) === slot, 'IncompatiblePart');
    free(part, db.time);
    part.mount = id;
    db.save(assetKey(partId), part);
  }
  if (old) {
    const part = await db.asset(old);
    part.mount = 0;
    db.save(assetKey(old), part);
  }
  car.parts[slot] = partId;
  db.save(assetKey(id), car);
}

async function open(db, actor, kind, key, price, expires, ids) {
  requireThat(uint(price) && price > 0 && price <= 1e9, 'InvalidPrice');
  requireThat(uint(expires) && expires > db.time && expires <= db.time + 30 * 86400, 'InvalidExpiry');
  const meta = await db.meta();
  const id = ++meta.orderCount;
  db.save('meta', meta);
  const order = {id, kind, key, price, expires, ids, status: OPEN, maker: actor,
    buyer: '', paid: 0, when: 0, linked: 0, hashes: [db.stub.getTxID()]};
  db.save(orderKey(id), order);
  return order;
}

// Reading the counter and individual orders records the versions competing
// transactions must still observe when the orderer commits them.
async function best(db, kind, key, limit, actor) {
  const {orderCount} = await db.meta();
  let choice = null;
  for (let id = 1; id <= orderCount; id++) {
    const order = await db.order(id);
    if (order.kind !== kind || order.key !== key || order.status !== OPEN ||
        order.expires <= db.time || order.maker === actor) continue;
    const better = kind === MODEL
      ? order.price <= limit && (!choice || order.price < choice.price)
      : order.price >= limit && (!choice || order.price > choice.price);
    if (better) choice = order;
  }
  return choice;
}

function mark(db, order, changes) {
  Object.assign(order, changes);
  const tx = db.stub.getTxID();
  if (!order.hashes.includes(tx)) order.hashes.push(tx);
  db.save(orderKey(order.id), order);
}

async function deliver(db, order, buyer, payer, price) {
  requireThat(order.status === OPEN && order.expires > db.time, 'OrderClosed');
  requireThat(order.kind !== BID && buyer !== order.maker, 'WrongBuyer');
  const assets = [];
  for (const id of order.ids) {
    const asset = await db.asset(id);
    requireThat(asset.lock === order.id && asset.owner === order.maker, 'DeliveryChanged');
    assets.push(asset);
  }
  const {wallets} = await db.meta();
  const fee = Math.floor(price * 2 / 100);
  await db.pay(payer, order.maker, price - fee);
  await db.pay(payer, wallets[FEES], fee);
  mark(db, order, {status: SOLD, buyer, paid: price, when: db.time});
  for (const asset of assets) {
    db.transfers.push({id: asset.id, from: asset.owner, to: buyer, hash: db.stub.getTxID()});
    Object.assign(asset, {owner: buyer, lock: 0});
    db.save(assetKey(asset.id), asset);
  }
}

async function match(db, ask, bid, price) {
  await deliver(db, ask, bid.maker, ESCROW, price);
  mark(db, ask, {linked: bid.id});
  mark(db, bid, {status: SOLD, ids: [ask.ids[0]], buyer: bid.maker,
    paid: price, when: db.time, linked: ask.id});
  await db.pay(ESCROW, bid.maker, bid.price - price);
}

async function list(db, actor, [kind, id, price, expires]) {
  const asset = await db.asset(id);
  requireThat(asset.owner === actor, 'NotOwner');
  const assets = [asset];
  if (kind === CAR) {
    requireThat(asset.model === 0 && !asset.lock && asset.busy <= db.time, 'CarUnavailable');
    for (const partId of asset.parts) {
      requireThat(partId, 'IncompleteCar');
      const part = await db.asset(partId);
      requireThat(part.owner === actor && !part.lock && part.mount === id, 'IncompleteCar');
      assets.push(part);
    }
  } else {
    requireThat((kind === MODEL || kind === SERIAL) && asset.model > 0, 'PartOnly');
    free(asset, db.time);
  }
  const order = await open(db, actor, kind, asset.key, price, expires, assets.map(a => a.id));
  for (const listed of assets) {
    listed.lock = order.id;
    db.save(assetKey(listed.id), listed);
  }
  if (kind === MODEL) {
    const crossing = await best(db, BID, order.key, price, actor);
    if (crossing) await match(db, order, crossing, crossing.price);
  }
  return order.id;
}

async function bid(db, actor, [key, price, expires]) {
  requireThat(uint(key) && key >= 4 && key < 28, 'UnknownSpec');
  const order = await open(db, actor, BID, key, price, expires, []);
  await db.pay(actor, ESCROW, price);
  const crossing = await best(db, MODEL, key, price, actor);
  if (crossing) await match(db, crossing, order, crossing.price);
  return order.id;
}

async function buy(db, actor, [id, expectedPrice]) {
  const order = await db.order(id);
  requireThat(order.status === OPEN && order.expires > db.time, 'OrderClosed');
  requireThat(order.price === expectedPrice, 'PriceChanged');
  if (order.kind === MODEL) {
    requireThat((await best(db, MODEL, order.key, order.price, actor))?.id === id, 'BetterAskExists');
  }
  await deliver(db, order, actor, actor, order.price);
}

async function close(db, actor, [id]) {
  const order = await db.order(id);
  requireThat(order.status === OPEN, 'OrderClosed');
  const expired = order.expires <= db.time;
  requireThat(expired || order.maker === actor, 'NotYourOrder');
  if (order.kind === BID) {
    await db.pay(ESCROW, order.maker, order.price);
  } else {
    for (const assetId of order.ids) {
      const asset = await db.asset(assetId);
      requireThat(asset.lock === id, 'DeliveryChanged');
      asset.lock = 0;
      db.save(assetKey(assetId), asset);
    }
  }
  mark(db, order, {status: expired ? EXPIRED : CANCELLED});
}

module.exports = {fit, list, bid, buy, close};
