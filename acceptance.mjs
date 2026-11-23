import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {botPilot} from './physics.mjs';
import {makePrediction} from './driver-sync.mjs';
import {runSeven} from './scenarios.mjs';

const evidence = path.resolve('evidence');
fs.mkdirSync(evidence, {recursive: true});
const runDir = fs.mkdtempSync(path.join(evidence, 'chain-'));
process.env.RAINPORT_DATA = process.env.RAINPORT_TEST_DATA || path.join(runDir,'node-data');
const save = (file, data) => fs.writeFileSync(path.join(runDir, file), JSON.stringify(data, null, 2));
const report = {started: new Date().toISOString(), passed: 0, total: 7, stage: '加载依赖',nodeData:path.relative(runDir,process.env.RAINPORT_DATA)};
let h;

function revertReceipt(error) {
 const receipt = error.receipt;
 assert(receipt?.status === 0 && receipt.hash && receipt.blockNumber > 0, '预期节点返回已入块的回滚回执');
 return {hash: receipt.hash, block: receipt.blockNumber, status: receipt.status, reason:error.reason || error.shortMessage};
}

async function race(wallet, car) {
 let frame = await h.start(wallet, car, true);
 const prediction=makePrediction(frame);
 while (!frame.done) {
  if (Date.now() - frame.ms > 240000) throw Error('验收驾驶超时');
  await sleep(100);
  const keys=botPilot(prediction.display());
  prediction.controls(keys);
  frame=h.drive(wallet,frame.id,keys,prediction.packet());
  prediction.accept(frame);
 }
 return h.finish(wallet, frame.id);
}

async function act(wallet, method, args, force = false) {
 const receipt = await h.op(wallet, method, args, undefined, force ? {gasLimit: 5000000n} : {});
 return {hash: receipt.hash, block: receipt.blockNumber, status: receipt.status};
}

async function parallel(id, price) {
 const results = await Promise.allSettled(['B','C'].map(w => act(w, 'buy', [id, price], true)));
 return results.map(result => result.status === 'fulfilled'
  ? {ok: true, ...result.value}
  : {ok: false, ...revertReceipt(result.reason)});
}

async function exportLedger() {
 const rpc = (method, params = []) => h.node.provider.request({method, params});
 const head = Number(await rpc('eth_blockNumber'));
 const raw = [];
 for (let height = 1; height <= head; height++) {
  const block = await rpc('eth_getBlockByNumber', ['0x' + height.toString(16), false]);
  for (const hash of block.transactions) {
   const receipt = await rpc('eth_getTransactionReceipt', [hash]);
   assert(receipt && receipt.transactionHash === hash && receipt.blockHash === block.hash, '回执与所在区块不一致');
   raw.push(receipt);
  }
 }
 save('node-receipts.json', raw);
 save('race-records.json', h.records);
 save('transactions.json', h.journal);
 const deployments = {};
 for (const [name, address] of Object.entries(h.meta)) {
  const deployment = raw.find(r => r.contractAddress?.toLowerCase() === address.toLowerCase());
  assert(deployment?.status === '0x1', '缺少合约部署回执：' + name);
  deployments[name] = {address, transactionHash: deployment.transactionHash, blockNumber: Number(deployment.blockNumber)};
 }
 save('deployment.json', {chainId: Number(await rpc('eth_chainId')), deployments, wallets: h.wallets});
 report.receipts = raw.length;
}

try {
 const {launch} = await import('./server.mjs');
 report.stage = '编译、部署和初始化';
 h = await launch({listen: false, showcase: false});
 fs.copyFileSync(path.join(process.env.RAINPORT_DATA, 'compiled.json'), path.join(runDir, 'compiled.json'));
 report.stage = '运行七项验收';
 await runSeven({
  assert, state: h.state, act, race, settle: h.finish, replay: h.replay, parallel, revertReceipt,
  repeatDraw: (w, id) => act(w, 'draw', [id, h.wallets[w]]),
  bal: async w => Number(await h.credits.balanceOf(w === '托管' ? h.meta.Archive : h.wallets[w])),
  expiry: h.expiry,
  record(checks) { report.passed = checks.length; save('checks.json', checks); console.log('通过 '+checks.length+'/7：'+checks.at(-1).text); }
 });
} catch (error) {
 report.error = error.message;
 fs.writeFileSync(path.join(runDir, 'failure.txt'), error.stack || error.message);
 process.exitCode = 1;
} finally {
 try {
  if (h) await exportLedger();
 } catch (error) {
  report.exportError = error.message;
  process.exitCode = 1;
 } finally {
  if (h) await h.stop();
  report.finished = new Date().toISOString();
  report.status = process.exitCode ? '未完成' : '通过';
  save('run.json', report);
  console.log(JSON.stringify(report, null, 2), runDir);
 }
}
