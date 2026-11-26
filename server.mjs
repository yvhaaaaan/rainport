import {enableControls,receiveControls,advanceRun,raceFrame} from './driver-sync.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';
import {newRun,sample,input,rank,standings,splitTimes,botPilot,models} from './physics.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)), require=createRequire(import.meta.url);
const ledgerName=process.env.RAINPORT_LEDGER||'evm';
if(!['evm','fabric'].includes(ledgerName))throw Error('RAINPORT_LEDGER 应为 evm 或 fabric');
const evmDir=path.resolve(process.env.RAINPORT_DATA||path.join(root,'data'));
export const dir=ledgerName==='fabric'?path.resolve(process.env.RAINPORT_FABRIC_DATA||path.join(root,'data-fabric')):evmDir;
if(ledgerName==='fabric'&&(dir===evmDir||fs.existsSync(path.join(dir,'contracts.json'))))throw Error('Fabric 需要独立的回放目录，当前目录属于以太坊测试链');
fs.mkdirSync(dir,{recursive:true});
const read=(name,fallback)=>fs.existsSync(path.join(dir,name))?JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')):fallback;
function write(name,value){const dest=path.join(dir,name);fs.writeFileSync(dest+'.tmp',JSON.stringify(value));fs.renameSync(dest+'.tmp',dest)}
const json=x=>JSON.parse(JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v));
const digest=obj=>ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(obj)));
const port=Number(process.env.PORT||(ledgerName==='fabric'?8789:8787));
const errorsZh={
 AssetListed:'此编号已有有效卖单，请先撤单',PartMounted:'部件仍装在车上，请先拆下',
 CarRacing:'车辆正在比赛',CarAssembled:'底盘上仍装有部件',
 CarListed:'车辆已挂牌，请先撤单',CarUnavailable:'车辆归属、挂牌或参赛状态不允许此操作',
 IncompatiblePart:'部件归属或槽位不匹配',NotYourChassis:'请选择自己的底盘和有效槽位',
 IncompleteCar:'整车需要三个有效的已装部件',OrderClosed:'该订单已成交、撤销或到期',
 BetterAskExists:'同款最低卖单已变化，请刷新订单簿',PriceChanged:'订单价格已变化',
 NotOwner:'当前钱包不持有该编号',WrongBuyer:'当前钱包无法购买此订单',
 NotYourOrder:'只有挂单人可在到期前撤单',InvalidPrice:'价格应为 1 至 10 亿的整数',
 InvalidExpiry:'订单有效期应在未来 30 天内',InvalidClock:'赛事计时与节点时间不符',
 ERC20InsufficientBalance:'测试币余额不足',ERC20InsufficientAllowance:'市场测试币额度不足',
 SlotChanged:'槽内配件已更换，请核对最新配置后重新装配'
};
function fabricUnavailable(e){return ledgerName==='fabric'&&[4,14].includes(e?.code)}
function clean(e){
 if(fabricUnavailable(e))return 'Fabric 节点暂不可用，请等节点恢复后重试';
 const reason=e?.reason||e?.info?.error?.data?.reason||e?.revert?.name||e?.shortMessage||e?.message||String(e);
 return errorsZh[reason]||reason;
}
async function evmLedger(listen){
 const [{default:ganache},{default:solc}]=await Promise.all([import('ganache'),import('solc')]);
 const opts={wallet:{mnemonic:'test test test test test test test test test test test junk',totalAccounts:8,defaultBalance:1000},chain:{chainId:31337,hardfork:'shanghai'},database:{dbPath:path.join(dir,'chain')},logging:{quiet:true},miner:{instamine:'eager'}};
 const node=listen?ganache.server(opts):{provider:ganache.provider(opts)};if(listen)await node.listen(Number(process.env.RPC_PORT||8545),'127.0.0.1');
 const provider=new ethers.BrowserProvider(node.provider, undefined, {cacheTimeout:-1});provider.pollingInterval=60;
 const names=['裁判','A','B','C','港务车队','手续费'],signers={},wallets={};
 for(let i=0;i<names.length;i++){signers[names[i]]=await provider.getSigner(i);wallets[names[i]]=await signers[names[i]].getAddress()}
 const code=fs.readFileSync(path.join(root,'Archive.sol'),'utf8');
 const compilerInput={language:'Solidity',sources:{'Archive.sol':{content:code}},settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:150},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}};
 const buildKey=digest([solc.version(),require('@openzeppelin/contracts/package.json').version,compilerInput]);
 let artifacts=read('build-key.json',null)===buildKey?read('compiled.json',null):null;
 if(!artifacts){
  const compiled=JSON.parse(solc.compile(JSON.stringify(compilerInput),{import:loc=>{try{return {contents:fs.readFileSync(require.resolve(loc),'utf8')}}catch{return {error:'Import missing '+loc}}}}));
  const errors=(compiled.errors||[]).filter(x=>x.severity==='error');if(errors.length)throw Error(errors.map(x=>x.formattedMessage).join('\n'));
  artifacts=compiled.contracts['Archive.sol'];write('compiled.json',artifacts);write('build-key.json',buildKey);
 }
 let meta=read('contracts.json',{}), journal=read('receipts.json',[]);
 const signed=async(w,contract,fn,args=[],submitted,override={})=>{
   const tx=await contract.connect(signers[w])[fn](...args,override);submitted?.(tx.hash);
   let rc;try{rc=await tx.wait()}catch(e){
     rc=e.receipt;
     if(rc){
       // A mined revert has a status but no reason in its receipt. Re-read at the same block.
       try{await provider.call({from:tx.from,to:tx.to,data:tx.data,value:tx.value,blockTag:rc.blockNumber})}
       catch(reverted){e.reason=reverted.reason||reverted.info?.error?.data?.reason||clean(reverted)}
       journal.push({fn,w,h:tx.hash,b:rc.blockNumber,ok:false,args:json(args),reason:e.reason});write('receipts.json',journal)
     }throw e
   }
   journal.push({fn,w,h:tx.hash,b:rc.blockNumber,ok:rc.status===1,args:json(args)});write('receipts.json',journal);return rc;
 };
 async function deploy(name,args){
  const a=artifacts[name];if(meta[name]){if(await provider.getCode(meta[name])==='0x')throw Error('节点与部署文件不匹配');return new ethers.Contract(meta[name],a.abi,signers['裁判'])}
  const c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,signers['裁判']).deploy(...args);await c.waitForDeployment();meta[name]=await c.getAddress();write('contracts.json',meta);return c;
 }
 const credits=await deploy('Credits',[['A','B','C','港务车队'].map(w=>wallets[w])]);
 const rng=await deploy('LocalMockRandom',[]),arc=await deploy('Archive',[meta.Credits,wallets['手续费'],meta.LocalMockRandom]);
 const expiry=()=>Math.floor(Date.now()/1000)+29*86400;
 const op=(w,fn,args,cb,ov)=>signed(w,arc,fn,args,cb,ov);
 if(!read('seeded.json',false)){
   const seeds=[['A',0,0],['A',1,0],['A',3,0],['A',5,0],['B',0,0],['B',2,0],['A',4,0],['B',6,0],['B',3,0],['港务车队',0,0],['港务车队',2,1],['港务车队',4,2],['港务车队',6,1],['港务车队',4,0],['港务车队',4,0],['港务车队',2,1],['港务车队',5,0],['港务车队',4,2],['A',6,1],['C',4,0],['港务车队',3,0]];
   for(let i=Number(await arc.tokenCount());i<seeds.length;i++){const [w,m,e]=seeds[i];await op('裁判','seed',[wallets[w],m,e])}
   for(const w of ['A','B','C','港务车队'])if(await credits.allowance(wallets[w],meta.Archive)===0n)await signed(w,credits,'approve',[meta.Archive,1000000n]);
   for(const [w,c,ps] of [['A',1,[2,7,4]],['B',5,[6,9,8]],['港务车队',10,[11,12,13]]])for(let i=0;i<3;i++)if(Number((await arc.asset(c)).parts[i])!==ps[i])await op(w,'fit',[c,i,ps[i]]);
   if(!await arc.genesisClosed())await op('裁判','seal',[]);
   for(const [k,t,p] of [[1,14,58],[1,15,65],[2,18,148],[1,16,115],[2,17,38]])if(!(await arc.asset(t)).lockId)await op('港务车队','list',[k,t,p,expiry()]);
   if(!journal.some(j=>j.fn==='bid'&&j.w==='C'&&j.ok))await op('C','bid',[16,46,expiry()]);
   write('seeded.json',true);
 }
 async function asset(id){const [a,owner,busy]=await Promise.all([arc.asset(id),arc.ownerOf(id),arc.busyUntil(id)]);return {id,owner,model:Number(a.model),edition:Number(a.edition),mount:Number(a.mount),lock:Number(a.lockId),parts:a.parts.map(Number),origin:a.origin===ethers.ZeroHash?null:a.origin,first:a.first,originRank:Number(a.originRank),busy:Number(busy),key:Number(a.model)*4+Number(a.edition)}}
 async function order(id){const o=await arc.order(id);return {id,kind:Number(o.kind),status:Number(o.status),maker:o.maker,buyer:o.buyer,key:Number(o.key),price:Number(o.price),paid:Number(o.paid),expires:Number(o.expiry),when:Number(o.soldAt),linked:Number(o.linked),ids:o.ids.map(Number).filter(Boolean)}}
 async function snapshot(w){
   const n=Number(await arc.tokenCount()),j=Number(await arc.orderCount());
   let orders=await Promise.all(Array.from({length:j},(_,i)=>order(i+1)));
   const assets=await Promise.all(Array.from({length:n},(_,i)=>asset(i+1)));
   const block=Number(await node.provider.request({method:'eth_blockNumber',params:[]}));
   const transfers=(await arc.queryFilter(arc.filters.Transfer())).map(ev=>({id:Number(ev.args[2]),from:ev.args[0],to:ev.args[1],hash:ev.transactionHash,block:ev.blockNumber}));
   const linkLogs=await Promise.all([arc.queryFilter(arc.filters.Opened()),arc.queryFilter(arc.filters.Filled()),arc.queryFilter(arc.filters.Closed())]);
   function attachReceipt(o,hash){if(o){o.hashes??=[];if(!o.hashes.includes(hash))o.hashes.push(hash)}}
   for(const e of linkLogs.flat()){
    const o=orders[Number(e.args[0])-1];
    attachReceipt(o,e.transactionHash);
    if(e.fragment.name==='Filled'&&o?.linked)attachReceipt(orders[o.linked-1],e.transactionHash);
   }
   return {balance:Number(await credits.balanceOf(wallets[w])),assets,orders,block,transfers,history:journal.slice().reverse()};
 }
 async function receipt(hash){if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('哈希无效');const rc=await node.provider.request({method:'eth_getTransactionReceipt',params:[hash]});if(!rc)throw Error('回执尚未生成');return rc}
 return {node,provider,arc,credits,op,asset,order,race:(id,w)=>arc.race(id,w),snapshot,receipt,wallets,signers,meta,journal,expiry,async stop(){if(listen)await node.close();else await node.provider.disconnect()}};
}
export async function launch({listen=true,showcase=true}={}){
 const ledger=ledgerName==='fabric'
  ?await (await import('./fabric/gateway.mjs')).fabricLedger()
  :await evmLedger(listen);
 if(ledger.binding){
  const saved=read('ledger-binding.json',null);
  if(saved!==null&&saved!==ledger.binding){
   await ledger.stop();
   throw Error('Fabric 通道与本地回放目录不匹配，请设置 RAINPORT_FABRIC_DATA 指向该网络的回放目录');
  }
  if(saved===null)write('ledger-binding.json',ledger.binding);
 }
 const {wallets,op,asset,order,race,meta,expiry,journal=[]}=ledger;
 const runs=read('runs.json',{}),records=read('records.json',[]);
 const saveRuns=()=>write('runs.json',runs);
 let lane=Promise.resolve();
 const atomic=fn=>{const result=lane.then(fn);lane=result.catch(()=>{});return result};
 async function start(w,car,stream=false){
  const old=runs[w];if(old&&!records.some(v=>v.id===old.id)&&Date.now()-old.ms<240000){
   if(stream&&!old.controlStream){sample(old,Date.now());enableControls(old);saveRuns()}
   return framed(old);
  }
  if(old&&!records.some(v=>v.id===old.id)){
   const previous=await race(old.id,wallets[w]),stage=Number(previous.stage);
   if(stage===2||stage===3||stage===1&&old.done&&Date.now()/1000<Number(previous.startTime)+298){
    await finish(w,old.id);
   }else if(stage===1)await op('裁判','abandon',[old.id,wallets[w]]);
  }
  const id=ethers.hexlify(crypto.randomBytes(32));await op('裁判','start',[id,wallets[w],car]);
  const g=await race(id,wallets[w]),cfg=g.config.map(Number);
  const spec=car?await Promise.all(cfg.slice(1).map(async t=>(await asset(t)).model)):[1,3,5];
  const r=newRun(Date.now()+3000,id,w,cfg,spec);if(stream)enableControls(r);runs[w]=r;saveRuns();return framed(r);
 }
 const framed=r=>raceFrame(r);
 function drive(w,id,keys,changes){
  const r=runs[w];if(!r||r.id!==id)throw Error('赛事编号无效');
  const now=Date.now(),stream=r.controlStream&&Array.isArray(changes);
  if(stream){receiveControls(r,changes,now);advanceRun(r,now)}
  else input(r,keys,now);
  if(r.done||!r.lastSave||now-r.lastSave>1000){r.lastSave=now;saveRuns()}
  return raceFrame(r,stream);
 }
 async function finish(w,id){
  const prior=records.find(a=>a.id===id&&a.driver===w);if(prior)return prior;
  const r=runs[w];if(!r||r.id!==id)throw Error('赛事编号无效');advanceRun(r,Date.now());if(!r.done)throw Error('尚未完赛');saveRuns();
  let g=await race(id,wallets[w]);
  let summary;
  if(Number(g.stage)===1){
   summary={id,driver:w,address:wallets[w],config:r.config,spec:r.spec,rank:rank(r),total:r.sectors[1],sectors:splitTimes(r),standings:standings(r),odds:1,pool:1};
   const replay={config:r.config,inputs:r.inputs,trace:r.trace,physicsVersion:r.physicsVersion||1};
   write(id+'.json',{summary,replay});
   await op('裁判','confirm',[id,wallets[w],summary.rank,Math.round(summary.total*1000),digest(summary),digest(replay)],undefined,{gasLimit:500000n});
  }else{
   // A previously confirmed result may use an older replay format. Resume the
   // settlement using exactly the bytes the referee already signed.
   const saved=read(id+'.json',null);
   if(!saved||digest(saved.summary)!==g.summary||digest(saved.replay)!==g.replay)throw Error('已签署赛事的回放文件缺失或摘要不符');
   summary=saved.summary;
  }
  if(Number(g.stage)!==3)await op('裁判','draw',[id,wallets[w]]);
  g=await race(id,wallets[w]);
  const record={...summary,prize:Number(g.prize),summaryHash:g.summary,replayHash:g.replay,configHash:g.configHash,tx:g.tx??journal.filter(j=>j.args[0]===id).map(j=>j.h)};records.push(record);write('records.json',records);return record;
 }
 async function replay(id){if(!/^0x[0-9a-f]{64}$/.test(id))throw Error('赛事编号无效');const v=read(id+'.json',null);if(!v)throw Error('回放文件不存在');const g=await race(id,v.summary.address);
  const cfg=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256[4]','uint16','uint16'],[v.summary.config,v.summary.odds,v.summary.pool]));
  if(digest(v.summary)!==g.summary||digest(v.replay)!==g.replay||cfg!==g.configHash)throw Error('回放、配置或成绩摘要与链上不符');return v.replay;
 }
 async function state(w){
   let data=await ledger.snapshot(w);
   const expired=data.orders.filter(o=>o.status===1&&o.expires<=Date.now()/1000);
   for(const o of expired){
    try{await op('裁判','close',[o.id],undefined,{gasLimit:300000n})}
    catch(e){if((await order(o.id)).status===1)throw e}
   }
   if(expired.length)data=await ledger.snapshot(w);
   const active=runs[w]&&!records.some(v=>v.id===runs[w].id)&&Date.now()-runs[w].ms<240000?framed(runs[w]):null;
   return {...data,wallet:w,address:wallets[w],wallets,records,contracts:meta,active};
 }
 const jobs=new Map();
 async function api(route,b){
  const w=b.wallet;if(!['A','B','C'].includes(w))throw Error('请选择演示钱包');
  if(route==='state')return atomic(()=>state(w));
  if(route==='start')return atomic(()=>start(w,Number(b.car),b.controlStream===true));
  if(route==='drive')return drive(w,b.id,b.keys,b.changes);
  if(route==='finish')return atomic(()=>finish(w,b.id));
  if(route==='replay')return replay(b.id);
  if(route==='abandon')return atomic(async()=>{const r=runs[w];if(r&&r.id===b.id&&Number((await race(r.id,wallets[w])).stage)===1){await op('裁判','abandon',[r.id,wallets[w]]);delete runs[w];saveRuns()}return {}});
  if(route==='receipt')return ledger.receipt(b.hash);
  if(route==='tx'){
    if(!new Set(['fit','list','bid','buy','close']).has(b.fn)||!Array.isArray(b.args)||b.args.some(x=>!Number.isSafeInteger(x)||x<0))throw Error('交易参数无效');
    const id=crypto.randomUUID(),job={status:'等待签名'};jobs.set(id,job);
    atomic(async()=>{
     try{
      if(b.fn==='fit'&&b.expectedSlot!==undefined){
       const car=await asset(b.args[0]);
       if(Number(car.parts[b.args[1]])!==b.expectedSlot)throw Error('槽内配件已更换，请核对最新配置后重新装配');
      }
      const args=ledgerName==='fabric'&&b.fn==='fit'&&b.expectedSlot!==undefined
       ?[...b.args,b.expectedSlot]:b.args;
      const rc=await op(w,b.fn,args,h=>{job.status='已提交';job.hash=h});
      job.status='已确认';job.block=rc.blockNumber;
     }catch(e){
      job.status=e.pendingTransactionId?'待核对':'失败';
      job.error=clean(e);
      if(e.receipt?.blockNumber)job.block=e.receipt.blockNumber;
     }
    });return {id};
  }
  if(route==='job'){const j=jobs.get(b.id);if(!j)throw Error('交易任务不存在');return j}throw Error('未知请求');
 }
 let httpd,timer,steward;
 const settling=new Set();
 if(listen){
  httpd=http.createServer(async(req,res)=>{try{
   res.setHeader('X-Rainport-Ledger',ledgerName);
   if(!['localhost','127.0.0.1','[::1]'].includes((req.headers.host||'').split(':')[0]))throw Error('仅供本机');
   if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw Error('仅接受同源操作');
   if(req.method==='GET'){
    const files={'/':['index.html','text/html'],'/client.mjs':['client.mjs','text/javascript'],'/physics.mjs':['physics.mjs','text/javascript'],'/art.mjs':['art.mjs','text/javascript'],'/style.css':['style.css','text/css']};
    files['/racer-profiles.mjs']=['racer-profiles.mjs','text/javascript'];
    files['/rainport-cover.webp']=['rainport-cover.webp','image/webp'];
    files['/gt27-studio.jpg']=['gt27-studio.jpg','image/jpeg'];
    files['/gt27-workshop.jpg']=['gt27-workshop.jpg','image/jpeg'];
    const selected=Object.hasOwn(files,req.url)?files[req.url]:null;
    if(selected){res.setHeader('Content-Type',selected[1]+'; charset=utf-8');res.end(fs.readFileSync(path.join(root,selected[0])));return}
   }
   if(req.method!=='POST'||!req.url.startsWith('/api/')||!(req.headers['content-type']||'').startsWith('application/json')){res.writeHead(404);res.end();return}
   let body='';for await(const buf of req){body+=buf;if(body.length>16384)throw Error('请求过长')}
   const answer=await api(req.url.slice(5),JSON.parse(body));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer));
  }catch(e){res.writeHead(fabricUnavailable(e)?503:400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:clean(e)}))}});
  await new Promise(resolve=>httpd.listen(port,'127.0.0.1',resolve));console.log('雨港已开放 http://127.0.0.1:'+port);
 }
 if(listen){
  steward=setInterval(()=>{for(const w of ['A','B','C']){
   const r=runs[w];if(!r||settling.has(w)||records.some(x=>x.id===r.id))continue;
   advanceRun(r,Date.now());if(!r.done&&r.t<239.95)continue;
   settling.add(w);atomic(async()=>{
    if(runs[w]?.id!==r.id)return;
    if(r.done){await finish(w,r.id);return}
    if(Number((await race(r.id,wallets[w])).stage)===1)await op('裁判','abandon',[r.id,wallets[w]]);
    delete runs[w];saveRuns();
   }).catch(e=>console.error('赛务',clean(e))).finally(()=>settling.delete(w));
  }},350);
 }
 if(showcase&&!read('showcase.json',false)){
  const w='港务车队';let working=false;
  timer=setInterval(async()=>{if(working)return;working=true;try{
   let rec=records.find(x=>x.driver===w);
   if(!rec){const r=runs[w];if(!r||Date.now()-r.ms>240000){await atomic(()=>start(w,10));return}
    drive(w,r.id,botPilot(r));if(!r.done)return;rec=await atomic(()=>finish(w,r.id))}
   await atomic(async()=>{const car=await asset(10);if(!car.lock){if(car.parts[1]!==21)await op(w,'fit',[10,1,21]);await op(w,'list',[3,10,500,expiry()])}
    write('showcase.json',true);clearInterval(timer)});
  }catch(e){console.error('展车实录',clean(e))}finally{working=false}},180);
 }
 return {...ledger,state,start,finish,drive,replay,runs,records,api,async stop(){clearInterval(timer);clearInterval(steward);if(httpd)await new Promise(done=>httpd.close(done));await ledger.stop()}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))launch().catch(e=>{console.error(e);process.exitCode=1});
