import {L,clamp,input,inputStep,sample,tick,rank} from './physics.mjs';

// Give keyboard transitions time to arrive before the referee commits that part of
// the lap. Rendering runs on the local race clock; settlement uses the referee only.
const inputWindowMs=360;
const validKeys=k=>Array.isArray(k)&&k.length===3&&[0,1].includes(k[0])&&[0,1].includes(k[1])&&[-1,0,1].includes(k[2]);
const gridTime=(t,step)=>+(Math.ceil(t/step-1e-7)*step).toFixed(3);
export function enableControls(r){r.controlStream=true;r.received=0;r.upcoming=[];}

export function receiveControls(r,changes,now){
  if(!Array.isArray(changes)||changes.length>64)throw Error('输入批次无效');
  let previous=r.upcoming.at(-1)?.[1]??r.t;
  for(const event of changes){
    if(!Array.isArray(event)||event.length!==5||!Number.isSafeInteger(event[0])||
       !Number.isFinite(event[1])||!validKeys(event.slice(2)))throw Error('驾驶输入无效');
    const [seq,requested,...keys]=event;
    if(seq<=r.received)continue;
    if(seq!==r.received+1)break; // A retry includes all unacknowledged transitions in order.
    const seconds=Math.max(0,(now-r.ms)/1000);
    const when=gridTime(Math.max(previous,r.t,clamp(requested,seconds-inputWindowMs/1000,seconds)),inputStep(r));
    r.upcoming.push([seq,when,...keys]);r.received=seq;previous=when;
  }
}

export function advanceRun(r,now){
  if(!r.controlStream)return sample(r,now);
  const target=now-inputWindowMs;
  while(r.upcoming.length&&r.ms+r.upcoming[0][1]*1000<=target+.001){
    const [,t,...keys]=r.upcoming.shift();
    input(r,keys,r.ms+t*1000);
  }
  return sample(r,target);
}

export function raceFrame(r,compact=false){
  const {trace,inputs,bots,...frame}=r;
  if(!compact)frame.bots=bots;
  // In the single-file game the response and the referee share a JS heap.
  return {...frame,keys:[...r.keys],sectors:[...r.sectors],rivalDelay:[...(r.rivalDelay||[])],
    upcoming:r.upcoming?.map(e=>[...e]),rank:rank(r)};
}

const analog=['d','x','v','yaw','steer','lateralV','bodySideSpeed','yawRate','rpm','slip','rumble','impact','accel','throttle','brake'];
const corrected=['d','x','yaw'];
const shortAngle=a=>a>Math.PI?a-Math.PI*2:a< -Math.PI?a+Math.PI*2:a;
export function makePrediction(opening,wall=Date.now(),clock=performance.now()){
  const origin=clock+opening.ms-wall, bots=opening.bots,dt=inputStep(opening);
  let anchor=opening, sequence=opening.received||0, pending=[], lastKeys=null;
  let sim, before={}, transitions=[], cursor=0, lastPaint=null;
  const offsets={d:0,x:0,yaw:0};
  const elapsed=now=>clamp((now-origin)/1000,0,240);
  function reset(){
    sim={...anchor,bots,keys:[...anchor.keys],sectors:[...anchor.sectors],rivalDelay:[...(anchor.rivalDelay||[])],trace:[],inputs:[]};
    before={...sim};
    transitions=[...(anchor.upcoming||[]),...pending];
    cursor=0;
  }
  function pose(now){
    // On a prolonged disconnection show the last predicted position; don't run an
    // entire unconfirmed lap locally or spend hundreds of ticks after a tab resumes.
    const t=Math.min(elapsed(now),anchor.t+2.5);
    while(sim.t+1e-7<t&&!sim.done&&sim.t<240){
      Object.assign(before,sim);
      while(cursor<transitions.length && transitions[cursor][1]<=sim.t+.00001)sim.keys=transitions[cursor++].slice(2);
      tick(sim,dt);
      sim.trace.length=0;
    }
    const mix=sim.t===before.t?1:clamp((t-before.t)/(sim.t-before.t),0,1);
    const r={...sim,t:Math.min(t,sim.t)};
    for(const k of analog)if(Number.isFinite(sim[k])){
      const amount=sim[k]-before[k];
      r[k]=before[k]+(k==='yaw'?shortAngle(amount):amount)*mix;
    }
    return r;
  }
  function reconcile(change,now) {
    const old=pose(now);
    change();reset();
    const fresh=pose(now);
    if(lastPaint===null||now-lastPaint>900||Math.abs(old.d-fresh.d)>60){
      for(const k of corrected)offsets[k]=0;
      return;
    }
    for(const k of corrected){
      const difference=(old[k]||0)-(fresh[k]||0);
      offsets[k]+=k==='yaw'?shortAngle(difference):difference;
    }
  }
  function accept(frame,now=performance.now()){
    if(frame.id!==anchor.id||frame.t<anchor.t||(frame.received||0)<(anchor.received||0))return;
    reconcile(()=>{
      anchor=frame;
      pending=pending.filter(e=>e[0]>(frame.received||0));
    },now);
  }
  function controls(keys,now=performance.now()){
    if(lastKeys&&keys.every((k,i)=>k===lastKeys[i]))return false;
    lastKeys=[...keys];
    const event=[++sequence,gridTime(elapsed(now),dt),...keys];
    // The current integration may already be one tick ahead for interpolation.
    pending.push(event);reset();
    return true;
  }
  function display(now=performance.now()){
    const r=pose(now),dt=lastPaint===null?0:clamp((now-lastPaint)/1000,0,.1);
    lastPaint=now;
    const decay=1-Math.exp(-dt/.13);
    for(const k of corrected){
      let correction=offsets[k]*decay;
      if(k==='d'&&correction>0)correction=Math.min(correction,Math.max(.06,r.v*.55)*dt);
      offsets[k]-=correction;
      if(Number.isFinite(r[k]))r[k]+=offsets[k];
    }
    r.d=clamp(r.d,0,L);
    return r;
  }
  reset();
  return {display,controls,accept,packet:()=>pending.slice(0,64),wait:now=>Math.max(0,(origin-now)/1000)};
}
