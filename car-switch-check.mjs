import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {copySnapshot} from './snapshot.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'rainport-switch-'));
const data=path.join(workspace,'ledger');
const profile=path.join(workspace,'chrome');
const evidence=path.resolve(process.argv[2]||path.join(root,'evidence','car-switch'));
fs.mkdirSync(evidence,{recursive:true});
copySnapshot(path.join(root,'demo-seed'),data);

async function freePort(){
 const socket=net.createServer();
 await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const number=socket.address().port;
 await new Promise(resolve=>socket.close(resolve));
 assert(![8787,8789].includes(number));
 return String(number);
}
process.env.RAINPORT_LEDGER='evm';
process.env.RAINPORT_DATA=data;
process.env.RPC_PORT='0';
process.env.PORT=await freePort();
process.env.UWS_USE_FALLBACK='1';
const {launch}=await import('./server.mjs');
const game=await launch({showcase:false});
const url='http://127.0.0.1:'+process.env.PORT;
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser=spawn(chrome,['--headless=new','--enable-unsafe-swiftshader','--no-first-run','--remote-debugging-port=0',
 '--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const errors=[],checks=[];
const clientSHA256=createHash('sha256').update(fs.readFileSync(path.join(root,'client.mjs'))).digest('hex');
let websocket;

async function until(test,label,timeout=20000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  const result=await test();
  if(result)return result;
  await delay(100);
 }
 throw Error('超时 · '+label);
}

try{
 const portFile=path.join(profile,'DevToolsActivePort');
 await until(()=>fs.existsSync(portFile),'Chrome 调试通道');
 const cdpPort=fs.readFileSync(portFile,'utf8').split(/\s/)[0];
 const tabs=await (await fetch('http://127.0.0.1:'+cdpPort+'/json/list')).json();
 websocket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
 await new Promise(resolve=>websocket.addEventListener('open',resolve,{once:true}));
 let sequence=0;
 const requests=new Map();
 websocket.onmessage=({data})=>{
  const response=JSON.parse(data);
  if(response.method==='Runtime.exceptionThrown')errors.push(response.params.exceptionDetails.text);
  const pending=requests.get(response.id);
  if(pending){
   requests.delete(response.id);
   if(response.error)pending.reject(Error(response.error.message));
   else pending.resolve(response.result);
  }
 };
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;
  requests.set(id,{resolve,reject});
  websocket.send(JSON.stringify({id,method,params}));
 });
 async function js(expression){
  const result=await call('Runtime.evaluate',{expression,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
 }
 const query=selector=>'document.querySelector('+JSON.stringify(selector)+')';
 const has=selector=>until(()=>js('Boolean('+query(selector)+')'),selector);
 async function click(selector,pattern=''){
  const target=await until(()=>js(`(()=>{
   const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>!b.disabled&&b.getClientRects().length&&new RegExp(${JSON.stringify(pattern)}).test(b.textContent.trim()));
   if(!b)return null;
   b.scrollIntoView({block:'center'});
   const rect=b.getBoundingClientRect();
   return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`),'点击 '+selector+' '+pattern);
  for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...target,button:'left',clickCount:1});
 }
 async function select(selector,value){
  assert(await js(`(()=>{
   const select=${query(selector)}, option=[...select.options].find(option=>option.value===${JSON.stringify(String(value))});
   if(select.disabled||!option||option.disabled)return false;
   select.value=option.value;
   select.dispatchEvent(new Event('change',{bubbles:true}));
   return true;
  })()`),'选择 '+selector+'='+value);
 }
 const lobby=()=>has('#carSelect');
 const nav=label=>click('nav button','^'+label+'$');
 const value=selector=>js(query(selector)+'?.value');
 async function reloadLobby(){
  await js('window.oldSwitchCheckPage=true');
  await call('Page.reload');
  await until(async()=>{
   try{return await js('!window.oldSwitchCheckPage&&Boolean('+query('#carSelect')+')');}
   catch{return false;}
  },'刷新后返回新的发车区文档');
 }
 async function pickCar(name){
  await click('main button','^换车$');
  await has('.dialog[aria-label="选择参赛车辆"]');
  await click('.dialog button','^选择 '+name+'$');
 }
 async function screenshot(name){
  const snap=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,name),Buffer.from(snap.data,'base64'));
 }
 async function active(config){
  const state=await until(async()=>(await game.state('A')).active,'链上起跑配置');
  assert.deepEqual(state.config,config);
  await has('.race-world[data-renderer]');
  const name=config[0]?'潮汐 GT #'+String(config[0]).padStart(3,'0'):'港务借用车';
  await until(()=>js(query('#race-car')+'?.textContent.trim()==='+JSON.stringify(name)),'车手界面 '+name);
  return state;
 }
 async function finishWithExit(){
  await click('.race-actions button','^退出比赛$');
  await click('.dialog button','确认退赛');
  await lobby();
  assert.equal((await game.state('A')).active,null);
 }

 await game.state('A');
 const teamCar=await game.asset(10);
 if(!teamCar.lock)await game.op('港务车队','list',[3,10,500,game.expiry()]);
 const stock=await game.order((await game.asset(10)).lock);
 await game.op('A','buy',[stock.id,stock.price]);
 assert.equal((await game.asset(10)).owner,game.wallets.A);

 await call('Runtime.enable');
 await call('Page.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url});
 await lobby();
 await select('#carSelect',1);
 await nav('车库');
 await has('#garagecar');
 await nav('比赛');
 await lobby();
 assert.equal(await value('#carSelect'),'1');
 await reloadLobby();
 assert.equal(await value('#carSelect'),'1');
 await pickCar('港务借用车');
 assert.equal(await value('#carSelect'),'0');
 await click('main button','^进入雨港$');
 const firstLoan=await active([0,0,0,0]);
 checks.push({name:'发车区可切换到借用车，所选自有车跨页面与刷新保留',borrowed:firstLoan.config});
 await finishWithExit();

 await select('#carSelect',1);
 // An active borrowed race launched by a different tab overrides this tab's preference.
 const loan=await game.start('A',0,true);
 await reloadLobby();
 assert.equal(await value('#carSelect'),'0');
 assert.match(await js(query('#lobby-race-car')+'?.textContent'),/^本场 · 港务借用车/);
 assert.equal((await game.state('A')).active.id,loan.id);
 await pickCar('潮汐 GT #001');
 await has('.dialog[aria-label="退赛后换车"]');
 await screenshot('switch-confirmation.png');
 await click('.dialog button','^关闭$|^取消$');
 assert.equal((await game.state('A')).active.id,loan.id);
 await pickCar('潮汐 GT #001');
 await click('.dialog button','^确认退赛并换车$');
 await until(async()=>!(await game.state('A')).active,'旧比赛已退赛');
 assert.equal(Number((await game.race(loan.id,game.wallets.A)).stage),4);
 await until(async()=>await value('#carSelect')==='1','退赛后选择 GT #001');
 await click('main button','^进入雨港$');
 const owned=await active([1,2,7,4]);
 assert.notEqual(owned.id,loan.id);
 checks.push({name:'取消保留原比赛，确认退赛后切为自有 GT #001',from:loan.config,to:owned.config});
 await finishWithExit();

 await nav('车库');
 await has('#garagecar');
 await select('#garagecar',10);
 const second=[10,...(await game.asset(10)).parts];
 await click('#workshop-race');
 await active(second);
 await screenshot('second-chassis.png');
 checks.push({name:'车库切换第二台自有车，发车配置和仪表身份一致',config:second});
 await finishWithExit();

 await game.op('A','list',[3,1,500,game.expiry()]);
 await game.op('A','fit',[10,1,0]);
 await reloadLobby();
 const options=await js(`[...document.querySelectorAll('#carSelect option')].map(o=>({value:o.value,disabled:o.disabled,text:o.textContent}))`);
 assert(options.some(o=>o.value==='1'&&o.disabled&&o.text.includes('挂牌')),JSON.stringify(options));
 assert(options.some(o=>o.value==='10'&&o.disabled&&/未装齐|缺|装配|部件/.test(o.text)),JSON.stringify(options));
 assert(options.some(o=>o.value==='0'&&!o.disabled),JSON.stringify(options));
 await screenshot('unavailable-chassis.png');
 checks.push({name:'挂牌和未装齐的车在发车区可见，借用车仍可用',options});
 assert.deepEqual(errors,[]);
}finally{
 fs.writeFileSync(path.join(evidence,'checks.json'),JSON.stringify({browser:'Chrome',ledger:'隔离 Ganache',clientSHA256,checks,errors},null,2)+'\n');
 websocket?.close();
 browser.kill();
 await game.stop();
}
console.log(evidence);
