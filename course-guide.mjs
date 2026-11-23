import {CUT,clamp,curvature,partDynamics,raceCar} from './physics.mjs';

// Group meaningful bends by direction once. Broad transitions between them give
// the driver space to straighten the wheel before the next turn is called.
const bends=[];
let active;
for(let d=0;d<=CUT;d+=4){
  const k=curvature(d);
  if(Math.abs(k)<1/800){active=null;continue}
  const turn=k>0?'right':'left';
  if(!active||active.turn!==turn){
    active={turn,entry:d,apex:d,end:d,peak:0};bends.push(active);
  }
  active.end=d;
  if(Math.abs(k)>active.peak){active.peak=Math.abs(k);active.apex=d}
}

export function courseNote(r){
  if(r.done)return null;
  // When already riding the barrier, the next bend can point straight into it.
  // Give the immediate recovery direction until the car moves back onto the lane.
  if(Math.abs(r.x)>.97&&r.rumble>.8){
    const right=r.x<0;
    return {turn:right?'right':'left',name:right?'向右回到路面':'向左回到路面',detail:'松油轻打方向',brake:false,recovering:true};
  }
  if(r.d>=CUT)return null;
  const speed=Math.hypot(r.v,r.bodySideSpeed||0);
  const bend=bends.find(b=>b.end>=r.d);
  const preview=clamp(speed*2.7+30,90,185);
  if(!bend||bend.entry-r.d>preview)return null;
  const before=r.d<bend.entry,apexDistance=Math.max(0,bend.apex-r.d);
  const severity=r.d<bend.apex?bend.peak:Math.abs(curvature(r.d));
  const tire=partDynamics[r.spec[1]],wing=partDynamics[r.spec[2]];
  // A conservative centreline advisory reserves 22% of grip for corrections.
  // Solve v²*k = mu*(g + downforce*v²/mass); this does not operate the pedals.
  const grip=.78*tire.wetFriction;
  const limitSq=grip*raceCar.gravity/Math.max(.0001,severity-grip*wing.downforce/raceCar.mass);
  const targetKmh=Math.floor(Math.sqrt(limitSq)*3.6/5)*5;
  const brakingDistance=speed*.65+Math.max(0,speed*speed-limitSq)/(2*.54*tire.wetFriction*raceCar.gravity);
  const brake=speed*3.6>targetKmh+5 && apexDistance<=brakingDistance;
  const name=bend.turn==='right'?'右弯':'左弯';
  const metres=n=>Math.ceil(n/10)*10+' m';
  const nameplate=before?metres(bend.entry-r.d)+'后'+name:name;
  let detail;
  if(brake)detail='减至 '+targetKmh+' km/h';
  else if(before)detail='准备入弯';
  else if(apexDistance>10)detail='距弯心 '+metres(apexDistance);
  else detail=bend.end-r.d<clamp(speed,23,52)?'出弯回正':'保持走线';
  return {turn:bend.turn,name:nameplate,detail,brake};
}

export function bindCourseGuide(element){
  const name=element.querySelector('strong'),detail=element.querySelector('small');
  return (r,countdown)=>{
    const note=countdown>0?null:courseNote(r);
    if(!note){if(!element.hidden)element.hidden=true;return}
    if(element.hidden)element.hidden=false;
    if(element.dataset.turn!==note.turn)element.dataset.turn=note.turn;
    element.classList.toggle('braking',note.brake);
    element.classList.toggle('recovering',!!note.recovering);
    if(name.textContent!==note.name)name.textContent=note.name;
    if(detail.textContent!==note.detail)detail.textContent=note.detail;
  }
}
