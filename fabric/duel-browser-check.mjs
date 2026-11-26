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
      requests.set(++id, {resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  ws.onmessage = ({data}) => {
    const m = JSON.parse(data), request = requests.get(m.id);
    if (m.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog',{accept:true});
    if (!request) return;
    requests.delete(m.id);
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

async function race(a,b,quick = false) {
  await a.click(quick ? 'match' : 'create');
  await a.element('#room-code');
  const code = await a.text('#room-code');
  if (!quick) await b.fill('#code',code);
  await b.click(quick ? 'match' : 'join');
  await Promise.all([a,b].map(c => c.element('#peer-position')));
  for (const c of [a,b]) assert.equal(await c.js('observed.frame.code'),code);
  console.log('Started '+(quick?'matched':'invited')+' room '+code);
  await Promise.all([a,b].map(c => c.accelerator(true)));
  await Promise.all([a,b].map(c => wait(() => c.js('observed.frame.drivers?.every(d=>d.d>10) && observed.frame.bots.length===6'), 'both cars moving')));
  await Promise.all([a,b].map(c => wait(async () => /对手 P\d+ · [1-9]\d* m/.test(await c.text('#peer-position')), 'opponent position rendered')));
  await Promise.all([a,b].map(c => wait(async () => {
    const phase = await c.js('observed.frame.phase');
    if (phase === 'closed') throw Error(await c.text('#duel'));
    if (phase === 'review') return true;
    // Edge can move a headless tab to the background. The game correctly
    // releases pedals on blur, so resume the test driver's accelerator.
    if (await c.js("document.querySelector('[data-key=w]')?.getAttribute('aria-pressed')==='false'")) await c.accelerator(true);
    return false;
  }, 'both drivers finish',250000)));
  await Promise.all([a,b].map(c => c.accelerator(false)));
  const raceId = await a.js('observed.frame.id');
  await a.click('commit');
  await b.click('commit');
  await Promise.all([a,b].map(c => c.element(c.selector('confirm'))));
  for(const c of [a,b]) {
    const display = await c.text('#duel');
    assert.match(display,/相差 0 ms/);
    assert.match(display,/名次差 0/);
  }
  await a.click('confirm');
  await wait(() => a.js('observed.info.confirmations.filter(Boolean).length === 1'), 'first signature');
  assert.equal(await a.js('observed.info.status'),'review');
  assert.deepEqual(await a.js('observed.info.prizes'),[0,0]);
  await b.click('confirm');
  await Promise.all([a,b].map(c => c.element(c.selector('leave'))));
  const state = await a.js('observed.info');
  assert.equal(state.status,'settled');
  assert.equal(state.manifest.id,raceId);
  assert(state.logs.every(log => log.some(([,step,throttle]) => Number.isInteger(step) && throttle===1)));
  assert.equal(new Set(state.confirmations.map(p=>p.envelope.id)).size,2);
  assert(state.confirmations.every(p=>p.resultHash===state.resultHash));
  await Promise.all([a,b].map(c => c.click('leave')));
  await Promise.all([a,b].map(c => c.element('#car option')));
  return state;
}

async function trade(seller,buyer,token,raceId) {
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
  assert.equal((provenance.match(/确认回执/g) || []).length,2);
  await buyer.click('receipt',settled.hashes.at(-1));
  await wait(() => buyer.js('observed.receipt?.validationCode==="VALID"'), 'valid Fabric receipt');
  const receipt = await buyer.js('observed.receipt');
  assert.equal(receipt.hash,settled.hashes.at(-1));
  console.log('Traded reward #'+token+' · Fabric block '+receipt.block+' · '+receipt.hash);
}

try {
  const resp = await fetch(url);
  assert.equal(resp.headers.get('X-Rainport-Ledger'),'fabric');
  fs.mkdirSync(profileRoot,{recursive:true});
  const [a,b] = await Promise.all([browser(chrome),browser(second)]);
  const idA = await register(a,'浏览器甲'), idB = await register(b,'浏览器乙');
  assert.notEqual(idA,idB);
  let result = await race(a,b);
  // Dropping no parts is a legitimate random outcome. Repeat by quick match.
  for(let i=0; !result.prizes.some(Boolean) && i<8; i++) result=await race(a,b,true);
  const who = result.prizes.findIndex(Boolean);
  assert(who>=0,'No reward dropped in nine completed duels');
  await trade([a,b][who],[b,a][who],result.prizes[who],result.manifest.id);
  await Promise.all([a,b].map(c=>c.click('lobby')));
  await a.click('match');
  await a.element('#room-code');
  const code = await a.text('#room-code');
  await b.click('match');
  await Promise.all([a,b].map(c => c.element('#peer-position')));
  assert.equal(await b.js('observed.frame.code'),code);
  await a.click('refuse');
  await a.element('#car option');
  await b.element(b.selector('leave'));
  assert.match(await b.text('#duel'),/本场无奖励/);
  assert.equal(await b.js('observed.info.reason'),'refused');
  assert.deepEqual(await b.js('observed.info.prizes'),[0,0]);
  await b.click('leave');
  await b.element('#car option');
  console.log('Two independent browser logins, replay signatures, reward sale, provenance and quick matching passed.');
} catch (error) {
  for (const client of clients) if (client.text) console.error((await client.text('body')).slice(-800));
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
