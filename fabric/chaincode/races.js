const {createHash} = require('node:crypto');
const {AbiCoder, keccak256} = require('ethers');
const {ID, HASH, DRIVERS, requireThat, uint, assetKey} = require('./ledger');

const coder = AbiCoder.defaultAbiCoder();
const raceKey = (id, driver) => 'race:' + id + ':' + driver;

async function getRace(db, id, driver) {
  requireThat(HASH.test(id) && ID.test(driver), 'InvalidRace');
  return db.load(raceKey(id, driver), {stage: 0});
}

async function start(db, [id, driver, carId]) {
  const {wallets} = await db.meta();
  requireThat(uint(carId) && DRIVERS.some(role => wallets[role] === driver), 'InvalidDriver');
  requireThat((await getRace(db, id, driver)).stage === 0, 'AlreadyStarted');
  const config = [carId, 0, 0, 0];
  if (carId) {
    const car = await db.asset(carId);
    requireThat(car.owner === driver && car.model === 0 && !car.lock && car.busy <= db.time, 'CarUnavailable');
    for (const [slot, partId] of car.parts.entries()) {
      requireThat(partId, 'IncompleteCar');
      const part = await db.asset(partId);
      requireThat(!part.lock && part.mount === carId && part.owner === driver, 'IncompleteCar');
      config[slot + 1] = partId;
    }
    Object.assign(car, {busy: db.time + 300, activeRace: raceKey(id, driver)});
    db.save(assetKey(carId), car);
  }
  const odds = 1, pool = 1;
  const configHash = keccak256(coder.encode(['uint256[4]', 'uint16', 'uint16'], [config, odds, pool]));
  db.save(raceKey(id, driver), {
    stage: 1, rank: 0, odds, pool, totalMs: 0, prize: 0, startTime: db.time,
    config, configHash, summary: null, replay: null, tx: [db.stub.getTxID()]
  });
}

async function unlock(db, race, id, driver) {
  const carId = race.config[0];
  if (carId) {
    const car = await db.asset(carId);
    if (car.activeRace === raceKey(id, driver)) {
      car.busy = 0;
      delete car.activeRace;
      db.save(assetKey(carId), car);
    }
  }
}

function updateRace(db, race, id, driver, changes) {
  Object.assign(race, changes);
  race.tx.push(db.stub.getTxID());
  db.save(raceKey(id, driver), race);
}

async function abandon(db, [id, driver]) {
  const race = await getRace(db, id, driver);
  requireThat(race.stage === 1, 'InvalidResult');
  updateRace(db, race, id, driver, {stage: 4});
  await unlock(db, race, id, driver);
}

async function confirm(db, [id, driver, rank, ms, summary, replay]) {
  const race = await getRace(db, id, driver);
  requireThat(race.stage === 1 && uint(rank) && rank >= 1 && rank <= 8 &&
    uint(ms) && ms > 0 && ms <= 240000 && HASH.test(summary) && HASH.test(replay), 'InvalidResult');
  requireThat(db.time <= race.startTime + 300 && db.time + 2 >= race.startTime + Math.floor(ms / 1000),
    'InvalidClock');
  updateRace(db, race, id, driver, {stage: 2, rank, totalMs: ms, summary, replay});
  await unlock(db, race, id, driver);
}

function tier(rank, roll) {
  const thresholds = rank === 1 ? [0, 2000, 7000, 9850] :
    rank <= 3 ? [1000, 5500, 8900, 9950] :
      rank <= 5 ? [3000, 8500, 9700, 9990] : [5500, 9500, 9900, 9998];
  const result = thresholds.findIndex(v => roll < v);
  return result < 0 ? 4 : result;
}

async function draw(db, [id, driver]) {
  const race = await getRace(db, id, driver);
  if (race.stage === 3) return race.prize;
  requireThat(race.stage === 2, 'ConfirmFirst');
  const hash = createHash('sha256').update('RAINPORT_FABRIC_MOCK_V1\x00' + id + '\x00' + driver).digest('hex');
  const random = BigInt('0x' + hash);
  const edition = tier(race.rank, Number(random % 10000n));
  let prize = 0;
  if (edition) {
    const pool = edition === 1 ? [1, 3, 5, 4] : [4, 2, 6];
    const pick = Number((random / 10000n) % BigInt(pool.length));
    prize = await db.issue(driver, pool[pick], edition - 1, id, race.rank);
  }
  updateRace(db, race, id, driver, {stage: 3, prize});
  return prize;
}

module.exports = {start, abandon, confirm, draw, getRace, tier};
