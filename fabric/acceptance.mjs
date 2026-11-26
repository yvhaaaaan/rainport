import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fabricLedger} from './gateway.mjs';
import players from './chaincode/players.js';
import {createPlayerKey, signPlayerAction} from '../player-keys.mjs';
import {loadDuelVerifier} from '../duel-rooms.mjs';
import {advanceDuel, createDuelWorld, MAX_STEPS, verifyDuel, startingLanes} from '../duel-verifier.mjs';
import {botPilot} from '../physics.mjs';

assert(process.argv.includes('--fresh-local-network'),
  '验收会登记玩家并改变账本。请在新建开发网络上使用 --fresh-local-network 运行。');
const count = Number((process.argv.find(arg => arg.startsWith('--players=')) || '--players=2').slice(10));
assert([2, 3, 4].includes(count), '请传入 --players=2、3 或 4');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(fs.readFileSync(process.env.FABRIC_CONFIG || path.join(root, '.fabric-local', 'gateway.json')));
assert(/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(config.endpoint), '验收只允许连接本机网关');
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence, {recursive: true});
const destination = fs.mkdtempSync(path.join(evidence, 'fabric-duel-' + count + 'p-'));
const write = (name, value) => fs.writeFileSync(path.join(destination, name), JSON.stringify(value, null, 2));
const checks = [], receipts = [];
const check = (text, details) => {
  checks.push({text, ...details});
  write('checks.json', checks);
  console.log('通过 ' + checks.length + '/7 ' + text);
};
const hash = value => createHash('sha256').update(JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item)).digest('hex');
const id = () => '0x' + randomBytes(32).toString('hex');

function drive(manifest) {
  const world = createDuelWorld(manifest), logs = manifest.players.map(() => []);
  const withdrawals = manifest.players.map(() => null);
  while (world.step < MAX_STEPS && !world.cars.every(car => car.done)) {
    for (const [i, car] of world.cars.entries()) {
      if (car.done) continue;
      const keys = botPilot(car, manifest.initial.lanes[i] / 2);
      if (keys.some((key, j) => key !== car.keys[j])) {
        logs[i].push([logs[i].length + 1, world.step, ...keys]);
      }
    }
    advanceDuel(world, logs, Math.min(world.step + 10, MAX_STEPS), withdrawals);
  }
  return logs;
}

let ledger;
try {
  ledger = await fabricLedger();
  const initial = await ledger.marketState();
  assert.equal(initial.assets.length, 21, '请使用新建的开发网络');
  assert.equal(initial.orders.length, 6);
  assert.deepEqual(initial.history.map(tx => tx.fn), ['Initialize']);
  const {domain} = await ledger.playerDomain();
  async function confirmed(operation) {
    const submitted = await operation;
    const committed = await ledger.receipt(submitted.hash, {fresh: true});
    assert.equal(committed.validationCode, 'VALID');
    assert.equal(committed.block, submitted.block);
    receipts.push(committed);
    return committed;
  }
  const keys = await Promise.all(Array.from({length:count}, () => createPlayerKey()));
  async function action(i, fn, args) {
    const profile = await ledger.player(keys[i].id);
    const envelope = await signPlayerAction(keys[i], domain, profile.nonce + 1, fn, args);
    return confirmed(ledger.playerAction(envelope));
  }
  const roster = [];
  for (const [i, key] of keys.entries()) {
    await action(i, 'register', []);
    const profile = await ledger.player(key.id);
    const car = await ledger.asset(profile.starterCar);
    assert.equal(profile.balance, 1000);
    assert.equal(car.owner, key.id);
    roster.push({id: key.id, config: [car.id, ...car.parts], spec: [1, 3, 5]});
  }
  check(count + ' 名独立车手各自持有赛车及启动资金', {players: roster});

  const verifier = await loadDuelVerifier();
  const manifest = {id: id(), seed: 29, players: roster, stepMs: 10, physicsVersion: 4,
    finishPolicy: 'individual-v1', verifierHash: verifier.hash, initial: {step: 0, lanes: startingLanes(count)}};
  const noWithdrawals = roster.map(() => null);
  // Select a reproducible award case for the trade assertions. Both identities
  // still drive and verify the entire race using the published verifier below.
  const logs = drive(manifest);
  const expected = verifyDuel(manifest, logs, noWithdrawals);
  const hasPrize = () => roster.some((p, i) => {
    const bytes = createHash('sha256').update('RAINPORT_FABRIC_MOCK_V1\0' + manifest.id + '\0' + p.id).digest('hex');
    const roll = Number(BigInt('0x' + bytes) % 10000n);
    const rank = expected[i].rank;
    return roll >= (rank === 1 ? 0 : rank <= 3 ? 1000 : rank <= 5 ? 3000 : 5500);
  });
  while (!hasPrize()) manifest.id = id();

  await confirmed(ledger.openDuel(manifest));
  const locked = await ledger.duel(manifest.id);
  assert.equal(locked.manifestHash, hash(manifest));
  assert.equal((await ledger.asset(roster[0].config[0])).busy, locked.deadline);
  const rejectsWith = reason => error => (error.reason || error.message).includes(reason);
  await assert.rejects(action(0, 'fit', [roster[0].config[0], 1, 0]), rejectsWith('CarRacing'));
  await assert.rejects(ledger.op('裁判', 'confirm', [manifest.id, ledger.wallets.A, 1, 1, manifest.id, manifest.id]),
    rejectsWith('SignedDuelRequired'));
  check('发车清单、车辆配置和验证程序哈希已锁定，单裁判确认已禁用', {manifestHash: locked.manifestHash});

  const inputHashes = logs.map(hash);
  await assert.rejects(ledger.publishDuelRecords(manifest.id, logs), rejectsWith('DuelInputsNotAnchored'));
  await confirmed(ledger.anchorDuelInputs(manifest.id, inputHashes, noWithdrawals));
  await assert.rejects(ledger.publishDuelRecords(manifest.id, logs.slice(1)), rejectsWith('InvalidDuelLog'));
  await confirmed(ledger.publishDuelRecords(manifest.id, logs));
  const review = await ledger.duel(manifest.id);
  assert.deepEqual(review.logs, logs);
  const results = verifyDuel(review.manifest, review.logs, review.withdrawals);
  assert.deepEqual(results, expected);
  assert.deepEqual(review.results, results);
  check('锁定输入后链码独立重演，赛道源码返回相同的名次与整数毫秒用时', {inputHashes, results});

  const digest = hash({id: manifest.id, manifestHash: review.manifestHash, inputHashes, withdrawals:noWithdrawals, results});
  assert.equal(review.resultHash, digest);
  const args = [manifest.id, inputHashes, results, digest];
  for (const [i, h] of inputHashes.entries()) {
    await action(i, 'duelCommit', [manifest.id, h]);
    await action(i, 'duelConfirm', args);
    const interim = await ledger.duel(manifest.id);
    assert.equal(interim.playerStatus[i], 'claimed');
    assert.equal(interim.confirmations.filter(Boolean).length, i + 1);
  }
  const settled = await ledger.duel(manifest.id);
  assert.equal(settled.status, 'settled');
  settled.confirmations.forEach(approval => players.verifyEnvelope(approval.envelope));
  const totalAssets = (await ledger.marketState()).assets.length;
  await action(0, 'duelConfirm', args);
  assert.equal((await ledger.marketState()).assets.length, totalAssets);
  write('race-record.json', settled);
  check('每位车手可独立核验领奖，重复签名保留原有奖品编号', {digest, prizes: settled.prizes});

  const seller = settled.prizes.findIndex(Boolean), buyer = (seller + 1) % count;
  assert.ok(seller >= 0);
  const serial = settled.prizes[seller], expires = ledger.expiry();
  for (const kind of [1, 2]) {
    // Leave this ask above outstanding demo bids so its cancellation can be tested.
    const price = kind === 1 ? 900 : 75;
    await action(seller, 'list', [kind, serial, price, expires]);
    const order = (await ledger.marketState()).orders.find(o => o.status === 1 && o.ids[0] === serial);
    assert.ok(order);
    if (kind === 1) await action(seller, 'close', [order.id]);
    else {
      const before = await ledger.player(keys[buyer].id);
      const bought = await action(buyer, 'buy', [order.id, price]);
      const sold = await ledger.order(order.id);
      const part = await ledger.asset(serial);
      assert.equal(part.owner, keys[buyer].id);
      assert.equal(part.origin, manifest.id);
      assert.equal(part.first, keys[seller].id);
      assert.equal(sold.hashes.at(-1), bought.hash);
      assert.equal((await ledger.player(keys[buyer].id)).balance, before.balance - price);
      check('奖励支持同款和按编号挂牌，成交后仍能查本人签名与交易回执', {serial, hash: bought.hash});
    }
  }

  const survivor = {...manifest, id: id()};
  await confirmed(ledger.openDuel(survivor));
  const alone = logs.map((log,i) => i === 0 ? log : []);
  const withdrawals = roster.map((p,i) => i === 0 ? null : {id:p.id, step:0});
  for (let i = 1; i < count; i++) await action(i, 'duelWithdraw', [survivor.id]);
  const ownHashes = alone.map(hash);
  await confirmed(ledger.anchorDuelInputs(survivor.id, ownHashes, withdrawals));
  await confirmed(ledger.publishDuelRecords(survivor.id, alone));
  const remaining = await ledger.duel(survivor.id);
  assert.deepEqual(remaining.playerStatus, ['eligible', ...Array(count - 1).fill('withdrawn')]);
  assert.deepEqual(remaining.results, verifyDuel(survivor, alone, withdrawals));
  assert.ok(remaining.results[0].rank > 0);
  await action(0, 'duelCommit', [survivor.id, ownHashes[0]]);
  await action(0, 'duelConfirm', [survivor.id, ownHashes, remaining.results, remaining.resultHash]);
  const individual = await ledger.duel(survivor.id);
  assert.equal(individual.status, 'settled');
  assert.equal(individual.confirmations.filter(Boolean).length, 1);
  for (const p of roster) assert.equal((await ledger.asset(p.config[0])).busy, 0);
  write('individual-record.json', individual);
  check('其他车手全部签退后，唯一完赛车手仍能独立结算且所有赛车解锁',
    {id:survivor.id, results:individual.results, prizes:individual.prizes});

  const listed = await confirmed(ledger.op('A', 'list', [2, 19, 111, expires]));
  const order = (await ledger.marketState()).orders.find(o => o.ids[0] === 19 && o.status === 1);
  const buyers = ['B', 'C'];
  const balances = await Promise.all(buyers.map(r => ledger.balance(r)));
  const attempts = await Promise.allSettled(buyers.map(r => confirmed(ledger.op(r, 'buy', [order.id, 111]))));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  const after = await Promise.all(buyers.map(r => ledger.balance(r)));
  const winner = attempts.findIndex(attempt => attempt.status === 'fulfilled');
  assert.equal(balances[winner] - after[winner], 111);
  assert.equal(balances[1-winner] - after[1-winner], 0);
  assert.equal((await ledger.asset(19)).owner, ledger.wallets[buyers[winner]]);
  check('两个买家竞争同一编号时，只有成交方付费并取得部件', {listing: listed.hash, winner: buyers[winner]});
} finally {
  write('node-receipts.json', receipts);
  ledger?.stop();
  console.log('验收记录 ' + destination);
}
