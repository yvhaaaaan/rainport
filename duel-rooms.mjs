import {createHash, randomBytes, randomInt} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as currentRules from './fabric/chaincode/verifiers/individual-v1.mjs';
const {classified, MAX_INPUTS, MAX_STEPS, STEP_MS, validCapacity, validControls} = currentRules;
// Published two-player verifier from release 61e1379. Never execute arbitrary
// programs discovered in a mutable race directory, even if referenced by a saved race.
export const legacyDuelHash = '9d8474c1eb4dc6acd8b9b197e6fc3dc0d0f1806ffe0e2698753473d3c1134dd8';

// The browser hashes and imports these exact bytes. Bundle all transitive physics
// dependencies so updating a car model cannot silently change a locked replay.
export async function loadDuelVerifier(directory) {
  const official = new URL('./fabric/chaincode/verifiers/individual-v1.mjs', import.meta.url);
  const source = fs.readFileSync(fileURLToPath(official), 'utf8');
  const legacyPrograms = new Map();
  if (directory) {
    const file = path.join(directory,'verifiers',legacyDuelHash+'.mjs');
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      if (createHash('sha256').update(bytes).digest('hex') === legacyDuelHash) {
        legacyPrograms.set(legacyDuelHash, await import('data:text/javascript;base64,'+bytes.toString('base64')));
      }
    }
  }
  return {source, hash: createHash('sha256').update(source).digest('hex'), legacyPrograms};
}

const GRACE_MS = 45000;
const IDLE_CONTROL_MS = 6000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createDuelRooms({start, dir, verifierHash, legacyPrograms = new Map(), now = Date.now}) {
  const rooms = new Map(), worlds = new Map(), starting = new Map();
  const storage = dir && path.join(dir, 'duel-rooms');
  const filename = code => path.join(storage, code + '.json');
  if (storage) {
    fs.mkdirSync(storage, {recursive: true});
    for (const name of fs.readdirSync(storage)) {
      if (!/^[A-Z2-9]{6}\.json$/.test(name)) continue;
      const room = JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8'));
      if (room.code + '.json' !== name) throw Error('保存的房间码无效');
      room.capacity ??= 2; // Rooms saved before 3- and 4-seat races had two seats.
      room.withdrawals ??= Array(room.capacity).fill(null);
      room.automatic ??= Array.from({length:room.capacity}, () => []);
      rooms.set(room.code, room);
    }
  }
  function persist(room) {
    if (!storage) return;
    const dest = filename(room.code);
    fs.writeFileSync(dest + '.tmp', JSON.stringify(room));
    fs.renameSync(dest + '.tmp', dest);
  }
  function rulesFor(manifest) {
    if (!verifierHash || manifest.verifierHash === verifierHash) return currentRules;
    if (!manifest.finishPolicy && manifest.players.length === 2 && manifest.verifierHash === legacyDuelHash)
      return legacyPrograms.get(legacyDuelHash);
  }
  function worldOf(room) {
    if (!worlds.has(room.code)) worlds.set(room.code, rulesFor(room.manifest).createDuelWorld(room.manifest));
    return worlds.get(room.code);
  }
  function close(room, reason) {
    room.phase = 'closed';
    room.reason = reason;
    room.closedAt = now();
    worlds.delete(room.code);
    persist(room);
  }
  function advance(room) {
    const wall = now();
    if (room.phase === 'waiting') {
      if (wall - room.seen[0] >= GRACE_MS) close(room, '房主已离线，房间已关闭');
      else {
        for (let i = room.seen.length-1; i > 0; i--) {
          if (wall - room.seen[i] >= GRACE_MS) removeWaitingGuest(room, i);
        }
      }
      return;
    }
    if (room.phase === 'starting' && !starting.has(room.code) && wall - Math.max(...room.seen) >= 600000)
      close(room, '发车登记超时，本场已关闭');
    if (room.phase !== 'racing') return;
    const rules = rulesFor(room.manifest);
    if (!rules) {
      close(room, '无法取得本场已锁定的验证程序，本场已关闭');
      return;
    }
    const world = worldOf(room);
    const stepAt = ms => Math.min(MAX_STEPS, Math.max(0, Math.floor((ms - room.startMs) / STEP_MS)));
    const simulate = t => rules.advanceDuel(world, room.logs, Math.max(world.step, stepAt(t)), room.withdrawals);
    const grace = world.individual ? IDLE_CONTROL_MS : GRACE_MS;
    const deadlines = room.seen.map((seen, i) => ({at: seen + grace, i})).sort((a,b) => a.at-b.at);
    for (const {at, i} of deadlines) {
      if (at > wall || classified(world.cars[i])) continue;
      simulate(at);
      if (classified(world.cars[i])) continue;
      if (!world.individual) { close(room, '车手断线超过 45 秒，本场已关闭'); return; }
      const log = room.logs[i], last = log.at(-1);
      if (last && last.slice(2).some(Boolean)) {
        // Stop a disconnected controller at the exact same step on replay.
        // Keep transport acknowledgements independent of automatic releases.
        log.push([log.length+1, world.step, 0, 0, 0]);
        room.automatic[i].push(log.length);
        persist(room);
      }
    }
    simulate(wall);
    if (world.cars.every(classified)) {
      room.phase = 'review';
      room.finished = rules.duelFrame(world);
      worlds.delete(room.code);
      persist(room);
    } else if (world.step === MAX_STEPS) close(room, '超过四分钟完赛时限，本场已关闭');
  }
  function sweep() {
    for (const room of rooms.values()) {
      advance(room);
      if (room.phase === 'closed' && now() - room.closedAt >= RETENTION_MS) {
        rooms.delete(room.code);
        if (storage) fs.rmSync(filename(room.code), {force: true});
      }
    }
  }
  function member(room, id) { return room.players.findIndex(p => p.id === id); }
  function removeWaitingGuest(room, i) {
    room.players.splice(i, 1);
    room.seen.splice(i, 1);
    persist(room);
  }
  function byCode(code) {
    const room = rooms.get(String(code).trim().toUpperCase());
    if (!room) throw Error('房间码无效或已过期');
    advance(room);
    return room;
  }
  function requireSeat(id, code) {
    const room = byCode(code), i = member(room, id);
    if (i < 0 || room.left.includes(id)) throw Error('当前车手不在这个房间');
    return room;
  }
  function latest(id) {
    let found = null;
    for (const room of rooms.values()) {
      if (member(room, id) < 0 || room.left.includes(id)) continue;
      advance(room);
      if (member(room, id) < 0) continue; // A disconnected guest may just have lost their waiting seat.
      if (!found || found.phase === 'closed' || room.phase !== 'closed') found = room;
    }
    return found;
  }
  function frame(room, id, touch = true) {
    const i = member(room, id), wall = now();
    if (touch && ['waiting', 'racing'].includes(room.phase)) {
      room.seen[i] = wall;
      // Persist heartbeats periodically; every accepted input is written before it is acknowledged.
      if (wall - (room.checkpoint || 0) >= 2000) { room.checkpoint = wall; persist(room); }
    }
    const snapshot = {code: room.code, capacity: room.capacity, phase: room.phase, id: room.id, serverMs: wall,
      members: room.players.map(p => p.id), connected: room.seen.map((t,seat) =>
        !room.left.includes(room.players[seat].id) && wall - t < IDLE_CONTROL_MS),
      startMs: room.startMs, manifest: room.manifest, automaticCount:room.automatic[i]?.length || 0,
      received: (room.logs[i]?.length || 0) - (room.automatic[i]?.length || 0)};
    if (room.manifest?.finishPolicy === 'individual-v1') snapshot.withdrawals = room.withdrawals;
    if (room.phase === 'racing') Object.assign(snapshot, rulesFor(room.manifest).duelFrame(worldOf(room)));
    if (room.phase === 'review') Object.assign(snapshot, room.finished, {log: room.logs[i], automatic:room.automatic[i]});
    if (room.reason) snapshot.reason = room.reason;
    return structuredClone(snapshot);
  }
  function newSeat(id, carId) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(carId) || carId < 0)
      throw Error('车手或底盘编号无效');
    return {id, carId};
  }
  function makeRoom(player, quick, capacity) {
    let code;
    do { code = Array.from({length: 6}, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
    const room = {code, quick, capacity, phase: 'waiting', id: '0x' + randomBytes(32).toString('hex'),
      seed: randomBytes(4).readUInt32BE(), players: [player], seen: [now()],
      logs: Array.from({length:capacity}, () => []), automatic: Array.from({length:capacity}, () => []),
      withdrawals: Array(capacity).fill(null), left: []};
    rooms.set(code, room);
    persist(room);
    return frame(room, player.id);
  }
  async function launch(room) {
    if (room.phase !== 'starting') return;
    if (!starting.has(room.code)) {
      const opening = (async () => {
        const manifest = await start({id: room.id, code:room.code, seed: room.seed, players: structuredClone(room.players)});
        const rules = rulesFor(manifest);
        if (!rules || manifest.id !== room.id || manifest.seed !== room.seed || manifest.players.length !== room.capacity ||
            manifest.players.some((p,i) => p.id !== room.players[i].id || p.config[0] !== room.players[i].carId))
          throw Error('链上参赛名单或配置与房间不一致');
        const world = rules.createDuelWorld(manifest);
        if (room.phase !== 'starting') return;
        room.manifest = manifest;
        room.startMs = now() + 3000;
        room.seen = room.players.map(() => now());
        room.phase = 'racing';
        worlds.set(room.code, world);
        persist(room);
      })();
      starting.set(room.code, opening);
      try { await opening; } finally { starting.delete(room.code); }
    } else await starting.get(room.code);
  }
  function existing(id) {
    const room = latest(id);
    return room?.phase !== 'closed' ? room : null;
  }
  function checkCapacity(capacity, current) {
    if (!validCapacity(capacity)) throw Error('房间需要 2 至 4 名真人车手');
    if (current && current.capacity !== capacity) throw Error('请先退出当前房间，再选择其他人数');
  }
  async function join(id, code, carId) {
    const player = newSeat(id, carId), room = byCode(code), current = existing(id);
    if (current && current !== room) throw Error('请先退出当前房间');
    if (member(room, id) === -1) {
      if (room.phase !== 'waiting') throw Error('房间已满或已关闭');
      room.players.push(player);
      room.seen.push(now());
      if (room.players.length === room.capacity) room.phase = 'starting';
      persist(room);
    } else if (room.left.includes(id)) throw Error('已退出这个房间');
    await launch(room);
    return frame(room, id);
  }
  async function match(id, carId, capacity = 2) {
    const player = newSeat(id, carId), current = existing(id);
    checkCapacity(capacity, current);
    if (current) { await launch(current); return frame(current, id); }
    for (const room of rooms.values()) {
      if (!room.quick || room.capacity !== capacity || room.phase !== 'waiting') continue;
      advance(room);
      if (room.phase === 'waiting') return join(id, room.code, carId);
    }
    return makeRoom(player, true, capacity);
  }
  function drive(id, code, changes) {
    const room = requireSeat(id, code), i = member(room, id);
    if (room.phase !== 'racing') return frame(room, id);
    const world = worldOf(room);
    if (classified(world.cars[i])) return frame(room, id);
    if (!Array.isArray(changes) || changes.length > 64) throw Error('驾驶输入批次无效');
    const log = room.logs[i], automatic = room.automatic[i], pending = [];
    const acknowledged = log.length - automatic.length;
    for (const event of changes) {
      if (!Array.isArray(event) || event.length !== 4 || !Number.isSafeInteger(event[0]) ||
          event[0] < 1 || event[0] > MAX_INPUTS || !validControls(event.slice(1))) throw Error('驾驶输入无效');
      const [seq, ...keys] = event;
      let prior;
      if (seq <= acknowledged) {
        // Find the original player input in a transcript that may also contain neutral releases.
        let position = seq;
        for (const release of automatic) {
          if (release > position) break;
          position++;
        }
        prior = log[position-1];
      } else prior = pending[seq-acknowledged-1];
      if (prior) {
        if (!keys.every((v, k) => prior[k+2] === v)) throw Error('输入序号与已确认记录冲突');
      } else {
        if (seq !== acknowledged + pending.length + 1) throw Error('请从最后确认的序号重发输入');
        const position = log.length + pending.length + 1;
        if (position > MAX_INPUTS || (world.individual && position === MAX_INPUTS && keys.some(Boolean)))
          throw Error('本场驾驶输入数量已达上限');
        pending.push([position, world.step, ...keys]);
      }
    }
    if (pending.length) {
      log.push(...pending);
      room.seen[i] = now();
      persist(room);
    }
    return frame(room, id);
  }
  return {
    create(id, carId, capacity = 2) {
      const player = newSeat(id, carId), current = existing(id);
      checkCapacity(capacity, current);
      return current ? frame(current, id) : makeRoom(player, false, capacity);
    }, join, match, drive, sweep,
    async poll(id, code) {
      const room = requireSeat(id, code);
      await launch(room);
      return frame(room, id);
    },
    current(id) { const room = latest(id); return room ? frame(room, id) : null; },
    records(id, code) {
      const room = requireSeat(id, code);
      if (room.phase !== 'review') throw Error('仍有车手尚未完赛');
      return structuredClone(room.logs);
    },
    phase(code) {
      const room = rooms.get(String(code).trim().toUpperCase());
      if (room) advance(room);
      return room?.phase ?? null;
    },
    codeFor(id) {
      for (const room of rooms.values()) if (room.id === id) return room.code;
      return null;
    },
    evidence(code) {
      const room = rooms.get(String(code).trim().toUpperCase());
      if (room) advance(room);
      if (!room?.finished) return null;
      return structuredClone({id:room.id, logs:room.logs, withdrawals:room.withdrawals});
    },
    withdraw(id, code) {
      const room = byCode(code), i = member(room, id);
      if (i < 0 || room.manifest?.finishPolicy !== 'individual-v1') throw Error('本场不支持该车手个人退赛');
      if (room.phase === 'racing') {
        const world = worldOf(room);
        if (!classified(world.cars[i])) {
          room.withdrawals[i] = {id, step:world.step};
          persist(room);
          advance(room);
        }
      }
      return frame(room, id, false);
    },
    leave(id, code) {
      const room = requireSeat(id, code);
      if (starting.has(room.code)) throw Error('链上发车正在确认，请稍后重试');
      if (room.phase === 'waiting' && member(room, id) > 0) {
        removeWaitingGuest(room, member(room, id));
        return {code: room.code, phase: 'closed'};
      }
      if (room.phase === 'racing' && room.manifest.finishPolicy === 'individual-v1') {
        if (!classified(worldOf(room).cars[member(room,id)])) throw Error('请先签名退赛再离开房间');
      } else if (room.phase !== 'closed' && room.phase !== 'review') close(room, '车手退出，本场已关闭');
      room.left.push(id);
      if (room.phase === 'review' && room.left.length === room.capacity) close(room, '赛后查看已结束');
      persist(room);
      return {code: room.code, phase: 'closed'};
    },
    complete(id, code) {
      const room = requireSeat(id, code);
      if (room.phase !== 'closed') close(room, '赛事已结束');
      return frame(room, id, false);
    }
  };
}
