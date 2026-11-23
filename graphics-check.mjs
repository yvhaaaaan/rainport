import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {build} from 'esbuild';

const tag=process.argv[2]||'current';
const prepare=process.argv.includes('--prepare');
if(!/^[a-z0-9-]+$/.test(tag))throw Error('Invalid test label');
const html='<style>*{margin:0}canvas{display:block;width:1280px;height:720px}</style><canvas></canvas><script type="module" src="bench.js"></script>';
const source=`
import {createTrackScene} from './track-scene.mjs';
const c=document.querySelector('canvas');
const start=performance.now(),samples=240;
const trace=[];
let calls=0,tris=0;
const proto=WebGL2RenderingContext.prototype;
for(const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
 const original=proto[method]; proto[method]=function(...args){calls++;if(args[0]===4)tris+=(method.startsWith('drawArrays')?args[2]:args[1])/3*(method.endsWith('Instanced')?args.at(-1):1);return original.apply(this,args);};
}
const lanes=[-.45,.45,-.42,.42,-.44,.44,-.39],frame={id:'bench',spec:[1,4,5],config:[1,2,7,4],x:0,t:0,d:0,v:40,keys:[1,0,0],rivalDelay:[]};
function grid(offset){
 frame.bots=lanes.map((lane,i)=>[60,70,Array.from({length:66},(_,t)=>80*t+offset+(5+i*5.75)),Array(66).fill(lane*100)]);
}
grid(0);
const world=createTrackScene(c,frame),created=performance.now();
${prepare?'await world.prepare(frame);':'world.render(frame,null);'}
const gl=c.getContext('webgl2'),pixel=new Uint8Array(4);
gl.readPixels(300,300,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
const cold=performance.now(),debug=gl.getExtension('WEBGL_debug_renderer_info');
const vendor=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):'unknown';
const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2'),queries=[];
function drain(){if(!timer)return;while(queries.length&&gl.getQueryParameter(queries[0].q,gl.QUERY_RESULT_AVAILABLE)){const item=queries.shift();if(!gl.getParameter(timer.GPU_DISJOINT_EXT))item.out.push(gl.getQueryParameter(item.q,gl.QUERY_RESULT)*1e-6);gl.deleteQuery(item.q)}}
function summary(arr){if(!arr.length)return {};const a=[...arr].sort((a,b)=>a-b),at=v=>+a[Math.min(a.length-1,Math.floor(a.length*v))].toFixed(2);return {median:at(.5),p95:at(.95),p99:at(.99),max:at(1)}}
for(const [section,base] of [['起步车群',0],['湿弯车群',480],['沿岸独跑',2200]]){
 grid(section==='沿岸独跑'?base-150:base);
 const set={interval:[],submit:[],gpu:[],calls:[],triangles:[]};
 let previous=0;
 for(let i=0;i<samples+20;i++){
  const t=await new Promise(requestAnimationFrame);
  frame.t=i/60;frame.d=base+40*frame.t; frame.x=.42*Math.sin(frame.t*.7);frame.yaw=.012*Math.sin(frame.t);
  drain();let q;if(timer&&i>=20&&i%2===0){q=gl.createQuery();gl.beginQuery(timer.TIME_ELAPSED_EXT,q);}
  calls=0;tris=0;const begin=performance.now();world.render(frame,null);const end=performance.now();
  if(q){gl.endQuery(timer.TIME_ELAPSED_EXT);queries.push({q,out:set.gpu})}
  if(i>=20){set.interval.push(t-previous);set.submit.push(end-begin);set.calls.push(calls);set.triangles.push(tris)}
  previous=t;
 }
 trace.push({section,intervalMs:summary(set.interval),slow33ms:set.interval.filter(v=>v>33.3).length,workMs:summary(set.submit),gpuMs:summary(set.gpu),medianDraws:summary(set.calls).median,medianTriangles:summary(set.triangles).median});
}
world.dispose();window.finished={prepared:${prepare},gpu:vendor,width:c.width,height:c.height,framesPerScene:samples,constructionMs:+(created-start).toFixed(1),firstDrawMs:+(cold-created).toFixed(1),trace};
`;
const res=await build({stdin:{contents:source,resolveDir:process.env.RAINPORT_GRAPHICS_SOURCE||process.cwd()},bundle:true,nodePaths:[path.resolve('node_modules')],write:false,format:'esm',target:'es2022'});
const server=http.createServer((req,out)=>{const js=req.url==='/bench.js';out.writeHead(200,{'Content-Type':js?'application/javascript':'text/html'});out.end(js?res.outputFiles[0].text:html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'rainport-gfx-profile-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--enable-webgl','--enable-unsafe-swiftshader','--remote-debugging-port=0','--window-size=1280,720','--force-device-scale-factor=1','--user-data-dir='+profile,'http://127.0.0.1:'+server.address().port],{stdio:'ignore',windowsHide:true});
let ws;
try{
 const until=Date.now()+90000,portFile=path.join(profile,'DevToolsActivePort');
 while(!fs.existsSync(portFile)&&Date.now()<until)await pause(100);
 const port=fs.readFileSync(portFile,'utf8').split(/\s+/)[0];
 const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise(ok=>ws.addEventListener('open',ok,{once:true}));
 let seq=0;
 const pending=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')console.error(m.params.exceptionDetails);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
 const cdp=(method,params)=>new Promise(ok=>{pending.set(++seq,ok);ws.send(JSON.stringify({id:seq,method,params}));});
 await cdp('Runtime.enable',{});
 let data;
 do{
  await pause(300);const p=await cdp('Runtime.evaluate',{expression:'window.finished',returnByValue:true});
  data=p.result?.result?.value;
 }while(!data&&Date.now()<until);
 if(!data)throw Error('Graphics benchmark did not finish');
 fs.mkdirSync('evidence/graphics',{recursive:true});
 fs.writeFileSync('evidence/graphics/'+tag+'.json',JSON.stringify(data,null,2));console.log(JSON.stringify(data));
}finally{ws?.close();browser.kill();server.close()}
