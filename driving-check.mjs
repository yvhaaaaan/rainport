import assert from 'node:assert/strict';
import fs from 'node:fs';
import {racerProfiles} from './racer-profiles.mjs';
import {computeRivalProfile,CUT, DT, L, botD, botX, botPilot, curve, drop, ghostAt, newRun, odds, rank, splitTimes, standings, tick} from './physics.mjs';

const rebuilt=Array.from({length:49},(_,n)=>computeRivalProfile(Math.floor(n/7),n%7));
if(process.argv.includes('--write-profiles')){
 const text='// Computed with the v3 driving model. Regenerate with node driving-check.mjs --write-profiles.\n'+
  'export const racerProfiles=[\n'+rebuilt.map(profile=>' '+JSON.stringify(profile)).join(',\n')+'\n];\n';
 fs.writeFileSync(new URL('./racer-profiles.mjs',import.meta.url),text);
 process.exit(0);
}
assert.deepEqual(rebuilt,racerProfiles,'预计算对手轨迹与当前车辆模型不符');

// A deterministic comparison of the game's fixed-step dynamics, separate from
// the wall-clock races and transactions in the local-node acceptance run.
const seed='0x0000ff82';
function lap(label,spec,style='循迹'){
 const r=newRun(0,seed,'测试车手',[0,0,0,0],spec);
 while(!r.done&&r.t<240){
  r.keys=botPilot(r);
  if(style==='只踩油门')r.keys=[1,0,0];
  if(style==='提前制动'&&Math.abs(curve(r.d))>.58&&r.v>34)r.keys=[0,1,r.keys[2]];
  tick(r);
 }
 assert(r.done&&r.sectors.length===2);
 const [wet,straight]=splitTimes(r);
 return {label,spec,style,wet,straight,total:r.sectors[1],position:rank(r),
  terminalKmh:+(r.v*3.6).toFixed(2)};
}
const laps=[
 lap('借用车',[1,3,5]),lap('更换 R2 雨胎',[1,4,5]),lap('更换 E3 高速引擎',[2,3,5]),
 lap('更换 W3 高下压力尾翼',[1,3,6]),lap('借用车',[1,3,5],'只踩油门'),
 lap('借用车',[1,3,5],'提前制动'),
];
const [baseline,rain,engine,wing,noSteer,braking]=laps;
assert(rain.wet<baseline.wet);
assert(engine.straight<baseline.straight&&engine.terminalKmh>baseline.terminalKmh);
assert(wing.wet<baseline.wet&&wing.straight>baseline.straight);
assert(braking.wet>baseline.wet&&noSteer.total>baseline.total+4);
const field=newRun(0,seed,'测试车手',[0,0,0,0],[1,3,5]);
const rivals=standings(field);
assert.equal(rivals.length,7);
assert.equal(rank(field),8);
for(const bot of field.bots){
 let last=0;
 for(let t=0;t<bot[0]+bot[1];t+=DT){
  const d=botD(t,bot);
  assert(d>=last&&d<=L);
  last=d;
 }
 assert.equal(botD(bot[0]+bot[1],bot),L);
 assert(Math.abs(botD(bot[0],bot)-CUT)<8);
}
const dropCounts=[1,2,3,4,5,6,7,8].map(position=>{
 const counts=[0,0,0,0,0];
 for(let roll=0;roll<10000;roll++){
  const item=drop(position,roll,0);
  counts[item?item.edition+1:0]++;
 }
 assert.deepEqual(counts,odds[position===1?0:position<=3?1:position<=5?2:3]);
 return {position,counts};
});
function onStraight(){
 const r=structuredClone(field);
 Object.assign(r,{d:CUT+100,t:55,v:36,bots:[],keys:[1,0,0],throttle:1,gear:4});
 return r;
}
const turn=onStraight();
turn.keys=[1,0,1];
tick(turn);
assert(turn.steer>0&&turn.steer<1&&turn.lateralV>0);
const initialSteer=turn.steer;
for(let i=0;i<6;i++)tick(turn);
const heldYaw=turn.yaw,heldX=turn.x;
turn.keys[2]=0;tick(turn);
assert(heldYaw>0&&turn.x>heldX&&turn.steer>0&&turn.steer<1,'松开方向后车身应渐进回正');
const brakingRun=onStraight(),coasting=onStraight();
brakingRun.keys=[0,1,0];coasting.keys=[0,0,0];
for(let i=0;i<20;i++){tick(coasting);tick(brakingRun)}
assert(coasting.v>brakingRun.v+5&&coasting.v<36,'松油和制动须有不同的减速度');
const shoulder=onStraight();
Object.assign(shoulder,{x:1.014,yaw:.12,steer:.4,keys:[1,0,1]});tick(shoulder);
assert(shoulder.impact>0&&shoulder.rumble>.5&&shoulder.x<1.03);
const blocker=field.bots[0],contact=onStraight(),free=onStraight();
Object.assign(contact,{t:20,bots:[blocker],rivalDelay:[0],d:botD(20,blocker)-4.6,x:botX(20,blocker,0),v:48});
Object.assign(free,{t:20,d:contact.d,x:contact.x,v:48});
tick(contact);tick(free);
assert(contact.impact>0&&contact.v<free.v,'追上同车道慢车会失去速度');
const legacy=newRun(0,seed,'旧版车手',[0,0,0,0],[1,3,5],1);
while(!legacy.done){legacy.keys=botPilot(legacy);tick(legacy)}
assert.equal(legacy.sectors[1],86.688);
assert.equal(legacy.trace.at(-1).length,4);
assert.equal(ghostAt(legacy.trace,20).yaw,0);
const oldV2=newRun(0,seed,'旧版V2车手',[0,0,0,0],[1,3,5],2);
while(!oldV2.done){oldV2.keys=botPilot(oldV2);tick(oldV2)}
assert.equal(oldV2.sectors[1],86.638);

function stopFrom100(wet,tire){
 const r=onStraight(), start=wet?10:CUT+10;
 Object.assign(r,{v:100/3.6,d:start,keys:[0,1,0],spec:[1,tire,5],throttle:0,brake:0});
 for(let i=0;i<400&&r.v>.05;i++)tick(r);
 assert(r.v<.05);
 return +(r.d-start).toFixed(2);
}
const stoppingMetres={wetRoadTire:stopFrom100(true,3),wetRainTire:stopFrom100(true,4),dryRoadTire:stopFrom100(false,3)};
assert(stoppingMetres.wetRoadTire>stoppingMetres.wetRainTire+3);
assert(stoppingMetres.wetRoadTire>stoppingMetres.dryRoadTire+6);
function testTurn(brake){
 const r=onStraight();Object.assign(r,{d:180,v:34,throttle:0,brake,keys:[0,brake,1]});
 for(let i=0;i<8;i++)tick(r);
 return {yawRate:+r.yawRate.toFixed(3),sideForceG:+(r.lateralAccel/9.81).toFixed(3),slipAngle:+r.frontSlipAngle.toFixed(3)};
}
const cornerGrip={free:testTurn(0),fullBrake:testTurn(1)};
assert(cornerGrip.free.sideForceG>cornerGrip.fullBrake.sideForceG+.03);
assert(cornerGrip.free.yawRate>0&&cornerGrip.free.slipAngle>0);
const parked=onStraight();Object.assign(parked,{v:0,throttle:0,keys:[0,0,1]});
const parkedStart=parked.d;
for(let i=0;i<30;i++)tick(parked);
assert.equal(parked.d,parkedStart);assert.equal(parked.x,0);
const railRecoveries=[];
for(const angleDegrees of [6,20,40]){
 const car=onStraight(),startingSpeed=31;
 Object.assign(car,{d:2200,x:.94,v:startingSpeed,yaw:angleDegrees*Math.PI/180,gear:3,keys:[1,0,0]});
 let contacted=false,minimumSpeed=startingSpeed;
 for(let i=0;i<30;i++){tick(car);minimumSpeed=Math.min(minimumSpeed,car.groundSpeed);contacted||=car.impact>.05;}
 const angle=angleDegrees*Math.PI/180;
 assert(contacted&&minimumSpeed>startingSpeed*(Math.cos(angle)-.60*Math.sin(angle)-.07));
 let releaseSeconds=0;
 car.keys=[1,0,-1];
 while(releaseSeconds<3&&car.x>.70){tick(car);releaseSeconds+=DT;}
 assert(car.x<=.70,'反打方向后应能离开护栏');
 railRecoveries.push({angleDegrees,approachKmh:startingSpeed*3.6,minimumKmh:+(minimumSpeed*3.6).toFixed(2),
  releaseSeconds:+releaseSeconds.toFixed(2)});
}
const controls={railRecoveries,initialSteer,heldYaw,coastingKmhAfterOneSecond:+(coasting.v*3.6).toFixed(2),
 brakingKmhAfterOneSecond:+(brakingRun.v*3.6).toFixed(2),sideBarrierImpulse:+shoulder.impact.toFixed(3),
 rearContactKmhLost:+((free.v-contact.v)*3.6).toFixed(2),legacyLap:legacy.sectors[1],legacyV2Lap:oldV2.sectors[1],stoppingMetres,cornerGrip};
console.log(JSON.stringify({mode:'百赫兹双轴车辆动力学与历史兼容性验证',seed,outerStep:DT,dynamicsStep:DT/5,
 sectorSeconds:laps,rivals,controls,dropCounts},null,2));
