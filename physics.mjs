import {racerProfiles} from './racer-profiles.mjs';
const L=3780,CUT=1820,DT=.05;
const models=['H01 潮汐底盘','E1 港湾引擎','E3 高速引擎','T1 公路胎','R2 雨胎','W1 短尾翼','W3 高下压力尾翼'];
const rarity=['普通','精良','稀有','传奇'];
const odds=[[0,2000,5000,2850,150],[1000,4500,3400,1050,50],[3000,5500,1200,290,10],[5500,4000,400,98,2]];
const pools=[[1,3,5,4],[4,2,6],[4,2,6],[4,2,6]];
const slot=m=>Math.ceil(m/2);
const curve=d=>d<CUT?(.78*Math.sin(d/156)+.22*Math.sin(d/70))*Math.max(0,Math.min(1,d/160,(CUT-d)/140)):0;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const botNames=['云岬','沙鸥','余烬','许澜','浅滩','冬青','汐音'];
const botSampleSeconds=2;
function vehicle(spec){
 return {spec:[...spec],d:0,x:0,v:0,t:0,keys:[0,0,0],sectors:[],trace:[[0,0,0,0]],done:false};
}
// Historical replay schedules use the original physics and starting grid.
function simulateLegacyRival(i,seed){
 const speedClass=(i+seed)%botNames.length;
 const r=vehicle([1,3,5]);
 const cruise=48.2-speedClass*.91;
 const braking=7.5+((seed+i*17)%13)*.22+speedClass*.38;
 const reaction=.25+((seed*3+i*7)%13)*.045;
 const distances=[0];
 while(!r.done){
  const target=cruise-braking*Math.abs(curve(r.d+20));
  r.keys=botPilot(r);
  r.keys[0]=Number(r.t>=reaction&&r.v<target);
  r.keys[1]=Number(r.v>target+1.1);
  tick(r);
  if(Math.round(r.t/DT)%(botSampleSeconds/DT)===0&&!r.done)distances.push(Math.round(r.d));
 }
 distances.push(L);
 return [...splitTimes(r),distances];
}
const legacyLanes=[-.68,.39,-.12,.68,-.4,.1,.83];
const trackHalfWidth=6.8;
const shifts=[0,11.8,20.1,28.9,37.4,45.8];
function roadCar(spec){
 return {...vehicle(spec),physicsVersion:2,steer:0,lateralV:0,yaw:0,slip:0,rumble:0,
  impact:0,accel:0,throttle:0,brake:0,gear:1,rpm:1150};
}
function simulateRival(i,seed){
 const r=roadCar([1,3,5]), side=i%2===0?-1:1, speedClass=(i+seed)%7;
 const cruise=47.7-speedClass*.9;
 const reaction=.42+((seed+i*13)%10)*.035;
 const startLane=side*(.48+(i%3)*.035);
 r.x=startLane;r.d=6+i*5.4;
 const distances=[r.d], lanes=[Math.round(r.x*100)];
 while(!r.done&&r.t<240){
  // Staggered rows merge into separate racing lines through the first bends.
  const bend=curve(r.d+25);
  const merge=clamp((r.d-60)/220,0,1);
  const lane=startLane+merge*(.17*bend+.08*Math.sin(r.d/145+i)-side*.055);
  const target=cruise-(8+speedClass*.43)*Math.abs(bend);
  r.keys=botPilot(r,lane);
  r.keys[0]=Number(r.t>=reaction&&r.v<target);
  r.keys[1]=Number(r.v>target+1.35);
  tick(r);
  if(Math.round(r.t/DT)%(botSampleSeconds/DT)===0&&!r.done){
   distances.push(+r.d.toFixed(1));lanes.push(Math.round(r.x*100));
  }
 }
 distances.push(L);lanes.push(Math.round(r.x*100));
 return [...splitTimes(r),distances,lanes];
}
function newRun(ms,id,driver,config,spec,version=4){
 const seed=parseInt(id.slice(-4),16)||0;
 const setup=version===1?simulateLegacyRival:version===2?simulateRival:newRival;
 const bots=botNames.map((_,i)=>setup(i,seed));
 const car=version===1?vehicle(spec):version===2?roadCar(spec):dynamicCar(spec);
 if(version===4)car.physicsVersion=4;
 return {...car,ms,id,driver,config:[...config],bots,rivalDelay:bots.map(()=>0),inputs:[]};
}
function botD(t,[a,b,distances]){
 if(t>=a+b)return L;
 if(!distances)return t<a?CUT*t/a:CUT+(L-CUT)*(t-a)/b;
 const i=Math.min(Math.floor(Math.max(0,t)/botSampleSeconds),distances.length-2);
 const end=i===distances.length-2?a+b:(i+1)*botSampleSeconds;
 const fraction=clamp((t-i*botSampleSeconds)/(end-i*botSampleSeconds),0,1);
 return distances[i]+(distances[i+1]-distances[i])*fraction;
}
function botX(t,[a,b,distances,lanes],i){
 if(!lanes)return legacyLanes[i];
 if(t>=a+b)return lanes.at(-1)/100;
 const n=Math.min(Math.floor(Math.max(0,t)/botSampleSeconds),lanes.length-2);
 const end=n===lanes.length-2?a+b:(n+1)*botSampleSeconds;
 const mix=clamp((t-n*botSampleSeconds)/(end-n*botSampleSeconds),0,1);
 return (lanes[n]+(lanes[n+1]-lanes[n])*mix)/100;
}
function legacyTick(r){
 if(r.done||r.t>=240)return;
 const [engine,tire,wing]=r.spec,[gas,brake,steer]=r.keys;
 const k=curve(r.d),grip=(tire===4?1.24:1)*(wing===6?1.3:1);
 const vmax=48.3+(engine===2?6.1:0)-(wing===6?2.5:0);
 const safe=vmax/(1+Math.abs(k)*.55/grip)+(wing===6?Math.abs(k)*4.8:0);
 const steeringRate=Math.min(1,r.v/5)*(.45+Math.min(r.v,55)*.024);
 r.x=clamp(r.x+(steer*steeringRate-k*(r.v/45)**2*.61/grip)*DT,-1.36,1.36);
 const acc=gas*(10.9-5.7*r.v/vmax)-brake*20-1-(r.v/vmax)**2*3.4-Math.max(0,r.v-safe)*.51-Math.max(0,Math.abs(r.x)-.91)*(10+r.v*.32);
 r.v=clamp(r.v+acc*DT,0,vmax);
 const last=r.d;r.d=Math.min(L,r.d+r.v*DT);
 for(const cut of [CUT,L])if(last<cut&&r.d>=cut)r.sectors.push(+(r.t+(cut-last)/r.v).toFixed(3));
 r.t=+(r.t+DT).toFixed(3);r.done=r.d>=L;
 if(r.done||Math.round(r.t/DT)%5===0)r.trace.push([r.t,+r.d.toFixed(2),+r.x.toFixed(3),+r.v.toFixed(2)]);
}
function approach(v,target,step){return v+clamp(target-v,-step,step)}
function traffic(r,nextX,dt=DT){
 // Cars share the same longitudinal clock used by classification and rendering.
 // Following a slower car clips closing speed; a following AI loses the same
 // distance as a small time delay when the player occupies its lane.
 for(let i=0;i<(r.bots?.length||0);i++){
  const b=r.bots[i], clock=Math.max(0,r.t-r.rivalDelay[i]), position=botD(clock,b);
  const gap=position-r.d;
  if(Math.abs(gap)>9||position>=L)continue;
  const bx=botX(clock,b,i),offset=nextX-bx;
  if(Math.abs(offset)>.292)continue;
  const bv=(botD(clock+dt,b)-position)/dt;
  if(gap>=3.5&&gap+(bv-r.v)*dt<4.65){
   const closing=Math.max(0,r.v-bv);
   r.v=Math.min(r.v,bv+Math.max(0,gap-4.65)/dt);
   r.impact=Math.max(r.impact,clamp(closing/11,0,1));
  }else if(gap<=-3.5&&-gap+(r.v-bv)*dt<4.65&&bv>r.v){
   r.rivalDelay[i]+=Math.min(dt,Math.max(0,(4.65+gap+(bv-r.v)*dt)/Math.max(1,bv)));
  }else if(Math.abs(gap)<3.55){
   const direction=Math.sign(offset)||((i%2)*2-1);
   if(r.lateralV*direction<0){
    r.impact=Math.max(r.impact,Math.min(.72,Math.abs(r.lateralV)*.65));
    r.v*=1-.014*r.impact;
    r.lateralV=direction*.075;
   }
   nextX=bx+direction*.292;
  }
 }
 return nextX;
}
// Existing API callers step by 50 ms. Live v4 controls use the same 10 ms
// integration grid for input, prediction, contact and the referee.
export const inputStep=r=>r.physicsVersion===4?.01:DT;
function tick(r,dt=DT){
 if(r.physicsVersion===4){
  for(let i=0;i<Math.round(dt/.01)&&!r.done;i++)dynamicTick(r,.01,1);
  return;
 }
 if(r.physicsVersion===3){dynamicTick(r);return}
 if(r.physicsVersion!==2){legacyTick(r);return}
 if(r.done||r.t>=240)return;
 const [engine,tire,wing]=r.spec,[gas,braking,steering]=r.keys;
 const v0=r.v,bend=curve(r.d),grip=(tire===4?1.24:1)*(wing===6?1.3:1);
 const top=48.3+(engine===2?6.1:0)-(wing===6?2.5:0);
 const safe=top/(1+Math.abs(bend)*.55/grip)+(wing===6?Math.abs(bend)*4.8:0);
 r.throttle=approach(r.throttle,gas,DT*(gas?4:8));
 r.brake=approach(r.brake,braking,DT*(braking?6:9));
 r.steer=approach(r.steer,steering,DT*(steering?3.5:5.5));
 const excess=Math.max(0,r.v-safe);
 const turning=Math.min(1,r.v/5)*(.45+Math.min(r.v,55)*.024);
 const drift=bend*(r.v/45)**2*.61/grip;
 const steeringGrip=1/(1+excess*.037/grip);
 const demand=turning*r.steer*steeringGrip-drift;
 r.lateralV+=(demand-r.lateralV)*(1-Math.exp(-DT*(6+grip)));
 r.slip=clamp(excess/(15*grip)+Math.abs(demand-r.lateralV)*.23,0,1);
 r.rumble=clamp((Math.abs(r.x)-.87)/.14,0,1)*Math.min(1,r.v/12);
 r.impact=Math.max(0,r.impact-DT*2.7);
 const resistance=.76+3.6*(r.v/top)**2;
 const traction=r.throttle*(10.9-5.7*r.v/top)-r.brake*20-resistance;
 const shoulder=Math.max(0,Math.abs(r.x)-.90)*(15+r.v*.68);
 r.v=clamp(r.v+(traction-excess*.51-shoulder)*DT,0,top);
 let nextX=traffic(r,r.x+r.lateralV*DT);
 if(Math.abs(nextX)>1.18){
  if(Math.abs(r.lateralV)>.15&&Math.abs(r.x)<1.1799){
   r.impact=Math.max(r.impact,Math.min(1,Math.abs(r.lateralV)*.85));
   r.v*=1-.085*r.impact;
  }
  nextX=Math.sign(nextX)*1.18;
  r.lateralV=0;
 }
 r.x=nextX;
 r.accel=(r.v-v0)/DT;
 const targetYaw=Math.atan2(r.lateralV*trackHalfWidth,Math.max(5,r.v))+r.steer*.028*Math.min(1,r.v/8);
 r.yaw+=(targetYaw-r.yaw)*(1-Math.exp(-7*DT));
 if(r.gear<6&&r.v>shifts[r.gear]*top/48.3)r.gear++;
 if(r.gear>1&&r.v<(shifts[r.gear-1]-2.3)*top/48.3)r.gear--;
 const shiftSpeed=(shifts[r.gear]||54)*top/48.3;
 r.rpm=Math.round(clamp(1050+r.v/shiftSpeed*5600+r.throttle*350,1050,7200));
 const before=r.d;
 r.d=Math.min(L,r.d+r.v*DT);
 for(const line of [CUT,L])if(before<line&&line<=r.d){
  r.sectors.push(+(r.t+(line-before)/r.v).toFixed(3));
 }
 r.t=+(r.t+DT).toFixed(3);r.done=r.d>=L;
 if(r.done||Math.round(r.t/DT)%5===0){
  const point=[r.t,+r.d.toFixed(2),+r.x.toFixed(3),+r.v.toFixed(2),
   +r.yaw.toFixed(3),+r.steer.toFixed(3),+r.slip.toFixed(2),+r.rumble.toFixed(2),+r.impact.toFixed(2)];
  if(r.rivalDelay?.some(seconds=>seconds>0))point.push(r.rivalDelay.map(seconds=>+seconds.toFixed(3)));
  r.trace.push(point);
 }
}

// Gravity, metre, second. Positive steering, lateral velocity and yaw turn right.
// The Frenet reference uses exactly the horizontal alignment of the rendered road.
const raceCar={mass:1260, inertia:1880, frontArm:1.18, rearArm:1.44, cg:.46, gravity:9.81};
// Original part numbers and collectible editions share the same model parameters.
export const partDynamics={
  1:{peakTorque:282}, 2:{peakTorque:334},
  3:{wetFriction:.70}, 4:{wetFriction:.86},
  5:{downforce:.53,drag:.52}, 6:{downforce:2.15,drag:.99}
};
const curvature=d=>.0039*curve(d);
const wheelbase=raceCar.frontArm+raceCar.rearArm;
const wheelLimit=v=>.54/(1+(v/11.4)**1.8);
const ratio=[0,3.20,2.16,1.60,1.29,1.08,.90];
const finalDrive=spec=>spec[0]===2?4.30:4.86;
const wheelRpm=(v,g,spec)=>v/(2*Math.PI*.326)*60*ratio[g]*finalDrive(spec);
function dynamicCar(spec){
 return {...roadCar(spec),physicsVersion:3,groundSpeed:0,bodySideSpeed:0,yawRate:0,
  frontSlipAngle:0,rearSlipAngle:0,lateralAccel:0,longitudinalAccel:0,shiftTime:0,previousAx:0};
}
function pilotTargets(r,lane){
 const preview=.45*r.v;
 const k=curvature(r.d+preview);
 const laneError=(lane-r.x)*trackHalfWidth;
 const v=Math.max(5,r.v), look=4.5+v*.56;
 const desiredYaw=Math.atan2(laneError,look);
 const kGoal=k+2*(desiredYaw-r.yaw-r.bodySideSpeed/v)/look;
 const desiredWheel=wheelbase*kGoal+.0038*v*v*kGoal-.048*(r.yawRate-v*kGoal);
 const grip=r.spec[1]===4?.65:.52;
 let speed=r.spec[0]===2?57:52;
 for(const ahead of [0,14,30,54,82]){
  const bend=Math.abs(curvature(r.d+ahead));
  if(bend<.0001)continue;
  const cornerSpeedSq=(grip*9.81*(r.spec[2]===6?1.27:1)) / bend;
  speed=Math.min(speed, Math.sqrt(cornerSpeedSq+2*4.5*ahead));
 }
 return {steer:clamp(desiredWheel/wheelLimit(r.v),-1,1),speed};
}
function dynamicSubstep(r,h){
 const {mass,inertia,frontArm,rearArm,cg,gravity}=raceCar;
 const [engine,tire,wing]=r.spec;
 const u=r.v,side=r.bodySideSpeed;
 const wet=clamp((CUT+55-r.d)/110,0,1);
 const kerb=clamp((Math.abs(r.x)*trackHalfWidth-5.83)/.77,0,1);
 const wingSpec=partDynamics[wing===6?6:5];
 const mu=(.99+wet*(partDynamics[tire===4?4:3].wetFriction-.99))*(1-.26*kerb);
 const downforce=wingSpec.downforce*u*u;
 const fz=mass*gravity+downforce;
 const frontLoad=clamp(fz*rearArm/wheelbase-mass*cg*r.previousAx/wheelbase,.25*fz,.78*fz);
 const rearLoad=fz-frontLoad;
 const steerAngle=r.steer*wheelLimit(u);
 const cos=Math.cos(steerAngle),sin=Math.sin(steerAngle);
 const atSpeed=Math.max(u,3.0);
 const frontSlip=steerAngle-Math.atan2(side+frontArm*r.yawRate,atSpeed);
 const rearSlip=-Math.atan2(side-rearArm*r.yawRate,atSpeed);
 const rpm=Math.max(1000,wheelRpm(u,r.gear,r.spec));
 const torque=partDynamics[engine===2?2:1].peakTorque*(.77+.23*Math.exp(-((rpm-4550)**2)/6200000));
 // ECU smoothly reduces engine torque near the rev limiter.
 const gas=r.physicsVersion===4&&r.keys[1]?0:r.throttle;
 const output=torque*ratio[r.gear]*finalDrive(r.spec)*.9/.326*
  clamp((6380-rpm)/380,0,1)*gas*(r.shiftTime>0?.18:1);
 const brakeForce=r.brake*mass*1.08*gravity;
 const frontCap=mu*frontLoad, rearCap=mu*rearLoad;
 // The GT's front/rear drive split and ABS bias share an axle friction circle.
 const rawFront=clamp(output*.38-brakeForce*.61,-frontCap,frontCap);
 const rawRear=clamp(output*.62-brakeForce*.39,-rearCap,rearCap);
 const motionSpeed=Math.max(u,Math.abs(side));
 const rolling=clamp(motionSpeed/3,0,1);
 const frontDemand=rolling*frontCap*Math.tanh(72000*frontSlip/frontCap);
 const rearDemand=rolling*rearCap*Math.tanh(96000*rearSlip/rearCap);
 const frontScale=1/Math.max(1,Math.hypot(rawFront,frontDemand)/frontCap);
 const rearScale=1/Math.max(1,Math.hypot(rawRear,rearDemand)/rearCap);
 const frontFy=frontDemand*frontScale,rearFy=rearDemand*rearScale;
 const frontFx=rawFront*frontScale,rearFx=rawRear*rearScale;
 const bodyFrontY=frontFy*cos+frontFx*sin;
 const drag=wingSpec.drag*u*u;
 const roll=mass*gravity*(.014+kerb*.082)*Math.min(1,u);
 const engineBrake=(1-r.throttle)*Math.min(680,u*18);
 // A yaw-stability brake acts only when the rear axle departs its linear range.
 const requestedRate=clamp(u*Math.tan(steerAngle)/(wheelbase+.0022*u*u),-mu*gravity/atSpeed,mu*gravity/atSpeed);
 const intervention=clamp((Math.abs(rearSlip)-.038)/.10,0,1);
 const yawBrake=clamp((requestedRate-r.yawRate)*inertia*8,-2300,2300)*intervention;
 const fx=frontFx*cos-frontFy*sin+rearFx-drag-roll-engineBrake-Math.abs(yawBrake)/.80;
 const bodyAx=fx/mass;
 const ay=(bodyFrontY+rearFy)/mass;
 const moment=(frontArm*bodyFrontY-rearArm*rearFy+yawBrake)/inertia;
 const low=clamp((motionSpeed-2)/3,0,1);
 const slowRate=u*Math.tan(steerAngle)/wheelbase;
 r.yawRate+=h*(moment*low+(slowRate-r.yawRate)*15*(1-low));
 r.bodySideSpeed+=h*((ay-u*r.yawRate)*low+(slowRate*rearArm-side)*15*(1-low));
 r.v=Math.max(0,u+h*(bodyAx+side*r.yawRate));
 if(r.v<.045&&Math.abs(r.bodySideSpeed)<.08&&r.throttle<.05){r.v=0;r.bodySideSpeed=0;r.yawRate=0;}
 const k=curvature(r.d);
 const cy=Math.cos(r.yaw),sy=Math.sin(r.yaw);
 const along=Math.max(0,(r.v*cy-r.bodySideSpeed*sy)/(1-k*r.x*trackHalfWidth));
 r.yaw+=h*(r.yawRate-k*along);
 r.yaw=Math.atan2(Math.sin(r.yaw),Math.cos(r.yaw));
 let cross=r.v*sy+r.bodySideSpeed*cy;
 let nextX=r.x+cross*h/trackHalfWidth;
 const clearance=Math.abs(cy)*.93+Math.abs(sy)*2.20;
 const limit=(7.88-clearance)/trackHalfWidth;
 if(Math.abs(nextX)>limit){
  const sign=Math.sign(nextX);
  nextX=sign*limit;
  // Use contact-point effective mass. A glancing front-corner impact rotates
  // the car toward the rail and keeps the velocity parallel to the barrier.
  const tangentArm=sign*(Math.sign(sy)*2.20*cy-Math.sign(cy)*.93*sy);
  const into=sign*(cross+tangentArm*(r.yawRate-k*along));
  if(into>0){
   const impulse=1.04*into/(1/mass+tangentArm*tangentArm/inertia);
   cross-=sign*impulse/mass;
   const tangent=Math.max(0,r.v*cy-r.bodySideSpeed*sy-.52*impulse/mass);
   r.v=Math.max(0,tangent*cy+cross*sy);
   r.bodySideSpeed=-tangent*sy+cross*cy;
   r.yawRate-=sign*tangentArm*impulse/inertia;
   r.impact=Math.max(r.impact,Math.min(1,into/5));
  }
 }
 r.lateralV=cross/trackHalfWidth;
 r.x=nextX;r.d+=along*h;
 r.previousAx+=(bodyAx-r.previousAx)*(1-Math.exp(-h*13));
 r.frontSlipAngle=frontSlip;r.rearSlipAngle=rearSlip;r.lateralAccel=ay;
 r.longitudinalAccel=bodyAx;r.rumble=kerb*Math.min(1,u/10);
 r.slip=clamp((Math.max(Math.abs(frontSlip),Math.abs(rearSlip))-.042)/.18,0,1)*Math.min(1,u/6);
}
function steerInput(r,key,h){
 if(r.physicsVersion!==4)return approach(r.steer,key,h*(key?2.7:4.1));
 const turnRate=3.6+1.0*clamp(1-r.v/30,0,1);
 if(key===0)return approach(r.steer,0,7.5*h);
 // A countersteer traverses the old lock quickly, then meters the new lock.
 // Preserve the tyre forces and yaw inertia when the driver reverses direction.
 if(r.steer*key<0){
  const unwind=Math.abs(r.steer)/10;
  if(unwind>=h)return approach(r.steer,0,10*h);
  return approach(0,key,turnRate*(h-unwind));
 }
 return approach(r.steer,key,turnRate*h);
}
function dynamicTick(r,dt=DT,substeps=5){
 if(r.done||r.t>=240)return;
 const before=r.d,v0=r.v;
 r.impact=Math.max(0,r.impact-dt*2.25);
 r.shiftTime=Math.max(0,r.shiftTime-dt);
 const rpm=wheelRpm(r.v,r.gear,r.spec);
 if(r.shiftTime===0){
  if(r.gear<6&&rpm>5960){r.gear++;r.shiftTime=.16}
  else if(r.gear>1&&rpm<3250){r.gear--;r.shiftTime=.12}
 }
 for(let i=0;i<substeps;i++){
  const h=dt/substeps;
  const braking=r.keys[1],v4=r.physicsVersion===4;
  const gas=v4&&braking?0:r.keys[0];
  r.throttle=approach(r.throttle,gas,h*(gas?4.6:v4&&braking?22:8));
  r.brake=approach(r.brake,braking,h*(v4?(braking?13:14):(braking?8:10)));
  r.steer=steerInput(r,r.keys[2],h);
  dynamicSubstep(r,h);
 }
 // Traffic response is evaluated against the same pre-step race clock as botD.
 const advance=r.d-before,unimpeded=r.v;r.d=before;
 const lane=traffic(r,r.x,dt);
 if(lane!==r.x){r.x=lane;r.bodySideSpeed=r.lateralV*trackHalfWidth-r.v*Math.sin(r.yaw);}
 const distanceAdvanced=advance*(unimpeded>.01?Math.min(1,r.v/unimpeded):1);
 r.d=Math.min(L,before+distanceAdvanced);
 r.accel=(r.v-v0)/dt;
 r.groundSpeed=Math.hypot(r.v,r.bodySideSpeed);
 r.rpm=Math.round(Math.max(1020+r.throttle*280,wheelRpm(r.v,r.gear,r.spec)));
 for(const line of [CUT,L])if(before<line&&line<=r.d)r.sectors.push(+(r.t+dt*(line-before)/distanceAdvanced).toFixed(3));
 r.t=+(r.t+dt).toFixed(3);r.done=r.d>=L;
 if((r.driver||r.config)&&(r.done||Math.round(r.t*1000)%250===0)){
  const p=[r.t,+r.d.toFixed(2),+r.x.toFixed(3),+r.v.toFixed(2),+r.yaw.toFixed(4),
    +r.steer.toFixed(3),+r.slip.toFixed(2),+r.rumble.toFixed(2),+r.impact.toFixed(2)];
  if(r.rivalDelay?.some(s=>s>0))p.push(r.rivalDelay.map(s=>+s.toFixed(3)));
  r.trace.push(p);
 }
}
// These immutable schedules were driven with the same 100 Hz car model at build time.
function newRival(i,seed){return racerProfiles[i*7+(seed+i)%7];}
function computeRivalProfile(i,group){
 const r=dynamicCar([1,3,5]), initial=(i%2===0?-1:1)*(.50+(i%3)*.03);
 r.x=initial;r.d=6+i*5.4;
 const distances=[r.d],lanes=[Math.round(initial*100)];
 while(!r.done&&r.t<240){
  const pilot=pilotTargets(r,initial+.09*curve(r.d+25));
  const speed=Math.min(46.2-group*.68,pilot.speed*(.91-group*.010));
  r.keys=[Number(r.t>.57&&r.v<speed),Number(r.v>speed+.9),pilot.steer];
  dynamicTick(r);
  if(Math.round(r.t/DT)%(botSampleSeconds/DT)===0&&!r.done){
   distances.push(+r.d.toFixed(1));lanes.push(Math.round(r.x*100));
  }
 }
 distances.push(L);lanes.push(Math.round(r.x*100));
 return [...splitTimes(r),distances,lanes];
}
function sample(r,ms){const until=Math.min(240,(ms-r.ms)/1000),dt=inputStep(r);while(!r.done&&r.t+dt<=until+1e-7)tick(r,dt);return r}
function input(r,keys,ms){if(!Array.isArray(keys)||keys.length!==3||![0,1].includes(keys[0])||![0,1].includes(keys[1])||![-1,0,1].includes(keys[2]))throw Error('驾驶输入无效');sample(r,ms);if(r.keys.join()!==keys.join()&&!r.done){r.inputs.push([r.t,...keys]);r.keys=[...keys]}}
function standings(r){const times=r.bots.map((s,i)=>({name:botNames[i],time:+(s[0]+s[1]+(r.rivalDelay?.[i]||0)).toFixed(3)}));if(r.done)times.push({name:r.driver,time:r.sectors[1]});return times.sort((a,b)=>a.time-b.time)}
function rank(r){return r.done?standings(r).findIndex(s=>s.name===r.driver)+1:1+r.bots.filter((s,i)=>botD(Math.max(0,r.t-(r.rivalDelay?.[i]||0)),s)>r.d).length}
function botPilot(r,targetLane=0){
 if(r.physicsVersion>=3){
  // A returned network frame still has its previous keys held until the next
  // input arrives. Forecast this interval at the same fixed step as the race.
  const lag=(Date.now()-r.ms)/1000-r.t;
  const delay=lag>0&&lag<.45?lag:0;
  let predicted=r;
  if(delay>=DT){
   predicted={...r,bots:[],driver:'',config:null,sectors:[],trace:[]};
   for(let t=DT;t<=delay+1e-7;t+=DT)tick(predicted);
  }
  const desired=pilotTargets(predicted,targetLane);
  let steer=0,best=Infinity;
  for(const key of [0,-1,1]){
   const reached=steerInput(predicted,key,Math.max(DT,delay));
   const error=Math.abs(reached-desired.steer);
   if(error<best){best=error;steer=key}
  }
  return [Number(predicted.v<desired.speed+.35),Number(predicted.v>desired.speed+1.35),steer];
 }
 const k=curve(r.d);
 const correction=k*(r.v/45)**2*.61/(r.spec[1]===4?1.24:1)
  +(targetLane-r.x)*4-(r.lateralV||0)*.95;
 return [1,0,correction>.18?1:correction<-.18?-1:0];
}
function ghostAt(trace,t){
 if(!trace?.length)return null;
 let i=0,j=trace.length-1;
 while(i+1<j){const m=(i+j)>>1;if(trace[m][0]<=t)i=m;else j=m}
 const a=trace[i],b=trace[j],f=clamp((t-a[0])/(b[0]-a[0]||1),0,1);
 const lerp=(n)=>(a[n]||0)+((b[n]||0)-(a[n]||0))*f;
 return {d:lerp(1),x:lerp(2),v:lerp(3),yaw:lerp(4),steer:lerp(5)};
}
function splitTimes(r){return [r.sectors[0],+(r.sectors[1]-r.sectors[0]).toFixed(3)]}
export const oddsForRank=rank=>odds[rank===1?0:rank<=3?1:rank<=5?2:3];
function drop(rank,roll,pick){const row=oddsForRank(rank);let e=-1;for(const p of row){if(roll<p)break;roll-=p;e++}return e<0?null:{edition:e,model:pools[e][pick%pools[e].length]}}

export {L,CUT,DT,computeRivalProfile,models,rarity,odds,pools,slot,curve,curvature,raceCar,clamp,newRun,botD,botX,tick,sample,input,standings,rank,botPilot,ghostAt,splitTimes,drop};
