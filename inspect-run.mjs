import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copySnapshot} from './snapshot.mjs';

const evidence = fileURLToPath(new URL('./evidence', import.meta.url));
const runs = fs.readdirSync(evidence, {withFileTypes:true})
  .filter(entry => entry.isDirectory() && entry.name.startsWith('chain-'))
  .map(entry => path.join(evidence, entry.name))
  .filter(dir => fs.existsSync(path.join(dir, 'run.json')) && fs.existsSync(path.join(dir,'node-data','chain')))
  .map(dir => ({dir, run:JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8'))}))
  .filter(item => item.run.passed === 7)
  .sort((a,b) => b.run.finished.localeCompare(a.run.finished));
if (!runs.length) throw Error('尚无已通过的完整验收快照。');
const working = fs.mkdtempSync(path.join(os.tmpdir(),'rainport-review-'));
copySnapshot(path.join(runs[0].dir,'node-data'),working);
console.log('已复制验收现场到 ' + working);
process.env.RAINPORT_DATA = working;
process.env.RAINPORT_SHOWCASE = '0';
process.env.PORT ||= '8788';
process.env.RPC_PORT ||= '8546';
await import('./play.mjs');
