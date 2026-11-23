import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

// Run on a separate demo world. E.g. node motion-check.mjs http://127.0.0.1:19283 before
const url = new URL(process.argv[2]);
const label = process.argv[3] || 'run';
assert.match(label, /^[a-z0-9-]+$/i);
const output = path.join('evidence', 'motion');
fs.mkdirSync(output, {recursive:true});
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function gameProbe(jitter) {
  const result = window.motionProbe = {frames:[], replies:[], errors:[], renderer:'', lastT:0, grid:0};
  const pos = new WeakSet();
  const gl = WebGL2RenderingContext.prototype;
  const originalLocation = gl.getUniformLocation;
  const originalFloat = gl.uniform1f;
  const originalClear = gl.clear;
  let distance=null, draws=0;
  gl.getUniformLocation=function(program,name){
    const loc=originalLocation.call(this,program,name);
    if(loc && name==='viewer')pos.add(loc);
    return loc;
  };
  gl.uniform1f=function(loc,value){if(pos.has(loc))distance=value;return originalFloat.call(this,loc,value)};
  gl.clear=function(mask){if(this.canvas.classList.contains('race-world'))draws++;return originalClear.call(this,mask)};
  const raf=window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(ts=>{
    const before=draws;
    cb(ts);
    if(draws===before || distance===null)return;
    result.frames.push([performance.now(),distance,document.getElementById('raceclock')?.textContent]);
  });
  const nativeFetch=window.fetch.bind(window);
  let packet=0;
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  window.fetch=async (req,opt)=>{
    const route=typeof req==='string'?req:req.url;
    const drive=route.endsWith('/drive');
    // Reproducible additional end-to-end RTT, split across both directions.
    const delay=drive&&jitter?[150,225,175,250,200][packet++%5]:0;
    const sent=performance.now();
    if(delay)await wait(delay*.5);
    const res=await nativeFetch(req,opt);
    if(delay)await wait(delay*.5);
    const parse=res.json.bind(res);
    res.json=async ()=>{
      const v=await parse();
      if(route.endsWith('/start')){
        result.grid=v.ms;
        result.opening={physicsVersion:v.physicsVersion??1,controlStream:v.controlStream===true};
      }
      if(drive){result.replies.push([performance.now(),performance.now()-sent,v.t,v.d]);result.lastT=v.t;}
      return v;
    };
    return res;
  };
}

const percentile=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.min(s.length-1,Math.floor(s.length*p))]:null};
const round=n=>n===null?null:+n.toFixed(3);
const distribution=a=>Object.fromEntries([['p50',.5],['p95',.95],['p99',.99],['max',1]].map(([k,p])=>[k,round(percentile(a,p))]));
function summarize(frames,replies){
  const times=[], deltas=[], packetIntervals=[], holds=[], forwardExcess=[];
  let same=0, stalled=0, clockRollbacks=0, lastClock=null;
  for(let i=1;i<frames.length;i++){
    const [at,position,clock]=frames[i], [prevAt,prevPosition]=frames[i-1];
    const dt=at-prevAt, delta=position-prevPosition;
    times.push(dt);deltas.push(delta);
    // 65 m/s exceeds the fastest car's top speed. This separates a bad snap from
    // a legitimate long displacement caused by one long display frame.
    forwardExcess.push(Math.max(0,delta-dt*.065));
    if(Math.abs(delta)<.0001){same+=dt;stalled+=dt;}else if(same){holds.push(same);same=0;}
    const [m,s]=String(clock).split(':').map(Number);
    if(Number.isFinite(s)){const value=m*60+s;if(lastClock!==null&&value+0.0001<lastClock)clockRollbacks++;lastClock=value;}
  }
  if(same)holds.push(same);
  for(let i=1;i<replies.length;i++)packetIntervals.push(replies[i][0]-replies[i-1][0]);
  const elapsed=frames.at(-1)[0]-frames[0][0];
  return {durationMs:round(elapsed),renderedFrames:frames.length,frameMs:distribution(times),framesAbove33ms:times.filter(v=>v>33.34).length,
    framesAbove50ms:times.filter(v=>v>50).length,freezeSharePct:round(100*stalled/elapsed),
    freezesOver50ms:holds.filter(v=>v>=50).length,worstHoldMs:round(Math.max(0,...holds)),
    distanceReversals:deltas.filter(v=>v<-.002).length,largestReverseM:round(-Math.min(0,...deltas)),
    hudClockReversals:clockRollbacks,largestForwardStepM:round(Math.max(0,...deltas)),
    implausibleForwardSteps:forwardExcess.filter(m=>m>.2).length,largestExcessM:round(Math.max(0,...forwardExcess)),
    packetRttMs:distribution(replies.map(r=>r[1])),packetIntervalMs:distribution(packetIntervals),replies:replies.length};
}
async function until(fn,name,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}throw Error('等待超时 '+name);}
async function measure(jitter){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'rainport-motion-chrome-'));
  const browser=spawn(chrome,['--headless=new','--enable-webgl','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check',
    '--disable-background-timer-throttling','--disable-features=Translate','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
  {windowsHide:true,stdio:'ignore'});
  let ws;
  try{
    const file=path.join(profile,'DevToolsActivePort');
    await until(()=>fs.existsSync(file),'Chrome');
    const port=fs.readFileSync(file,'utf8').split(/\s/)[0], base='http://127.0.0.1:'+port;
    const tab=(await (await fetch(base+'/json/list')).json()).find(t=>t.type==='page');
    ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
    const requests=new Map(), errors=[];let sequence=0;
    ws.onmessage=({data})=>{const m=JSON.parse(data);
      if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
      if(!m.id)return;
      const {yes,no}=requests.get(m.id);requests.delete(m.id);if(m.error)no(Error(m.error.message));else yes(m.result);};
    const cdp=(method,params={})=>new Promise((yes,no)=>{const id=++sequence;requests.set(id,{yes,no});ws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
    const click=async text=>{const p=await until(()=>js(`(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})&&!b.disabled);if(!e)return false;const r=e.getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*.5}})()`),text);
      for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
    const key=(k,down)=>cdp('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',key:k,code:'Key'+k.toUpperCase(),windowsVirtualKeyCode:k.toUpperCase().charCodeAt(0)});
    await cdp('Runtime.enable');await cdp('Page.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+gameProbe.toString()+')('+String(jitter)+')'});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
    const version=await cdp('Browser.getVersion');
    await cdp('Page.navigate',{url:String(url)});
    await click('进入雨港');await until(()=>js('window.motionProbe?.grid'),'比赛发车',55000);
    const gpu=await js(`(()=>{const c=document.querySelector('.race-world'),g=c.getContext('webgl2');const ext=g.getExtension('WEBGL_debug_renderer_info');return {renderer:c.dataset.renderer,gpu:ext?g.getParameter(ext.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER),...motionProbe.opening}})()`);
    assert.equal(gpu.renderer,'webgl2');
    await key('w',true);await until(()=>js('motionProbe.lastT>=3'),'车辆起步');
    const begin=await js('performance.now()');
    await sleep(2700);await key('d',true);await sleep(320);await key('d',false);
    await sleep(1200);await key('a',true);await sleep(310);await key('a',false);
    await sleep(1300);await key('s',true);await sleep(330);await key('s',false);
    await sleep(5900);const end=await js('performance.now()');
    const captures=await js(`({frames:motionProbe.frames.filter(r=>r[0]>=${begin}&&r[0]<=${end}),replies:motionProbe.replies.filter(r=>r[0]>=${begin}&&r[0]<=${end})})`);
    await key('w',false);await click('退出比赛');await click('确认退赛');
    await until(()=>js("!!document.querySelector('#carSelect')"),'返回发车区');
    assert(captures.frames.length>35 && captures.replies.length>10);
    assert(captures.frames.at(-1)[1]-captures.frames[0][1]>100);
    assert.deepEqual(errors,[]);
    return {condition:jitter?'added-rtt-jitter-150-250ms':'normal-loopback',chrome:version.product,...gpu,
      ...summarize(captures.frames,captures.replies), errors,
      first6sMoving:summarize(captures.frames.filter(r=>r[0]-begin<=6000),captures.replies.filter(r=>r[0]-begin<=6000)),
      samples:{frames:captures.frames.map(([a,d,t])=>[round(a-begin),round(d),t]),replies:captures.replies.map(([a,r,t,d])=>[round(a-begin),round(r),t,round(d)])}};
  }finally{ws?.close();browser.kill();}
}
const hash = createHash('sha256').update(Buffer.from(await(await fetch(new URL('client.mjs',url))).arrayBuffer())).digest('hex');
const result={label,bundleSha256:hash,window:'12s driving after race clock reaches 3s; WebGL clear, road viewer uniform and HUD clock sampled after actual render callbacks',resolution:'1280x720 DPR 1',conditions:[]};
for(const jitter of [false,true]){
  const condition=await measure(jitter);result.conditions.push(condition);
  fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify(result));
  const {samples,...summary}=condition;console.log(JSON.stringify(summary));
}

if(label==='after' && fs.existsSync(path.join(output,'before.json'))){
  const baseline=JSON.parse(fs.readFileSync(path.join(output,'before.json'),'utf8'));
  const compact=c=>({frames:c.renderedFrames,p95FrameMs:c.frameMs.p95,maxFrameMs:c.frameMs.max,framesAbove50ms:c.framesAbove50ms,
    medianRttMs:c.packetRttMs.p50,stopPct:c.freezeSharePct,stopsAbove50ms:c.freezesOver50ms,longestStopMs:c.worstHoldMs,
    reversals:c.distanceReversals,largestForwardStepM:c.largestForwardStepM,implausibleForwardSteps:c.implausibleForwardSteps});
  const compare={protocol:'Chrome 1280×720，独立本地链。借用车从起步后3秒起，持续油门并依次右转、左转、短刹车。延迟档的双向附加 RTT 循环取150、225、175、250、200毫秒。',
    intervals:'采样约12秒，并单列持续运动的前6秒。每个通过 WebGL clear 并实际绘制的帧从道路着色器 viewer 读取纵向位置。帧间隔包含浏览器与系统调度。',
    before:baseline.bundleSha256,after:result.bundleSha256,gpu:result.conditions[0].gpu,conditions:result.conditions.map((c,i)=>({condition:c.condition,
      movingFirst6s:{before:compact(baseline.conditions[i].first6sMoving),after:compact(c.first6sMoving)},
      entireRun:{before:compact(baseline.conditions[i]),after:compact(c)}}))};
  fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(compare,null,2));
}
