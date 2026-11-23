import assert from 'node:assert/strict';
import {newRun, inputStep, tick, CUT} from './physics.mjs';
import {enableControls, makePrediction, receiveControls, advanceRun, raceFrame} from './driver-sync.mjs';

function straight(version) {
  const car=newRun(0,'00ff','A',[0,0,0,0],[1,3,5],version);
  Object.assign(car,{d:CUT+250,v:30,gear:4,bots:[],rivalDelay:[]});
  return car;
}

// Move the same 20 ms press through every possible phase of a 50 ms window.
// Observe both the predicted pedal/wheel and the referee that commits the replay.
function taps(version,index) {
  let visible=0,official=0,maxDiscrepancy=0;
  for(let phase=0;phase<50;phase++) {
    const car=straight(version);enableControls(car);
    const preview=makePrediction(raceFrame(car),0,0);
    const down=[0,0,0];down[index]=1;
    let predictedPeak=0,refereePeak=0;
    for(let ms=0;ms<=150;ms++) {
      if(ms===phase||ms===phase+20) {
        preview.controls(ms===phase?down:[0,0,0],ms);
        receiveControls(car,preview.packet(),ms);
      }
      const key=index===2?'steer':'brake';
      advanceRun(car,ms+360);
      const frame=preview.display(ms);
      predictedPeak=Math.max(predictedPeak,frame[key]);refereePeak=Math.max(refereePeak,car[key]);
      if(ms===150)maxDiscrepancy=Math.max(maxDiscrepancy,Math.abs(frame.d-car.d));
    }
    if(predictedPeak>.0001)visible++;
    if(refereePeak>.0001)official++;
  }
  return {tested:50,visible,official,maxDiscrepancyM:+maxDiscrepancy.toFixed(5)};
}

function timeTo(version,starting,keys,test) {
  const car=Object.assign(straight(version),starting,{keys});
  const display=makePrediction(raceFrame(car),0,0);
  for(let ms=0;ms<=1500;ms++)if(test(display.display(ms)))return ms;
  throw Error('控制输入在预期时间内未生效');
}
function inspect(version) {
  return {version,inputStepMs:inputStep(straight(version))*1000,
    steeringTaps:taps(version,2),brakeTaps:taps(version,1),
    reverseFromRightLockMs:timeTo(version,{steer:1},[0,0,-1],r=>r.steer<0),
    steeringReleaseMs:timeTo(version,{steer:1},[0,0,0],r=>Math.abs(r.steer)<.001),
    brake80PercentMs:timeTo(version,{throttle:1},[0,1,0],r=>r.brake>=.8)};
}
const previous=inspect(3),current=inspect(4);
for(const probe of [current.steeringTaps,current.brakeTaps]){
  assert.equal(probe.visible,50);assert.equal(probe.official,50);assert(probe.maxDiscrepancyM<.00001);
}
assert(current.reverseFromRightLockMs<previous.reverseFromRightLockMs*.5);
assert(current.brake80PercentMs<previous.brake80PercentMs*.8);
// 50 ms public steps must reproduce individual input steps for identical inputs.
const outer=straight(4),inner=straight(4);
for(let i=0;i<80;i++){
  outer.keys=inner.keys=[Number(i<45),Number(i>=45),i<15?1:i<37?-1:0];
  tick(outer);
  for(let j=0;j<5;j++)tick(inner,inputStep(inner));
}
assert.deepEqual(outer,inner);
console.log(JSON.stringify({setup:'借用车，沿岸直道 108 km/h，无邻车。20 ms 点按逐毫秒遍历 50 个起始相位；回正及反打从满舵测量。',previous,current},null,2));
