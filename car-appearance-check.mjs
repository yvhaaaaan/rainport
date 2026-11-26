import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {copySnapshot} from './snapshot.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'rainport-car-match-'));
const site = path.join(temp,'site');
const data = path.join(temp,'chain');
const profile = path.join(temp,'chrome');
const out = path.resolve(process.argv[2] || path.join(root,'evidence','car-appearance'));
fs.mkdirSync(site);
fs.mkdirSync(out,{recursive:true});
copySnapshot(path.join(root,'demo-seed'),data);
for(const name of ['Archive.sol','server.mjs','driver-sync.mjs','racer-profiles.mjs','physics.mjs',
 'index.html','style.css','art.mjs','gt27-studio.jpg','gt27-workshop.jpg','rainport-cover.webp']){
 fs.copyFileSync(path.join(root,name),path.join(site,name));
}
fs.symlinkSync(path.join(root,'node_modules'),path.join(site,'node_modules'),process.platform==='win32'?'junction':'dir');

// Only this disposable browser build observes the actual geometry and the
// lacquer shader uniform at draw time. The shipped bundle has no probe.
const probe = `
function observedCar(T, options = {}) {
 const car = createRaceCar(T, options);
 const shaders = new Map();
 let captureNode;
 car.object.traverse(node => {
  const material = node.material;
  if(!material || !node.geometry || !node.geometry.name)return;
  if(node.geometry.name === 'Chassis')captureNode = node;
  if(shaders.has(material))return;
  shaders.set(material,null);
  const before = material.onBeforeCompile;
  material.onBeforeCompile = function(shader,renderer) {
   before.call(this, shader, renderer);
   shaders.set(material,shader.uniforms);
  };
 });
 if(captureNode) {
  const previous = captureNode.onAfterRender;
  captureNode.onAfterRender = function(renderer, ...args) {
   previous.call(this, renderer, ...args);
   const id=car.object.userData.chassisId;
   const meshes=[];
   car.object.traverseVisible(n=>{
    if(n.geometry?.name)meshes.push(n.geometry.name);
   });
   const scene = options.studio ? 'studio' : options.ghost ? 'ghost' :
    renderer.domElement.id === 'playback' ? 'replay' : 'race';
   const paint=shaders.get(this.material)?.gtFinish?.value?.getHexString();
   const visuals={id,paint,meshes:meshes.sort()};
   (globalThis.carProof ??= {})[scene + ':' + id]=visuals;
  };
 }
 return car;
}
export {observedCar as createRaceCar};
`;
await build({entryPoints:[path.join(root,'game.mjs')],outfile:path.join(site,'client.mjs'),bundle:true,
 format:'esm',charset:'utf8',target:'es2020',minify:true,legalComments:'inline',
 plugins:[{name:'car-proof',setup(builder){
  builder.onLoad({filter:/[\\/]car-model\.mjs$/},({path:source})=>{
   const text=fs.readFileSync(source,'utf8');
   assert.match(text,/export\s*\{\s*createRaceCar\s*\}/);
   return {contents:text.replace(/export\s*\{\s*createRaceCar\s*\};?/,probe),resolveDir:root};
  });
 }}]});

async function availablePort(){
 const server=net.createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 await new Promise(resolve=>server.close(resolve));
 return String(port);
}
const port=await availablePort();
process.env.PORT=port;
process.env.RPC_PORT='0';
process.env.RAINPORT_DATA=data;
process.env.RAINPORT_LEDGER='evm';
process.env.UWS_USE_FALLBACK='1';
const {launch}=await import(pathToFileURL(path.join(site,'server.mjs')));
const game=await launch({showcase:false});
const url='http://127.0.0.1:'+port;
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser=spawn(chrome,['--headless=new','--enable-webgl','--enable-unsafe-swiftshader','--no-first-run',
 '--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
 {windowsHide:true,stdio:'ignore'});
let ws;
const errors=[];
async function wait(test,label,timeout=35000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await test();if(value)return value;await delay(100);}
 throw Error('超时 · '+label);
}
const report={browser:'Chrome',ledger:'隔离的 Ganache 演示链',screens:[],checks:[],declaredClientSHA256:
 createHash('sha256').update(fs.readFileSync(path.join(root,'client.mjs'))).digest('hex'),testClientSHA256:
 createHash('sha256').update(fs.readFileSync(path.join(site,'client.mjs'))).digest('hex')};

try{
 const portfile=path.join(profile,'DevToolsActivePort');
 await wait(()=>fs.existsSync(portfile),'Chrome');
 const tabs=await (await fetch('http://127.0.0.1:'+fs.readFileSync(portfile,'utf8').split(/\s/)[0]+'/json/list')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 let seq=0;
 const pending=new Map();
 ws.onmessage=({data})=>{
  const msg=JSON.parse(data);
  if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);
  const request=pending.get(msg.id);
  if(request){pending.delete(msg.id);if(msg.error)request.reject(Error(msg.error.message));else request.resolve(msg.result);}
 };
 const call=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
 });
 const js=async expression=>{
  const value=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);
  return value.result.value;
 };
 const has=selector=>wait(()=>js('document.querySelector('+JSON.stringify(selector)+') !== null'),selector);
 async function click(selector,label=''){
  const point=await wait(()=>js(`(()=>{
   const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>!x.disabled&&x.getClientRects().length&&x.textContent.includes(${JSON.stringify(label)}));
   if(!b)return null;
   b.scrollIntoView({block:'center',behavior:'instant'});
   const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`),'点击 '+label+' '+selector);
  for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
 }
 const select=async (selector,value)=>assert(await js(`(()=>{
  const field=document.querySelector(${JSON.stringify(selector)});
  if(!field||![...field.options].some(o=>o.value===${JSON.stringify(String(value))}))return false;
  field.value=${JSON.stringify(String(value))};field.dispatchEvent(new Event('change',{bubbles:true}));return true;
 })()`),'选择 '+selector+'='+value);
 const nav=label=>click('nav button',label);
 const proof=(key,test=Boolean)=>wait(async()=>{
  const value=await js('window.carProof?.['+JSON.stringify(key)+']');
  return value&&test(value)?value:false;
 },'模型 '+key,50000);
 async function screen(file){
  const snap=await call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,file),Buffer.from(snap.data,'base64'));
  report.screens.push(file);
 }
 async function start(config){
  await click('#workshop-race');
  await has('.race-world[data-renderer="webgl2"]');
  const frame=await wait(async()=>(await game.state('A')).active,'链上起跑配置');
  assert.deepEqual(frame.config,config);
  return proof('race:'+config[0]);
 }
 async function leave(){
  await click('.race-actions button','退出比赛');
  await click('.dialog button','确认退赛');
  await has('#carSelect');
 }
 async function fit(index,part){
  await click('.workshop-slot[data-slot="'+index+'"]');
  await select('#workshop-part',part);
  await click('#workshop-fit');
  await click('.dialog button','签署并提交');
  await wait(async()=>(await game.asset(1)).parts[index]===part
   && await js('!document.querySelector(".dialog")'),'已装入 #'+part);
 }
 function config(visual,tire,wing){
  assert.equal(visual.meshes.filter(mesh=>mesh===tire).length,4);
  assert(visual.meshes.includes(wing));
 }
 function match(a,b){
  assert.equal(a.id,b.id);
  assert.match(a.paint,/^[0-9a-f]{6}$/);
  assert.equal(a.paint,b.paint);
  assert.deepEqual(a.meshes,b.meshes);
 }
 await call('Runtime.enable');
 await call('Page.enable');
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
 await game.op('A','fit',[1,1,3]);
 const availableOrders=(await game.state('A')).orders;
 if(!availableOrders.some(o=>o.kind===3&&o.status===1&&o.ids[0]===10)){
  await game.op('港务车队','list',[3,10,500,game.expiry()]);
 }
 await call('Page.navigate',{url});
 await has('#carSelect');
 await nav('车库');
 await has('.car-preview[data-renderer="webgl2"]');
 const original=await proof('studio:1');
 config(original,'RoadWheel','SprintWing');
 await screen('garage-stock.png');
 const first=await start([1,2,3,4]);
 match(original,first);
 await screen('race-stock.png');
 report.checks.push({name:'同一底盘车库与赛道匹配',chassis:1,stock:first});
 const raceId=(await game.state('A')).active.id;
 await call('Page.reload');
 await has('#carSelect');
 await click('main button','继续比赛');
 await has('.race-world[data-renderer="webgl2"]');
 match(original,await proof('race:1'));
 assert.equal((await game.state('A')).active.id,raceId);
 assert.equal(await js('document.querySelector("#race-car").textContent'),'潮汐 GT #001');
 report.checks.push({name:'刷新后仍继续原底盘和车漆的比赛',chassis:1});
 await leave();
 await nav('车库');
 await has('.car-preview[data-renderer="webgl2"]');
 await fit(1,7);
 await fit(2,19);
 const changed=await proof('studio:1',x=>x.meshes.includes('RainWheel')&&x.meshes.includes('AeroWing'));
 config(changed,'RainWheel','AeroWing');
 assert.equal(changed.paint,original.paint);
 await screen('garage-refit.png');
 const second=await start([1,2,7,19]);
 match(changed,second);
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
 const speedKmh=await wait(async()=>{
  const speed=await js('Number(document.querySelector("#speed")?.textContent)');
  return speed>35?speed:false;
 },'实际行驶速度超过 35 km/h');
 await screen('race-refit.png');
 await call('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
 report.checks.push({name:'改装雨胎和高翼在车库和发车同步',chassis:1,fitted:[2,7,19],speedKmh,render:second});
 await leave();
 await nav('展馆');
 const exhibit=await proof('studio:10');
 config(exhibit,'RoadWheel','AeroWing');
 await js('delete window.carProof["studio:10"]');
 await nav('市场');
 await has('#marketbody');
 await click('main button','买整车');
 await has('#marketbody .car-preview[data-car-preview="10"][data-renderer="webgl2"]');
 match(exhibit,await proof('studio:10'));
 report.checks.push({name:'整车交易清单与展馆显示同一辆车',chassis:10});
 await nav('展馆');
 await click('.exhibit-info table button','#012');
 await click('.dialog button','回放');
 await has('#playback[data-renderer="webgl2"]');
 const replay=await proof('replay:10');
 config(replay,'RainWheel','AeroWing');
 assert.equal(exhibit.paint,replay.paint);
 await screen('historical-replay.png');
 report.checks.push({name:'历史回放使用比赛时的雨胎',chassis:10,current:exhibit,record:replay});
 await click('.dialog button','关闭');
 await click('.exhibit-info .actions button','挑战圈速');
 await has('#carSelect');
 await select('#carSelect',0);
 await click('main button','进入雨港');
 await has('.race-world[data-renderer="webgl2"]');
 const borrowed=await proof('race:0');
 config(borrowed,'RoadWheel','SprintWing');
 assert.notEqual(borrowed.paint,second.paint);
 const ghost=await proof('ghost:10');
 config(ghost,'RainWheel','AeroWing');
 report.checks.push({name:'借用车外观有区分，幽灵保留历史雨胎',borrowed,ghost});
 await screen('loan-and-ghost.png');
 await leave();
 assert.deepEqual(errors,[]);
 report.passed=true;
}finally{
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({...report,errors},null,2)+'\n');
 ws?.close();
 browser.kill();
 await game.stop();
}
console.log(out);
