import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {botPilot,inputStep,newRun,rank,tick} from './physics.mjs';
import {enableControls,makePrediction,receiveControls,advanceRun,raceFrame} from './driver-sync.mjs';

if(process.argv[2]==='--replay'){
 const directory=process.argv[3];
 const files=fs.readdirSync(directory).filter(file=>/^0x[0-9a-f]{64}\.json$/.test(file));
 assert(files.length,'没有可核对的赛事轨迹');
 const records=files.map(file=>{
  const {summary,replay}=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
  const r=newRun(0,summary.id,summary.driver,summary.config,summary.spec,replay.physicsVersion??3);
  let cursor=0;
  while(!r.done&&r.t<240){
   while(cursor<replay.inputs.length&&replay.inputs[cursor][0]<=r.t+1e-6)r.keys=replay.inputs[cursor++].slice(1);
   tick(r,inputStep(r));
  }
  // The persisted JSON format represents both -0 and +0 as 0.
  assert(JSON.stringify(r.trace)===JSON.stringify(replay.trace),'重演轨迹与裁判原始轨迹不同：'+summary.id);
  assert.equal(r.sectors[1],summary.total);
  return {race:summary.id,seconds:summary.total,rank:rank(r),tracePoints:r.trace.length,inputs:replay.inputs.length,identical:true};
 });
 console.log(JSON.stringify(records,null,2));
 process.exit(0);
}

// Exercise the same acknowledged input packets as the browser with a virtual clock.
const presets=[[100],[135],[100,118,107,135,111],[122,158,95,135,100]];
const loops=[];
for(let seed=0;seed<7;seed++){
 for(const cadence of presets){
  let wall=0,count=0,minWallSpeed=Infinity;
  const r=newRun(3000,seed.toString(16),'A',[1,2,7,4],[1,4,5]);
  enableControls(r);
  const predictor=makePrediction(raceFrame(r),0,0);
  while(!r.done&&wall<245000){
   const interval=cadence[count++%cadence.length];wall+=interval;
   const predicted=predictor.display(wall);
   const keys=botPilot(predicted);
   predictor.controls(keys,wall);
   receiveControls(r,predictor.packet(),wall);
   advanceRun(r,wall);
   predictor.accept(raceFrame(r,true),wall);
   if(r.d>200&&r.d<1700)minWallSpeed=Math.min(minWallSpeed,r.v);
  }
  loops.push({seed,cadence,rank:rank(r),time:r.sectors[1],minWetKmh:+(minWallSpeed*3.6).toFixed(1)});
 }
}
console.log(JSON.stringify(loops,null,2));
assert(loops.every(row=>row.rank===1&&row.time<90),'自动车手应在全部发车和回包组合中完赛获胜');
