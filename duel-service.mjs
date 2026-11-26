import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import players from './fabric/chaincode/players.js';
import {createDuelRooms, loadDuelVerifier} from './duel-rooms.mjs';
import {startingLanes} from './duel-verifier.mjs';

const playerId = /^player:[a-f0-9]{64}$/;
const raceId = /^0x[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const randomToken = () => randomBytes(32).toString('hex');
const terminal = duel => ['closed', 'settled'].includes(duel.status);

export async function createDuelService(ledger, directory, atomic) {
  const {domain} = await ledger.playerDomain();
  const verifier = await loadDuelVerifier(directory);
  const rules = path.join(directory, 'verifiers');
  fs.mkdirSync(rules, {recursive:true});
  fs.writeFileSync(path.join(rules, verifier.hash + '.mjs'), verifier.source);
  const session = new Map(), challenges = new Map();
  const pendingFile = path.join(directory, 'pending-duels.json');
  const pending = new Map(fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : []);
  function savePending() {
    fs.writeFileSync(pendingFile + '.next', JSON.stringify([...pending]));
    fs.renameSync(pendingFile + '.next', pendingFile);
  }
  function forget(id) {
    if (pending.delete(id)) savePending();
  }
  const rooms = createDuelRooms({
    dir:directory,
    verifierHash:verifier.hash,
    legacyPrograms:verifier.legacyPrograms,
    async start({id, seed, code, players: entrants}) {
      // Retain the proposed manifest across an ambiguous Gateway commit.
      let entry = pending.get(id);
      if (!entry) {
        const roster = await Promise.all(entrants.map(async ({id:driver,carId}) => {
          const car = await ledger.asset(carId);
          if (car.model !== 0 || car.owner !== driver || car.parts.some(p => !p)) throw Error('请选择自己的完整赛车');
          const parts = await Promise.all(car.parts.map(p => ledger.asset(p)));
          return {id:driver, config:[carId, ...car.parts], spec:parts.map(p => p.model)};
        }));
        const manifest = {id,seed,players:roster,finishPolicy:'individual-v1',physicsVersion:4,verifierHash:verifier.hash,
          initial:{step:0,lanes:startingLanes(roster.length)},stepMs:10};
        entry = {manifest, code, deadline:0};
        pending.set(id, entry);
        savePending();
      }
      let state;
      try {
        await atomic(() => ledger.openDuel(entry.manifest));
      } catch (err) {
        // A retry may encounter the already committed race.
        try { state = await ledger.duel(id); } catch {
          if (!err.pendingTransactionId && err.reason) forget(id);
          throw err;
        }
      }
      state ??= await ledger.duel(id);
      if (terminal(state)) throw Error('该赛事已经结束');
      entry.deadline = state.deadline;
      savePending();
      return state.manifest;
    },
  });
  function track(frame) {
    const entry = pending.get(frame?.id);
    if (entry && entry.code !== frame.code) {
      entry.code = frame.code;
      savePending();
    }
    return frame;
  }
  function retire(state) {
    const {id,players} = state.manifest;
    const code = pending.get(id)?.code;
    if (state.status === 'closed' && code) {
      for (const player of players) {
        const current = rooms.current(player.id);
        if (current?.id === id && current.phase !== 'closed') { rooms.complete(player.id,code); break; }
      }
    }
    forget(id);
    return state;
  }
  async function reconcile(id) {
    let state = await ledger.duel(id);
    if (terminal(state)) return retire(state);
    const entry = pending.get(id);
    if (entry && !entry.deadline) {entry.deadline=state.deadline;savePending();}
    if (state.manifest.finishPolicy === 'individual-v1') {
      if (state.logs) { forget(id); return state; }
      const code = entry?.code || rooms.codeFor(id);
      if (code && rooms.phase(code) === 'racing') {
        for (const [i, proof] of (state.withdrawalProofs || []).entries()) {
          if (proof) rooms.withdraw(state.manifest.players[i].id, code);
        }
      }
      const evidence = code && rooms.evidence(code);
      if (evidence?.id === id) {
        if (!state.inputHashes) {
          const hashes = evidence.logs.map(log => createHash('sha256').update(JSON.stringify(log)).digest('hex'));
          await ledger.anchorDuelInputs(id, hashes, evidence.withdrawals);
        }
        await ledger.publishDuelRecords(id, evidence.logs);
      } else if (state.status === 'racing' && Date.now() >= state.deadline * 1000) {
        await ledger.expireDuel(id);
      } else return state;
    } else if (Date.now() >= state.deadline * 1000) {
      await ledger.expireDuel(id);
    } else if (!state.logs && state.commitments.every(Boolean) && entry?.code) {
      const logs = await rooms.records(state.manifest.players[0].id, entry.code);
      await ledger.revealDuel(id, logs);
    } else return state;
    state = await ledger.duel(id);
    if (state.manifest.finishPolicy === 'individual-v1' && state.logs) forget(id);
    return terminal(state) ? retire(state) : state;
  }
  function cleanTokens(map) {
    for (const [token, entry] of map) if (entry.until <= Date.now()) map.delete(token);
  }
  let sweeping = false;
  const sweep = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      cleanTokens(challenges); cleanTokens(session);
      rooms.sweep();
      for (const [id, entry] of pending) {
        if (entry.manifest.finishPolicy === 'individual-v1' || !entry.deadline || Date.now() >= entry.deadline * 1000) {
          try { await atomic(() => reconcile(id)); } catch (err) {
            if (!entry.deadline && (err.reason||err.message).includes('UnknownDuel')) {
              const room = rooms.current(entry.manifest.players[0].id);
              if (room?.id !== id || room.phase === 'closed') forget(id);
            } else console.error('联机赛果复核', err.reason || err.message);
          }
        }
      }
    } finally { sweeping = false; }
  }, 5000);
  sweep.unref();
  async function api(route, b, token) {
    if (route === 'domain') return {domain};
    if (route === 'register') {
      if (b.envelope?.action !== 'register') throw Error('注册签名无效');
      await atomic(() => ledger.playerAction(b.envelope));
      return {registered:true};
    }
    if (route === 'challenge') {
      if (!playerId.test(b.id)) throw Error('玩家身份无效');
      cleanTokens(challenges);
      if (challenges.size >= 4096) throw Error('登录请求繁忙，请稍后重试');
      const challenge = randomToken();
      challenges.set(challenge, {id:b.id, until:Date.now()+60000});
      return {challenge};
    }
    if (route === 'login') {
      const envelope = b.envelope;
      const [challenge] = envelope?.args ?? [];
      const issued = challenges.get(challenge);
      if (!issued || issued.until <= Date.now() || issued.id !== envelope.id || envelope.action !== 'login' ||
          envelope.nonce !== 0 || envelope.domain !== domain || envelope.args.length !== 1) throw Error('登录请求已失效');
      players.verifyEnvelope(envelope);
      challenges.delete(challenge);
      const player = await ledger.player(envelope.id);
      if (!player.registered || player.publicKey !== envelope.publicKey) throw Error('该签名身份尚未注册');
      const bearer = randomToken();
      session.set(bearer, {id:player.id, until:Date.now()+12*3600000});
      return {token:bearer,id:player.id};
    }
    const active = session.get(token);
    if (!active || active.until <= Date.now()) throw Error('请用本机玩家密钥重新登录');
    const id = active.id;
    if (['create','join','match'].includes(route)) {
      const current = rooms.current(id);
      if (!current || current.phase === 'closed') {
        if (!Number.isSafeInteger(b.car) || b.car < 1) throw Error('请选择参赛车辆');
        const car = await ledger.asset(b.car);
        if (car.model !== 0 || car.owner !== id || car.lock || car.busy > Date.now()/1000 || !car.parts.every(Boolean))
          throw Error('所选车辆需归你所有、装配齐全且可参赛');
      }
    }
    switch (route) {
      case 'logout': session.delete(token); return {};
      case 'player': return ledger.player(id);
      case 'inventory': {
        const [player, market] = await Promise.all([ledger.player(id),ledger.marketState()]);
        return {player, assets:market.assets.filter(a => a.owner === id),
          orders:market.orders.filter(o => o.kind <= 2 && (o.status === 1 || o.maker === id || o.buyer === id)),
          items:market.assets.filter(a => a.lock && a.model)};
      }
      case 'transfers':
        if (!Number.isSafeInteger(b.asset) || b.asset <= 0) throw Error('部件编号无效');
        return (await ledger.marketState()).transfers.filter(t => t.id === b.asset);
      case 'receipt': return ledger.receipt(b.hash);
      case 'origin': {
        const item = await ledger.asset(b.asset);
        if (!item.origin) return null;
        if (playerId.test(item.first)) return {kind:'duel',race:await ledger.duel(item.origin)};
        return {kind:'legacy',race:await ledger.race(item.origin,item.first)};
      }
      case 'info':
        if (!raceId.test(b.id)) throw Error('赛事编号无效');
        return atomic(() => reconcile(b.id));
      case 'action': {
        if (b.envelope?.id !== id || !['list','buy','close','fit','duelCommit','duelConfirm','duelRefuse','duelWithdraw'].includes(b.envelope.action)) throw Error('玩家操作无效');
        return atomic(async () => {
          const receipt = await ledger.playerAction(b.envelope);
          if (b.envelope.action.startsWith('duel')) {
            const duelId=b.envelope.args[0];
            // The receipt acknowledges the player's transaction. The steward
            // retries synchronization independently if the Gateway is interrupted.
            try {await reconcile(duelId);} catch(err){console.error('联机记录同步',err.reason||err.message);}
          }
          return receipt;
        });
      }
      case 'current': return {room:track(await rooms.current(id))};
      case 'create': return track(await rooms.create(id,b.car,b.capacity));
      case 'join': return track(await rooms.join(id,b.code,b.car));
      case 'match': return track(await rooms.match(id,b.car,b.capacity));
      case 'poll': return track(await rooms.poll(id,b.code));
      case 'drive': return rooms.drive(id,b.code,b.changes);
      case 'leave': {
        const frame = rooms.current(id);
        if (!frame || frame.code !== b.code) throw Error('当前车手不在这个房间');
        if (frame.manifest || pending.has(frame.id)) {
          let state;
          try {state = await atomic(() => reconcile(frame.id));}
          catch(err){if (frame.manifest || !(err.reason||err.message).includes('UnknownDuel')) throw err;}
          if (state && !terminal(state)) {
            const seat = state.manifest.players.findIndex(player => player.id === id);
            const finished = ['withdrawn','dnf','claimed','refused'].includes(state.playerStatus?.[seat]);
            if (!finished) throw Error('请先签名退赛，或在完赛后领取或放弃自己的奖励');
          }
        }
        await rooms.leave(id,b.code);
        return {};
      }
      default: throw Error('未知联机请求');
    }
  }
  function source(hash) {
    if (!hashPattern.test(hash)) return null;
    const file = path.join(rules,hash+'.mjs');
    if (!fs.existsSync(file)) return null;
    const bytes = fs.readFileSync(file);
    return createHash('sha256').update(bytes).digest('hex') === hash ? bytes : null;
  }
  return {api,source,stop:() => clearInterval(sweep)};
}
