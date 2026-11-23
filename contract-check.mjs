import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Contract, id } from 'ethers';

process.env.RAINPORT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rainport-contract-'));
const {launch} = await import('./server.mjs');
const h = await launch({listen:false, showcase:false});
const checks = [];
const summary = r => ({hash:r.hash, block:r.blockNumber, status:r.status});
async function expectRevert(wallet, method, args, reason) {
  let failure;
  try { await h.op(wallet, method, args, undefined, {gasLimit:500000n}); }
  catch (error) { failure = error; }
  assert.equal(failure?.receipt?.status, 0);
  assert.equal(failure.reason, reason);
  return {...summary(failure.receipt), reason};
}
try {
  const {A,B} = h.wallets;
  await h.op('A','approve',[B,7]);
  const mounted = await expectRevert('B','transferFrom',[A,B,7],'PartMounted');
  const list = await h.op('A','list',[3,1,500,h.expiry()]);
  const locked = await expectRevert('B','safeTransferFrom(address,address,uint256)',[A,B,7],'AssetListed');
  const chassis = await expectRevert('A','transferFrom',[A,B,1],'AssetListed');
  assert.equal(await h.arc.ownerOf(7),A);
  assert.equal((await h.asset(7)).mount,1);
  const close = await h.op('A','close',[await h.arc.orderCount()]);
  await h.op('A','fit',[1,1,0]);
  const free = await h.op('B','safeTransferFrom(address,address,uint256)',[A,B,7]);
  assert.equal(await h.arc.ownerOf(7),B);
  checks.push({check:'获授权的钱包仅可转移已解锁并拆下的部件',mounted,listed:summary(list),locked,chassis,close:summary(close),free:summary(free)});

  const rng = new Contract(h.meta.LocalMockRandom,['function word(bytes32,address) view returns(uint256)'],h.provider);
  // Select a reproducible no-drop input to exercise the contract branch in isolation.
  let race,roll;
  for(let seed=0;seed<100;seed++){
    race=id('rainport:no-drop-test:'+seed);
    roll=Number((await rng.word(race,A))%10000n);
    if(roll<5500)break;
  }
  assert.ok(roll<5500);
  const start=await h.op('裁判','start',[race,A,0]);
  const count=Number(await h.arc.tokenCount());
  const record=await h.op('裁判','confirm',[race,A,8,1,id('fixture:summary'),id('fixture:replay')]);
  const draw=await h.op('A','draw',[race,A]);
  const repeat=await h.op('B','draw',[race,A]);
  const result=await h.arc.race(race,A);
  assert.equal(result.stage,3n);
  assert.equal(result.prize,0n);
  assert.equal(Number(await h.arc.tokenCount()),count);
  assert.equal((await h.arc.queryFilter(h.arc.filters.Reward(race,A))).length,1);
  checks.push({check:'合约固定输入，第八名未掉落结算；重复调用保留零奖品及一次奖励事件',race,roll,start:summary(start),confirm:summary(record),draw:summary(draw),repeat:summary(repeat),count});
  fs.writeFileSync(new URL('./evidence/contract-check.json',import.meta.url),JSON.stringify({chainId:31337,nodeData:process.env.RAINPORT_DATA,checks},null,2));
  console.log(checks.map(c=>c.check).join('\n'));
} finally {await h.stop();}
