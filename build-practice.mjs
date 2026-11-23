import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const directory=path.dirname(fileURLToPath(import.meta.url));
const outputDirectory=process.argv[2]?path.resolve(process.argv[2]):directory;
fs.mkdirSync(outputDirectory,{recursive:true});
const read=name=>fs.readFileSync(path.join(directory,name),'utf8');
const save=(name,contents)=>{
 const dest=path.join(outputDirectory,name);
 fs.writeFileSync(dest+'.next',contents);
 fs.renameSync(dest+'.next',dest);
};
const source=read('game.mjs');
const adapter="import {enableControls,receiveControls,advanceRun,raceFrame} from './driver-sync.mjs';\n"+read('practice.js')+
  "\nconst practiceRequest=makePractice();\nasync function fetch(url,options){const value=await practiceRequest(url.slice(5),JSON.parse(options.body));return {ok:true,json:async()=>value}}\n";
async function compile(offline){
 const contents=offline?source.replace('const LOCAL_MODE=true;',()=>adapter+'const LOCAL_MODE=false;'):source;
 const output=await build({stdin:{contents,resolveDir:directory,sourcefile:'game.mjs'},bundle:true,minify:true,
  write:false,format:offline?'iife':'esm',target:'es2020',charset:'utf8',legalComments:'inline'});
 return output.outputFiles[0].text;
}
const [web,practice]=await Promise.all([compile(false),compile(true)]);
save('client.mjs',web);
let html=read('index.html').replace('<title>弯道档案 · 雨港</title>','<title>弯道档案 · 雨港离线练习</title>')
 .replace('连接本地节点…','离线练习').replace('正在连接雨港本地节点…','正在打开发车区…')
 .replace(/<link rel="stylesheet" href="\/style.css"\s*\/?\s*>/,()=>'<style>'+read('style.css')+'</style>')
 .replace(/<script type="module" src="\/client.mjs"><\/script>/,()=>'<script>'+practice.replace(/<\/script/gi,'<\\/script')+'</script>');
for(const file of ['gt27-studio.jpg','gt27-workshop.jpg','rainport-cover.webp']){
 const type=file.endsWith('.jpg')?'jpeg':'webp';
 const uri='data:image/'+type+';base64,'+fs.readFileSync(path.join(directory,file)).toString('base64');
 html=html.replaceAll('./'+file,uri).replaceAll(file,uri);
}
save('practice.html',html);
console.log('已构建网页游戏和单文件离线版');
