import fs from 'node:fs';
import path from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import grpc from '@grpc/grpc-js';
import {connect, signers, StatusCode} from '@hyperledger/fabric-gateway';
import fabricProtos from '@hyperledger/fabric-protos';

const {common, peer} = fabricProtos;
const roles = ['裁判', 'A', 'B', 'C', '港务车队', '手续费'];
const defaultConfig = fileURLToPath(new URL('../.fabric-local/gateway.json', import.meta.url));
const txIdPattern = /^[0-9a-f]{64}$/;
const validationNames = new Map(Object.entries(StatusCode).map(([name, code]) => [code, name]));
const configName = () => path.resolve(process.env.FABRIC_CONFIG || defaultConfig);
const decode = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const deadline = ms => () => ({deadline: Date.now() + ms});

function connectRainport() {
  const filename = configName();
  if (!fs.existsSync(filename)) throw Error('找不到 Fabric 网关配置。请先部署链码并设置 FABRIC_CONFIG。');
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const {endpoint, hostAlias, tlsCert, channel, chaincode, identities} = config;
  const read = file => fs.readFileSync(path.resolve(path.dirname(filename), file));
  if (![endpoint, hostAlias, tlsCert, channel, chaincode].every(value => typeof value === 'string' && value.trim()) ||
      !roles.every(role => ['mspId', 'certificate', 'privateKey'].every(key =>
        typeof identities?.[role]?.[key] === 'string' && identities[role][key].trim()))) {
    throw Error('Fabric 配置缺少网关、TLS、通道、链码或演示身份');
  }
  const client = new grpc.Client(endpoint, grpc.credentials.createSsl(read(tlsCert)), {
    'grpc.ssl_target_name_override': hostAlias,
  });
  const sessions = {};
  const stop = () => {
    for (const {gateway} of Object.values(sessions)) gateway.close();
    client.close();
  };
  try {
    for (const role of roles) {
      const {mspId, certificate, privateKey} = identities[role];
      const gateway = connect({
        client,
        identity: {mspId, credentials: read(certificate)},
        signer: signers.newPrivateKeySigner(createPrivateKey(read(privateKey))),
        evaluateOptions: deadline(7000),
        endorseOptions: deadline(20000),
        submitOptions: deadline(10000),
        commitStatusOptions: deadline(45000),
      });
      const network = gateway.getNetwork(channel);
      sessions[role] = {gateway, contract: network.getContract(chaincode), mspId,
        qscc: network.getContract('qscc')};
    }
    return {sessions, stop, config};
  } catch (error) {
    stop();
    throw error;
  }
}

function transactionStatus(hash, block, code, {channel, chaincode}) {
  return {ledger: 'fabric', hash, block, blockNumber: block, channel, contract: chaincode,
    validationCode: validationNames.get(code) ?? String(code), successful: code === 0, status: code === 0 ? 1 : 0};
}

function readReceipt(bytes, hash, config) {
  const block = common.Block.deserializeBinary(bytes);
  const transactions = block.getData().getDataList_asU8();
  const outcome = block.getMetadata().getMetadataList_asU8()[common.BlockMetadataIndex.TRANSACTIONS_FILTER];
  for (let i = 0; i < transactions.length; i++) {
    const envelope = common.Envelope.deserializeBinary(transactions[i]);
    const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
    const header = common.ChannelHeader.deserializeBinary(payload.getHeader().getChannelHeader_asU8());
    if (header.getTxId() !== hash) continue;
    const extension = peer.ChaincodeHeaderExtension.deserializeBinary(header.getExtension_asU8());
    if (header.getChannelId() !== config.channel || extension.getChaincodeId()?.getName() !== config.chaincode) {
      throw Error('该交易不属于当前雨港链码');
    }
    if (outcome?.[i] === undefined) throw Error('Fabric 区块缺少交易验证状态');
    return transactionStatus(hash, block.getHeader().getNumber(), outcome[i], config);
  }
  throw Error('该区块未包含请求的交易 ID');
}

function chaincodeError(error) {
  const details = error.details?.map?.(value => value.message).filter(Boolean);
  const explanation = details?.find(value => /message:|[A-Z][a-z]+(?:[A-Z][a-z]+)+/.test(value));
  const reason = explanation?.replace(/^.*?message:\s*/s, '').replace(/^"(.*)"$/s, '$1');
  if (reason) error.reason = reason;
  return error;
}

async function evaluate(contract, name, ...args) {
  try {
    return decode(await contract.evaluateTransaction(name, ...args.map(String)));
  } catch (error) {
    throw chaincodeError(error);
  }
}

async function submit(contract, config, name, args, {onSubmitted, onCommit, findReceipt} = {}) {
  try {
    const tx = await contract.submitAsync(name, {arguments: args});
    const hash = tx.getTransactionId();
    onSubmitted?.(hash);
    let receipt;
    try {
      const status = await tx.getStatus();
      receipt = transactionStatus(hash, Number(status.blockNumber), status.code, config);
    } catch (statusError) {
      try {
        if (findReceipt) receipt = await findReceipt(hash);
      } catch {
        // The ordering service has accepted the transaction. A peer that has
        // not seen the block yet cannot tell us whether validation succeeded.
      }
      if (!receipt) {
        const error = new Error('交易已提交，节点暂未返回验证结果', {cause: statusError});
        error.pendingTransactionId = hash;
        throw error;
      }
    }
    onCommit?.(receipt);
    if (!receipt.successful) {
      const error = new Error('Fabric 交易未通过验证：' + receipt.validationCode);
      error.receipt = receipt;
      throw error;
    }
    return receipt;
  } catch (error) {
    throw chaincodeError(error);
  }
}

async function walletIds(sessions) {
  const identities = await Promise.all(roles.map(role => evaluate(sessions[role].contract, 'WhoAmI')));
  return Object.fromEntries(roles.map((role, index) => [role, identities[index].id]));
}

function verifyWallets(expected, actual) {
  if (!roles.every(role => expected[role] && expected[role] === actual?.[role])) {
    throw Error('当前 Fabric 证书和已登记的演示身份不匹配');
  }
}

export async function initializeFabric() {
  const {sessions, config, stop} = connectRainport();
  const {contract, qscc} = sessions['裁判'];
  try {
    const wallets = await walletIds(sessions);
    const existing = await evaluate(contract, 'GetWallets');
    if (existing && Object.keys(existing).length) {
      verifyWallets(wallets, existing);
      return {alreadyInitialized: true, channel: config.channel, contract: config.chaincode};
    }
    const identities = roles.map(role => ({role, id: wallets[role]}));
    const receipt = await submit(contract, config, 'Initialize', [JSON.stringify(identities)], {
      findReceipt: async hash => readReceipt(await qscc.evaluateTransaction('GetBlockByTxID', config.channel, hash), hash, config),
    });
    verifyWallets(wallets, await evaluate(contract, 'GetWallets'));
    return receipt;
  } finally {
    stop();
  }
}

export async function fabricLedger() {
  const {sessions, config, stop} = connectRainport();
  try {
    const {contract, qscc} = sessions['裁判'];
    const genesis = common.Block.deserializeBinary(await qscc.evaluateTransaction('GetBlockByNumber', config.channel, '0'));
    const wallets = await walletIds(sessions);
    verifyWallets(wallets, await evaluate(contract, 'GetWallets'));
    const binding = [config.channel, config.chaincode, Buffer.from(genesis.getHeader().getDataHash_asU8()).toString('hex'),
      ...Object.values(wallets)].join('/');
    const meta = {archive: config.chaincode, credits: config.chaincode, chainId: config.channel, rpc: config.endpoint};
    const receipts = new Map();
    async function receipt(hash, {fresh = false} = {}) {
      if (typeof hash !== 'string' || !txIdPattern.test(hash)) throw Error('Fabric 交易 ID 无效');
      if (!fresh && receipts.has(hash)) return receipts.get(hash);
      const pending = qscc.evaluateTransaction('GetBlockByTxID', config.channel, hash)
        .then(bytes => readReceipt(bytes, hash, config));
      receipts.set(hash, pending);
      try {
        return await pending;
      } catch (error) {
        if (receipts.get(hash) === pending) receipts.delete(hash);
        throw error;
      }
    }
    function op(role, name, args, onSubmitted) {
      return submit(sessions[role].contract, config, 'Execute', [name, JSON.stringify(args)], {
        onSubmitted, findReceipt: receipt, onCommit: committed => receipts.set(committed.hash, committed),
      });
    }
    async function snapshot(role) {
      const actor = sessions[role];
      const [state, info] = await Promise.all([
        evaluate(actor.contract, 'Snapshot'), actor.qscc.evaluateTransaction('GetChainInfo', config.channel),
      ]);
      const {orders, assets, history, transfers, balances} = state;
      const lookup = new Map();
      const hashes = [...new Set([...history.map(entry => entry.h), ...transfers.map(entry => entry.hash)])];
      // Service cold starts may encounter many old receipts. Limit concurrent peer queries.
      for (let i = 0; i < hashes.length; i += 12) {
        await Promise.all(hashes.slice(i, i + 12).map(async hash => lookup.set(hash, (await receipt(hash)).block)));
      }
      return {ledger: 'fabric', mspId: actor.mspId, balance: balances[role], assets, orders,
        block: common.BlockchainInfo.deserializeBinary(info).getHeight() - 1,
        transfers: transfers.map(entry => ({...entry, block: lookup.get(entry.hash)})),
        history: history.map(entry => ({...entry, b: lookup.get(entry.h)})).sort((a, b) => b.b - a.b)};
    }
    const relay = (name, ...args) => submit(contract, config, name, args, {
      findReceipt: receipt, onCommit: committed => receipts.set(committed.hash, committed),
    });
    return {wallets, op, meta, binding, receipt, snapshot, stop,
      playerDomain: () => evaluate(contract, 'GetPlayerDomain'),
      player: id => evaluate(contract, 'GetPlayer', id),
      playerAction: envelope => relay('PlayerAction', JSON.stringify(envelope)),
      marketState: () => evaluate(contract, 'Snapshot'),
      openDuel: manifest => relay('OpenDuel', JSON.stringify(manifest)),
      duel: id => evaluate(contract, 'GetDuel', id),
      revealDuel: (id, logs) => relay('RevealDuel', id, JSON.stringify(logs)),
      expireDuel: id => relay('ExpireDuel', id),
      asset: id => evaluate(contract, 'GetAsset', id),
      order: id => evaluate(contract, 'GetOrder', id),
      race: (id, actor) => evaluate(contract, 'GetRace', id, actor),
      balance: async role => (await evaluate(contract, 'Snapshot')).balances[role],
      expiry: () => Math.floor(Date.now()/1000) + 29 * 86400};
  } catch (error) {
    stop();
    throw error;
  }
}
