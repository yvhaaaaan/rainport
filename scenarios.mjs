async function runSeven(h){
 const {state,act,race,settle,replay,repeatDraw,assert,parallel,bal}=h;
 const log=[],keep=(i,text,values)=>{log.push({case:i,text,values});h.record?.(log)};
 const first=await race('A',1);
 const before=(await state('A')).assets.length,again=await settle('A',first.id);
 assert(first.rank===1&&first.prize>0,'首圈须以第一名完赛并取得一件部件');
 const repeated=await repeatDraw('A',first.id);
 assert(again.prize===first.prize&&(await state('A')).assets.length===before,'重复结算改变奖励');
 keep(1,'按排名掉落，重开结算与重复抽取保持同一编号',{race:first.id,rank:first.rank,prize:first.prize,total:first.total,receipt:repeated,count:before});
 let s=await state('A'),p=s.assets.find(a=>a.id===first.prize);
 const fitted=await act('A','fit',[1,Math.ceil(p.model/2)-1,p.id]);
 const second=await race('A',1);s=await state('A');let pr=s.assets.find(a=>a.id===p.id);
 assert(pr.origin===first.id&&pr.originRank===first.rank&&pr.first===s.address,'掉落来源不符');
 assert(!first.config.includes(p.id)&&second.config.includes(p.id),'使用记录错误');
 const ghost=await replay(second.id);assert(ghost.trace.length>10,'回放轨迹缺失');
 keep(2,'装车后二跑，来源赛事与首次使用赛事分别可查',{prize:p.id,origin:pr.origin,firstUse:second.id,rank:second.rank,sectors:second.sectors,fit:fitted,traceSamples:ghost.trace.length});
 s=await state('A');if(s.assets.find(a=>a.id===7).mount===0)await act('A','fit',[1,1,7]);
 await act('A','fit',[1,1,0]);const serial=await act('A','list',[2,7,95,h.expiry()]);let o=(await state('A')).orders.at(-1);
 const serialBuy=await act('B','buy',[o.id,95]);await act('B','fit',[5,1,7]);s=await state('B');
 assert(s.assets.find(a=>a.id===7).mount===5&&s.assets.find(a=>a.id===7).owner===s.address,'编号买入或再装车失败');
 assert(s.records.some(r=>r.id===first.id&&r.driver==='A'&&r.config.includes(7)),'原车手成绩丢失');
 keep(3,'拆下指定雨胎，过户后保留原车手参赛履历',{serial:7,listing:serial,buy:serialBuy,mountedOn:5,originalLap:first.id});
 const base=await bal('B'),esc=await bal('托管');
 const bidRc=await act('B','bid',[16,52,h.expiry()]);const bid=(await state('B')).orders.at(-1);
 assert(await bal('B')===base-52&&await bal('托管')===esc+52,'求购托管金额不符');
 const stock=(await state('C')).orders.find(o=>o.kind===1&&o.ids[0]===14&&o.status===1);
 await act('港务车队','close',[stock.id]);await act('港务车队','list',[2,14,48,h.expiry()]);
 const privateAsk=(await state('B')).orders.at(-1);assert(privateAsk.status===1&&(await state('B')).orders.find(o=>o.id===bid.id).status===1,'指定单误撮合');
 const matched=await act('C','list',[1,20,50,h.expiry()]);s=await state('B');
 assert(s.orders.find(o=>o.id===bid.id).paid===52&&s.assets.find(a=>a.id===20).owner===s.address,'价格优先撮合错误');
 const pre=await bal('B');await act('B','bid',[16,40,h.expiry()]);const free=(await state('B')).orders.at(-1);const refund=await act('B','close',[free.id]);
 assert(await bal('B')===pre&&await bal('托管')===esc,'撤单退款金额不符');
 keep(4,'求购托管、主动同款撮合、指定编号隔离、撤单退款',{escrowDelta:52,bid:bidRc,filled:matched,price:52,excludedOrder:privateAsk.id,returned:40,refund});
 await act('A','fit',[1,1,3]);s=await state('A');const ids=[1,...s.assets.find(a=>a.id===1).parts];
 await act('A','list',[3,1,500,h.expiry()]);o=(await state('A')).orders.at(-1);const balances=await Promise.all(['A','B','手续费'].map(bal));
 const buyCar=await act('B','buy',[o.id,500]);s=await state('B');const after=await Promise.all(['A','B','手续费'].map(bal)),delta=after.map((v,i)=>v-balances[i]);
 assert(String(delta)==='490,-500,10'&&ids.every(t=>s.assets.find(a=>a.id===t).owner===s.address),'整车交割资金或权属不符');
 assert(String(s.assets.find(a=>a.id===1).parts)===String(ids.slice(1)),'装配关系丢失');
 const next=await race('B',1);assert(String(next.config)===String(ids),'购买配置不能直接比赛');
 keep(5,'500 CR 整车原子交割，买家使用原配置完赛',{ids,buyCar,seller:delta[0],buyer:delta[1],fee:delta[2],race:next.id,total:next.total});
 await act('A','list',[2,19,111,h.expiry()]);o=(await state('A')).orders.at(-1);const old=await Promise.all(['B','C'].map(bal));
 const attempts=await parallel(o.id,111),costs=await Promise.all(['B','C'].map(bal));const spends=costs.map((v,i)=>old[i]-v);
 assert(attempts.filter(v=>v.ok).length===1,'竞购成交笔数错误');
 const winnerIndex=attempts.findIndex(v=>v.ok),winner=['B','C'][winnerIndex];
 s=await state(winner);
 const sold=s.orders.find(order=>order.id===o.id),owner=s.assets.find(a=>a.id===19).owner;
 assert(spends[winnerIndex]===111&&spends[1-winnerIndex]===0,'竞购货款扣错买家');
 assert(sold.status===2&&sold.buyer===s.address&&sold.paid===111&&owner===s.address,'订单买家与资产归属不符');
 keep(6,'两个独立买方竞争同一编号，仅成交者取得部件并支付货款',{serial:19,attempts,spends,winner,owner});
 const listed=await act('B','list',[3,1,500,h.expiry()]);o=(await state('B')).orders.at(-1);const tire=o.ids[2];
 async function expectLocked(fn,args){
  let rejection;
  try{await act('B',fn,args,true)}catch(e){
   rejection={reason:e.reason||e.shortMessage||e.message,receipt:h.revertReceipt?.(e)??null};
  }
  assert(!!rejection,'整车挂牌期间操作应被拒绝：'+fn);
  return rejection;
 }
 const detachRejection=await expectLocked('fit',[1,1,0]);
 const rejection=await expectLocked('list',[2,tire,68,h.expiry()]);
 s=await state('B');
 assert(o.ids.every(id=>s.assets.find(a=>a.id===id).lock===o.id),'挂牌锁在拒绝操作后改变');
 assert(s.assets.find(a=>a.id===tire).mount===1&&s.assets.find(a=>a.id===1).parts[1]===tire,'挂牌期间轮胎装配关系改变');
 const cancelled=await act('B','close',[o.id]);
 await act('B','fit',[1,1,0]);const relist=await act('B','list',[2,tire,68,h.expiry()]);
 s=await state('B');assert(s.assets.find(a=>a.id===tire).lock===s.orders.at(-1).id,'撤单后的拆件重新挂牌失败');
 keep(7,'整车挂牌期间拒绝拆胎和单卖，撤单后拆胎并按编号挂牌',{tire,listed,detachRejection,rejection,cancelled,relist});return log;
}
export {runSeven};
