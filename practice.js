function makePractice(){
 const accounts={A:'练习车手 A',B:'练习车手 B',C:'练习车手 C',港务车队:'港务车队',手续费:'赛务账户'};
 let db;try{db=JSON.parse(localStorage.getItem('rainport-practice-v3'))}catch{}
 const checkpointKey=w=>'rainport-practice-active:'+w;
 if(db)for(const [w,r] of Object.entries(db.runs||{})){
  try{
   const saved=JSON.parse(localStorage.getItem(checkpointKey(w)));
   if(saved?.id===r.id && saved.t>=r.t && !db.records.some(record=>record.id===r.id))db.runs[w]=saved;
  }catch{}
 }
 const checkpointJobs=new Set();
 function checkpoint(w,r){
  if(checkpointJobs.has(w))return;
  checkpointJobs.add(w);
  const write=()=>{
   checkpointJobs.delete(w);
   if(db.runs[w]!==r||r.done)return;
   try{localStorage.setItem(checkpointKey(w),JSON.stringify(r))}catch{}
  };
  if(typeof requestIdleCallback==='function')requestIdleCallback(write,{timeout:1000});else write();
 }
 const now=()=>Math.floor(Date.now()/1000);
 const save=()=>{try{localStorage.setItem('rainport-practice-v3',JSON.stringify(db))}catch{}};
 const make=(owner,model,edition=0)=>{const id=db.assets.length+1;db.assets.push({id,owner,model,edition,key:model*4+edition,mount:0,lock:0,parts:[0,0,0],first:owner,origin:null,originRank:0,busy:0});return db.assets[id-1]};
 function order(w,kind,key,price,expires,ids){const o={id:db.orders.length+1,kind,key,price,expires,ids,status:1,maker:w,paid:0,buyer:'',when:0,linked:0};db.orders.push(o);return o}
 const asset=id=>{const a=db.assets[id-1];if(!a)throw Error('编号不存在');return a};
 const check=(b,msg)=>{if(!b)throw Error(msg)};
 const best=(kind,key,limit,w)=>db.orders.filter(o=>o.status===1&&o.expires>now()&&o.kind===kind&&o.key===key&&o.maker!==w&&(kind===1?o.price<=limit:o.price>=limit)).sort((a,b)=>(kind===1?a.price-b.price:b.price-a.price)||a.id-b.id)[0];
 const pay=(a,b,p)=>{check(db.bal[a]>=p,'余额不足');db.bal[a]-=p;db.bal[b]+=p};
 function deliver(o,buyer,payer,p){check(o&&o.status===1&&o.expires>now(),'订单已关闭');check(o.kind!==4&&o.maker!==buyer,'无效买家');
  for(const id of o.ids)check(asset(id).owner===o.maker&&asset(id).lock===o.id,'交付清单已变');
  const fee=Math.floor(p*.02);pay(payer,o.maker,p-fee);pay(payer,accounts.手续费,fee);
  Object.assign(o,{buyer,paid:p,when:now(),status:2});for(const id of o.ids)Object.assign(asset(id),{owner:buyer,lock:0});
 }
 function match(a,b,p){deliver(a,b.maker,'托管',p);Object.assign(b,{status:2,paid:p,when:now(),buyer:b.maker,linked:a.id,ids:[a.ids[0]]});a.linked=b.id;pay('托管',b.maker,b.price-p)}
 function close(o,w){check(o&&o.status===1,'订单已关闭');check(o.maker===w||o.expires<=now(),'仅挂单人可撤单');o.status=o.expires<=now()?4:3;if(o.kind===4)pay('托管',o.maker,o.price);else o.ids.forEach(t=>asset(t).lock=0)}
 function action(w,fn,args){
  if(fn==='fit'){const [c,s,t]=args,car=asset(c);check(car.owner===w&&car.model===0&&!car.lock&&car.busy<=now()&&s>=0&&s<3,'底盘已锁定或不属于当前车手');
   if(t){const p=asset(t);check(p.owner===w&&!p.lock&&!p.mount&&slot(p.model)===s+1,'部件归属、槽位或挂牌状态不符')}
   if(car.parts[s])asset(car.parts[s]).mount=0;car.parts[s]=t;if(t)asset(t).mount=c;return}
  if(fn==='close'){close(db.orders[args[0]-1],w);return}
  if(fn==='buy'){const [id,p]=args,o=db.orders[id-1];check(o&&o.price===p,'价格已变');
   if(o.kind===1)check(best(1,o.key,p,w)?.id===id,'请购买同款最低价');deliver(o,w,w,p);return}
  const isBid=fn==='bid',[kind,t,p,exp]=isBid?[4,0,args[1],args[2]]:args;check(Number.isSafeInteger(p)&&p>0&&p<=1e9&&exp>now()&&exp<=now()+2592000,'价格或有效期无效');
  if(isBid){const key=args[0];pay(w,'托管',p);const b=order(w,4,key,p,exp,[]),a=best(1,key,p,w);if(a)match(a,b,a.price);return}
  const a=asset(t);check(a.owner===w&&!a.mount&&!a.lock&&a.busy<=now(),'资产已挂牌、已装配或不属于当前车手');
  if(kind===3)check(a.model===0&&a.parts.every(v=>v&&asset(v).owner===w&&!asset(v).lock),'整车配置不完整或已锁定');else check(a.model>0&&[1,2].includes(kind),'单件出售需要部件');
  const ids=kind===3?[t,...a.parts]:[t],o=order(w,kind,a.key,p,exp,ids);ids.forEach(i=>asset(i).lock=o.id);
  if(kind===1){const b=best(4,a.key,p,w);if(b)match(o,b,b.price)}
 }
 function settle(w,r){let rec=db.records.find(x=>x.id===r.id);if(rec)return rec;check(r.done,'尚未完赛');
  const rankNow=rank(r),random=Math.floor(Math.random()*10000),reward=drop(rankNow,random,Math.floor(Math.random()*1000000));let prize=0;
  if(reward){const p=make(w,reward.model,reward.edition);prize=p.id;p.origin=r.id;p.originRank=rankNow}
  rec={id:r.id,driver:r.driver,address:w,rank:rankNow,total:r.sectors[1],sectors:splitTimes(r),config:r.config,spec:r.spec,standings:standings(r),prize,tx:[],odds:1,pool:1};
  db.records.push(rec);db.replays[r.id]={trace:r.trace,inputs:r.inputs,config:r.config,physicsVersion:r.physicsVersion||1};if(r.config[0])asset(r.config[0]).busy=0;save();return rec;
 }
 if(!db){db={assets:[],orders:[],records:[],runs:{},replays:{},bal:{托管:0},history:[]};
  Object.values(accounts).forEach(w=>db.bal[w]=10000);
  const seeds=[['A',0],['A',1],['A',3],['A',5],['B',0],['B',2],['A',4],['B',6],['B',3],['港务车队',0],['港务车队',2,1],['港务车队',4,2],['港务车队',6,1],['港务车队',4],['港务车队',4],['港务车队',2,1],['港务车队',5],['港务车队',4,2],['A',6,1],['C',4],['港务车队',3]];
  seeds.forEach(([w,m,e])=>make(accounts[w],m,e));for(const [w,c,ps] of [['A',1,[2,7,4]],['B',5,[6,9,8]],['港务车队',10,[11,12,13]]])ps.forEach((v,i)=>action(accounts[w],'fit',[c,i,v]));
  const exp=now()+2500000;for(const [k,t,p] of [[1,14,58],[1,15,65],[2,18,148],[1,16,115],[2,17,38]])action(accounts.港务车队,'list',[k,t,p,exp]);
  action(accounts.C,'bid',[16,46,exp]);const r=newRun(0,'练习港队-0001','港务车队',[10,11,12,13],[2,4,6]);
  while(!r.done){r.keys=botPilot(r);tick(r)}settle(accounts.港务车队,r);action(accounts.港务车队,'fit',[10,1,21]);action(accounts.港务车队,'list',[3,10,500,exp]);save();
 }
 return async function(route,b){const w=accounts[b.wallet];if(!w)throw Error('钱包无效');
  for(const o of db.orders)if(o.status===1&&o.expires<=now())close(o,w);
  if(route==='state'){let a=db.runs[w];if(a&&(a.done&&db.records.some(r=>r.id===a.id)||Date.now()-a.ms>240000))a=null;return {wallet:b.wallet,address:w,wallets:accounts,balance:db.bal[w],escrow:db.bal["托管"],assets:db.assets,orders:db.orders,records:db.records,history:db.history,contracts:{},active:a}}
  if(route==='tx'){
   if(b.fn==='fit'&&b.expectedSlot!==undefined)check(asset(b.args[0]).parts[b.args[1]]===b.expectedSlot,'槽内配件已更换，请核对最新配置后重新装配');
   const backup=JSON.stringify(db);try{action(w,b.fn,b.args);save()}catch(e){db=JSON.parse(backup);throw e}return {id:'练习操作'}
  }
  if(route==='job')return {status:'练习已完成'};
  if(route==='start'){const keep=db.runs[w];if(keep&&!keep.done&&Date.now()-keep.ms<240000){if(b.controlStream&&!keep.controlStream){sample(keep,Date.now());enableControls(keep)}return b.controlStream?raceFrame(keep):keep;}
   const car=b.car?asset(b.car):null;if(car)check(car.owner===w&&!car.lock&&car.busy<=now()&&car.model===0&&car.parts.every(Boolean),'车辆不可参赛');
   const config=car?[car.id,...car.parts]:[0,0,0,0],spec=car?car.parts.map(id=>asset(id).model):[1,3,5];
   if(car)car.busy=now()+300;const r=newRun(Date.now()+3000,'练习-'+Date.now().toString(16),b.wallet,config,spec);if(b.controlStream)enableControls(r);db.runs[w]=r;save();return b.controlStream?raceFrame(r):r}
  const r=db.runs[w];if(route==='replay')return db.replays[b.id];if(route==='finish'&&db.records.some(v=>v.id===b.id&&v.address===w))return db.records.find(v=>v.id===b.id&&v.address===w);
  check(r&&r.id===b.id,'赛事编号无效');if(route==='drive'){const now=Date.now(),stream=r.controlStream&&Array.isArray(b.changes);
   if(stream){receiveControls(r,b.changes,now);advanceRun(r,now)}else input(r,b.keys,now);
   if(!r.lastSave||now-r.lastSave>1200||r.done){r.lastSave=now;checkpoint(w,r)}
   return stream?raceFrame(r,true):{...r,rank:rank(r)}}
  if(route==='abandon'){if(r.config[0])asset(r.config[0]).busy=0;delete db.runs[w];save();return {}}
  if(route==='finish'){if(r.controlStream)advanceRun(r,Date.now());else sample(r,Date.now());return settle(w,r)}throw Error('请求无效');
 };
}
