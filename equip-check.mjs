import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {copySnapshot} from './snapshot.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const fixture=path.join(root,'evidence','chain-YgTDt9','node-data');
const out=path.join(root,'evidence','assembly');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rainport-assembly-'));
const site=path.join(temp,'site');
const chain=path.join(temp,'chain-snapshot');
fs.mkdirSync(site);
fs.mkdirSync(out,{recursive:true});
copySnapshot(fixture,chain);
for(const name of ['Archive.sol','server.mjs','driver-sync.mjs','racer-profiles.mjs','physics.mjs',
  'index.html','style.css','art.mjs','gt27-studio.jpg','gt27-workshop.jpg','rainport-cover.webp']){
  fs.copyFileSync(path.join(root,name),path.join(site,name));
}
fs.symlinkSync(path.join(root,'node_modules'),path.join(site,'node_modules'),process.platform==='win32'?'junction':'dir');
execFileSync(process.execPath,[path.join(root,'build-practice.mjs'),site],{stdio:'inherit'});
process.env.PORT=process.env.EQUIP_CHECK_PORT||'19477';
process.env.RPC_PORT=process.env.EQUIP_CHECK_RPC||'19445';
process.env.RAINPORT_DATA=chain;
process.env.UWS_USE_FALLBACK='1';
const {launch}=await import(pathToFileURL(path.join(site,'server.mjs')));
const game=await launch({showcase:false});
const url='http://127.0.0.1:'+process.env.PORT;
const serial=n=>'#'+String(n).padStart(3,'0');
const report={snapshot:path.relative(root,fixture),wallet:'B',checks:[],receipts:{},screens:[],
  clientSHA256:createHash('sha256').update(fs.readFileSync(path.join(site,'client.mjs'))).digest('hex')};
const chrome=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile=path.join(temp,'chrome');
const browser=spawn(chrome,['--headless=new','--enable-webgl','--enable-unsafe-swiftshader','--no-first-run',
  '--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let ws;
async function wait(test,label,millis=22000){
  const end=Date.now()+millis;
  while(Date.now()<end){const value=await test();if(value)return value;await delay(90);}
  throw Error('超时 · '+label);
}
async function getReceipt(hash){
  const r=await game.node.provider.request({method:'eth_getTransactionReceipt',params:[hash]});
  assert.equal(Number(r.status),1);
  return r;
}
try{
  const state=await game.state('B');
  const previous=state.records.find(r=>r.driver==='B'&&r.prize===24);
  assert(previous,'快照须包含 B 掉落 #024 的已结算赛事');
  const car=state.assets.find(a=>a.id===previous.config[0]);
  const prize=state.assets.find(a=>a.id===previous.prize);
  assert.equal(prize.owner,state.address);
  assert.equal(prize.origin,previous.id);
  assert.deepEqual(car.parts,[2,0,4]);
  const old=car.parts[2], tire=20;
  assert.equal(prize.model,6);
  assert.equal(prize.mount,0);
  assert.equal(prize.lock,0);
  report.source={race:previous.id,rank:previous.rank,driver:state.address,prize:prize.id,model:prize.model,
    previousConfiguration:previous.config,workshopStart:[car.id,...car.parts]};
  report.receipts.reward=await getReceipt(previous.tx.at(-1));
  const devPort=path.join(profile,'DevToolsActivePort');
  await wait(()=>fs.existsSync(devPort),'启动 Chrome');
  const tabs=await (await fetch('http://127.0.0.1:'+fs.readFileSync(devPort,'utf8').split(/\s/)[0]+'/json/list')).json();
  ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise(ok=>ws.addEventListener('open',ok,{once:true}));
  const pending=new Map(),errors=[];
  let next=0;
  ws.onmessage=({data})=>{
    const m=JSON.parse(data);
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    const req=pending.get(m.id);
    if(req){pending.delete(m.id);if(m.error)req.reject(Error(m.error.message));else req.resolve(m.result);}
  };
  function cdp(method,params={}){
    return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({method,params,id}));});
  }
  async function evaluate(expression){
    const v=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(v.exceptionDetails)throw Error(v.exceptionDetails.exception?.description||v.exceptionDetails.text);
    return v.result.value;
  }
  const has=s=>wait(()=>evaluate('!!document.querySelector('+JSON.stringify(s)+')'),s);
  async function click(selector,label=''){
    const point=await wait(()=>evaluate(`(()=>{const b=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>!b.disabled&&b.textContent.includes(${JSON.stringify(label)})&&b.getClientRects().length);if(!b)return null;b.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`),'点击 '+selector+' '+label);
    for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  }
  async function select(selector,n){
    assert(await evaluate(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});if(!s||![...s.options].some(o=>o.value===${JSON.stringify(String(n))}&&!o.disabled))return false;s.value=${JSON.stringify(String(n))};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`),'可选择 '+selector+'='+n);
  }
  async function screen(name){
    await delay(100);
    const file=name+'.png',r=await cdp('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(out,file),Buffer.from(r.data,'base64'));
    report.screens.push(file);
  }
  const resize=(width,height)=>cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  const asset=id=>game.asset(id);
  async function signFit(control,part,slot,oldPart,name){
    const firstBlock=await game.node.provider.request({method:'eth_blockNumber',params:[]});
    await click(control);await has('.dialog');
    const note=await evaluate("document.querySelector('.dialog').innerText");
    assert(note.includes(serial(part||oldPart)),note);
    await click('.dialog button','签署并提交');
    await wait(()=>evaluate("!document.querySelector('.dialog')"),'签名确认');
    const logs=await game.arc.queryFilter(game.arc.filters.Fitted(car.id,part),Number(firstBlock)+1);
    const ev=logs.at(-1);
    assert(ev,'缺少 Fitted 事件 '+name);
    assert.equal(Number(ev.args.slot),slot);
    assert.equal(Number(ev.args.old),oldPart);
    assert.equal((await asset(car.id)).parts[slot],part);
    if(oldPart)assert.equal((await asset(oldPart)).mount,0);
    if(part)assert.equal((await asset(part)).mount,car.id);
    report.receipts[name]=await getReceipt(ev.transactionHash);
    report.checks.push({operation:name,car:car.id,slot,oldPart,newPart:part,block:ev.blockNumber,hash:ev.transactionHash});
  }
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
    const nativeFetch=window.fetch.bind(window);window.raceQueries=[];
    window.fetch=async function(route,opts){
      const res=await nativeFetch(route,opts);
      if(route==='/api/start'||route==='/api/replay')window.raceQueries.push({route,params:JSON.parse(opts.body),status:res.status});
      return res;
    };`});
  await resize(1440,960);await cdp('Page.navigate',{url});
  await has('#carSelect');await click('nav button','钱包');await has('#walletselect');
  await select('#walletselect','B');
  await wait(()=>evaluate("document.querySelector('.account')?.textContent.includes('B')"),'钱包 B');
  await click('nav button','比赛');await click('main button','查看结算');
  await wait(async()=>(await evaluate('location.hash'))==='#result='+previous.id,'结算赛事');
  await screen('result-with-drop');await click('main button','装配掉落部件');
  await has('#workshop-part');
  assert.equal(await evaluate("document.querySelector('#garagecar').value"),String(car.id));
  assert.equal(await evaluate("document.querySelector('#workshop-part').value"),String(prize.id));
  const slots=await evaluate("Array.from(document.querySelectorAll('.workshop-slot'),x=>x.dataset.slot)");
  assert.deepEqual(slots,['0','1','2']);
  assert(await evaluate("document.querySelector('[data-equipped=\"4\"]')!==null"));
  assert((await evaluate("document.body.innerText")).includes(serial(prize.id)));
  await screen('comparison');
  await resize(390,844);await evaluate('scrollTo(0,0)');await delay(120);
  assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'),'窄屏横向溢出');
  const labels=await evaluate("Array.from(document.querySelectorAll('[data-pick-slot]'),b=>b.getBoundingClientRect().toJSON())");
  assert.equal(labels.length,3);
  for(let i=0;i<labels.length;i++)for(const other of labels.slice(i+1)){
    const own=labels[i];
    assert(own.right<=other.left||other.right<=own.left||own.bottom<=other.top||other.bottom<=own.top,'窄屏零件标签相互遮挡');
  }
  await screen('mobile-workshop');await resize(1440,960);
  await signFit('#workshop-fit',prize.id,2,old,'replace-wing');
  assert.equal((await asset(prize.id)).origin,previous.id);
  assert.equal((await game.state('B')).active,null);
  await has('[data-stock-id="'+old+'"]');
  const row='[data-stock-id="'+old+'"]';
  await click('.workshop-stock summary');
  await click(row+' button','编号出售');await has('.dialog');
  assert((await evaluate("document.querySelector('.dialog').innerText")).includes(serial(old)));
  await click('.dialog button','关闭');
  assert(await evaluate("!document.querySelector('#workshop-race') || document.querySelector('#workshop-race').disabled"),'缺少轮胎时不能发车');
  await cdp('Page.reload');await has('#garagecar');
  assert.equal(await evaluate("document.querySelector('#garagecar').value"),String(car.id));
  await has('[data-equipped="'+prize.id+'"]');
  await has(row);
  await screen('fitted-after-refresh');
  await click('.workshop-slot[data-slot="1"]');await select('#workshop-part',tire);
  await signFit('#workshop-fit',tire,1,0,'fill-tire');
  await signFit('#workshop-remove',0,1,tire,'remove-tire');
  await select('#workshop-part',tire);await signFit('#workshop-fit',tire,1,0,'refit-tire');
  await screen('ready');
  const ready=await game.state('B'),config=[car.id,...(await asset(car.id)).parts];
  assert.equal(ready.balance,state.balance);
  assert.equal(ready.assets.length,state.assets.length);
  assert.deepEqual(config,[1,2,20,24]);
  await click('#workshop-race');
  await wait(()=>evaluate("document.querySelector('#delta')?.innerText.includes('幽灵')"),'加载经校验的上圈幽灵',40000);
  const queries=await evaluate('window.raceQueries');
  assert(queries.some(q=>q.route==='/api/replay'&&q.params.id===previous.id&&q.status===200));
  assert(queries.some(q=>q.route==='/api/start'&&q.params.car===car.id&&q.status===200));
  const active=game.runs.B;
  const entered=await game.arc.race(active.id,state.address);
  assert.deepEqual(entered.config.map(Number),config);
  const grid=(await game.arc.queryFilter(game.arc.filters.Grid(active.id,state.address))).at(-1);
  report.receipts.grid=await getReceipt(grid.transactionHash);
  report.rerun={id:active.id,ghostId:previous.id,config:entered.config.map(Number),configHash:entered.configHash,
    retainedOrigin:(await asset(prize.id)).origin,block:grid.blockNumber,hash:grid.transactionHash};
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
  await wait(()=>evaluate("Number(document.querySelector('#speed')?.innerText)>25"),'新配置起步');
  await screen('rerun-ghost');
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87});
  await click('.race-actions button','退出比赛');await click('.dialog button','确认退赛');
  await has('#carSelect');
  await click('nav button','车库');await has('#garagecar');await select('#garagecar',car.id);
  await click('.workshop-slot[data-slot="2"]');await select('#workshop-part',old);
  await click('#workshop-fit');await has('.dialog');
  assert((await evaluate("document.querySelector('.dialog').innerText")).includes(serial(prize.id)));
  const api=async(route,params)=>{
    const res=await fetch(url+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:'B',...params})});
    assert(res.ok);return res.json();
  };
  const peer=await api('tx',{fn:'fit',args:[car.id,2,19],expectedSlot:prize.id});
  const confirmed=await wait(async()=>{const j=await api('job',{id:peer.id});return j.status==='已确认'&&j;},'第二个客户端确认换装');
  report.receipts.concurrentFit=await getReceipt(confirmed.hash);
  await click('.dialog button','签署并提交');
  await wait(()=>evaluate("document.querySelector('.dialog')?.innerText.includes('槽内配件已更换')"),'拒绝过期装配预览');
  assert.equal((await asset(car.id)).parts[2],19);
  assert.equal((await asset(old)).mount,0);
  assert.equal(Number(await game.node.provider.request({method:'eth_blockNumber',params:[]})),Number(confirmed.block));
  report.stalePreview={displayedPart:prize.id,requestedPart:old,concurrentPart:19,finalPart:(await asset(car.id)).parts[2],
    peerReceipt:confirmed.hash,denial:await evaluate("document.querySelector('.dialog p').textContent")};
  await screen('stale-selection');
  await cdp('Page.navigate',{url:url+'/#result='+previous.id});
  await click('main button','装车再跑');await has('#workshop-fit-race');
  await signFit('#workshop-fit-race',prize.id,2,19,'fit-and-race');
  await wait(()=>evaluate("document.querySelector('#delta')?.innerText.includes('幽灵')"),'装配后一键追逐幽灵',40000);
  const shortcut=game.runs.B;
  const nextGrid=(await game.arc.queryFilter(game.arc.filters.Grid(shortcut.id,state.address))).at(-1);
  assert.notEqual(shortcut.id,active.id);
  assert.deepEqual(nextGrid.args.config.map(Number),config);
  report.receipts.shortcutGrid=await getReceipt(nextGrid.transactionHash);
  report.shortcut={id:shortcut.id,config:nextGrid.args.config.map(Number),ghost:previous.id,hash:nextGrid.transactionHash};
  await click('.race-actions button','退出比赛');await click('.dialog button','确认退赛');await has('#carSelect');
  assert.deepEqual(errors,[]);
  report.passed=true;
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,source:report.source,operations:report.checks,grid:report.rerun},null,2));
} finally{
  ws?.close();browser.kill();await game.stop();
}
