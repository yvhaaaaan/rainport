import assert from 'node:assert/strict';
import {newRun} from './physics.mjs';
import {enableControls,receiveControls,advanceRun,raceFrame,makePrediction} from './driver-sync.mjs';

const referee=newRun(0,'ff01','测试',[0,0,0,0],[1,4,5]);
enableControls(referee);
const client=makePrediction(raceFrame(referee),0,0);
const reference=newRun(0,'ff01','测试',[0,0,0,0],[1,4,5]);
enableControls(reference);
const events=[[0,[1,0,0]],[1100,[1,0,1]],[1250,[1,0,0]],[2400,[0,1,0]],
  [2475,[1,0,0]],[6000,[1,0,-1]],[6200,[1,0,0]]];
let previous=-1,transition=0,maxError=0;
const messages=[],replies=[];
for(let ms=0;ms<7900;ms+=5){
  while(transition<events.length&&events[transition][0]<=ms){
    const keys=events[transition++][1];
    client.controls(keys,ms);
    receiveControls(reference,[[transition,ms/1000,...keys]],ms);
    messages.push({arrival:ms+80,changes:client.packet()});
  }
  if(ms%90===0)messages.push({arrival:ms+115,changes:client.packet()});
  for(const msg of messages.filter(m=>m.arrival===ms)){
    receiveControls(referee,msg.changes,ms);
    advanceRun(referee,ms);
    replies.push({arrival:ms+(ms%30===0?145:90),frame:raceFrame(referee,true)});
  }
  for(const m of replies.filter(m=>m.arrival===ms))client.accept(m.frame,ms);
  const r=client.display(ms);
  assert(r.d>=previous-1e-6,'回包触发了车身后跳');previous=r.d;
  if(ms%50===0){
    // Compare exact tick boundaries with a second referee receiving events on time.
    advanceRun(reference,ms+360);
    if(ms>7000)maxError=Math.max(maxError,Math.abs(r.d-reference.d));
  }
}
assert.equal(referee.received,events.length);
assert.deepEqual(referee.inputs.map(e=>e.slice(1)),events.map(e=>e[1]));
assert.equal(client.packet().length,0);
assert(maxError<.002,'预测和权威动力学未收敛');
console.log(JSON.stringify({transitions:referee.inputs.length,maximumSettledErrorM:maxError,reverseFrames:0}));
