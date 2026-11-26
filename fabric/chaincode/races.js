const {createHash} = require('node:crypto');
const {ID, HASH, requireThat, assetKey} = require('./ledger');

const raceKey = (id, driver) => 'race:' + id + ':' + driver;

async function getRace(db, id, driver) {
  requireThat(HASH.test(id) && ID.test(driver), 'InvalidRace');
  return db.load(raceKey(id, driver), {stage: 0});
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
  if (race.stage === 4) return;
  requireThat(race.stage === 1 || race.stage === 2, 'InvalidResult');
  updateRace(db, race, id, driver, {stage: 4, reason: 'legacy-retired'});
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
  requireThat(race.stage === 3, 'SignedDuelRequired');
  return race.prize;
}

async function award(db, id, driver, rank) {
  const hash = createHash('sha256').update('RAINPORT_FABRIC_MOCK_V1\x00' + id + '\x00' + driver).digest('hex');
  const random = BigInt('0x' + hash);
  const edition = tier(rank, Number(random % 10000n));
  let prize = 0;
  if (edition) {
    const pool = edition === 1 ? [1, 3, 5, 4] : [4, 2, 6];
    const pick = Number((random / 10000n) % BigInt(pool.length));
    prize = await db.issue(driver, pool[pick], edition - 1, id, rank);
  }
  return prize;
}

module.exports = {abandon, draw, getRace, tier, award};
