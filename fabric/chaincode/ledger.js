const {createHash, X509Certificate} = require('node:crypto');

const REFEREE = '裁判';
const TEAM = '港务车队';
const FEES = '手续费';
const ESCROW = 'market-escrow';
const DRIVERS = ['A', 'B', 'C', TEAM];
const ROLES = [REFEREE, ...DRIVERS, FEES];
const ID = /^[A-Za-z0-9_.-]+:[a-f0-9]{64}$/;
const HASH = /^0x[a-f0-9]{64}$/;
const requireThat = (condition, error) => {
  if (!condition) throw Error(error);
};
const uint = value => Number.isSafeInteger(value) && value >= 0;
const key = (kind, id) => kind + ':' + id;
const assetKey = id => key('asset', id);
const orderKey = id => key('order', id);
const balanceKey = id => key('balance', id);
const transactionKey = id => key('tx', id);
const fingerprint = value => createHash('sha256').update(value).digest('hex');

function identity(ctx) {
  const mspId = ctx.clientIdentity.getMSPID();
  return {id: mspId + ':' + fingerprint(ctx.clientIdentity.getID()), mspId};
}

function isBootstrapAdmin(ctx) {
  if (ctx.clientIdentity.getMSPID() !== 'Org1MSP') return false;
  if (ctx.clientIdentity.assertAttributeValue('rainport.admin', 'true')) return true;
  const certificate = new X509Certificate(ctx.stub.getCreator().idBytes);
  return certificate.subject.split('\n').includes('OU=admin');
}

function parse(text, error) {
  try {
    return JSON.parse(text);
  } catch {
    throw Error(error);
  }
}

// An endorsement simulation reads committed state, so in-progress writes need
// to be visible inside this invocation (for example an ask immediately matched).
class Ledger {
  constructor(stub) {
    this.stub = stub;
    this.time = Number(stub.getTxTimestamp().seconds.toString());
    this.draft = new Map();
    this.dirty = new Set();
    this.transfers = [];
  }

  async load(name, fallback = null) {
    if (!this.draft.has(name)) {
      const bytes = await this.stub.getState(name);
      this.draft.set(name, bytes.length ? JSON.parse(Buffer.from(bytes).toString()) : fallback);
    }
    return this.draft.get(name);
  }

  save(name, value) {
    this.draft.set(name, value);
    this.dirty.add(name);
  }

  async meta() {
    const meta = await this.load('meta');
    requireThat(meta, 'NotInitialized');
    return meta;
  }

  async asset(id) {
    requireThat(uint(id) && id > 0, 'UnknownAsset');
    const item = await this.load(assetKey(id));
    requireThat(item, 'UnknownAsset');
    return item;
  }

  async order(id) {
    requireThat(uint(id) && id > 0, 'OrderClosed');
    const value = await this.load(orderKey(id));
    requireThat(value, 'OrderClosed');
    return value;
  }

  async balance(id) {
    return this.load(balanceKey(id), 0);
  }

  async pay(from, to, amount) {
    if (!amount) return;
    const balance = await this.balance(from);
    requireThat(balance >= amount, 'ERC20InsufficientBalance');
    this.save(balanceKey(from), balance - amount);
    this.save(balanceKey(to), (await this.balance(to)) + amount);
  }

  async issue(owner, model, edition, origin = null, originRank = 0) {
    const meta = await this.meta();
    const id = ++meta.tokenCount;
    this.save('meta', meta);
    this.save(assetKey(id), {
      id, owner, model, edition, key: model * 4 + edition, mount: 0, lock: 0,
      parts: [0, 0, 0], origin, first: owner, originRank, busy: 0
    });
    return id;
  }

  async commit(fn, w, args, result) {
    const h = this.stub.getTxID();
    const entry = {fn, w, h, ok: true, args, time: this.time, transfers: this.transfers};
    if (result !== undefined) entry.result = result;
    this.save(transactionKey(h), entry);
    for (const name of this.dirty) {
      await this.stub.putState(name, Buffer.from(JSON.stringify(this.draft.get(name))));
    }
    this.stub.setEvent('RainportTransaction', Buffer.from(JSON.stringify(entry)));
  }

  async history() {
    const history = [];
    const iterator = await this.stub.getStateByRange('tx:', 'tx;');
    try {
      while (true) {
        const entry = await iterator.next();
        if (entry.value) history.push(JSON.parse(Buffer.from(entry.value.value).toString()));
        if (entry.done) break;
      }
    } finally {
      await iterator.close();
    }
    return history.sort((a, b) => b.time - a.time || (a.h < b.h ? -1 : 1));
  }
}

module.exports = {
  REFEREE, TEAM, FEES, ESCROW, DRIVERS, ROLES, ID, HASH, requireThat, uint,
  assetKey, orderKey, balanceKey, transactionKey, identity, isBootstrapAdmin, parse, Ledger
};
