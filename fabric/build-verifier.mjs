import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'fabric/chaincode/verifiers/individual-v1.mjs');
const {outputFiles} = await build({absWorkingDir: root, entryPoints: ['duel-verifier.mjs'],
  bundle: true, write: false, format: 'esm', platform: 'browser', charset: 'utf8', legalComments: 'none'});
const bytes = Buffer.from(outputFiles[0].contents);
if (process.argv.includes('--check')) {
  if (!(await fs.readFile(target)).equals(bytes)) throw Error('验证程序构建产物与源码不一致，请重新生成。');
} else {
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, bytes);
}
console.log(createHash('sha256').update(bytes).digest('hex'), target);
