import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createDuelRooms, legacyDuelHash, loadDuelVerifier} from './duel-rooms.mjs';
import {createDuelWorld, duelFrame, startingLanes, verifyDuel} from './duel-verifier.mjs';

const official = await loadDuelVerifier(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rainport-duel-check-'));
let wall = 1700000000000, failsOnce = true, individual = false;
const starts = [];
async function start({id, seed, players}) {
  starts.push(id);
  if (failsOnce) { failsOnce = false; throw Error('模拟提交后回执丢失'); }
  return {id, seed, physicsVersion: 4, verifierHash: official.hash, stepMs: 10,
    ...(individual ? {finishPolicy:'individual-v1'} : {}),
    initial: {step: 0, lanes: startingLanes(players.length)},
    players: players.map(({id, carId}) => ({id, config: [carId, 0, 0, 0], spec: [1,3,5]}))};
}
const openService = () => createDuelRooms({dir, verifierHash: official.hash, start, now: () => wall});

// Run the content-addressed ES module in each requested browser, including hash
// verification and module import from a blob as the real client does.
async function browserCheck(executable, fixtures) {
  const profile = fs.mkdtempSync(path.join(dir, 'browser-'));
  const {promise, resolve, reject} = Promise.withResolvers();
  const page = '<script type="module">' + [
    'try {',
    'const fixtures = await (await fetch("/fixture")).json();',
    'const bytes = await (await fetch("/verifier")).arrayBuffer();',
    'const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));',
    'const hash = Array.from(sum,x=>x.toString(16).padStart(2,"0")).join("");',
    'if (fixtures.some(f=>f.manifest.verifierHash!==hash)) throw Error("验证程序哈希不同");',
    'const url = URL.createObjectURL(new Blob([bytes], {type:"text/javascript"}));',
    'const {verifyDuel} = await import(url);',
    'const result = fixtures.map(f=>verifyDuel(f.manifest, f.logs, f.withdrawals));',
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
    else if (req.url === '/fixture') res.end(JSON.stringify(fixtures.map(({manifest,logs,withdrawals}) => ({manifest,logs,withdrawals}))));
    else { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(page); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--no-default-browser-check', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port],
    {windowsHide:true, stdio:'ignore'});
  browser.once('error', reject);
  const timer = setTimeout(() => reject(Error('浏览器复算超时')), 30000);
  try { assert.deepEqual(await promise, fixtures.map(f=>f.expected)); }
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
  const fixtures = [{manifest:state.manifest, logs, expected}];
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
  assert.throws(() => rooms.create('invalid', 0, 5), /2 至 4/);
  await assert.rejects(rooms.match('invalid', 0, '3'), /2 至 4/);
  individual = true;

  // Start both queues together. A partially filled 3-seat room may never absorb a 4-seat request.
  const triples = await rooms.match('three-0',0,3);
  const quads = await rooms.match('four-0',0,4);
  assert.notEqual(triples.code, quads.code);
  await assert.rejects(rooms.match('three-0',0,4), /退出当前房间/);
  const partial = await rooms.match('four-1',0,4);
  assert.equal(partial.code, quads.code);
  assert.equal(partial.phase, 'waiting');
  rooms.leave('four-1', quads.code);
  assert.deepEqual(rooms.current('four-0').members, ['four-0']);
  for (const [capacity, name] of [[3,'three'],[4,'four']]) {
    const host = name+'-0';
    const room = (await rooms.match(host,0,capacity));
    const ids = Array.from({length:capacity}, (_,i)=>name+'-'+i);
    const priorStarts = starts.length;
    assert.equal(room.capacity, capacity);
    for (const guest of ids.slice(1,-1)) {
      const joined = await rooms.match(guest,0,capacity);
      assert.equal(joined.code, room.code);
      assert.equal(joined.phase, 'waiting');
      assert.equal(joined.manifest, undefined);
    }
    assert.equal(starts.length, priorStarts);
    rooms = openService();
    const last = ids.at(-1);
    const racing = await rooms.join(last,room.code,0);
    assert.deepEqual(racing.members,ids);
    assert.equal(racing.phase,'racing');
    assert.equal(racing.bots.length,8-capacity);
    assert.equal(starts.length,priorStarts+1);
    await assert.rejects(rooms.join('extra',room.code,0), /房间已满/);
    for (const [i,id] of ids.entries()) {
      wall = racing.startMs + 10*i;
      rooms.drive(id,room.code,[[1,1,0,0]]);
    }
    rooms = openService();
    let final;
    for (let step=0; step<45; step++) {
      wall+=3000;
      for (const id of ids) final=await rooms.poll(id,room.code);
      if (final.phase==='review') break;
    }
    assert.equal(final.phase,'review');
    const inputs=rooms.records(host,room.code);
    assert.deepEqual(inputs, ids.map((_,i)=>[[1,i,1,0,0]]));
    const results=final.drivers.map(({id,rank,totalMs})=>({id,rank,totalMs}));
    assert.deepEqual(verifyDuel(final.manifest,inputs,final.withdrawals),results);
    assert.deepEqual([...final.drivers,...final.bots].map(x=>x.rank).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);
    assert.throws(()=>verifyDuel(final.manifest,inputs.slice(1)), /记录不齐全/);
    const tie=createDuelWorld(final.manifest);
    for (const car of tie.cars) {car.done=true;car.sectors=[0.5,1];}
    assert.deepEqual(duelFrame(tie).drivers.map(d=>d.rank),ids.map((_,i)=>i+1));
    for (const id of ids.slice(0,-1)) {
      rooms.leave(id,room.code);
      assert.equal(rooms.current(last).phase,'review');
    }
    fixtures.push({manifest:final.manifest,logs:inputs,withdrawals:final.withdrawals,expected:results});
    rooms.leave(last,room.code);
  }
  // The member who owns the code retires. Their departure must not block
  // a finisher, a reconnecting driver, or publication of the official inputs.
  const ids=['retired','offline','reconnected','finisher'];
  const mixed=rooms.create(ids[0],0,4);
  let opening;
  for (const id of ids.slice(1)) opening=await rooms.join(id,mixed.code,0);
  const code=mixed.code;
  assert.equal(rooms.phase(code),'racing');
  assert.equal(rooms.codeFor(opening.id),code);
  assert.equal(rooms.evidence(code),null);
  assert.equal(rooms.evidence('ABSENT'),null);
  assert.throws(()=>rooms.leave(ids[0],code), /签名退赛/);
  wall=opening.startMs;
  for (const id of ids) rooms.drive(id,code,[[1,1,0,0]]);
  wall+=500;
  const retirement=rooms.withdraw(ids[0],code);
  assert.deepEqual(retirement.withdrawals,[{id:ids[0],step:50},null,null,null]);
  assert.equal(retirement.drivers[0].dnfStep,50);
  assert.equal(retirement.drivers[0].rank,null);
  assert.equal(rooms.drive(ids[0],code,[[2,0,1,0]]).received,1);
  rooms.leave(ids[0],code);
  assert.deepEqual(rooms.withdraw(ids[0],code).withdrawals,retirement.withdrawals);
  rooms=openService();
  assert.equal(rooms.codeFor(opening.id),code);
  wall+=4500;
  await rooms.poll(ids[3],code);
  wall+=1010;
  const offline=await rooms.poll(ids[3],code);
  assert.equal(offline.phase,'racing');
  assert.equal(offline.drivers[1].dnfStep,null);
  assert.equal(offline.connected[1],false);
  // The automatic neutral event has a transcript index but no client input number.
  assert.equal(rooms.drive(ids[2],code,[[1,1,0,0],[2,1,0,0]]).received,2);
  for (let i=0; i<82 && rooms.phase(code)!=='review'; i++) {
    wall+=3000;
    await rooms.poll(ids[2],code); await rooms.poll(ids[3],code);
  }
  const final=await rooms.poll(ids[3],code), evidence=rooms.evidence(code);
  assert.equal(final.phase,'review');
  assert.deepEqual((await rooms.poll(ids[2],code)).automatic,[2]);
  assert.deepEqual(evidence.logs[1],[[1,0,1,0,0],[2,600,0,0,0]]);
  assert.deepEqual(evidence.logs[2],[[1,0,1,0,0],[2,600,0,0,0],[3,601,1,0,0]]);
  const results=verifyDuel(final.manifest,evidence.logs,evidence.withdrawals);
  assert.deepEqual(results.slice(0,2),[
    {id:ids[0],rank:null,totalMs:null,dnfStep:50},
    {id:ids[1],rank:null,totalMs:null,dnfStep:24000}
  ]);
  for (const i of [2,3]) assert.deepEqual(results[i],{id:ids[i],rank:final.drivers[i].rank,totalMs:final.drivers[i].totalMs});
  assert.throws(()=>verifyDuel(final.manifest,evidence.logs,[{id:ids[3],step:50},null,null,null]),/退赛记录/);
  assert.throws(()=>verifyDuel(final.manifest,evidence.logs,[...evidence.withdrawals.slice(0,-1),{id:ids[3],step:23999}]),/晚于/);
  fixtures.push({manifest:final.manifest,...evidence,expected:results});

  const early=rooms.create('quit-one',0);
  const earlyStart=await rooms.join('quit-two',early.code,0);
  assert.equal(rooms.withdraw('quit-one',early.code).phase,'racing');
  assert.equal(rooms.withdraw('quit-two',early.code).phase,'review');
  const noFinish=rooms.evidence(early.code);
  const noFinishResults=verifyDuel(earlyStart.manifest,noFinish.logs,noFinish.withdrawals);
  assert.deepEqual(noFinishResults,['quit-one','quit-two'].map(id=>({id,rank:null,totalMs:null,dnfStep:0})));
  fixtures.push({manifest:earlyStart.manifest,...noFinish,expected:noFinishResults});
  // A finished pre-capacity room remains available after an upgrade with its original verifier hash.
  const oldSave=path.join(dir,'duel-rooms',invite.code+'.json');
  const saved=JSON.parse(fs.readFileSync(oldSave,'utf8'));
  delete saved.capacity;
  saved.phase='review'; saved.left=[]; saved.finished={step:state.step,drivers:state.drivers,bots:state.bots};
  saved.manifest.verifierHash='a'.repeat(64);
  fs.writeFileSync(oldSave,JSON.stringify(saved));
  rooms=openService();
  const oldReview=await rooms.poll('A',invite.code);
  assert.equal(oldReview.capacity,2);
  assert.equal(oldReview.manifest.verifierHash,saved.manifest.verifierHash);
  assert.deepEqual(rooms.records('A',invite.code),logs);
  // Supply the previously deployed verifier to exercise an in-flight upgrade
  // using the original distributed bytes, independent of this checkout.
  if (process.env.RAINPORT_LEGACY_VERIFIER) {
    const archiveDir=path.join(dir,'verifiers'), legacyCode='QAX234';
    fs.mkdirSync(archiveDir,{recursive:true});
    const archive=path.join(archiveDir,legacyDuelHash+'.mjs');
    fs.copyFileSync(process.env.RAINPORT_LEGACY_VERIFIER,archive);
    const installed=await loadDuelVerifier(dir);
    const priorRules=installed.legacyPrograms.get(legacyDuelHash);
    assert(priorRules,'提供的验证程序与已发布的旧版摘要不一致');
    const manifest={...state.manifest,id:'0x'+'6'.repeat(64),verifierHash:legacyDuelHash,
      players:state.manifest.players.map((p,i)=>({...p,id:'legacy-'+i}))};
    const seats=manifest.players.map(p=>({id:p.id,carId:p.config[0]}));
    const legacy={code:legacyCode,quick:false,phase:'racing',id:manifest.id,seed:manifest.seed,
      players:seats,seen:[wall,wall],logs:[[[1,0,1,0,0]],[[1,0,1,0,0]]],left:[],manifest,startMs:wall-1000};
    const store=path.join(dir,'duel-rooms',legacyCode+'.json');
    fs.writeFileSync(store,JSON.stringify(legacy));
    rooms=createDuelRooms({dir,start,verifierHash:official.hash,legacyPrograms:installed.legacyPrograms,now:()=>wall});
    let recovered=await rooms.poll(seats[0].id,legacyCode);
    assert.equal(recovered.phase,'racing');
    assert.equal(recovered.step,100);
    assert.equal(recovered.capacity,2);
    assert.equal(recovered.manifest.verifierHash,legacyDuelHash);
    for(let i=0;i<13&&recovered.phase==='racing';i++) {
      wall+=10000;
      recovered=await rooms.poll(seats[0].id,legacyCode); await rooms.poll(seats[1].id,legacyCode);
    }
    assert.equal(recovered.phase,'review');
    assert.deepEqual(priorRules.verifyDuel(manifest,rooms.records(seats[0].id,legacyCode)),
      recovered.drivers.map(({id,rank,totalMs})=>({id,rank,totalMs})));
    fs.appendFileSync(archive,'\n');
    assert.equal((await loadDuelVerifier(dir)).legacyPrograms.size,0);
    console.log('旧双人房按原始签名版本恢复发车进度并完赛，损坏的归档不可载入。');
  }
  for (const executable of process.argv.slice(2)) {
    await browserCheck(executable, fixtures);
    console.log(path.basename(executable) + ' 2 / 3 / 4 人复算一致');
  }
  console.log('2–4 人房间、按人数快速匹配、重试与断线、日志持久化、八车名次及整数毫秒复算通过。');
} finally {
  fs.rmSync(dir, {recursive: true, force: true, maxRetries: 6, retryDelay: 200});
}
