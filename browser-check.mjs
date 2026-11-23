import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {botPilot} from './physics.mjs';
import {makePrediction} from './driver-sync.mjs';

// Run against a running demo or a restored acceptance snapshot.
const drive = process.argv.includes('--drive');
const review = process.argv.includes('--review');
const url = process.env.RAINPORT_UI_URL || ('http://127.0.0.1:' + (review ? 8788 : 8787));
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'rainport-chrome-'));
const dest = path.join('evidence',drive?'driving-3d':'screens');
fs.mkdirSync(dest,{recursive:true});
const browser = spawn(chrome,['--headless=new','--enable-webgl','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check',
  '--disable-background-timer-throttling','--disable-features=Translate','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
  {windowsHide:true,stdio:'ignore'});
const errors = [], log = [];
let ws;
async function until(check, what, seconds=25, interval=160) {
  const end = Date.now() + seconds*1000;
  while (Date.now()<end) {
    const v=await check();
    if (v) return v;
    await pause(interval);
  }
  throw Error('超时 · '+what);
}
try {
  const portFile=path.join(profile,'DevToolsActivePort');
  await until(()=>fs.existsSync(portFile),'启动浏览器');
  const port=fs.readFileSync(portFile,'utf8').split(/\s+/)[0];
  const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise(ok=>ws.addEventListener('open',ok,{once:true}));
  let seq=0;
  const requests=new Map();
  ws.onmessage=({data})=>{
    const m=JSON.parse(data);
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    const req=requests.get(m.id);
    if(req){requests.delete(m.id);if(m.error)req.reject(Error(m.error.message));else req.resolve(m.result);}
  };
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;requests.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
  });
  const js=async expression=>{
    const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  };
  const body=()=>js('document.body.innerText');
  const contains=(s)=>until(async()=>(await body()).includes(s),s);
  const waitFor=s=>until(()=>js('Boolean(document.querySelector('+JSON.stringify(s)+'))'),s);
  async function click(text,selector='button') {
    const found=await js(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>!b.disabled&&b.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    if(!found)throw Error('找不到按钮 '+text);
  }
  const size=(width,height)=>cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  async function snap(name){
    await pause(180);
    const png=await cdp('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(dest,name+'.png'),Buffer.from(png.data,'base64'));
    log.push({screen:name+'.png',text:(await body()).slice(0,4200)});
  }
  const nav=async(name,sel)=>{await click(name,'nav button');await waitFor(sel);};
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  if(drive)await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__intervals=[];let previous;
    function measure(t){if(document.querySelector('.race-world')&&previous)window.__intervals.push(t-previous);previous=t;requestAnimationFrame(measure)}requestAnimationFrame(measure);
    const original=window.fetch;window.fetch=async(...args)=>{const res=await original(...args);if(args[0]==='/api/start')res.clone().json().then(r=>window.__grid=r);if(args[0]==='/api/drive')res.clone().json().then(r=>window.__race=r);return res;};
    const Audio=window.AudioContext;if(Audio)window.AudioContext=class extends Audio{constructor(...a){super(...a);window.__sound=this;}};
  `});
  await size(drive?1280:1440,drive?720:960);
  await cdp('Page.navigate',{url});
  await waitFor('#carSelect');
  if(drive){
    const xy=await js("(()=>{const r=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('进入雨港')||b.textContent.includes('继续比赛')).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,...xy,button:'left',clickCount:1});
    await until(()=>js("document.querySelector('.race-world')?.dataset.renderer"),'生成赛道',55);
    const renderer=await js("document.querySelector('.race-world').dataset.renderer");
    assert.equal(renderer,'webgl2');
    await snap('grid');
    const held=new Set();
    const key=async(letter,on)=>{
      if(held.has(letter)===on)return;
      if(on)held.add(letter);else held.delete(letter);
      await cdp('Input.dispatchKeyEvent',{type:on?'keyDown':'keyUp',key:letter,code:'Key'+letter.toUpperCase(),windowsVirtualKeyCode:letter.toUpperCase().charCodeAt(0)});
    };
    const grid=await until(()=>js('window.__grid'),'起跑配置',30);
    await key('w',true);let wet=false,coast=false,sound='',maxSpeed=0,gear=0,braked=false;
    await until(async()=>{
      const r=await js('window.__race');
      if(!r||!r.id)return false;
      if(r.done)return true;
      const predicted=makePrediction({...r,bots:grid.bots}).display();
      const [gas,brake,steer]=botPilot(predicted),braking=Boolean(brake)||(r.t>17&&r.t<17.9);
      await key('w',Boolean(gas)&&!braking);await key('s',braking);await key('a',steer<0);await key('d',steer>0);
      braked ||= r.brake>.2;maxSpeed=Math.max(maxSpeed,r.v*3.6);gear=Math.max(gear,r.gear);
      if(!wet&&r.d>360){wet=true;sound=await js('window.__sound?.state');await snap('wet-bend');}
      if(!coast&&r.d>2270){coast=true;await snap('coast');}
      return false;
    },'键盘驾驶完赛',195,64);
    await waitFor('[data-reward-stage="sealed"]');await click('直接查看结果');
    await contains('最终名次');await snap('finish');
    assert(wet&&coast&&braked&&maxSpeed>120&&gear>=4&&sound==='running');
    const times=await js('window.__intervals.filter(v=>v>0).sort((a,b)=>a-b)');
    const e={renderer,audio:sound,maxKmh:+maxSpeed.toFixed(1),gear,braked,medianFrameMs:times[Math.floor(times.length/2)],p95FrameMs:times[Math.floor(times.length*.95)],capturedFrames:times.length};
    fs.writeFileSync(path.join(dest,'telemetry.json'),JSON.stringify(e,null,2));console.log(e);
  }else if(review){
    const state=await (await fetch(url+'/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:'A'})})).json();
    const first=state.records.find(r=>r.driver==='A'), second=state.records.find(r=>r.driver==='A'&&r.id!==first.id);
    const prize=state.assets.find(a=>a.id===first.prize);
    const serial='#'+String(prize.id).padStart(3,'0');
    const carSale=state.orders.find(o=>o.kind===3&&o.status===2);
    await js("document.querySelector('main details').open=true");
    await click('查看结算 ','main details button');await contains('最终名次');
    assert.equal(await js('location.hash'),'#result='+first.id);await snap('result');
    const initial=await js("document.querySelector('main').innerText");
    await cdp('Page.reload');
    await until(()=>js("performance.getEntriesByType('navigation')[0]?.type==='reload'"),'刷新浏览器');
    await contains('最终名次');
    assert.equal(await js("document.querySelector('main').innerText"),initial);
    if(prize.mount){
      await nav('展馆','.exhibit');await click(serial,'.pin button');
    } else {
      await nav('车库','#garagecar');
      await js("document.querySelector('.workshop-stock > summary').click()");
      await click('展签','[data-stock-id="'+prize.id+'"] button');
    }
    await contains('获得记录');await contains(second.id);await contains(first.id);await snap('provenance');
    await click('回放 ','.dialog button');await contains('链上三项摘要校验通过');await snap('replay');await click('关闭','.dialog button');
    await nav('钱包','#walletselect');
    await js("const sel=document.querySelector('#walletselect');sel.value='B';sel.dispatchEvent(new Event('change'))");
    await until(()=>js("document.querySelector('.account').textContent.includes('B')"),'切换至买方钱包');
    await click('订单 '+carSale.id);await waitFor('.dialog');await contains('490 CR');await snap('buyer-order');
    const purchase=state.history.find(j=>j.fn==='buy'&&Number(j.args[0])===carSale.id&&j.ok);
    await click('回执 '+purchase.h.slice(0,9),'.dialog button');
    await contains('交易哈希');await snap('receipt');
  } else {
    await snap('grid');
    await click('本场奖池');await contains('0.02%');await snap('prize-pool');await click('关闭','.dialog button');
    await nav('车库','#garagecar');await snap('garage');
    await nav('市场','#marketbody');await contains('暂无成交');await snap('market');
    await click('按编号买藏品');await click('查看原件展签');await contains('#018');await snap('serial');await click('关闭','.dialog button');
    await until(async()=>{const r=await fetch(url+'/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:'A'})});const s=await r.json();return s.orders.some(o=>o.kind===3&&o.status===1)},'展车实录与换胎完成',150);
    await nav('展馆','.body .exhibit');await contains('购买整车');await snap('hall');
    await click('购买整车');await contains('卖家实收');await snap('bundle');
    await click('关闭','.dialog button');
    await nav('比赛','#carSelect');
    await size(390,844);await snap('mobile');
    assert(await js('document.documentElement.scrollWidth <= innerWidth'),'手机页面超宽');
    await size(1440,960);
    await click('进入雨港');await waitFor('#speed');
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
    await until(()=>js("Number(document.querySelector('#speed')?.textContent)>15"),'实际起步',30);
    assert(Number.parseInt(await js("document.querySelector('#speed').textContent"))>15,'浏览器键盘油门未生效');
    await snap('driving');
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
    await click('退出比赛');await click('确认退赛');await waitFor('#carSelect');
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(dest,drive?'lap.json':review?'review.json':'demo.json'),JSON.stringify({url,errors,log},null,2));
  console.log(log.map(x=>x.screen).join(' · '));
} finally {
  ws?.close();
  browser.kill();
}
