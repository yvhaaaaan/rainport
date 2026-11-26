import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

// Start an isolated, initialized Fabric node and its web server, then point
// RAINPORT_UI_URL at that server. Each run registers two new test identities.
const url = process.env.RAINPORT_UI_URL;
if (!url) throw Error('Set RAINPORT_UI_URL to the isolated Fabric web server');
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const second = process.env.SECOND_BROWSER_PATH || (fs.existsSync(edge) ? edge : chrome);
const clients = [];
const browserProfiles = [];
const profileRoot = path.resolve(process.env.RAINPORT_FABRIC_NETWORK || fileURLToPath(new URL('../.fabric-local/',import.meta.url)));

async function wait(check, label, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await pause(150);
  }
  throw Error('Timed out: ' + label);
}

async function browser(exe) {
  const profile = fs.mkdtempSync(path.join(profileRoot, 'rainport-signed-duel-'));
  browserProfiles.push(profile);
  const child = spawn(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0', '--window-size=720,560', '--user-data-dir=' + profile, 'about:blank'],
    {windowsHide:true, stdio:'ignore'});
  let failed;
  child.once('error', err => { failed = err; });
  const client = {child};
  clients.push(client);
  const activePort = path.join(profile, 'DevToolsActivePort');
  await wait(() => { if (failed) throw failed; return fs.existsSync(activePort); }, 'browser startup');
  const port = fs.readFileSync(activePort, 'utf8').split(/\s+/)[0];
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  client.ws = ws;
  await new Promise((ok, fail) => { ws.onopen=ok; ws.onerror=fail; });
  const requests = new Map();
  let id = 0;
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if(ws.readyState!==WebSocket.OPEN){reject(Error('Browser closed during '+method));return;}
      const requestId=++id;
      const timeout=setTimeout(()=>{
        requests.delete(requestId);
        reject(Error('Browser timed out during '+method));
      },30000);
      requests.set(requestId, {resolve,reject,timeout});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  ws.onclose=()=>{
    for(const request of requests.values()){clearTimeout(request.timeout);request.reject(Error('Browser connection closed'));}
    requests.clear();
  };
  ws.onmessage = ({data}) => {
    const m = JSON.parse(data), request = requests.get(m.id);
    if (m.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog',{accept:true});
    if (!request) return;
    requests.delete(m.id);
    clearTimeout(request.timeout);
    if (m.error) request.reject(Error(m.error.message));
    else request.resolve(m.result);
  };
  const js = async expression => {
    const answer = await send('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
    if (answer.exceptionDetails) throw Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
    return answer.result.value;
  };
  const selector = (act, value) => '[data-act="'+act+'"]' +
    (value === undefined ? '' : '[data-value="'+value+'"]');
  const present = css => js('Boolean(document.querySelector('+JSON.stringify(css)+'))');
  const element = css => wait(() => present(css), css);
  const click = async (action, value) => {
    const css = selector(action,value);
    await element(css);
    await js('document.querySelector('+JSON.stringify(css)+').click()');
  };
  const fill = (css, value) => js('document.querySelector('+JSON.stringify(css)+').value='+JSON.stringify(value));
  const text = css => js('document.querySelector('+JSON.stringify(css)+')?.innerText');
  const accelerator = pressed => send('Input.dispatchKeyEvent',{type:pressed?'keyDown':'keyUp',
    key:'w',code:'KeyW',windowsVirtualKeyCode:87});
  Object.assign(client, {send,js,element,selector,click,fill,text,accelerator});
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  // Observe the same public room, inventory and receipt responses that the UI
  // renders. Never copy a session token or a private browser key.
  await send('Page.addScriptToEvaluateOnNewDocument', {source:`
    window.observed = {};
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args), route = String(args[0]).split('/').pop();
      if (response.ok && ['poll','drive','join','create','match','info','inventory','receipt'].includes(route)) {
        const record = await response.clone().json();
        if (record.phase) window.observed.frame = record;
        window.observed[route] = record;
      }
      return response;
    };`});
  await send('Page.navigate',{url});
  await element('#alias');
  return client;
}

async function register(client, alias) {
  await client.fill('#alias',alias);
  await client.click('register');
  await client.element('#car option');
  const first = await client.js('observed.inventory');
  assert.equal(first.assets.length, 4);
  await client.click('logout');
  await client.element('#alias');
  await client.click('login');
  await client.element('#car option');
  assert.equal(await client.js('observed.inventory.player.id'), first.player.id);
  return first.player.id;
}

async function openRoom(drivers, quick) {
  const count = drivers.length, [host] = drivers;
  await host.fill('#capacity',String(count));
  await host.click(quick ? 'match' : 'create');
  await host.element('#room-code');
  const code = await host.text('#room-code');
  for (let n=1; n<count; n++) {
    const next = drivers[n];
    if (quick) await next.fill('#capacity',String(count));
    else await next.fill('#code',code);
    await next.click(quick ? 'match' : 'join');
    if (n<count-1) {
      await next.element('#room-code');
      assert.equal(await next.text('#room-code'),code);
      await wait(() => host.js('observed.frame.members.length === '+(n+1)), 'waiting for more drivers');
      assert.equal(await host.js('observed.frame.phase'),'waiting');
    }
  }
  await Promise.all(drivers.map(client => client.element('#peer-position')));
  for (const c of drivers) {
    const frame = await c.js('observed.frame');
    assert.equal(frame.code,code);
    assert.equal(frame.capacity,count);
    assert.equal(frame.members.length,count);
    assert.equal(frame.bots.length,8-count);
    assert.equal(await c.js("document.querySelectorAll('#peer-position .peer-line').length"),count-1);
    assert.equal(await c.js("document.querySelectorAll('.human-dot').length"),count-1);
  }
  console.log('Started '+count+'-player '+(quick?'matched':'invited')+' room '+code);
  return code;
}

async function ledgerState(client,id) {
  return client.js(`(async()=>{
    const res=await fetch('/api/duel/info',{method:'POST',headers:{'Content-Type':'application/json',
      Authorization:'Bearer '+sessionStorage.getItem('duel.token')},body:JSON.stringify({id:${JSON.stringify(id)}})});
    const state=await res.json();if(!res.ok)throw Error(state.error);return state;
  })()`);
}

async function repeatClaim(client,race) {
  // The normal UI removes the claim button after payment. Exercise a fresh,
  // authentic signature from the original, non-exportable browser key.
  const source=fs.readFileSync(new URL('../player-keys.mjs',import.meta.url)).toString('base64');
  const signature=await client.js(`(async()=>{
    const {findPlayerKey,signPlayerAction}=await import(${JSON.stringify('data:text/javascript;base64,'+source)});
    const key=await findPlayerKey(sessionStorage.getItem('duel.alias'));
    async function api(route,body={}) {
      const r=await fetch('/api/duel/'+route,{method:'POST',headers:{'Content-Type':'application/json',
        Authorization:'Bearer '+sessionStorage.getItem('duel.token')},body:JSON.stringify(body)});
      const json=await r.json();if(!r.ok)throw Error(json.error);return json;
    }
    const [{domain},player]=await Promise.all([api('domain'),api('player')]);
    const before=await api('inventory');
    await api('action',{envelope:await signPlayerAction(key,domain,player.nonce+1,'duelConfirm',
      ${JSON.stringify([race.manifest.id,race.inputHashes,race.results,race.resultHash])})});
    const after=await api('inventory');
    return {before:before.assets.map(a=>a.id),after:after.assets.map(a=>a.id)};
  })()`);
  assert.deepEqual(signature.before,signature.after);
  const after=await ledgerState(client,race.manifest.id);
  assert.deepEqual(after.prizes,race.prizes);
  assert.deepEqual(after.confirmations,race.confirmations);
}

async function finishRace(drivers,{quick=false,solo=false,refuseLast=false}={}) {
  const count=drivers.length, finishers=solo?drivers.slice(0,1):drivers;
  await openRoom(drivers,quick);
  await Promise.all(drivers.map(c=>c.accelerator(true)));
  await Promise.all(drivers.map(c=>wait(()=>c.js('observed.frame.drivers?.every(d=>d.d>10)'), 'all cars moving')));
  await Promise.all(drivers.map(c=>wait(()=>c.js(
    "Array.from(document.querySelectorAll('#peer-position b')).every(el=>/P\\d+ · [1-9]\\d* m/.test(el.textContent))"), 'each opponent position rendered')));
  const raceId=await drivers[0].js('observed.frame.id');
  if(refuseLast){
    // A short drop releases the pedal on the authoritative timeline. This
    // driver reconnects with the key still held and later signs that record.
    const reconnecting=drivers[0], previous=await reconnecting.js('observed.frame.received');
    await reconnecting.send('Network.enable');
    const network={latency:0,downloadThroughput:-1,uploadThroughput:-1};
    try {
      await reconnecting.send('Network.emulateNetworkConditions',{...network,offline:true});
      await pause(8000);
    } finally { await reconnecting.send('Network.emulateNetworkConditions',{...network,offline:false}); }
    await wait(()=>reconnecting.js('observed.frame.automaticCount>0 && observed.frame.received>'+previous), 'held throttle resumed after reconnect');
  }
  if(solo){
    for(const c of drivers.slice(1)){
      await c.click('withdraw');
      await c.element('#car option');
      await c.accelerator(false);
    }
    await wait(()=>drivers[0].js("observed.frame.phase==='racing' && observed.frame.drivers.filter(d=>Number.isInteger(d.dnfStep)).length === "+(count-1)), 'only remaining driver continues');
  }
  await Promise.all(finishers.map(c=>wait(async()=>{
    const phase=await c.js('observed.frame.phase');
    if(phase==='closed')throw Error(await c.text('#duel'));
    if(phase==='review')return true;
    // Blur releases pedals. Resume if a headless browser loses focus.
    if(await c.js("document.querySelector('[data-key=w]')?.getAttribute('aria-pressed')==='false'"))await c.accelerator(true);
    return false;
  }, 'drivers finish',250000)));
  await Promise.all(finishers.map(c=>c.accelerator(false)));
  for(const c of finishers){
    await c.element(c.selector('commit'));
    await wait(async()=>{
      const display=await c.text('#duel');
      return (display.match(/相差 0 ms/g)||[]).length===finishers.length &&
        (display.match(/名次差 0/g)||[]).length===finishers.length &&
        (display.match(/与终场记录一致/g)||[]).length===count-finishers.length;
    },'device replay verified for every driver');
  }
  const claimants=refuseLast?finishers.slice(0,-1):finishers;
  if(refuseLast){
    const c=finishers.at(-1);
    await c.click('refuse');
    await c.element('#car option');
  }
  for(const [i,c] of claimants.entries()){
    await c.click('commit');
    await c.click('confirm');
    await c.element(c.selector('leave'));
    const state=await ledgerState(c,raceId);
    assert.equal(state.playerStatus[i],'claimed');
    assert.equal(state.confirmations.filter(Boolean).length,i+1);
    assert.equal(state.commitments.filter(Boolean).length,i+1);
    for(let j=i+1;j<count;j++)assert.equal(state.prizes[j],0,'no prize without that player’s claim');
    if(i===0)await repeatClaim(c,state);
    await c.click('leave');
    await c.element('#car option');
  }
  const state=await ledgerState(drivers[0],raceId);
  assert.equal(state.status,'settled');
  assert.equal(state.manifest.finishPolicy,'individual-v1');
  assert.equal(state.results.length,count);
  assert.equal(state.results.filter(r=>r.rank!==null).length,finishers.length);
  assert(state.logs.every(log=>log.some(([,step,gas])=>Number.isInteger(step)&&gas===1)));
  const confirmed=state.confirmations.filter(Boolean);
  assert.equal(new Set(confirmed.map(p=>p.envelope.id)).size,claimants.length);
  assert(confirmed.every(p=>p.resultHash===state.resultHash));
  if(solo){
    assert(state.results.slice(1).every(r=>r.rank===null&&r.totalMs===null&&Number.isInteger(r.dnfStep)));
    assert(state.playerStatus.slice(1).every(s=>s==='withdrawn'));
  }
  if(refuseLast)assert.equal(state.playerStatus.at(-1),'refused');
  console.log('Final classifications: '+state.results.map((r,n)=>state.playerStatus[n]+' '+(r.rank===null?'DNF':r.totalMs+' ms')).join(', '));
  return state;
}

async function trade(seller,buyer,token,raceId,count) {
  await seller.click('inventory');
  await seller.click('offer',token);
  await seller.fill('#ask-kind','2');
  await seller.fill('#price','67');
  await seller.click('list',token);
  const order = await wait(() => seller.js('observed.inventory.orders.find(o=>o.status===1 && o.ids.includes('+token+'))'), 'committed listing');
  await buyer.click('market');
  await buyer.click('buy',order.id);
  const settled = await wait(() => buyer.js('observed.inventory.orders.find(o=>o.id==='+order.id+' && o.status===2)'), 'committed sale');
  assert.equal(settled.paid,67);
  await buyer.click('inventory');
  await buyer.click('label',token);
  await buyer.element('#proof');
  const provenance = await buyer.text('#detail');
  assert(provenance.includes(raceId));
  assert.equal((provenance.match(/确认回执/g) || []).length,count);
  await buyer.click('receipt',settled.hashes.at(-1));
  await wait(() => buyer.js('observed.receipt?.validationCode==="VALID"'), 'valid Fabric receipt');
  const receipt = await buyer.js('observed.receipt');
  assert.equal(receipt.hash,settled.hashes.at(-1));
  console.log('Traded reward #'+token+' · Fabric block '+receipt.block+' · '+receipt.hash);
}

try {
  const resp=await fetch(url);
  assert.equal(resp.headers.get('X-Rainport-Ledger'),'fabric');
  fs.mkdirSync(profileRoot,{recursive:true});
  const sizes=process.argv.length>2?process.argv.slice(2).map(Number):[3,4];
  assert(sizes.every(n=>[2,3,4].includes(n)),'Pass room sizes from 2 to 4, e.g. 3 4');
  const fleet=await Promise.all(Array.from({length:Math.max(...sizes)},(_,n)=>browser(n===1?second:chrome)));
  const ids=[];
  for(const [n,c] of fleet.entries()) ids.push(await register(c,'浏览器车手'+(n+1)));
  assert.equal(new Set(ids).size,fleet.length);

  for(const [index,count] of sizes.entries()) {
    const drivers=fleet.slice(0,count);
    await finishRace(drivers,{quick:index%2===1,refuseLast:index===0&&count>=3});
  }
  // Actual drops are probabilistic. Every solo round must settle without a
  // co-signature. Continue until the sole finisher can sell an actual part.
  const drivers=fleet.slice(0,sizes.at(-1));
  let traded=false;
  for(let attempt=0; !traded&&attempt<9; attempt++) {
    const state=await finishRace(drivers,{quick:true,solo:true});
    if(!state.prizes[0])continue;
    await trade(drivers[0],drivers[1],state.prizes[0],state.manifest.id,1);
    traded=true;
  }
  assert(traded,'The sole finisher claimed each time but drew no parts in nine races');
  console.log('Verified '+sizes.join(', ')+' player racing, individual replay, withdrawals, repeat claim and transfer of a solo winner’s reward.');
} catch (error) {
  for (const client of clients) if (client.text) console.error((await client.text('body').catch(()=>'' )).slice(-800));
  throw error;
} finally {
  for (const client of clients) {
    if (client.ws?.readyState === WebSocket.OPEN) try { await Promise.race([client.send('Browser.close'),pause(2000)]); } catch {}
    client.ws?.close();
    if (client.child.exitCode===null) {
      await Promise.race([new Promise(ok=>client.child.once('exit',ok)),pause(4000)]);
      if (client.child.exitCode===null) client.child.kill();
    }
  }
  for (const profile of browserProfiles) {
    if (path.dirname(profile)===profileRoot && path.basename(profile).startsWith('rainport-signed-duel-'))
      await fs.promises.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  }
}
