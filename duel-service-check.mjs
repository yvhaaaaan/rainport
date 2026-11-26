import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createDuelService} from './duel-service.mjs';
import {createPlayerKey, signPlayerAction} from './player-keys.mjs';

test('登录挑战、会话与房间席位只授权给相应签名车手', async t => {
  const domain = 'rainport:session-test';
  const [alice, bob, chen] = await Promise.all([createPlayerKey(), createPlayerKey(), createPlayerKey()]);
  const profiles = new Map(), assets = new Map();
  for (const [i, driver] of [alice,bob,chen].entries()) {
    const car = 1 + i * 4, parts = [car+1, car+2, car+3];
    profiles.set(driver.id, {id:driver.id,publicKey:driver.publicKey,registered:true,starterCar:car});
    assets.set(car, {model:0,owner:driver.id,busy:0,lock:0,parts});
    parts.forEach((part, slot) => assets.set(part, {model:slot*2+1,owner:driver.id}));
  }
  let duel;
  const ledger = {
    playerDomain: () => ({domain}), player: id => profiles.get(id), asset: id => assets.get(id),
    openDuel(manifest) {
      const empty = manifest.players.map(() => null);
      duel = {manifest,status:'racing',deadline:Math.floor(Date.now()/1000)+600,commitments:[...empty],
        withdrawalProofs:[...empty],playerStatus:empty.map(() => 'racing')};
    },
    duel(id) { assert.equal(id,duel.manifest.id); return duel; },
    playerAction(envelope) {
      assert.equal(envelope.action,'duelWithdraw');
      assert.deepEqual(envelope.args,[duel.manifest.id]);
      const i = duel.manifest.players.findIndex(player => player.id === envelope.id);
      duel.withdrawalProofs[i] = {envelope};
      duel.playerStatus[i] = 'withdrawn';
      return {status:'VALID'};
    },
    anchorDuelInputs(id, hashes, withdrawals) {
      assert.equal(id,duel.manifest.id);
      assert.equal(duel.inputHashes,undefined,'重试必须使用首次锁定的摘要');
      Object.assign(duel,{inputHashes:hashes,withdrawals,status:'anchored'});
    },
    publishDuelRecords(id, logs) {
      assert.equal(id,duel.manifest.id);
      assert.equal(duel.status,'anchored');
      if (!duel.retried) { duel.retried = true; throw Error('模拟发布时网关中断'); }
      Object.assign(duel,{logs,status:'review'});
    }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rainport-session-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  let wall = Date.now();
  t.mock.method(Date,'now',() => wall);
  const service = await createDuelService(ledger, dir, fn => fn());
  t.after(() => service.stop());
  const {api} = service;
  const challenge = async key => (await api('challenge', {id:key.id})).challenge;
  const login = async (key, code, scope=domain) => api('login',
    {envelope:await signPlayerAction(key, scope, 0, 'login', [code])});

  await assert.rejects(api('create', {car:1,id:alice.id}), /重新登录/);
  const issued = await challenge(alice);
  await assert.rejects(login(bob, issued), /已失效/);
  await assert.rejects(login(alice, issued, domain+'-other'), /已失效/);
  await assert.rejects(login({...alice,privateKey:bob.privateKey}, issued), /InvalidPlayerSignature/);
  const proof = await signPlayerAction(alice, domain, 0, 'login', [issued]);
  const simultaneous = await Promise.allSettled([api('login',{envelope:proof}),api('login',{envelope:proof})]);
  const successes = simultaneous.filter(call => call.status === 'fulfilled');
  assert.equal(successes.length, 1);
  const aliceToken = successes[0].value.token;
  const bobToken = (await login(bob, await challenge(bob))).token;
  const chenToken = (await login(chen, await challenge(chen))).token;
  assert.notEqual(aliceToken, bobToken);

  const bobAction = await signPlayerAction(bob, domain, 2, 'buy', [5,40]);
  await assert.rejects(api('action', {envelope:bobAction}, aliceToken), /玩家操作无效/);
  await assert.rejects(api('create', {car:5}, aliceToken), /归你所有/);
  assert.equal((await api('current', {}, aliceToken)).room, null);
  const room = await api('create', {car:1,capacity:3}, aliceToken);
  assert.deepEqual(room.members, [alice.id]);
  await assert.rejects(api('join', {code:room.code,car:1}, bobToken), /归你所有/);
  assert.deepEqual((await api('poll', {code:room.code}, aliceToken)).members, [alice.id]);
  const drive = {code:room.code,id:alice.id,changes:[[1,1,0,0]]};
  await assert.rejects(api('drive', drive, bobToken), /不在这个房间/);
  const waiting = await api('join', {code:room.code,car:5}, bobToken);
  assert.equal(waiting.phase,'waiting');
  assert.equal(duel,undefined);
  const race = await api('join', {code:room.code,car:9}, chenToken);
  assert.equal(race.phase, 'racing');
  assert.deepEqual(race.members, [alice.id,bob.id,chen.id]);
  assert.equal(race.manifest.finishPolicy,'individual-v1');
  assert.equal((await api('drive', drive, bobToken)).received, 1);
  assert.equal((await api('poll', {code:room.code}, aliceToken)).received, 0);
  for (const [driver,token] of [[alice,aliceToken],[chen,chenToken]]) {
    const envelope = await signPlayerAction(driver,domain,2,'duelWithdraw',[race.id]);
    await api('action',{envelope},token);
    await api('leave',{code:room.code},token);
  }
  // The first seat has already left. The remaining driver's heartbeat and
  // signed-in session suffice to finish and publish the full room record.
  for (wall=race.startMs; wall<=race.startMs+240000; wall+=3000) {
    if ((await api('poll',{code:room.code},bobToken)).phase === 'review') break;
  }
  await assert.rejects(api('info',{id:race.id},bobToken),/网关中断/);
  const review = await api('info',{id:race.id},bobToken);
  assert.equal(review.status,'review');
  assert.deepEqual(review.withdrawals.map(w=>w?.id || null),[alice.id,null,chen.id]);
  assert.equal(review.logs.length,3);
  assert.deepEqual(review.commitments,[null,null,null]);
  await api('logout', {}, aliceToken);
  await assert.rejects(api('drive', drive, aliceToken), /重新登录/);
  assert.equal((await api('player', {id:alice.id}, bobToken)).id, bob.id);
});
