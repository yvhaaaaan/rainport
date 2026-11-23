import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const read=n=>fs.readFileSync(new URL(n,import.meta.url),'utf8');
const PHYS=read('racer-profiles.mjs').replace('export const racerProfiles','const racerProfiles')+
 read('physics.mjs').replace(/^import .*$/m,'').replace(/^export (?=const |function )/gm,'').split('\nexport {')[0],PRACTICE=read('practice.js'),SUITE=read('scenarios.mjs').split('\nexport {')[0];
const checks=await (async()=>{let wall=Date.now(),seed=20261120;const D=class extends Date{static now(){return wall}};const M=Object.create(Math);M.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);const data=new Map();const storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};const mk=new Function('Date','Math','localStorage',PHYS+PRACTICE+';return {api:makePractice(),pilot:botPilot}');let {api,pilot}=mk(D,M,storage);
const req=(w,route,b={})=>api(route,{...b,wallet:w});const state=w=>req(w,'state');
const act=async(w,fn,args)=>{await req(w,'tx',{fn,args});return {practice:true,action:fn}};
const race=async(w,c)=>{let r=await req(w,'start',{car:c});while(!r.done&&r.t<240){wall+=100;r=await req(w,'drive',{id:r.id,keys:pilot(r)})}return req(w,'finish',{id:r.id})};
const bal=async w=>w==='托管'?(await state('A')).escrow:(await state(w)).balance;
const run=new Function(SUITE+';return runSeven')();return run({assert:(b,m)=>{if(!b)throw Error(m)},state,act,race,bal,settle:async(w,id)=>{({api,pilot}=mk(D,M,storage));return req(w,'finish',{id})},replay:id=>req('A','replay',{id}),repeatDraw:async(w,id)=>{await req(w,'finish',{id});return {practice:true,action:'再次结算'}},expiry:()=>Math.floor(wall/1000)+604800,parallel:async(id,p)=>{const a=await Promise.allSettled(['B','C'].map(w=>act(w,'buy',[id,p])));return a.map(v=>v.status==='fulfilled'?{ok:true,practice:true}:{ok:false,reason:v.reason.message})}});})();
console.log(JSON.stringify({mode:'练习适配器，确定性时钟，无链上回执',checks},null,2));
