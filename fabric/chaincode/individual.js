const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {uint, requireThat} = require('./ledger');
const {award} = require('./races');

const policy = 'individual-v1';
const digestPattern = /^[a-f0-9]{64}$/;
const programDirectory = path.join(__dirname, 'verifiers');
const programs = new Map();
let current;

function readProgram(file) {
  const bytes = fs.readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const program = {digest, bytes};
  programs.set(digest, program);
  return program;
}

function currentProgram() {
  if (!current) current = readProgram(path.join(programDirectory, policy + '.mjs'));
  return current;
}

function initialize(race) {
  requireThat(race.manifest.verifierHash === currentProgram().digest, 'UnknownOfficialVerifier');
  const count = race.manifest.players.length;
  Object.assign(race, {playerStatus: Array(count).fill('racing'), inputHashes: null, withdrawals: null,
    withdrawalProofs: Array(count).fill(null), refusals: Array(count).fill(null)});
}

async function replay(manifest, logs, withdrawals) {
  const expected = manifest.verifierHash;
  currentProgram();
  if (!programs.has(expected)) {
    // Upgrades may ship an older official bundle under its digest to finish races already opened.
    const file = path.join(programDirectory, expected + '.mjs');
    requireThat(digestPattern.test(expected) && fs.existsSync(file) && readProgram(file).digest === expected,
      'UnknownOfficialVerifier');
  }
  const program = programs.get(expected);
  // Only bytes from the installed chaincode package can reach the module loader.
  program.module ??= import('data:text/javascript;base64,' + program.bytes.toString('base64'));
  const verifier = await program.module;
  return verifier.verifyDuel(manifest, logs, withdrawals);
}

function anchor(race, inputHashes, withdrawals, hash) {
  const players = race.manifest.players;
  requireThat(Array.isArray(inputHashes) && inputHashes.length === players.length &&
    players.every((_, i) => typeof inputHashes[i] === 'string' && digestPattern.test(inputHashes[i])),
    'InvalidDuelDigest');
  requireThat(Array.isArray(withdrawals) && withdrawals.length === players.length, 'InvalidDuelWithdrawals');
  for (const [i, player] of players.entries()) {
    const w = withdrawals[i];
    // A quit signature can cross the finish-line update. In that case the
    // recorder has no withdrawal step; the locked input log still decides the result.
    if (w === null) continue;
    requireThat(race.withdrawalProofs[i], 'WithdrawalNotAuthorized');
    requireThat(w && w.id === player.id && uint(w.step) && w.step < 24000 && Object.keys(w).length === 2,
      'InvalidDuelWithdrawals');
  }
  if (race.inputHashes) {
    requireThat(hash(inputHashes) === hash(race.inputHashes) && hash(withdrawals) === hash(race.withdrawals),
      'RecordsAlreadyAnchored');
    return false;
  }
  requireThat(race.status === 'racing', 'DuelNotRacing');
  Object.assign(race, {inputHashes, withdrawals, status: 'anchored'});
  return true;
}

function digestResult(race, inputHashes, results, hash) {
  const {manifest, manifestHash, withdrawals} = race;
  return hash({id: manifest.id, manifestHash, inputHashes, withdrawals, results});
}

function updateStatus(race) {
  race.status = race.playerStatus.includes('eligible') ? 'review' : 'settled';
}

async function publish(db, race, logs, hash) {
  const results = await replay(race.manifest, logs, race.withdrawals);
  for (const [i, result] of results.entries()) {
    if (result.rank === null && race.withdrawals[i] === null) {
      requireThat(db.time >= race.startedAt + 240, 'RaceTimeLimitNotReached');
    }
  }
  race.results = results;
  race.resultHash = digestResult(race, race.inputHashes, results, hash);
  race.playerStatus = results.map((r, i) => {
    if (race.withdrawalProofs[i]) return 'withdrawn';
    return r.rank === null ? 'dnf' : 'eligible';
  });
  updateStatus(race);
}

async function claim(db, race, i, args, envelope, hash) {
  const [id, inputHashes, results, resultHash] = args;
  requireThat(race.results && race.resultHash === resultHash &&
    digestResult(race, inputHashes, results, hash) === race.resultHash, 'DuelResultMismatch');
  if (race.playerStatus[i] === 'claimed') return false;
  requireThat(race.playerStatus[i] === 'eligible', 'DuelRewardUnavailable');
  requireThat(race.commitProofs[i] && race.commitments[i] === race.inputHashes[i], 'OwnCommitmentRequired');
  const {id: driver, rank} = race.results[i];
  race.prizes[i] = await award(db, id, driver, rank);
  race.confirmations[i] = {envelope, resultHash, tx: db.stub.getTxID()};
  race.playerStatus[i] = 'claimed';
  updateStatus(race);
  return true;
}

function refuse(db, race, i, envelope) {
  if (race.playerStatus[i] === 'refused') return false;
  requireThat(race.playerStatus[i] === 'eligible', 'DuelRewardUnavailable');
  race.refusals[i] = {envelope, tx: db.stub.getTxID()};
  race.playerStatus[i] = 'refused';
  updateStatus(race);
  return true;
}

module.exports = {policy, initialize, anchor, publish, claim, refuse};
