import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createDuelService} from './duel-service.mjs';
import {createPlayerKey, signPlayerAction} from './player-keys.mjs';

test('登录挑战、会话与房间席位只授权给相应签名车手', async t => {
  const domain = 'rainport:session-test';
  const [alice, bob] = await Promise.all([createPlayerKey(), createPlayerKey()]);
  const profiles = new Map(), assets = new Map();
  for (const [i, driver] of [alice,bob].entries()) {
    const car = 1 + i * 4, parts = [car+1, car+2, car+3];
    profiles.set(driver.id, {id:driver.id,publicKey:driver.publicKey,registered:true,starterCar:car});
    assets.set(car, {model:0,owner:driver.id,busy:0,lock:0,parts});
    parts.forEach((part, slot) => assets.set(part, {model:slot*2+1,owner:driver.id}));
  }
  let duel;
  const ledger = {
    playerDomain: () => ({domain}), player: id => profiles.get(id), asset: id => assets.get(id),
    openDuel(manifest) {
      duel = {manifest,status:'racing',deadline:Math.floor(Date.now()/1000)+600,commitments:[null,null]};
    },
    duel(id) { assert.equal(id,duel.manifest.id); return duel; },
    playerAction() { assert.fail('跨会话的签名交易不应转发到账本'); }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rainport-session-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
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
  assert.notEqual(aliceToken, bobToken);

  const bobAction = await signPlayerAction(bob, domain, 2, 'buy', [5,40]);
  await assert.rejects(api('action', {envelope:bobAction}, aliceToken), /玩家操作无效/);
  await assert.rejects(api('create', {car:5}, aliceToken), /归你所有/);
  assert.equal((await api('current', {}, aliceToken)).room, null);
  const room = await api('create', {car:1}, aliceToken);
  assert.deepEqual(room.members, [alice.id]);
  await assert.rejects(api('join', {code:room.code,car:1}, bobToken), /归你所有/);
  assert.deepEqual((await api('poll', {code:room.code}, aliceToken)).members, [alice.id]);
  const drive = {code:room.code,id:alice.id,changes:[[1,1,0,0]]};
  await assert.rejects(api('drive', drive, bobToken), /不在这个房间/);
  const race = await api('join', {code:room.code,car:5}, bobToken);
  assert.equal(race.phase, 'racing');
  assert.deepEqual(race.members, [alice.id,bob.id]);
  assert.equal((await api('drive', drive, bobToken)).received, 1);
  assert.equal((await api('poll', {code:room.code}, aliceToken)).received, 0);
  await api('logout', {}, aliceToken);
  await assert.rejects(api('drive', drive, aliceToken), /重新登录/);
  assert.equal((await api('player', {id:alice.id}, bobToken)).id, bob.id);
});
