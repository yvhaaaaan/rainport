import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {botPilot} from '../physics.mjs';
import {makePrediction} from '../driver-sync.mjs';
import {runSeven} from '../scenarios.mjs';

assert(process.argv.includes('--fresh-local-network'),
  '此验收会交易并改变账本。请仅在新建的本地开发网络上运行 node fabric/acceptance.mjs --fresh-local-network');

const root = fileURLToPath(new URL('../', import.meta.url));
const configPath = path.resolve(process.env.FABRIC_CONFIG || path.join(root, '.fabric-local', 'gateway.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const loopbackGateway = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
assert(loopbackGateway.test(config.endpoint), '验收只允许连接本机开发网关');

const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence, {recursive: true});
const runDir = fs.mkdtempSync(path.join(evidence, 'fabric-'));
process.env.RAINPORT_LEDGER = 'fabric';
process.env.FABRIC_CONFIG = configPath;
process.env.RAINPORT_FABRIC_DATA = path.join(runDir, 'race-data');

const write = (name, data) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 2));
const report = {ledger: 'fabric', started: new Date().toISOString(), passed: 0, total: 7, stage: '连接本地网关'};
const receipts = new Map();
let game;

function reason(error) {
  return error.reason || error.details?.find(item => item.message)?.message || error.message || String(error);
}

function failedReceipt(error) {
  const rc = error.receipt;
  if (!rc) {
    // An endorsement rejection has a proposal ID at most. Never report it as a committed transaction.
    assert.match(reason(error), /OrderClosed|CarListed|AssetListed|PartMounted|订单已成交|车辆已挂牌|有效卖单|部件仍装在车上/);
    return null;
  }
  assert.equal(rc.status, 0, '预期账本拒绝该交易');
  assert.match(rc.hash, /^[a-f0-9]{64}$/i);
  assert(Number.isSafeInteger(rc.blockNumber) && rc.blockNumber > 0);
  return {hash: rc.hash, block: rc.blockNumber, status: rc.status, validationCode: rc.validationCode};
}

async function peerReceipt(hash, expectedStatus = 1) {
  assert.match(hash, /^[a-f0-9]{64}$/i, '必须使用 Fabric 节点返回的交易 ID');
  const rc = await game.receipt(hash, {fresh: true});
  assert.equal(rc.ledger, 'fabric');
  assert.equal(rc.hash, hash);
  assert.equal(rc.channel, game.meta.chainId);
  assert.equal(rc.contract, game.meta.archive);
  assert.equal(rc.status, expectedStatus);
  assert.equal(rc.successful, expectedStatus === 1);
  assert(Number.isSafeInteger(rc.block) && rc.block > 0, '回执应包含所在区块');
  assert.equal(rc.validationCode === 'VALID', expectedStatus === 1);
  receipts.set(hash, rc);
  return rc;
}

async function act(wallet, fn, args) {
  const rc = await game.op(wallet, fn, args);
  assert.equal(rc.status, 1);
  const confirmed = await peerReceipt(rc.hash);
  assert.equal(confirmed.block, rc.blockNumber, '网关提交状态与节点中的区块号不一致');
  return {hash: rc.hash, block: rc.blockNumber, status: rc.status, validationCode: confirmed.validationCode};
}

async function race(wallet, car) {
  let frame = await game.start(wallet, car, true);
  const prediction = makePrediction(frame);
  while (!frame.done) {
    if (Date.now() - frame.ms > 240000) throw Error('验收驾驶超时');
    await sleep(100);
    const keys = botPilot(prediction.display());
    prediction.controls(keys);
    frame = await game.drive(wallet, frame.id, keys, prediction.packet());
    prediction.accept(frame);
  }
  const record = await game.finish(wallet, frame.id);
  const official = await game.race(record.id, game.wallets[wallet]);
  assert.equal(Number(official.stage), 3);
  assert.equal(Number(official.prize), record.prize);
  assert.deepEqual(official.config.map(Number), record.config);
  assert.equal(official.summary, record.summaryHash);
  assert.equal(official.replay, record.replayHash);
  assert.equal(official.configHash, record.configHash);
  assert.equal(record.tx.length, 3, '开赛、确认排名、结算奖励应各有一笔节点回执');
  assert.equal(new Set(record.tx).size, 3, '三笔赛事交易应各有独立交易 ID');
  for (const hash of record.tx) await peerReceipt(hash);
  const replay = await game.replay(record.id);
  assert(replay.trace.length > 10);
  console.log('Fabric 完赛 '+wallet+' · 第 '+record.rank+' 名 · '+record.total.toFixed(3)+' 秒');
  return record;
}

async function parallel(order, price) {
  assert.notEqual(game.wallets.B, game.wallets.C);
  const jobs = await Promise.allSettled(['B', 'C'].map(wallet => act(wallet, 'buy', [order, price])));
  return Promise.all(jobs.map(async (result, index) => {
    const buyer = ['B', 'C'][index];
    if (result.status === 'fulfilled') return {buyer, ok: true, ...result.value};
    const failure = failedReceipt(result.reason);
    if (failure) {
      const rc = await peerReceipt(failure.hash, 0);
      assert.equal(rc.block, failure.block);
      assert.equal(rc.validationCode, 'MVCC_READ_CONFLICT');
    }
    return {buyer, ok: false, reason: reason(result.reason), receipt: failure};
  }));
}

async function verifyPristineNetwork() {
  assert(loopbackGateway.test(game.meta.rpc), '拒绝对远程网关进行交易验收');
  const state = await game.snapshot('A');
  assert.equal(state.ledger, 'fabric');
  assert.equal(state.assets.length, 21, '请部署未使用的演示库存');
  assert.equal(state.orders.length, 6, '请部署未使用的六笔初始订单');
  assert.equal(game.records.length, 0);
  assert(!state.history.some(j => /^(?:start|confirm|draw|abandon)$/i.test(j.fn)), '验收要求账本没有历史赛事');
  assert(state.orders.every(o => o.status === 1 && o.expires > Date.now() / 1000 + 900), '初始挂单须全部有效');
  assert.deepEqual(state.assets.find(a => a.id === 1)?.parts, [2, 7, 4]);
  assert.equal(state.assets.find(a => a.id === 1)?.owner, game.wallets.A);
  assert.equal(state.assets.find(a => a.id === 20)?.owner, game.wallets.C);
  const owners = ['A', 'B', 'C', '港务车队', '托管', '手续费'];
  assert.deepEqual(await Promise.all(owners.map(w => game.balance(w))), [10000, 10000, 9954, 10000, 46, 0]);
  write('deployment.json', {ledger: 'fabric', contracts: game.meta, wallets: game.wallets, startingBlock: state.block});
}

try {
  const {launch} = await import('../server.mjs');
  game = await launch({listen: false, showcase: false});
  report.stage = '确认开发网为初始状态';
  await verifyPristineNetwork();
  report.stage = '运行七项验收';
  await runSeven({
    assert, act, parallel, race, revertReceipt: failedReceipt,
    state: game.state, settle: game.finish, replay: game.replay,
    repeatDraw: (w, id) => act('裁判', 'draw', [id, game.wallets[w]]),
    bal: game.balance, expiry: game.expiry,
    record(checks) {
      report.passed = checks.length;
      write('checks.json', checks);
      console.log('通过 '+checks.length+'/7 '+checks.at(-1).text);
    },
  });
  assert.equal(game.records.length, 3, '验收应恰好结算三场赛事');
} catch (error) {
  report.error = reason(error);
  process.exitCode = 1;
} finally {
  try {
    if (game) {
      write('race-records.json', game.records);
      write('node-receipts.json', [...receipts.values()]);
      await game.stop();
    }
  } catch (error) {
    report.exportError = reason(error);
    process.exitCode = 1;
  }
  report.finished = new Date().toISOString();
  report.receipts = receipts.size;
  report.status = process.exitCode ? '未完成' : '通过';
  write('run.json', report);
  console.log(JSON.stringify(report, null, 2), runDir);
}
