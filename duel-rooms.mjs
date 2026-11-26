import {createHash, randomBytes, randomInt} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {advanceDuel, createDuelWorld, duelFrame, MAX_INPUTS, MAX_STEPS, STEP_MS, validControls} from './duel-verifier.mjs';

// The browser hashes and imports these exact bytes. Bundle all transitive physics
// dependencies so updating a car model cannot silently change a locked replay.
export async function loadDuelVerifier() {
  const {build} = await import('esbuild');
  const result = await build({absWorkingDir: path.dirname(fileURLToPath(import.meta.url)),
    entryPoints: ['duel-verifier.mjs'], bundle: true, write: false, format: 'esm',
    platform: 'browser', charset: 'utf8', legalComments: 'none'});
  const source = result.outputFiles[0].text;
  return {source, hash: createHash('sha256').update(source).digest('hex')};
}

const GRACE_MS = 45000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createDuelRooms({start, dir, verifierHash, now = Date.now}) {
  const rooms = new Map(), worlds = new Map(), starting = new Map();
  const storage = dir && path.join(dir, 'duel-rooms');
  const filename = code => path.join(storage, code + '.json');
  if (storage) {
    fs.mkdirSync(storage, {recursive: true});
    for (const name of fs.readdirSync(storage)) {
      if (!/^[A-Z2-9]{6}\.json$/.test(name)) continue;
      const room = JSON.parse(fs.readFileSync(path.join(storage, name), 'utf8'));
      if (room.code + '.json' !== name) throw Error('保存的房间码无效');
      rooms.set(room.code, room);
    }
  }
  function persist(room) {
    if (!storage) return;
    const dest = filename(room.code);
    fs.writeFileSync(dest + '.tmp', JSON.stringify(room));
    fs.renameSync(dest + '.tmp', dest);
  }
  function worldOf(room) {
    if (!worlds.has(room.code)) worlds.set(room.code, createDuelWorld(room.manifest));
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
    if (room.phase === 'waiting' && wall - room.seen[0] >= GRACE_MS)
      close(room, '房主已离线，房间已关闭');
    if (room.phase === 'starting' && !starting.has(room.code) && wall - Math.max(...room.seen) >= 600000)
      close(room, '发车登记超时，本场已关闭');
    if (room.phase !== 'racing') return;
    if (verifierHash && room.manifest.verifierHash !== verifierHash) {
      close(room, '服务器的物理版本已更新，本场已关闭');
      return;
    }
    const world = worldOf(room);
    const stepAt = ms => Math.min(MAX_STEPS, Math.max(0, Math.floor((ms - room.startMs) / STEP_MS)));
    // Simulate only through the disconnect cutoff. Late polling cannot turn a
    // stale accelerator into a finish before checking the reconnect window.
    const deadlines = room.seen.map((seen, i) => ({at: seen + GRACE_MS, i})).sort((a,b) => a.at-b.at);
    for (const {at, i} of deadlines) {
      if (at > wall || world.cars[i].done) continue;
      advanceDuel(world, room.logs, Math.max(world.step, stepAt(at)));
      if (!world.cars[i].done) { close(room, '车手断线超过 45 秒，本场已关闭'); return; }
    }
    advanceDuel(world, room.logs, Math.max(world.step, stepAt(wall)));
    if (world.cars.every(car => car.done)) {
      room.phase = 'review';
      room.finished = duelFrame(world);
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
    const snapshot = {code: room.code, phase: room.phase, id: room.id, serverMs: wall,
      members: room.players.map(p => p.id), connected: room.seen.map(t => wall - t < 6000),
      startMs: room.startMs, manifest: room.manifest, received: room.logs[i]?.length || 0};
    if (room.phase === 'racing') Object.assign(snapshot, duelFrame(worldOf(room)));
    if (room.phase === 'review') Object.assign(snapshot, room.finished, {log: room.logs[i]});
    if (room.reason) snapshot.reason = room.reason;
    return structuredClone(snapshot);
  }
  function newSeat(id, carId) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(carId) || carId < 0)
      throw Error('车手或底盘编号无效');
    return {id, carId};
  }
  function makeRoom(player, quick) {
    let code;
    do { code = Array.from({length: 6}, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
    const room = {code, quick, phase: 'waiting', id: '0x' + randomBytes(32).toString('hex'),
      seed: randomBytes(4).readUInt32BE(), players: [player], seen: [now()], logs: [[], []], left: []};
    rooms.set(code, room);
    persist(room);
    return frame(room, player.id);
  }
  async function launch(room) {
    if (room.phase !== 'starting') return;
    if (!starting.has(room.code)) {
      const opening = (async () => {
        const manifest = await start({id: room.id, seed: room.seed, players: structuredClone(room.players)});
        const world = createDuelWorld(manifest);
        if ((verifierHash && manifest.verifierHash !== verifierHash) ||
            manifest.id !== room.id || manifest.seed !== room.seed ||
            manifest.players.some((p,i) => p.id !== room.players[i].id || p.config[0] !== room.players[i].carId))
          throw Error('链上参赛名单或配置与房间不一致');
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
  async function join(id, code, carId) {
    const player = newSeat(id, carId), room = byCode(code), current = existing(id);
    if (current && current !== room) throw Error('请先退出当前房间');
    if (member(room, id) === -1) {
      if (room.phase !== 'waiting') throw Error('房间已满或已关闭');
      room.players.push(player);
      room.seen.push(now());
      room.phase = 'starting';
      persist(room);
    } else if (room.left.includes(id)) throw Error('已退出这个房间');
    await launch(room);
    return frame(room, id);
  }
  async function match(id, carId) {
    const player = newSeat(id, carId), current = existing(id);
    if (current) { await launch(current); return frame(current, id); }
    for (const room of rooms.values()) {
      if (!room.quick || room.phase !== 'waiting') continue;
      advance(room);
      if (room.phase === 'waiting') return join(id, room.code, carId);
    }
    return makeRoom(player, true);
  }
  function drive(id, code, changes) {
    const room = requireSeat(id, code), i = member(room, id);
    if (room.phase !== 'racing') return frame(room, id);
    const world = worldOf(room);
    if (world.cars[i].done) return frame(room, id);
    if (!Array.isArray(changes) || changes.length > 64) throw Error('驾驶输入批次无效');
    const log = room.logs[i], pending = [];
    for (const event of changes) {
      if (!Array.isArray(event) || event.length !== 4 || !Number.isSafeInteger(event[0]) ||
          event[0] < 1 || event[0] > MAX_INPUTS || !validControls(event.slice(1))) throw Error('驾驶输入无效');
      const [seq, ...keys] = event;
      const prior = log[seq-1] || pending[seq-1-log.length];
      if (prior) {
        if (!keys.every((v, k) => prior[k+2] === v)) throw Error('输入序号与已确认记录冲突');
      } else {
        if (seq !== log.length + pending.length + 1) throw Error('请从最后确认的序号重发输入');
        pending.push([seq, world.step, ...keys]);
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
    create(id, carId) {
      const player = newSeat(id, carId), current = existing(id);
      return current ? frame(current, id) : makeRoom(player, false);
    }, join, match, drive, sweep,
    async poll(id, code) {
      const room = requireSeat(id, code);
      await launch(room);
      return frame(room, id);
    },
    current(id) { const room = latest(id); return room ? frame(room, id) : null; },
    records(id, code) {
      const room = requireSeat(id, code);
      if (room.phase !== 'review') throw Error('两名车手尚未完赛');
      return structuredClone(room.logs);
    },
    leave(id, code) {
      const room = requireSeat(id, code);
      if (starting.has(room.code)) throw Error('链上发车正在确认，请稍后重试');
      if (room.phase !== 'closed' && room.phase !== 'review') close(room, '车手退出，本场已关闭');
      room.left.push(id);
      if (room.phase === 'review' && room.left.length === 2) close(room, '赛后查看已结束');
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
