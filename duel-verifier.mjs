import {L, botD, botX, newRun, tick} from './physics.mjs';

export const STEP_MS = 10;
export const MAX_STEPS = 24000;
export const MAX_INPUTS = 8192;
const AI_NAMES = ['云岬', '沙鸥', '余烬', '许澜', '浅滩', '冬青'];
const GRID_LANES = [-0.35, 0.35];

export function validControls(keys) {
  return Array.isArray(keys) && keys.length === 3 && [0, 1].includes(keys[0]) &&
    [0, 1].includes(keys[1]) && [-1, 0, 1].includes(keys[2]);
}

function validateManifest(m) {
  if (!m || !/^0x[0-9a-f]{64}$/.test(m.id) || !/^[0-9a-f]{64}$/.test(m.verifierHash) ||
      m.physicsVersion !== 4 || m.stepMs !== STEP_MS || !Number.isInteger(m.seed) ||
      m.seed < 0 || m.seed > 0xffffffff || m.initial?.step !== 0 ||
      m.initial?.lanes?.length !== 2 || GRID_LANES.some((x, i) => x !== m.initial.lanes[i]) ||
      !Array.isArray(m.players) || m.players.length !== 2) throw Error('无法识别本场发车规则');
  for (const player of m.players) {
    if (!player || typeof player.id !== 'string' || !player.id || !Array.isArray(player.config) ||
        player.config.length !== 4 || !player.config.every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Array.isArray(player.spec) || player.spec.length !== 3 ||
        player.spec.some((model, i) => ![i*2+1, i*2+2].includes(model))) throw Error('发车配置无效');
  }
  if (m.players[0].id === m.players[1].id) throw Error('参赛车手重复');
}

export function createDuelWorld(manifest) {
  validateManifest(manifest);
  // newRun selects the prerecorded AI profiles from the last four seed digits.
  const gridSeed = ((manifest.seed >>> 16) ^ (manifest.seed & 0xffff)).toString(16).padStart(4, '0');
  const cars = manifest.players.map(({id, config, spec}, i) => {
    const car = newRun(0, gridSeed, id, config, spec, manifest.physicsVersion);
    car.x = manifest.initial.lanes[i];
    car.bots.length = AI_NAMES.length;
    car.rivalDelay.length = AI_NAMES.length;
    return car;
  });
  return {step: 0, cars, cursors: [0, 0], delays: AI_NAMES.map(() => 0)};
}

// An input stamped n is effective before the integration from step n to n+1.
export function advanceDuel(world, logs, targetStep) {
  if (!Number.isSafeInteger(targetStep) || targetStep < world.step || targetStep > MAX_STEPS)
    throw Error('模拟步无效');
  while (world.step < targetStep && !world.cars.every(car => car.done)) {
    for (const [index, car] of world.cars.entries()) {
      const log = logs[index];
      while (world.cursors[index] < log.length && log[world.cursors[index]][1] === world.step) {
        if (car.done) throw Error('记录包含完赛后的输入');
        car.keys = log[world.cursors[index]++].slice(2);
      }
      if (!car.done) {
        // Both cars see the same six rivals at the beginning of this tick.
        car.rivalDelay = [...world.delays];
        tick(car, STEP_MS / 1000);
        car.trace.length = 0;
      }
    }
    for (let i = 0; i < world.delays.length; i++)
      world.delays[i] = Math.max(world.cars[0].rivalDelay[i], world.cars[1].rivalDelay[i]);
    world.step++;
  }
  return world;
}

export function duelFrame(world) {
  const seconds = world.step * STEP_MS / 1000;
  const bots = world.cars[0].bots.map((profile, index) => {
    const t = Math.max(0, seconds - world.delays[index]);
    const d = botD(t, profile), totalMs = Math.round((profile[0] + profile[1] + world.delays[index]) * 1000);
    return {id: 'ai-' + (index + 1), name: AI_NAMES[index], d, x: botX(t, profile, index),
      v: (botD(t + 0.01, profile) - d) / 0.01, done: d >= L, totalMs};
  });
  const drivers = world.cars.map(car => ({
    id: car.driver, d: car.d, x: car.x, v: car.v, t: car.t, yaw: car.yaw, steer: car.steer,
    gear: car.gear, rpm: car.rpm, done: car.done, totalMs: car.done ? Math.round(car.sectors[1] * 1000) : null
  }));
  // Stable grid order breaks a millisecond tie (and a live distance tie).
  const grid = [...drivers, ...bots];
  grid.sort((a, b) => Number(b.done) - Number(a.done) || (a.done ? a.totalMs - b.totalMs : b.d - a.d));
  grid.forEach((car, i) => { car.rank = i + 1; });
  return {step: world.step, drivers, bots};
}

export function verifyDuel(manifest, logs) {
  if (!Array.isArray(logs) || logs.length !== 2) throw Error('双方驾驶记录不齐全');
  for (const log of logs) {
    if (!Array.isArray(log) || log.length > MAX_INPUTS) throw Error('驾驶记录长度无效');
    let lastStep = 0;
    log.forEach((event, index) => {
      if (!Array.isArray(event) || event.length !== 5 || event[0] !== index + 1 ||
          !Number.isSafeInteger(event[1]) || event[1] < lastStep || event[1] >= MAX_STEPS ||
          !validControls(event.slice(2))) throw Error('驾驶记录序号、模拟步或输入无效');
      lastStep = event[1];
    });
  }
  const world = createDuelWorld(manifest);
  advanceDuel(world, logs, MAX_STEPS);
  if (!world.cars.every(car => car.done)) throw Error('至少一名车手未在限时内完赛');
  if (world.cursors.some((cursor, i) => cursor !== logs[i].length)) throw Error('记录包含完赛后的输入');
  return duelFrame(world).drivers.map(({id, rank, totalMs}) => ({id, rank, totalMs}));
}
