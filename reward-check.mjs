import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Contract} from 'ethers';
import {botPilot} from './physics.mjs';
import {makePrediction} from './driver-sync.mjs';
import {copySnapshot} from './snapshot.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const reviewIndex=process.argv.indexOf('--review');
const reviewRoot=reviewIndex<0?null:path.resolve(process.argv[reviewIndex+1]);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rainport-reward-check-'));
const site=path.join(temp,'site'),data=path.join(temp,'data');
const out=path.join(root,'evidence','rewards');
fs.mkdirSync(site);fs.mkdirSync(out,{recursive:true});
copySnapshot(reviewRoot?path.join(reviewRoot,'data'):path.join(root,'demo-seed'),data);
for(const name of ['Archive.sol','server.mjs','driver-sync.mjs','racer-profiles.mjs','physics.mjs','index.html',
 'style.css','art.mjs','gt27-studio.jpg','gt27-workshop.jpg','rainport-cover.webp']){
 fs.copyFileSync(path.join(root,name),path.join(site,name));
}
fs.symlinkSync(path.join(root,'node_modules'),path.join(site,'node_modules'),process.platform==='win32'?'junction':'dir');
execFileSync(process.execPath,[path.join(root,'build-practice.mjs'),site],{stdio:'inherit'});
process.env.RAINPORT_DATA=data;
process.env.PORT=process.env.REWARD_CHECK_PORT||'19577';
process.env.RPC_PORT=process.env.REWARD_CHECK_RPC||'19545';
process.env.UWS_USE_FALLBACK='1';
const game=await (await import(pathToFileURL(path.join(site,'server.mjs')))).launch({showcase:false});
const base='http://127.0.0.1:'+process.env.PORT;
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile=path.join(temp,'chrome');
const browser=spawn(chrome,['--headless=new','--enable-webgl','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check',
 '--disable-background-timer-throttling','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const report={clientSHA256:createHash('sha256').update(fs.readFileSync(path.join(site,'client.mjs'))).digest('hex'),
 styleSHA256:createHash('sha256').update(fs.readFileSync(path.join(site,'style.css'))).digest('hex'),
 snapshot:'demo-seed',chainId:31337,receipts:{},checks:[],screens:[]};
report.freshDriveSHA256=reviewRoot?createHash('sha256').update(fs.readFileSync(path.join(reviewRoot,'site','client.mjs'))).digest('hex'):report.clientSHA256;
report.mode=reviewRoot?'在同一批已完赛记录和原始节点快照的副本上复核最终画面':'实时浏览器完赛后开箱';
const errors=[];
let ws,closing=false;
async function until(test,label,ms=22000,interval=70){
 const end=Date.now()+ms;
 while(!closing&&Date.now()<end){const result=await test();if(result)return result;await delay(interval);}
 throw Error('超时 · '+label);
}
async function noDropRace(){
 // Use the public development random source to select a deterministic no-drop branch for QA.
 const rng=new Contract(game.meta.LocalMockRandom,['function word(bytes32,address) view returns(uint256)'],game.provider);
 let r,roll;
 for(let i=0;i<30;i++){
  r=await game.api('start',{wallet:'B',car:0});
  roll=Number(await rng.word(r.id,game.wallets.B)%10000n);
  if(roll<5500)break;
  await game.api('abandon',{wallet:'B',id:r.id});
 }
 assert(roll<5500);
 const id=r.id;
 await until(async()=>{
  const keys=(Date.now()-r.ms)<24000?[0,0,0]:botPilot(r);
  r=await game.api('drive',{wallet:'B',id,keys});
  return r.done;
 },'B 延迟发车后有效完赛',175000,85);
 const rec=await game.api('finish',{wallet:'B',id});
 assert.equal(rec.rank,8);assert.equal(rec.prize,0);
 return {rec,roll};
}
async function inspectReward(rec){
 const account=game.wallets[rec.driver];
 const g=await game.arc.race(rec.id,account);
 const events=await game.arc.queryFilter(game.arc.filters.Reward(rec.id,account));
 assert.equal(events.length,1);assert.equal(Number(g.stage),3);
 const event=events[0];
 assert.equal(Number(event.args[3]),rec.prize);
 const receipt=await game.node.provider.request({method:'eth_getTransactionReceipt',params:[event.transactionHash]});
 assert.equal(Number(receipt.status),1);
 report.receipts[rec.driver]=receipt;
 return {race:rec.id,rank:rec.rank,total:rec.total,wallet:account,prize:rec.prize,rarityTier:Number(event.args[2]),
  block:event.blockNumber,drawTransaction:event.transactionHash,events:events.length};
}
async function inventory(blockTag='latest'){
 const a=await game.arc.balanceOf(game.wallets.A,{blockTag}), b=await game.arc.balanceOf(game.wallets.B,{blockTag});
 return {all:Number(await game.arc.tokenCount({blockTag})),A:Number(a),B:Number(b)};
}
try{
 let initial=await inventory();
 const records=reviewRoot?(await game.state('A')).records:[];
 const savedA=records.findLast(r=>r.driver==='A'&&r.prize),savedB=records.findLast(r=>r.driver==='B'&&r.prize===0);
 if(reviewRoot){
  assert(savedA&&savedB,'复核快照须包含有掉落和未掉落两场真实完赛');
  const events=await game.arc.queryFilter(game.arc.filters.Reward(savedA.id,game.wallets.A));
  initial=await inventory(events[0].blockNumber-1);
 }
 async function emptyResult(){
  if(!reviewRoot)return noDropRace();
  const rng=new Contract(game.meta.LocalMockRandom,['function word(bytes32,address) view returns(uint256)'],game.provider);
  return {rec:savedB,roll:Number(await rng.word(savedB.id,game.wallets.B)%10000n)};
 }
 const noDrop=emptyResult().then(value=>({value}),error=>({error}));
 const portFile=path.join(profile,'DevToolsActivePort');
 await until(()=>fs.existsSync(portFile),'Chrome 端口');
 const tabs=await (await fetch('http://127.0.0.1:'+fs.readFileSync(portFile,'utf8').split(/\s/)[0]+'/json/list')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 let seq=0,recordReveals=false;
 const revealEndpointCalls=[];
 const calls=new Map();
 ws.onmessage=({data})=>{
  const m=JSON.parse(data),req=calls.get(m.id);
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
  if(recordReveals&&m.method==='Network.requestWillBeSent'){
   const u=new URL(m.params.request.url);if(u.pathname.startsWith('/api/'))revealEndpointCalls.push(u.pathname);
  }
  if(req){calls.delete(m.id);if(m.error)req.reject(Error(m.error.message));else req.resolve(m.result);}
 };
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq;calls.set(id,{resolve,reject});ws.send(JSON.stringify({method,params,id}));
 });
 const js=async expression=>{
  const reply=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);
  return reply.result.value;
 };
 const has=(sel,ms)=>until(()=>js('!!document.querySelector('+JSON.stringify(sel)+')'),sel,ms);
 const text=()=>js("document.querySelector('main').innerText");
 const size=(width,height)=>cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 async function click(label,selector='button'){
  const p=await until(()=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>!b.disabled&&b.getClientRects().length&&b.innerText.includes(${JSON.stringify(label)}));if(!el)return null;el.scrollIntoView({block:'center',behavior:'instant'});const box=el.getBoundingClientRect();return{x:box.left+box.width/2,y:box.top+box.height/2}})()`),label);
  for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
 }
 async function shot(name){
  const file=name+'.png',p=await cdp('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,file),Buffer.from(p.data,'base64'));report.screens.push(file);
 }
 await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Network.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(route,options){
   const response=await nativeFetch(route,options);
   if(route==='/api/start'||route==='/api/drive'){
    response.clone().json().then(r=>{window[route==='/api/start'?'qaGrid':'qaRace']=r;});
   }
   return response;
  };`});
 async function drive(){
  await cdp('Page.navigate',{url:base});await has('#carSelect');
  await click('进入雨港');
  const opening=await until(()=>js('window.qaGrid'),'起跑',50000);
  const held=new Set();
  async function key(letter,on){
   if(held.has(letter)===on)return;
   if(on)held.add(letter);else held.delete(letter);
   await cdp('Input.dispatchKeyEvent',{type:on?'keyDown':'keyUp',key:letter,code:'Key'+letter.toUpperCase(),windowsVirtualKeyCode:letter.toUpperCase().charCodeAt(0)});
  }
  let maxKmh=0;
  await until(async()=>{
   const r=await js('window.qaRace');if(!r)return false;
   if(r.done)return true;
   const predicted=makePrediction({...r,bots:opening.bots}).display(),[gas,brake,steer]=botPilot(predicted);
   await key('w',!!gas);await key('s',!!brake);await key('a',steer<0);await key('d',steer>0);
   maxKmh=Math.max(maxKmh,r.v*3.6);
   return false;
  },'A 通过浏览器按键有效完赛',185000,60);
  for(const k of [...held])await key(k,false);
  assert(maxKmh>140);
  return {id:opening.id,maxKmh};
 }
 await size(1280,800);
 let session;
 if(reviewRoot){
  const saved=JSON.parse(fs.readFileSync(path.join(data,savedA.id+'.json'),'utf8'));
  session={id:savedA.id,maxKmh:Math.max(...saved.replay.trace.map(p=>p[3]))*3.6};
  await cdp('Page.navigate',{url:base+'/#reward='+savedA.id});
 }else session=await drive();
 const sealed='[data-reward-stage="sealed"]',running='.reward-reel[data-phase="rolling"]';
 await has(sealed);
 const a=(await game.state('A')).records.find(r=>r.id===session.id);
 assert(a&&a.prize>0);
 const prize=await game.asset(a.prize),serial='#'+String(a.prize).padStart(3,'0');
 const result='[data-reward-result="'+a.prize+'"]', link=base+'/#result='+a.id;
 assert.equal(prize.owner,game.wallets.A);assert.equal(prize.origin,a.id);
 assert(!(await text()).includes(serial),'封箱阶段提前显示最终编号');
 const settled=await inventory();
 report.finish={...await inspectReward(a),maxKmh:+session.maxKmh.toFixed(1),part:{model:prize.model,edition:prize.edition}};
 recordReveals=true;
 await shot('sealed');await click('开启奖箱');await has(running);await delay(675);await shot('spinning');
 const cardSequence=()=>js("Array.from(document.querySelectorAll('.reward-card'),e=>[e.dataset.model,e.dataset.edition])");
 const firstSequence=await cardSequence();assert(firstSequence.length>10);
 const stopped=await until(()=>js(`(()=>{const reel=document.querySelector('.reward-reel[data-phase="landed"]');if(!reel)return null;const card=reel.querySelector('.reward-card.is-winner'),needle=reel.querySelector('.reward-pointer');const a=card.getBoundingClientRect(),b=needle.getBoundingClientRect();return {model:Number(card.dataset.model),edition:Number(card.dataset.edition),offset:Math.abs(a.left+a.width/2-b.left-b.width/2)};})()`),'指针停稳',11000,16);
 assert.equal(stopped.model,prize.model);assert.equal(stopped.edition,prize.edition);assert(stopped.offset<4,JSON.stringify(stopped));
 report.winner=stopped;await shot('landed');await has(result);await shot('revealed');
 await click('装配掉落部件');await has('#workshop-part');
 assert.equal(await js("document.querySelector('#workshop-part').value"),String(a.prize));
 report.checks.push('真实完赛进入封箱、停卡居中揭晓并定位实际掉落件的装配预览');
 await cdp('Page.navigate',{url:link});await has(result);await click('重看开箱');await has(running);
 assert.deepEqual(await cardSequence(),firstSequence);
 await cdp('Page.reload');await has(result);
 assert((await text()).includes(serial));report.checks.push('滚动中刷新后直接看到已登记的同一编号');
 await click('重看开箱');await has(running);await click('车库','nav button');await has('#garagecar');
 await delay(5300);assert(await js("!!document.querySelector('#garagecar')"));
 report.checks.push('离开滚动中的卡带，旧动画完成后仍停留在车库');
 await cdp('Page.navigate',{url:link});await has(result);
 await size(390,844);await click('重看开箱');await has(running);
 assert(await js('document.documentElement.scrollWidth<=innerWidth'));await shot('mobile');await click('跳过动画');await has(result);
 report.checks.push('390 像素屏无横向溢出，跳过动画得到同一编号');
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 const before=Date.now();await click('重看开箱');await has(result,1700);
 report.reducedMotionMs=Date.now()-before;report.checks.push('减少动态效果时直接显示本场结果');
 await cdp('Emulation.setEmulatedMedia',{features:[]});await size(1280,800);
 const b=await noDrop;if(b.error)throw b.error;
 const empty=b.value.rec;report.empty={...await inspectReward(empty),mockRoll:b.value.roll,
  method:'独立测试链筛选公开模拟随机源的未掉落分支，B 延迟 24 秒起步，按真实计时驾驶借用车完赛'};
 await js("sessionStorage.setItem('rp-wallet','B')");
 await cdp('Page.navigate',{url:'about:blank'});
 await cdp('Page.navigate',{url:base+'/#reward='+empty.id});await has(sealed);await click('开启奖箱');
 await has('.reward-reel[data-phase="landed"]');
 assert.equal(await js("document.querySelector('.reward-card.is-winner').dataset.model"),'0');
 await has('[data-reward-result="0"]');await shot('empty');
 assert(!(await text()).includes('装配掉落部件'));
 await click('重看开箱');await has(running);await click('跳过动画');await has('[data-reward-result="0"]');
 report.checks.push('真实第八名的未掉落记录，动画、跳过及重看皆返回空结果');
 await cdp('Page.navigate',{url:base+'/#reward='+empty.id+'&replay=1'});
 await has(sealed);await click('直接查看结果');await has('[data-reward-result="0"]');
 report.checks.push('可在封箱盘直接查看结果');
 const final=await inventory();
 assert.equal(final.all,initial.all+1);assert.equal(final.A,initial.A+1);assert.equal(final.B,initial.B);
 assert.deepEqual(settled,final);
 const winners=await game.arc.queryFilter(game.arc.filters.Reward(a.id,game.wallets.A));
 const misses=await game.arc.queryFilter(game.arc.filters.Reward(empty.id,game.wallets.B));
 assert.equal(winners.length,1);assert.equal(misses.length,1);
 report.inventory={initial,afterSettlement:settled,afterReplay:final};
 report.browserRevealQueries=[...new Set(revealEndpointCalls)];
 assert(revealEndpointCalls.every(q=>q==='/api/state'),'展示奖箱发送了额外请求 '+report.browserRevealQueries);
 report.checks.push('两场各一条链上 Reward 事件，所有开箱展示均未改变 NFT 数量');
 assert.deepEqual(errors,[]);report.browserErrors=errors;report.passed=true;
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(report,null,2));
 console.log('奖箱验收通过',JSON.stringify({client:report.clientSHA256,prize:a.prize,winner:report.finish.drawTransaction,noDrop:report.empty.drawTransaction}));
}finally{
 closing=true;ws?.close();browser.kill();await game.stop();
}
