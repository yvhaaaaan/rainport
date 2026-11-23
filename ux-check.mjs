import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {copySnapshot} from './snapshot.mjs';

const project=fileURLToPath(new URL('.',import.meta.url));
const label=process.argv[2]||'after';
assert(['before','after'].includes(label),'node ux-check.mjs before|after [built project folder]');
const source=path.resolve(process.argv[3]||project);
const work=fs.mkdtempSync(path.join(os.tmpdir(),'rainport-driving-usability-'));
const site=path.join(work,'site'),profile=path.join(work,'chrome'),out=path.join(project,'evidence','usability');
for(const folder of [site,out])fs.mkdirSync(folder,{recursive:true});
const digest=x=>createHash('sha256').update(x).digest('hex');
const jsSource=fs.readFileSync(path.join(source,'client.mjs'),'utf8');
// Observe only the values already consumed by the player mesh and road shader. The source
// checksum identifies the original release, before adding this measurement call in the copy.
const renderAnchor=/([\w$]+)\.uniforms\.viewer\.value=([\w$]+)\.d,\1\.uniforms\.lane\.value=[^;]*?\1\.uniforms\.heading\.value=[\w$]+/g;
assert.equal(Array.from(jsSource.matchAll(renderAnchor)).length,1,'3D renderer observation point');
const client=jsSource.replace(renderAnchor,(match,road,run)=>match+',window.drivingProbe.frame('+run+')');
for(const file of ['index.html','style.css','Archive.sol','server.mjs','driver-sync.mjs','physics.mjs','racer-profiles.mjs','art.mjs','gt27-studio.jpg','gt27-workshop.jpg','rainport-cover.webp']){
 fs.copyFileSync(path.join(source,file),path.join(site,file));
}
for(const entry of fs.readdirSync(source))if(entry.endsWith('.mjs')&&entry!=='client.mjs'&&!fs.existsSync(path.join(site,entry)))fs.copyFileSync(path.join(source,entry),path.join(site,entry));
fs.writeFileSync(path.join(site,'client.mjs'),client);
fs.symlinkSync(path.join(project,'node_modules'),path.join(site,'node_modules'),process.platform==='win32'?'junction':'dir');
process.env.PORT=process.env.UX_PORT||'19677';
process.env.RPC_PORT=process.env.UX_RPC_PORT||'19645';
process.env.UWS_USE_FALLBACK='1';
process.env.RAINPORT_DATA=path.join(work,'node-data');
copySnapshot(path.join(project,'demo-seed'),process.env.RAINPORT_DATA);
const game=await (await import(pathToFileURL(path.join(site,'server.mjs')))).launch({showcase:false});
const url='http://127.0.0.1:'+process.env.PORT;
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser=spawn(chrome,['--headless=new','--enable-webgl','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-features=Translate','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const round=x=>Math.round(x*100)/100;
const median=values=>values.length?values.slice().sort((a,b)=>a-b)[Math.floor(values.length/2)]:null;
async function wait(test,label,timeout=22000){const end=Date.now()+timeout;while(Date.now()<end){const v=await test();if(v)return v;await delay(18)}throw Error('等待超时 '+label)}
function drivingProbe(){
 const p=window.drivingProbe={frames:[],events:[],changes:[],reply:null,opening:null};
 p.frame=r=>p.frames.push([performance.now(),r.t,r.steer,r.brake,r.v,r.yaw,r.x,r.throttle,...r.keys]);
 const stamp=e=>{if(!e.repeat)p.events.push([performance.now(),e.type,e.key||e.pointerId,e.clientX||0,e.clientY||0]);};
 for(const type of ['keydown','keyup','pointerdown','pointerup','pointermove','pointercancel','blur'])window.addEventListener(type,stamp,true);
 const real=window.fetch.bind(window);
 window.fetch=async(route,opts)=>{
  if(route==='/api/drive'){const body=JSON.parse(opts.body);for(const e of body.changes||[])p.changes[e[0]]=[performance.now(),...e];}
  const res=await real(route,opts);
  if(route==='/api/start'||route==='/api/drive'){const parse=res.json.bind(res);res.json=async()=>{const value=await parse();if(route.endsWith('start'))p.opening=value;else p.reply=value;return value}}
  return res;
 };
}
const report={variant:label,clientSHA256:digest(jsSource),instrumentedSHA256:digest(client),cssSHA256:digest(fs.readFileSync(path.join(source,'style.css'))),fixture:'demo-seed',protocol:'Real Chrome CDP key/touch input. A read-only render probe samples steer/brake/yaw, speed in m/s and track-relative x at the Three.js player draw. Times measured on performance.now in the page. The isolated node records the lap.'};
let ws;
try{
 const devFile=path.join(profile,'DevToolsActivePort');await wait(()=>fs.existsSync(devFile),'Chrome');
 const port=fs.readFileSync(devFile,'utf8').split(/\s/)[0];
 const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 const tab=tabs.find(t=>t.type==='page');ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 const queue=new Map(),errors=[];let seq=0;
 ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id){const p=queue.get(m.id);queue.delete(m.id);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result)}};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;queue.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const js=async s=>{const r=await cdp('Runtime.evaluate',{expression:s,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const get=selector=>js('Boolean(document.querySelector('+JSON.stringify(selector)+'))');
 const key=(k,down)=>cdp('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',key:k,code:'Key'+k.toUpperCase(),windowsVirtualKeyCode:k.toUpperCase().charCodeAt(0)});
 const center=(selector,label='')=>js(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.includes(${JSON.stringify(label)})&&!b.disabled);if(!el)return null;el.scrollIntoView({block:'nearest'});const box=el.getBoundingClientRect();return{x:box.x+box.width/2,y:box.y+box.height/2}})()`);
 async function click(selector,label=''){const point=await wait(()=>center(selector,label),label||selector);for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1})}
 await cdp('Runtime.enable');await cdp('Page.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+drivingProbe.toString()+')()'});
 await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
 await cdp('Page.navigate',{url});await wait(()=>get('#carSelect'),'发车区');await click('button','进入雨港');
 await wait(()=>js('drivingProbe.opening&&drivingProbe.frames.length>10'),'起步',50000);
 await key('w',true);await wait(()=>js("drivingProbe.frames.at(-1)?.[4]>11"),'加速至40km/h',30000);
 await key('w',false);await delay(240);
 const taps=[];
 for(let i=0;i<9;i++){
  const k=i%2?'a':'d';
  const from=await js('drivingProbe.events.length'),sequence=await js('drivingProbe.changes.length');
  await key(k,true);await delay(14+(i%3)*3);await key(k,false);await delay(235+i*7);
  const events=await js('drivingProbe.events.slice('+from+').filter(e=>e[2]==='+JSON.stringify(k)+')');
  assert.equal(events.length,2);
  const [down,up]=events.map(e=>e[0]);
  const frames=await js('drivingProbe.frames.filter(f=>f[0]>='+down+'-28&&f[0]<='+up+'+150)');
  const base=frames.filter(f=>f[0]<down).at(-1);
  const signed=k==='d'?1:-1;
  const newFrames=frames.filter(f=>f[0]>=down);
  const hit=newFrames.find(f=>signed*(f[2]-(base?.[2]||0))>.012);
  const wire=await js('drivingProbe.changes.slice('+sequence+').filter(Boolean)');
  taps.push({key:k,heldMs:round(up-down),firstRenderedResponseMs:hit?round(hit[0]-down):null,
   peakChange:round(Math.max(...newFrames.map(f=>signed*(f[2]-(base?.[2]||0))))),wire:wire.map(e=>e.slice(1))});
 }
 report.shortSteerTaps={count:taps.length,detected:taps.filter(t=>t.firstRenderedResponseMs!==null).length,medianResponseMs:median(taps.map(t=>t.firstRenderedResponseMs).filter(n=>n!==null)),pulses:taps};
 console.log('short taps',report.shortSteerTaps.detected+'/'+taps.length);
 const steeringStart=await js('performance.now()');
 await key('d',true);await delay(230);await key('a',true);await delay(145);await key('d',false);await delay(275);await key('a',false);await delay(330);
 const ster=await js('drivingProbe.frames.filter(f=>f[0]>='+steeringStart+')'),events=await js('drivingProbe.events.filter(e=>e[0]>='+steeringStart+"&&e[1].startsWith('key'))");
 const tm=events.map(e=>e[0]);assert.equal(tm.length,4);
 const first=(start,end,fn)=>{const f=ster.find(x=>x[0]>=start&&x[0]<=end&&fn(x));return f?round(f[0]-start):null};
 report.reverse={firstRightMs:first(tm[0],tm[1],f=>f[2]>.025),oppositeHeldMs:round(tm[2]-tm[1]),requestedDuringOverlap:ster.filter(f=>f[0]>tm[1]+75&&f[0]<tm[2]).at(-1)?.at(-1),
  firstLeftSteerAfterPressMs:first(tm[1],tm[3],f=>f[2]<-.025),neutralAfterReleaseMs:first(tm[3],Infinity,f=>Math.abs(f[2])<.025)};
 const brakeStart=await js('performance.now()');
 await key('w',true);await delay(70);await key('s',true);await delay(420);await key('s',false);await delay(225);await key('w',false);
 const braking=await js('drivingProbe.frames.filter(f=>f[0]>='+brakeStart+')'),brakeEvents=await js('drivingProbe.events.filter(e=>e[0]>='+brakeStart+"&&e[2]==='s')");
 const [bs,be]=brakeEvents.map(e=>e[0]);
 const prior=braking.filter(f=>f[0]<=bs).at(-1),end=braking.filter(f=>f[0]<=be).at(-1),applied=braking.find(f=>f[0]>=bs&&f[3]>.02),clear=braking.find(f=>f[0]>be&&f[3]<.02);
 report.braking={firstBrakeMs:applied?round(applied[0]-bs):null,releaseMs:clear?round(clear[0]-be):null,initialKmh:round(prior[4]*3.6),endKmh:round(end[4]*3.6),requestAtEnd:end.slice(-3)};
 // Change to a touch viewport while keeping the same actual race.
 await cdp('Emulation.setDeviceMetricsOverride',{width:844,height:390,mobile:true,deviceScaleFactor:1});
 await cdp('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
 await delay(200);const points={};for(const k of ['a','d','s','w'])points[k]=await center('[data-key="'+k+'"]');
 assert(Object.values(points).every(v=>v&&v.x>0&&v.y>0),'触控按钮应可见');
 const finger=(k,id)=>({...points[k],id,radiusX:5,radiusY:5,force:.7});
 const touch=(type,p)=>cdp('Input.dispatchTouchEvent',{type,touchPoints:p});
 const read=async()=>{await delay(135);return js('drivingProbe.changes.filter(Boolean).at(-1)?.slice(-3)')};
 const tp={};await touch('touchStart',[finger('w',1)]);tp.gas=await read();
 await touch('touchStart',[finger('w',1),finger('a',2)]);tp.gasLeft=await read();
 await touch('touchMove',[finger('w',1),finger('d',2)]);tp.slideAcrossSteering=await read();
 await touch('touchMove',[finger('s',1),finger('d',2)]);tp.slideAcrossPedals=await read();
 const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,label+'-touch.png'),Buffer.from(shot.data,'base64'));
 await touch('touchCancel',[]);tp.afterCancel=await read();
 await key('w',true);await touch('touchStart',[finger('w',1)]);await delay(75);await touch('touchEnd',[]);tp.keyboardStillHeld=await read();await key('w',false);
 report.touch={viewport:[844,390],points,submittedControlSequence:tp};
 await key('d',true);await delay(95);const blurStart=await js('performance.now()');
 const other=await cdp('Target.createTarget',{url:'about:blank'});await cdp('Target.activateTarget',{targetId:other.targetId});await delay(180);
 const genuineBlur=await js('drivingProbe.events.some(e=>e[0]>='+blurStart+"&&e[1]==='blur')");
 if(!genuineBlur)await js("window.dispatchEvent(new Event('blur'))");
 await cdp('Page.bringToFront');await cdp('Target.closeTarget',{targetId:other.targetId});await delay(180);
 report.focus={trigger:genuineBlur?'activate second Chrome tab':'window blur event (CDP headless)',keysAfterReturn:await read()};await key('d',false);
 await wait(()=>js('drivingProbe.reply?.t>3'),'裁判实车数据');
 const active=game.runs.A;
 report.race={id:active.id,physicsVersion:active.physicsVersion,serverElapsed:active.t,renderer:await js("document.querySelector('.race-world').dataset.renderer")};
 report.browserErrors=errors;assert.deepEqual(errors,[]);
 assert.deepEqual(tp.afterCancel,[0,0,0]);
 const file=path.join(out,label+'.json');fs.writeFileSync(file,JSON.stringify(report,null,2));
 console.log(JSON.stringify({file,touch:tp,reverse:report.reverse,brake:report.braking,focus:report.focus}));
}finally{ws?.close();browser.kill();await game.stop()}
