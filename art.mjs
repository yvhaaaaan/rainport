import {L,CUT,curve,botD,botX} from './physics.mjs';
import {createTrackScene} from './track-scene.mjs';
import {carAppearance} from './car-appearance.mjs';
import {compatibleRearCar} from './car-preview.mjs';
function fallbackPaint(canvas,r,ghost,attract=false){
 const ctx=canvas.getContext('2d'),w=900,h=450;
 if(canvas.width!==w){canvas.width=w;canvas.height=h}
 const d=r?.d||0,x=r?.x||0,t=r?.t||0,hz=162;
 const grad=(y1,y2,a,b)=>{const g=ctx.createLinearGradient(0,y1,0,y2);g.addColorStop(0,a);g.addColorStop(1,b);return g};
 const poly=(pts,color)=>{ctx.fillStyle=color;ctx.beginPath();pts.forEach(([u,v],i)=>i?ctx.lineTo(u,v):ctx.moveTo(u,v));ctx.closePath();ctx.fill()};
 const line=(pts,color,size)=>{ctx.strokeStyle=color;ctx.lineWidth=size;ctx.beginPath();pts.forEach(([u,v],i)=>i?ctx.lineTo(u,v):ctx.moveTo(u,v));ctx.stroke()};
 ctx.fillStyle=grad(0,hz,'#10202e','#537682');ctx.fillRect(0,0,w,hz+2);
 const moon=ctx.createRadialGradient(705,66,0,705,66,37);moon.addColorStop(0,'#ffe6b8');moon.addColorStop(.21,'#e4cdb2');moon.addColorStop(.24,'#b4c6bf80');moon.addColorStop(1,'#b4c6bf00');ctx.fillStyle=moon;ctx.fillRect(665,25,80,82);
 const hash=i=>{const n=Math.sin(i*127.1+33.79)*43758.5453;return n-Math.floor(n)};
 const coast=Math.min(1,Math.max(0,(d-CUT+150)/300));
 for(let j=0;j<52;j++){const bx=j*19-12,hh=(7+hash(j)*35)*(bx>450?1-coast:1);if(hh<3)continue;ctx.fillStyle=j%2?'#2a434d':'#304c56';ctx.fillRect(bx,hz-hh,12+hash(j+3)*17,hh);for(let l=0;l<4;l++){ctx.fillStyle=l%3?'#bbac7e':'#86b3af';if(5+Math.floor(l/2)*7<hh)ctx.fillRect(bx+3+(l%2)*6,hz-hh+5+Math.floor(l/2)*7,2,2)}}
 for(const [cx,s] of [[74,1.3],[207,.84],[650,.65],[812,1.05]]){
  ctx.save();ctx.globalAlpha=cx>450?1-coast:1;
  const yy=hz-65*s;line([[cx-14*s,hz],[cx,yy],[cx+16*s,hz]],'#203941',6*s);
  line([[cx-30*s,yy+10*s],[cx-29*s,yy],[cx+53*s,yy-17*s],[cx+68*s,yy-9*s],[cx-30*s,yy+10*s]],'#1d333c',3*s);
  for(let j=0;j<6;j++)line([[cx+(-22+j*13)*s,yy+(7-j*2.2)*s],[cx+(-15+j*13)*s,yy+(-2-j*2.2)*s]],'#1f3942',1.7*s);
  line([[cx+48*s,yy-9*s],[cx+48*s,yy+25*s]],'#273f45',1.5*s);ctx.fillStyle='#f9ad61';ctx.fillRect(cx-2,yy-5,3,3);ctx.restore()
 }
 ctx.fillStyle=grad(hz,h,'#39555c','#101c24');ctx.fillRect(0,hz,w,h-hz);
 function project(z){const s=1/(1+z/26),y=hz+(h-hz)*s;
 const bend=attract?-.52:curve(d+z*.62);return {x:w*.5+(1-s)**1.8*bend*178-x*384*s,y,wide:420*s+4,s}}
 if(coast>0){
  ctx.save();ctx.globalAlpha=coast;
  ctx.fillStyle=grad(hz,h,'#506c73','#1a3541');ctx.fillRect(w*.52,hz,w*.48,h-hz);
  for(let i=0;i<46;i++){const yy=hz+hash(i+3)**2*150,xx=470+hash(i+70)*410;line([[xx,yy],[xx+6+Math.sin(i+t)*3,yy]],'#69818a',1)}
  const boat=696+Math.sin(t*.014)*12;
  poly([[boat-42,hz-5],[boat+49,hz-5],[boat+38,hz],[boat-35,hz]],'#293e46');
  ctx.fillStyle='#354d53';ctx.fillRect(boat-27,hz-14,15,10);ctx.fillStyle='#ffd4a2';ctx.fillRect(boat-24,hz-11,5,2);ctx.restore()
 }
 for(let n=82;n>=0;n--){const z=n*5.2,a=project(z+5.2),b=project(z),strip=Math.floor((d+z)/12)%2;
  const band=(left,right,color)=>poly([[a.x+left*a.wide,a.y],[a.x+right*a.wide,a.y],[b.x+right*b.wide,b.y],[b.x+left*b.wide,b.y]],color);
  band(-1.095,1.095,strip?'#cb713c':'#c5c6bb');band(-1,1,strip?'#34474d':'#35484d');
  if(strip){band(-.34,-.331,'#c1c7bc');band(.331,.34,'#c1c7bc')}
  band(-.96,-.95,'#abb4ac');band(.95,.96,'#abb4ac');
  if(n%2===0){const rx=b.x+(hash(n+Math.floor(d/60))-.5)*b.wide*1.9;line([[rx,b.y],[rx+Math.max(1,b.wide*.1),b.y]],'rgba(158,184,181,.16)',Math.max(.5,b.s*1.7))}
 }
 for(let n=12;n>0;n--){const z=n*33-(d%33),q=project(z);for(const side of [-1,1]){const xx=q.x+side*q.wide*1.19,yy=q.y,ht=q.s*200;line([[xx,yy],[xx,yy-ht],[xx-side*ht*.18,yy-ht]],'#20323a',Math.max(1,4*q.s));const lamp=xx-side*ht*.18;ctx.fillStyle='#ffdda1';ctx.fillRect(lamp-ht*.048,yy-ht-1,ht*.095,Math.max(1,3*q.s));line([[xx-side*ht*.06,yy+1],[xx-side*ht*.05,yy+ht*.2]],'rgba(247,166,83,.26)',Math.max(1,3*q.s))}}
 const liveryColor=appearance=>'#'+appearance.color.toString(16).padStart(6,'0');
 function car(cx,cy,size,col,alpha=1,player=false,appearance){
  ctx.save();ctx.translate(cx,cy);ctx.scale(size,size);ctx.globalAlpha=alpha;
  const shape=(pts,c)=>poly(pts,c);ctx.fillStyle='#06111799';ctx.beginPath();ctx.ellipse(0,4,99,12,0,0,Math.PI*2);ctx.fill();
  if(appearance&&r&&!attract){
   const rear=compatibleRearCar(appearance);
   const left=-134,top=-112,width=268,height=134;
   ctx.drawImage(rear.canvas,left,top,width,height);
   if(player&&r.keys[1]){
    ctx.shadowColor='#ff563d';ctx.shadowBlur=12;
    for(const points of rear.lights)line(points.map(([x,y])=>[left+x*width,top+y*height]),'#ff694e',2.3);
   }
   ctx.restore();
   return;
  }
  if(appearance?.spec[1]!==0)for(const side of [-1,1]){
   const rain=appearance?.spec[1]===4;
   ctx.fillStyle='#11191c';ctx.fillRect(side<0?-91:rain?64:68,-20,rain?27:23,27);
  }
  shape([[-93,-25],[-83,-41],[-53,-49],[-33,-69],[28,-70],[54,-51],[77,-46],[93,-29],[89,-9],[72,0],[-76,0],[-91,-9]],col);
  shape([[-50,-49],[-30,-65],[26,-66],[47,-50],[24,-45],[-28,-46]],'#162a34');
  shape([[-37,-51],[-26,-62],[22,-63],[36,-54],[3,-56]],'#536976');
  shape([[-87,-32],[-51,-40],[55,-39],[86,-32],[71,-24],[-72,-24]],'#39474b');
  if(appearance?.spec[2]){
   const high=appearance.spec[2]===6,height=high?-54:-43,width=high?93:78;
   for(const side of [-1,1])line([[side*52,-37],[side*54,height+3]],'#151d23',5);
   shape([[-width,height],[width-4,height],[width+1,height+4],[-width+3,height+6]],'#1a252c');
  }
  shape([[-92,-23],[-64,-24],[-56,-12],[57,-12],[64,-24],[91,-22],[86,-9],[62,-3],[-69,-3],[-88,-10]],'#182328');
  for(const side of [-1,1]){line([[side*83,-31],[side*62,-34],[side*28,-33]],'#b73b24',6);line([[side*81,-32],[side*63,-34],[side*31,-33]],'#ff9a5f',2)}
  shape([[-18,-20],[18,-20],[20,-11],[-19,-11]],'#c3bca4');
  ctx.fillStyle='#26333a';ctx.font='bold 6px monospace';ctx.textAlign='center';ctx.fillText(appearance?.plate||'RAIN',0,-14);
  line([[0,-8],[0,-1]],'#778181',2);ctx.restore()
 }
 if(r&&!attract){const rivals=r.opponents??r.bots.map((b,i)=>{const time=Math.max(0,t-(r.rivalDelay?.[i]||0));return {d:botD(time,b),x:botX(time,b,i)}});
  const cars=rivals.map((car,i)=>({...car,c:['#e3ab66','#9baeb4','#a85645','#768572','#b5b5a5','#9c839b','#82aaa9'][i]}));if(ghost)cars.push({...ghost,c:ghost.appearance?liveryColor(ghost.appearance):'#78e6db',g:1});
  cars.filter(v=>v.d>d-2&&v.d-d<420).sort((a,b)=>b.d-a.d).forEach(v=>{const q=project(Math.max(0,v.d-d+8));car(q.x+q.wide*v.x*.8,q.y-8,q.s*.93,v.c,v.g?.47:1,false,v.appearance)});
 }
 const appearance=carAppearance(r?.config,r?.spec);
 car(attract?655:450+x*36,attract?396:415,attract?1.8:1.15,liveryColor(appearance),1,true,appearance);
 for(let i=0;i<42;i++){const yy=(hash(i+90)*h+t*(70+i%6*17))%h,xx=(hash(i+2)*w+t*42)%w;line([[xx,yy],[xx-3,yy+8]],'rgba(202,228,231,.16)',1)}
}
let sceneCanvas=null,activeScene=null,removalWatcher=null;
const fallbackCanvases=new WeakSet();
const replacementCanvases=new WeakMap();
function useFallback(canvas){
 fallbackCanvases.add(canvas);canvas.dataset.renderer='canvas2d';
 // A canvas that has already acquired WebGL cannot acquire a 2D context after
 // a driver reset. Keep old references working while adopting a fresh element.
 if(!canvas.getContext('2d')&&!replacementCanvases.has(canvas)){
  const replacement=canvas.cloneNode(false);fallbackCanvases.add(replacement);
  canvas.replaceWith(replacement);replacementCanvases.set(canvas,replacement);
 }
}
function releaseTrack(canvas){
 if(canvas&&canvas!==sceneCanvas)return;
 removalWatcher?.disconnect();removalWatcher=null;
 activeScene?.dispose();activeScene=null;sceneCanvas=null;
}
function sceneFor(canvas,r){
 if(!fallbackCanvases.has(canvas)){
  if(canvas!==sceneCanvas){
   releaseTrack();
   try{
    activeScene=createTrackScene(canvas,r);sceneCanvas=canvas;
    removalWatcher=new MutationObserver(()=>{if(!canvas.isConnected)releaseTrack(canvas)});
    removalWatcher.observe(document.body,{childList:true,subtree:true});
    canvas.addEventListener('webglcontextlost',()=>{
     if(sceneCanvas!==canvas)return;
     sceneCanvas=null;removalWatcher?.disconnect();removalWatcher=null;
     activeScene?.dispose();activeScene=null;useFallback(canvas);
    },{once:true});
   }catch(error){
    console.warn('当前图形设备使用兼容赛道画面',error);useFallback(canvas);
   }
  }
  return activeScene;
 }
 return null;
}
async function prepareTrack(canvas,frame){
 const world=sceneFor(canvas,frame);
 if(world){
  try{await world.prepare(frame);if(activeScene===world)return;}
  catch(error){
   console.warn('赛道图形预热失败，切换兼容画面',error);
   releaseTrack(canvas);useFallback(canvas);
  }
 }
 fallbackPaint(replacementCanvases.get(canvas)||canvas,frame,null);
}
function paint(canvas,r,ghost,attract=false){
 if(!r||attract){fallbackPaint(canvas,r,ghost,attract);return;}
 const world=sceneFor(canvas,r);
 if(world)world.render(r,ghost);else fallbackPaint(replacementCanvases.get(canvas)||canvas,r,ghost);
}
export {paint,prepareTrack,releaseTrack};

