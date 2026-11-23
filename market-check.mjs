import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Separate chain: advancing the local block clock must never affect the playable world.
process.env.RAINPORT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rainport-book-'));
const {launch} = await import('./server.mjs');
const h = await launch({listen: false, showcase: false});
const results = [];
const tx = async (w, fn, args) => {
  const rc = await h.op(w, fn, args);
  assert.equal(rc.status, 1);
  return {hash: rc.hash, block: rc.blockNumber};
};
const lastOrder = async () => Number(await h.arc.orderCount());
const funds = w => h.credits.balanceOf(h.wallets[w]);
const itemOwner = n => h.arc.ownerOf(n);
try {
  const due = h.expiry();
  // Both R2 common asks now have the same price. #014 was posted first.
  await tx('港务车队', 'close', [2]);
  await tx('港务车队', 'list', [1, 15, 58, due]);
  const before = await funds('B');
  const buy = await tx('B', 'bid', [16, 75, due]);
  const order = await h.order(await lastOrder());
  assert.equal(order.paid, 58);
  assert.equal(before - await funds('B'), 58n);
  assert.equal(await itemOwner(14), h.wallets.B);
  assert.equal(await itemOwner(15), h.wallets['港务车队']);
  results.push({check:'同价卖单按时间优先，买方剩余托管款立即返还', received:14, limit:75, paid:58, returned:17, buy});

  await tx('B', 'bid', [16, 52, due]);
  const firstBid = await lastOrder();
  await tx('A', 'bid', [16, 52, due]);
  const laterBid = await lastOrder();
  const match = await tx('C', 'list', [1, 20, 46, due]);
  assert.equal(await itemOwner(20), h.wallets.B);
  assert.equal((await h.order(firstBid)).paid, 52);
  assert.equal((await h.order(laterBid)).status, 1);
  results.push({check:'高价求购优先，同价先到先得',firstBid,laterBid,price:52,match});

  const block = await h.node.provider.request({method:'eth_getBlockByNumber',params:['latest',false]});
  const end = Number(block.timestamp) + 12;
  const balance = await funds('A');
  await tx('A', 'bid', [16, 35, end]);
  const shortBid = await lastOrder();
  await tx('A', 'list', [3, 1, 500, end]);
  const carOrder = await lastOrder();
  await h.node.provider.request({method:'evm_increaseTime',params:[16]});
  await h.node.provider.request({method:'evm_mine',params:[]});
  const releasedCar = await tx('C', 'close', [carOrder]);
  const releasedBid = await tx('C', 'close', [shortBid]);
  assert.equal((await h.order(shortBid)).status, 4);
  assert.equal((await h.order(carOrder)).status, 4);
  for (const asset of [1,2,7,4]) assert.equal((await h.asset(asset)).lock, 0);
  assert.equal(await funds('A'), balance);
  results.push({check:'到期后第三方可释放四件套锁并退还求购托管',ids:[1,2,7,4],refund:35,releasedCar,releasedBid});
  const report = {chainId:31337,chainDirectory:process.env.RAINPORT_DATA,results};
  const dest = new URL('./evidence/orderbook.json', import.meta.url);
  fs.writeFileSync(dest,JSON.stringify(report,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {
  await h.stop();
}
