import {L, botD, botX, newRun, tick} from './physics.mjs';

export const STEP_MS = 10;
export const MAX_STEPS = 24000;
export const MAX_INPUTS = 8192;
const AI_NAMES = ['云岬', '沙鸥', '余烬', '许澜', '浅滩', '冬青'];
const GRID_LANES = [
  [-0.35, 0.35],
  [-0.55, 0, 0.55],
  [-0.6, -0.2, 0.2, 0.6]
];

export function validCapacity(n) {
  return Number.isInteger(n) && n >= 2 && n <= 4;
}

export function startingLanes(n) {
  if (!validCapacity(n)) throw Error('房间需要 2 至 4 名真人车手');
  return [...GRID_LANES[n-2]];
}

export function validControls(keys) {
  return Array.isArray(keys) && keys.length === 3 && [0, 1].includes(keys[0]) &&
    [0, 1].includes(keys[1]) && [-1, 0, 1].includes(keys[2]);
}

function validateManifest(m) {
  if (!m || !/^0x[0-9a-f]{64}$/.test(m.id) || !/^[0-9a-f]{64}$/.test(m.verifierHash) ||
      m.physicsVersion !== 4 || m.stepMs !== STEP_MS || !Number.isInteger(m.seed) ||
      m.seed < 0 || m.seed > 0xffffffff || m.initial?.step !== 0 ||
      !Array.isArray(m.players) || !validCapacity(m.players.length) ||
      (m.finishPolicy !== undefined && m.finishPolicy !== 'individual-v1') ||
      !Array.isArray(m.initial.lanes) || m.initial.lanes.length !== m.players.length ||
      startingLanes(m.players.length).some((x, i) => x !== m.initial.lanes[i])) throw Error('无法识别本场发车规则');
  for (const player of m.players) {
    if (!player || typeof player.id !== 'string' || !player.id || !Array.isArray(player.config) ||
        player.config.length !== 4 || !player.config.every(n => Number.isSafeInteger(n) && n >= 0) ||
        !Array.isArray(player.spec) || player.spec.length !== 3 ||
        player.spec.some((model, i) => ![i*2+1, i*2+2].includes(model))) throw Error('发车配置无效');
  }
  if (new Set(m.players.map(p => p.id)).size !== m.players.length) throw Error('参赛车手重复');
}

export function createDuelWorld(manifest) {
  validateManifest(manifest);
  // newRun selects the prerecorded AI profiles from the last four seed digits.
  const gridSeed = ((manifest.seed >>> 16) ^ (manifest.seed & 0xffff)).toString(16).padStart(4, '0');
  const botCount = 8 - manifest.players.length;
  const cars = manifest.players.map(({id, config, spec}, i) => {
    const car = newRun(0, gridSeed, id, config, spec, manifest.physicsVersion);
    car.x = manifest.initial.lanes[i];
    car.dnfStep = null;
    car.bots.length = botCount;
    car.rivalDelay.length = botCount;
    return car;
  });
  return {step: 0, cars, individual: manifest.finishPolicy === 'individual-v1',
    cursors: cars.map(() => 0), delays: Array(botCount).fill(0)};
}

export const classified = car => car.done || car.dnfStep != null;

function withdrawAtStep(world, logs, withdrawals) {
  for (const [i, record] of withdrawals.entries()) {
    if (!record || record.step !== world.step) continue;
    const car = world.cars[i];
    if (car.done) throw Error('退赛记录晚于该车手完赛');
    // Inputs accepted on the withdrawal boundary did not advance the car.
    while (logs[i][world.cursors[i]]?.[1] === world.step) world.cursors[i]++;
    car.dnfStep = world.step;
    car.keys = [0,0,0];
    car.v = 0;
  }
}

// An input stamped n is effective before the integration from step n to n+1.
export function advanceDuel(world, logs, targetStep, withdrawals = []) {
  if (!Number.isSafeInteger(targetStep) || targetStep < world.step || targetStep > MAX_STEPS)
    throw Error('模拟步无效');
  if (world.individual) withdrawAtStep(world, logs, withdrawals);
  while (world.step < targetStep && !world.cars.every(classified)) {
    for (const [index, car] of world.cars.entries()) {
      const log = logs[index];
      while (world.cursors[index] < log.length && log[world.cursors[index]][1] === world.step) {
        if (classified(car)) throw Error('记录包含完赛后或退赛后的输入');
        car.keys = log[world.cursors[index]++].slice(2);
      }
      if (!classified(car)) {
        // Every driver sees the same AI positions at the beginning of the tick.
        car.rivalDelay = [...world.delays];
        tick(car, STEP_MS / 1000);
        car.trace.length = 0;
      }
    }
    for (const car of world.cars)
      for (let i = 0; i < world.delays.length; i++)
        world.delays[i] = Math.max(world.delays[i], car.rivalDelay[i]);
    world.step++;
    if (world.individual) withdrawAtStep(world, logs, withdrawals);
  }
  if (world.individual && world.step === MAX_STEPS) {
    for (const car of world.cars) {
      if (!classified(car)) { car.dnfStep = MAX_STEPS; car.keys = [0,0,0]; car.v = 0; }
    }
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
    gear: car.gear, rpm: car.rpm, done: car.done, dnfStep: car.dnfStep, rank: null,
    totalMs: car.done ? Math.round(car.sectors[1] * 1000) : null
  }));
  // Stable grid order breaks a millisecond tie (and a live distance tie).
  const grid = [...drivers.filter(driver => driver.dnfStep === null), ...bots];
  grid.sort((a, b) => Number(b.done) - Number(a.done) || (a.done ? a.totalMs - b.totalMs : b.d - a.d));
  grid.forEach((car, i) => { car.rank = i + 1; });
  return {step: world.step, drivers, bots};
}

export function verifyDuel(manifest, logs, withdrawals) {
  const world = createDuelWorld(manifest);
  if (!Array.isArray(logs) || logs.length !== world.cars.length) throw Error('参赛车手的驾驶记录不齐全');
  if (world.individual) {
    if (!Array.isArray(withdrawals) || withdrawals.length !== world.cars.length) throw Error('车手退赛记录不齐全');
    for (const [i, record] of withdrawals.entries()) {
      if (record === null) continue;
      if (!record || record.id !== world.cars[i].driver || !Number.isSafeInteger(record.step) ||
          record.step < 0 || record.step >= MAX_STEPS) throw Error('退赛记录的车手或模拟步无效');
    }
  } else if (withdrawals?.some(record => record !== null)) throw Error('该场规则不支持个人退赛');
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
  advanceDuel(world, logs, MAX_STEPS, withdrawals);
  if (!world.cars.every(classified)) throw Error('至少一名车手未在限时内完赛');
  if (world.individual && withdrawals.some((record,i) => record && record.step !== world.cars[i].dnfStep))
    throw Error('退赛记录晚于该车手完赛');
  if (world.cursors.some((cursor, i) => cursor !== logs[i].length)) throw Error('记录包含完赛后的输入');
  return duelFrame(world).drivers.map(({id, rank, totalMs, dnfStep}) => dnfStep === null
    ? {id, rank, totalMs} : {id, rank, totalMs, dnfStep});
}
