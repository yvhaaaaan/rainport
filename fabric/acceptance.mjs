import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fabricLedger} from './gateway.mjs';
import players from './chaincode/players.js';
import {createPlayerKey, signPlayerAction} from '../player-keys.mjs';
import {loadDuelVerifier} from '../duel-rooms.mjs';
import {advanceDuel, createDuelWorld, MAX_STEPS, verifyDuel} from '../duel-verifier.mjs';
import {botPilot} from '../physics.mjs';

assert(process.argv.includes('--fresh-local-network'),
  '验收会登记玩家并改变账本。请在新建开发网络上使用 --fresh-local-network 运行。');
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(fs.readFileSync(process.env.FABRIC_CONFIG || path.join(root, '.fabric-local', 'gateway.json')));
assert(/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(config.endpoint), '验收只允许连接本机网关');
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence, {recursive: true});
const destination = fs.mkdtempSync(path.join(evidence, 'fabric-duel-'));
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
  const world = createDuelWorld(manifest), logs = [[], []];
  while (world.step < MAX_STEPS && !world.cars.every(car => car.done)) {
    for (const [i, car] of world.cars.entries()) {
      if (car.done) continue;
      const keys = botPilot(car, i === 0 ? -0.2 : 0.2);
      if (keys.some((key, j) => key !== car.keys[j])) {
        logs[i].push([logs[i].length + 1, world.step, ...keys]);
      }
    }
    advanceDuel(world, logs, Math.min(world.step + 10, MAX_STEPS));
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
  const keys = await Promise.all([createPlayerKey(), createPlayerKey()]);
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
  check('两个独立签名身份各自持有赛车及启动资金', {players: roster});

  const verifier = await loadDuelVerifier();
  const manifest = {id: id(), seed: 29, players: roster, stepMs: 10, physicsVersion: 4,
    verifierHash: verifier.hash, initial: {step: 0, lanes: [-0.35, 0.35]}};
  // Select a reproducible award case for the trade assertions. Both identities
  // still drive and verify the entire race using the published verifier below.
  const logs = drive(manifest);
  const expected = verifyDuel(manifest, logs);
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
  await action(0, 'duelCommit', [manifest.id, inputHashes[0]]);
  await assert.rejects(ledger.revealDuel(manifest.id, logs), rejectsWith('BothCommitmentsRequired'));
  await action(1, 'duelCommit', [manifest.id, inputHashes[1]]);
  await confirmed(ledger.revealDuel(manifest.id, logs));
  const review = await ledger.duel(manifest.id);
  assert.deepEqual(review.logs, logs);
  const results = verifyDuel(review.manifest, review.logs);
  assert.deepEqual(results, expected);
  check('收齐双摘要后上链原始输入，复算得到相同名次和整数毫秒用时', {inputHashes, results});

  const digest = hash({id: manifest.id, manifestHash: review.manifestHash, inputHashes, results});
  const args = [manifest.id, inputHashes, results, digest];
  await action(0, 'duelConfirm', args);
  assert.deepEqual((await ledger.duel(manifest.id)).prizes, [0, 0]);
  await action(1, 'duelConfirm', args);
  const settled = await ledger.duel(manifest.id);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.resultHash, digest);
  settled.confirmations.forEach(approval => players.verifyEnvelope(approval.envelope));
  const count = (await ledger.marketState()).assets.length;
  await action(0, 'duelConfirm', args);
  assert.equal((await ledger.marketState()).assets.length, count);
  write('race-record.json', settled);
  check('双方签名同一摘要才结算，重试保持奖励编号', {digest, prizes: settled.prizes});

  const seller = settled.prizes.findIndex(Boolean), buyer = 1 - seller;
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
      check('奖励支持同款和按编号挂牌，成交后仍能查双签及交易回执', {serial, hash: bought.hash});
    }
  }

  const disputed = {...manifest, id: id()};
  await confirmed(ledger.openDuel(disputed));
  for (let i = 0; i < 2; i++) await action(i, 'duelCommit', [disputed.id, inputHashes[i]]);
  await confirmed(ledger.revealDuel(disputed.id, logs));
  const disagreement = await ledger.duel(disputed.id);
  for (let i = 0; i < 2; i++) {
    const computed = results.map(r => ({...r, totalMs: r.totalMs + i}));
    const resultHash = hash({id: disputed.id, manifestHash: disagreement.manifestHash, inputHashes, results: computed});
    await action(i, 'duelConfirm', [disputed.id, inputHashes, computed, resultHash]);
  }
  assert.equal((await ledger.duel(disputed.id)).reason, 'disagreement');
  assert.equal((await ledger.marketState()).assets.length, count);
  const refused = {...manifest, id: id()};
  await confirmed(ledger.openDuel(refused));
  await action(1, 'duelRefuse', [refused.id]);
  assert.equal((await ledger.duel(refused.id)).reason, 'refused');
  for (const p of roster) assert.equal((await ledger.asset(p.config[0])).busy, 0);
  check('复算分歧及显式拒签关闭赛事并解锁车辆', {disputed: disputed.id, refused: refused.id});

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
