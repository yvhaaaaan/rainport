import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createDuelRooms, loadDuelVerifier} from './duel-rooms.mjs';
import {verifyDuel} from './duel-verifier.mjs';

const official = await loadDuelVerifier(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rainport-duel-check-'));
let wall = 1700000000000, failsOnce = true;
const starts = [];
async function start({id, seed, players}) {
  starts.push(id);
  if (failsOnce) { failsOnce = false; throw Error('模拟提交后回执丢失'); }
  return {id, seed, physicsVersion: 4, verifierHash: official.hash, stepMs: 10,
    initial: {step: 0, lanes: [-0.35, 0.35]},
    players: players.map(({id, carId}) => ({id, config: [carId, 0, 0, 0], spec: [1,3,5]}))};
}
const openService = () => createDuelRooms({dir, verifierHash: official.hash, start, now: () => wall});

// Run the content-addressed ES module in each requested browser, including hash
// verification and module import from a blob as the real client does.
async function browserCheck(executable, manifest, logs, expected) {
  const profile = fs.mkdtempSync(path.join(dir, 'browser-'));
  const {promise, resolve, reject} = Promise.withResolvers();
  const page = '<script type="module">' + [
    'try {',
    'const fixture = await (await fetch("/fixture")).json();',
    'const bytes = await (await fetch("/verifier")).arrayBuffer();',
    'const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));',
    'if (Array.from(sum,x=>x.toString(16).padStart(2,"0")).join("") !== fixture.manifest.verifierHash) throw Error("验证程序哈希不同");',
    'const url = URL.createObjectURL(new Blob([bytes], {type:"text/javascript"}));',
    'const {verifyDuel} = await import(url);',
    'const result = verifyDuel(fixture.manifest, fixture.logs);',
    'await fetch("/done",{method:"POST",body:JSON.stringify({result})});',
    '} catch(error) { await fetch("/done",{method:"POST",body:JSON.stringify({error:String(error)})}); }'
  ].join('\n') + '</script>';
  const server = http.createServer(async (req, res) => {
    if (req.url === '/done') {
      let body = '';
      for await (const part of req) body += part;
      const data = JSON.parse(body);
      if (data.error) reject(Error(data.error)); else resolve(data.result);
      res.end();
    } else if (req.url === '/verifier') res.end(official.source);
    else if (req.url === '/fixture') res.end(JSON.stringify({manifest, logs}));
    else { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(page); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--no-default-browser-check', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port],
    {windowsHide:true, stdio:'ignore'});
  browser.once('error', reject);
  const timer = setTimeout(() => reject(Error('浏览器复算超时')), 30000);
  try { assert.deepEqual(await promise, expected); }
  finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
    const exited = once(browser, 'exit');
    if (browser.kill()) await exited;
  }
}

try {
  let rooms = openService();
  const invite = rooms.create('A', 0);
  const queue = await rooms.match('C', 0);
  assert.notEqual(invite.code, queue.code);
  await assert.rejects(rooms.join('B', invite.code.toLowerCase(), 0), /回执/);
  rooms = openService();
  const opened = await rooms.poll('B', invite.code);
  assert.deepEqual(starts, [opened.id, opened.id]);
  assert.equal(opened.startMs, wall + 3000);
  assert.deepEqual(opened.members, ['A','B']);
  assert.equal(opened.bots.length, 6);
  assert.equal((await rooms.join('A', invite.code, 0)).startMs, opened.startMs);
  assert.throws(() => rooms.drive('outsider', invite.code, [[1,1,0,0]]), /不在/);
  assert.throws(() => rooms.records('A', invite.code), /尚未完赛/);
  assert.throws(() => rooms.drive('A', invite.code, [[2,1,0,0]]), /重发/);
  assert.throws(() => rooms.drive('A', invite.code, [[1,1,0,0],[2,0,0,7]]), /输入无效/);
  assert.equal(rooms.current('A').received, 0);
  rooms.drive('A', invite.code, [[1,1,0,0]]);
  assert.equal(rooms.drive('A', invite.code, [[1,1,0,0]]).received, 1);
  assert.throws(() => rooms.drive('A', invite.code, [[1,0,1,0]]), /冲突/);
  wall = opened.startMs + 27;
  rooms.drive('B', invite.code, [[1,1,0,0]]);
  const mobile = await rooms.poll('A', invite.code);
  assert.equal(mobile.step, 2);
  assert.ok(mobile.drivers[0].d > mobile.drivers[1].d);
  wall += 200;
  rooms.drive('A', invite.code, [[2,1,0,-1]]);
  wall += 10;
  rooms.drive('A', invite.code, [[3,1,0,0]]);
  const before = await rooms.poll('B', invite.code);
  rooms = openService();
  assert.deepEqual(await rooms.poll('B', invite.code), before);
  let state;
  for (let i=0; i<13; i++) {
    wall += 10000;
    state = await rooms.poll('A', invite.code);
    await rooms.poll('B', invite.code);
    if (state.phase === 'review') break;
  }
  assert.equal(state.phase, 'review');
  const logs = rooms.records('A', invite.code);
  assert.deepEqual(logs[0], [[1,0,1,0,0],[2,22,1,0,-1],[3,23,1,0,0]]);
  assert.deepEqual(logs[1], [[1,2,1,0,0]]);
  assert.deepEqual(state.log, logs[0]);
  const expected = state.drivers.map(({id, rank, totalMs}) => ({id, rank, totalMs}));
  assert.deepEqual(verifyDuel(state.manifest, logs), expected);
  assert.deepEqual(verifyDuel({...state.manifest, seed:123}, [[[1,0,1,0,0]],[[1,0,1,0,0]]]), [
    {id:'A',rank:6,totalMs:97851}, {id:'B',rank:7,totalMs:97936}
  ]);
  assert.throws(() => verifyDuel(state.manifest, [[],logs[1]]), /未在限时/);
  assert.throws(() => verifyDuel(state.manifest, [logs[0], [[2,0,1,0,0]]]), /序号/);
  assert.throws(() => verifyDuel(state.manifest, [[...logs[0],[4,23000,0,0,0]],logs[1]]), /完赛后/);
  rooms.leave('A', invite.code);
  assert.deepEqual(rooms.records('B', invite.code), logs);
  rooms.leave('B', invite.code);
  const matchedA = await rooms.match('A', 0), matchedB = await rooms.match('B', 0);
  assert.equal(matchedA.code, matchedB.code);
  assert.notEqual(matchedB.code, queue.code); // The old waiting player has disconnected.
  wall += 30000;
  const reconnect = await rooms.poll('A', matchedB.code);
  assert.equal(reconnect.phase, 'racing');
  assert.equal(reconnect.connected[1], false);
  wall += 16000;
  assert.equal((await rooms.poll('B', matchedB.code)).phase, 'closed');
  assert.throws(() => rooms.records('A', matchedB.code), /尚未完赛/);
  const idleA = await rooms.match('A', 0);
  await rooms.match('B', 0);
  for (let i=0; i<9; i++) {
    wall += 30000;
    await rooms.poll('A', idleA.code);
    await rooms.poll('B', idleA.code);
  }
  assert.match(rooms.current('A').reason, /四分钟/);
  for (const executable of process.argv.slice(2)) {
    await browserCheck(executable, state.manifest, logs, expected);
    console.log(path.basename(executable) + ' 复算一致');
  }
  console.log('双人房间、快速匹配、重试与断线、日志持久化、八车名次及整数毫秒复算通过。');
} finally {
  fs.rmSync(dir, {recursive: true, force: true, maxRetries: 6, retryDelay: 200});
}
