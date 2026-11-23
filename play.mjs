import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copySnapshot} from './snapshot.mjs';

const port = Number(process.env.PORT || 8787);
const address = 'http://127.0.0.1:' + port;
function prepareFirstVisit() {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const target = path.join(root,'data');
  const seed = path.join(root,'demo-seed');
  if (process.env.RAINPORT_DATA || fs.existsSync(target) || !fs.existsSync(path.join(seed,'showcase.json'))) return;
  const receipts = JSON.parse(fs.readFileSync(path.join(seed,'receipts.json'),'utf8'));
  const expires = receipts.filter(r=>r.fn==='list' && r.ok).map(r=>Number(r.args[3]));
  const now = Date.now()/1000;
  // Fresh installations always offer live orders, including when this build is opened months later.
  if (!expires.length || Math.min(...expires) < now+86400 || Math.max(...expires)>now+30*86400) return;
  const staging = fs.mkdtempSync(path.join(root,'.starting-'));
  copySnapshot(seed,staging);
  try { fs.renameSync(staging,target); }
  catch (err) { if (!fs.existsSync(target)) throw err; fs.rmSync(staging,{recursive:true,force:true}); }
}
async function alreadyPlaying() {
  try {
    const res = await fetch(address, {signal: AbortSignal.timeout(1800)});
    return res.ok && (await res.text()).includes('id="rainport"');
  } catch { return false; }
}
function openGame() {
  if (process.platform !== 'win32' || process.env.RAINPORT_OPEN_BROWSER === '0') return;
  // Only the local port is configurable.
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', address],
                      {detached: true, stdio: 'ignore', windowsHide: true});
  child.unref();
}
if (await alreadyPlaying()) {
  openGame();
} else {
  console.log('正在启动雨港。首次启动会部署合约并准备演示库存。');
  prepareFirstVisit();
  const {launch} = await import('./server.mjs');
  const instance = await launch({showcase:process.env.RAINPORT_SHOWCASE !== '0'});
  openGame();
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    await instance.stop();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
