const {Contract} = require('fabric-contract-api');
const {
  DRIVERS, ROLES, REFEREE, TEAM, ESCROW, ID, requireThat, uint, identity,
  isBootstrapAdmin, parse, balanceKey, transactionKey, Ledger
} = require('./ledger');
const market = require('./market');
const races = require('./races');
const duels = require('./duels');
const players = require('./players');

const seeds = [
  ['A', 0, 0], ['A', 1, 0], ['A', 3, 0], ['A', 5, 0], ['B', 0, 0], ['B', 2, 0],
  ['A', 4, 0], ['B', 6, 0], ['B', 3, 0], [TEAM, 0, 0], [TEAM, 2, 1], [TEAM, 4, 2],
  [TEAM, 6, 1], [TEAM, 4, 0], [TEAM, 4, 0], [TEAM, 2, 1], [TEAM, 5, 0],
  [TEAM, 4, 2], ['A', 6, 1], ['C', 4, 0], [TEAM, 3, 0]
];
const garages = [['A', 1, [2, 7, 4]], ['B', 5, [6, 9, 8]], [TEAM, 10, [11, 12, 13]]];
const listings = [[1, 14, 58], [1, 15, 65], [2, 18, 148], [1, 16, 115], [2, 17, 38]];

const operations = Object.assign(Object.create(null), {
  fit: {n: 3, run: market.fit},
  list: {n: 4, run: market.list},
  bid: {n: 3, run: market.bid},
  buy: {n: 2, run: market.buy},
  close: {n: 1, run: market.close},
  abandon: {n: 2, official: true, run: races.abandon},
  draw: {n: 2, run: (db, actor, args) => races.draw(db, args)}
});

class Rainport extends Contract {
  constructor() {
    super('Rainport');
  }

  async WhoAmI(ctx) {
    return identity(ctx);
  }

  async GetWallets(ctx) {
    return (await new Ledger(ctx.stub).load('meta'))?.wallets ?? {};
  }

  async GetPlayerDomain(ctx) {
    return {domain: await players.domain(new Ledger(ctx.stub))};
  }

  async GetPlayer(ctx, id) {
    return players.get(new Ledger(ctx.stub), id);
  }

  async PlayerAction(ctx, envelopeJSON) {
    const db = new Ledger(ctx.stub);
    const {wallets} = await db.meta();
    requireThat(identity(ctx).id === wallets[REFEREE], 'RefereeOnly');
    const envelope = parse(envelopeJSON, 'InvalidArguments');
    return players.execute(db, envelope, duels.playerActions);
  }

  async Initialize(ctx, rolesJSON) {
    requireThat(isBootstrapAdmin(ctx), 'BootstrapAdminOnly');
    const db = new Ledger(ctx.stub);
    requireThat(!await db.load('meta'), 'AlreadyInitialized');
    const bindings = parse(rolesJSON, 'InvalidRoles');
    requireThat(Array.isArray(bindings) && bindings.length === ROLES.length, 'InvalidRoles');
    const wallets = {};
    for (const binding of bindings) {
      requireThat(binding && ROLES.includes(binding.role) && !wallets[binding.role] &&
        typeof binding.id === 'string' && ID.test(binding.id) &&
        !Object.values(wallets).includes(binding.id), 'InvalidRoles');
      wallets[binding.role] = binding.id;
    }
    db.save('meta', {wallets, tokenCount: 0, orderCount: 0, playerDomain: 'rainport:' + ctx.stub.getTxID()});
    for (const driver of DRIVERS) db.save(balanceKey(wallets[driver]), 10000);
    for (const [role, model, edition] of seeds) await db.issue(wallets[role], model, edition);
    for (const [role, car, parts] of garages) {
      for (const [i, t] of parts.entries()) await market.fit(db, wallets[role], [car, i, t]);
    }
    const expiry = db.time + 29 * 86400;
    for (const [kind, id, price] of listings) await market.list(db, wallets[TEAM], [kind, id, price, expiry]);
    await market.bid(db, wallets.C, [16, 46, expiry]);
    await db.commit('Initialize', '管理员', bindings);
    return wallets;
  }

  async Execute(ctx, fn, argsJSON) {
    requireThat(fn !== 'start' && fn !== 'confirm', 'SignedDuelRequired');
    const operation = operations[fn];
    const args = parse(argsJSON, 'InvalidArguments');
    requireThat(operation && Array.isArray(args), 'InvalidArguments');
    const guardedFit = fn === 'fit' && args.length === 4;
    requireThat(args.length === operation.n || guardedFit, 'InvalidArguments');
    if (!operation.official && fn !== 'draw') requireThat(args.every(uint), 'InvalidArguments');
    const actor = identity(ctx).id;
    const db = new Ledger(ctx.stub);
    const {wallets} = await db.meta();
    const role = ROLES.find(name => wallets[name] === actor);
    requireThat(role, 'UnregisteredIdentity');
    if (operation.official) requireThat(role === REFEREE, 'RefereeOnly');
    const result = operation.official
      ? await operation.run(db, args)
      : await operation.run(db, actor, args);
    await db.commit(fn, role, args, result);
    return result === undefined ? {ok: true} : result;
  }

  async GetAsset(ctx, id) {
    return new Ledger(ctx.stub).asset(Number(id));
  }

  async GetOrder(ctx, id) {
    return new Ledger(ctx.stub).order(Number(id));
  }

  async GetRace(ctx, id, canonicalID) {
    return races.getRace(new Ledger(ctx.stub), id, canonicalID);
  }

  async OpenDuel(ctx, manifestJSON) {
    return duels.openDuel(ctx, manifestJSON);
  }

  async RevealDuel(ctx, id, logsJSON) {
    return duels.revealDuel(ctx, id, logsJSON);
  }

  async AnchorDuelInputs(ctx, id, hashesJSON, withdrawalsJSON) {
    return duels.anchorDuelInputs(ctx, id, hashesJSON, withdrawalsJSON);
  }

  async PublishDuelRecords(ctx, id, logsJSON) {
    return duels.publishDuelRecords(ctx, id, logsJSON);
  }

  async ExpireDuel(ctx, id) {
    return duels.expireDuel(ctx, id);
  }

  async GetDuel(ctx, id) {
    return duels.getDuel(ctx, id);
  }

  async GetTransaction(ctx, id) {
    requireThat(/^[a-f0-9]{64}$/.test(id), 'InvalidTxID');
    const tx = await new Ledger(ctx.stub).load(transactionKey(id));
    requireThat(tx, 'UnknownTxID');
    return tx;
  }

  async Snapshot(ctx) {
    const db = new Ledger(ctx.stub);
    const {wallets, tokenCount, orderCount} = await db.meta();
    const assets = [], orders = [], balances = {};
    for (let id = 1; id <= tokenCount; id++) assets.push(await db.asset(id));
    for (let id = 1; id <= orderCount; id++) orders.push(await db.order(id));
    for (const role of ROLES) balances[role] = await db.balance(wallets[role]);
    balances['托管'] = await db.balance(ESCROW);
    const history = await db.history();
    const transfers = history.flatMap(tx => tx.transfers);
    return {wallets, assets, orders, balances, history, transfers};
  }
}

module.exports.contracts = [Rainport];
