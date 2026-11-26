import {makePrediction} from './driver-sync.mjs';
import {bindDriveControls} from './race-controls.mjs';
import {partDynamics} from './physics.mjs';
import {L,CUT,DT,models,rarity,odds,pools,slot,curve,clamp,newRun,botD,tick,sample,input,standings,rank,botPilot,ghostAt,splitTimes,drop} from './physics.mjs';
import {paint, prepareTrack, releaseTrack} from './art.mjs';
import {carAppearance} from './car-appearance.mjs';
import {renderCarPreviews} from './car-preview.mjs';
import {makeRaceAudio} from './race-audio.mjs';
import {mountRewardReel} from './reward-reel.mjs';
import {rewardArt} from './reward-art.mjs';
import {caseArt} from './reward-case-art.mjs';
import {oddsForRank} from './physics.mjs';
import {cockpitMarkup,readInstruments} from './race-hud.mjs';
const raceSound=makeRaceAudio();
const LOCAL_MODE=true;
const root=document.getElementById('rainport'),find=s=>root.querySelector(s);
const body=find('.body'),notice=t=>find('.toast').textContent=t;
const handlers=new Map();let counter=0;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const btn=(s,fn,hot=false,disabled=false)=>{const key=++counter;handlers.set(key,fn);return '<button type="button" data-f="'+key+'" class="'+(hot?'hot':'ghost')+'" '+(disabled?'disabled':'')+'>'+escape(s)+'</button>'};
const safe=async f=>{try{return await f()}catch(e){notice('操作失败 · '+(e.message||e));return null}};
root.addEventListener('click',e=>{const b=e.target.closest('[data-f]');if(b&&!b.disabled&&handlers.has(+b.dataset.f))safe(handlers.get(+b.dataset.f))});
let wallet='A';try{wallet=sessionStorage.getItem('rp-wallet')||'A'}catch{}
if(!['A','B','C'].includes(wallet))wallet='A';
const local=LOCAL_MODE;
async function api(route,data={}){const payload={...data,wallet};const response=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok||result.error)throw Error(result.error||'本地服务未响应');return result}
let state,page='比赛',tab=1,selectedCar=0,garageCar=0,modelKey=16,current=null,loop=0,anim=0,ghost=null,ghostRec=null,lastResult=null,busy=false;
const SELL_TAB=4;
let keys=[0,0,0],driveControls=null,onDriveInput=null;
const usesFabric=()=>local&&state?.ledger==='fabric';
const ledgerName=()=>local?(usesFabric()?'Fabric':'本地链'):'练习';
const cash=x=>Number(x).toLocaleString('zh-CN')+' CR',id=n=>'#'+String(n).padStart(3,'0'), clock=n=>Number.isFinite(n)?Math.floor(n/60)+':'+(n%60).toFixed(3).padStart(6,'0'):'—';
const A=n=>state.assets.find(a=>a.id===n),mine=()=>state.assets.filter(a=>a.owner===state.address);
const who=a=>Object.keys(state.wallets).find(k=>state.wallets[k]===a)||a;
const names=['底盘','引擎','轮胎','尾翼'],status=['','在挂','已成交','已撤单','已到期'],kinds=['','同款卖单','指定编号','整车','型号求购'];
const effect=['雨港双座底盘','标准引擎，极速 174 km/h','高速引擎，极速增加 22 km/h','标准湿弯抓地','湿路摩擦系数约 0.86','低阻标准尾翼','增加高速下压力，也增加直道阻力'];
const ownedCars=()=>mine().filter(a=>a.model===0),availableCars=()=>ownedCars().filter(c=>!c.lock&&c.parts.every(Boolean)&&c.busy<=Date.now()/1000);
const badge=a=>a?models[a.model]+' '+id(a.id):'空槽';
const raceCarName=cfg=>cfg?.[0]?'潮汐 GT '+id(cfg[0]):'港务借用车';
const carModels=parts=>parts.map(part=>A(part)?.model||0);
function raceBlock(car){
 if(!car)return '';
 if(car.lock)return '整车已挂牌，撤单后可参赛';
 const missing=car.parts.flatMap((part,i)=>part?[]:[names[i+1]]);
 if(missing.length)return '缺少'+missing.join('、');
 if(car.busy>Date.now()/1000)return '车辆正在参赛';
 return '';
}
let carChoiceKey='';
function rememberRaceCar(car){
 selectedCar=car;
 try{sessionStorage.setItem(carChoiceKey,String(car))}catch{}
}
function adoptState(next){
 state=next;
 const world=local?(state.ledger==='fabric'?'fabric/'+state.contracts.chainId:state.contracts.Archive):'practice';
 const key='rp-race-car:'+world+':'+wallet;
 if(carChoiceKey!==key){
  carChoiceKey=key;
  selectedCar=0;
  try{selectedCar=Number(sessionStorage.getItem(key))||0}catch{}
 }
 const cars=ownedCars();
 if(selectedCar&&!cars.some(c=>c.id===selectedCar))rememberRaceCar(0);
 if(!cars.some(c=>c.id===garageCar))garageCar=cars[0]?.id||0;
}
const stamp=s=>new Date(s*1000).toLocaleString('zh-CN',{hour12:false});
function dismiss(){const canvas=find('#playback');if(canvas)releaseTrack(canvas);find('.modal')?.remove()}
function modal(title,html){dismiss();const wrap=document.createElement('div');wrap.className='modal';wrap.innerHTML='<section class="dialog" role="dialog" aria-modal="true" aria-label="'+escape(title)+'"><div class="toolbar"><h3>'+escape(title)+'</h3>'+btn('关闭',dismiss)+'</div>'+html+'</section>';root.append(wrap);wrap.querySelector('button')?.focus()}
function stat(label,v){return '<div><small>'+label+'</small><b>'+v+'</b></div>'}
function row(s,actions=''){return '<div class="row"><div>'+s+'</div><div class="flex">'+actions+'</div></div>'}
function options(cs,sel){return cs.map(c=>'<option '+(c.id===sel?'selected':'')+' value="'+c.id+'">潮汐 GT '+id(c.id)+'</option>').join('')}
async function reload(){const next=await api('state');if(next.wallet===wallet)adoptState(next)}
// Keep a displayed inventory current when another demo wallet trades in a second tab.
let syncing=false;
async function syncView(){
 if(syncing||!local||!state||current||busy||find('.modal')||document.hidden||
    !['比赛','市场','车库','钱包','展馆'].includes(page)||(page==='比赛'&&!find('#carSelect')))return;
 const seenPage=page,seenWallet=wallet,oldBlock=state.block,oldRecords=state.records.length;
 const active=state.active;
 syncing=true;
 try{
  const next=await api('state');
  if(page!==seenPage||wallet!==seenWallet||next.wallet!==wallet||current||busy||find('.modal'))return;
  if(next.block>oldBlock||next.records.length!==oldRecords||next.active?.id!==active?.id||next.active?.done!==active?.done){
   adoptState(next);
   render();
  }
 }catch(e){notice('同步库存失败 · '+e.message)}finally{syncing=false}
}
window.addEventListener('focus',syncView);
setInterval(syncView,12000);
function oddsDialog(){modal('雨港 · 掉率与奖池','<p class="muted">掉率 v1 · 奖池 v1 · 本地模拟随机源。有效完赛抽取一次，奖池内各型号等概率。</p><div class="scroll"><table><tr><th>排名</th>'+['未掉落',...rarity].map(x=>'<th>'+x+'</th>').join('')+'</tr>'+odds.map((r,i)=>'<tr><td>'+['1','2–3','4–5','6–8'][i]+'</td>'+r.map(n=>'<td>'+n/100+'%</td>').join('')+'</tr>').join('')+'</table></div>'+pools.map((p,i)=>row(rarity[i]+' · '+p.map(m=>models[m]).join(' / '))).join('')+'<p class="sub">同型号不同发行版使用相同驾驶参数。</p>')}
function header(){find('nav').innerHTML=['比赛','车库','展馆','市场','钱包'].map(n=>btn(n,()=>switchPage(n))).join('');Array.from(find('nav').children).forEach((el,i)=>{el.classList.toggle('sel',['比赛','车库','展馆','市场','钱包'][i]===page);el.disabled=!!current});find('.account').textContent=ledgerName()+(usesFabric()?' · 身份 ':' · 钱包 ')+wallet}
async function switchPage(p){if(current||busy||switchingCar)return;await reload();if(current||busy||switchingCar)return;closeReward();dismiss();resetWorkshop();page=p;render()}
function writeRoute(hash=''){
 if(location.hash===hash)return;
 const address=new URL(location.href);address.hash=hash;
 try{history.replaceState(null,'',address)}catch{}
}
function render(){closeReward();dismiss();handlers.clear();header();if(page==='比赛')lobby();if(page==='车库')garage();if(page==='展馆')museum();if(page==='市场')market();if(page==='钱包')walletView();paintPreviews();writeRoute(page==='车库'?workshopRoute():'')}
function drawProfile(canvas) {
 const context=canvas.getContext('2d');
 canvas.width=710;canvas.height=120;
 const y=d=>63-curve(d)*44;
 const x=d=>8+d/L*694;
 context.lineWidth=1;
 for(let i=0;i<11;i++){context.strokeStyle='#304044';context.beginPath();context.moveTo(8+i*69,14);context.lineTo(8+i*69,108);context.stroke()}
 for(const level of [21,63,105]){context.beginPath();context.moveTo(8,level);context.lineTo(702,level);context.stroke()}
 for(const [from,to,color] of [[0,CUT,'#ff995e'],[CUT,L,'#9dbbb5']]){
  context.strokeStyle=color;context.lineWidth=4;context.beginPath();context.moveTo(x(from),y(from));
  for(let d=from+8;d<to;d+=8)context.lineTo(x(d),y(d));
  context.lineTo(x(to),y(to));context.stroke();
 }
}
function lobby(){
 const previous=state.records.filter(r=>r.driver===wallet);
 const last=previous.at(-1);
 const active=state.active,carId=active?.config[0]??selectedCar;
 const carName=raceCarName([carId]),blocked=!active&&raceBlock(A(carId));
 const raceAction=usesFabric()?'进入双人联机':active?'继续比赛':blocked?'选择可用车辆':'进入雨港';
 const carOptions='<option value="0">港务借用车</option>'+ownedCars().map(car=>{
  const reason=car.id===active?.config[0]?'':raceBlock(car);
  return '<option value="'+car.id+'" '+(reason?'disabled':'')+'>'+raceCarName([car.id])+(reason?' · '+reason:'')+'</option>';
 }).join('');
 const controls='<div class="keyguide"><span><kbd>W</kbd><kbd>↑</kbd> 加速</span><span><kbd>S</kbd><kbd>↓</kbd> 刹车</span><span><kbd>A</kbd><kbd>D</kbd> 转向</span></div>';
 body.innerHTML=`<section class="hero">
  <canvas aria-hidden="true"></canvas><div class="hero-image" aria-hidden="true"></div>
  <div class="over"><div class="label track-label">RAINPORT CIRCUIT</div><h1>雨港<span>夜间竞速</span></h1>
  <p>穿过港区湿弯，冲上沿岸长直道。</p>
  <div class="hero-metrics">${stat('赛道长度','3.78 <em>km</em>')}${stat('发车阵容','8 <em>辆</em>')}${stat('预计圈时','90 <em>秒</em>')}</div>
  <p class="lobby-race-car" id="lobby-race-car">${active?'本场':'参赛车辆'} · ${carName}</p>
  <div class="actions">${btn(raceAction,blocked&&!usesFabric()?showCarPicker:()=>startRace(),true)}${btn('换车',showCarPicker)}${btn('本场奖池',oddsDialog)}</div></div></section>
  <div class="lobby-grid"><section class="sheet"><div class="sheet-title"><h2>发车准备</h2></div>
  <label for="carSelect">参赛车辆</label><select id="carSelect" ${active?'disabled':''}>${carOptions}</select>
  <p class="muted loadout" id="loadout"></p>${controls}<div class="actions">${btn('打开装配台',()=>openWorkshop({carId}))}</div></section>
  <section class="sheet"><div class="sheet-title"><h2>赛道分段</h2><small>转向曲线</small></div>
  <canvas class="profile" aria-label="前段连续弯道，后段直道"></canvas><div class="sector-list"><span><b>S1</b> 港区湿弯 <small>1.82 km</small></span><span><b>S2</b> 沿岸直道 <small>1.96 km</small></span></div></section></div>
  ${ghostRec?row('挑战幽灵 · '+clock(ghostRec.total)+' · '+escape(ghostRec.driver),btn('清除幽灵',()=>{ghost=null;ghostRec=null;render()})):''}
  ${last?row('上场成绩 · 第 '+last.rank+' 名　'+clock(last.total),(rewardSeen(last)?btn('重看开箱',()=>showReward(last,{replay:true,play:true})):btn('开启赛后奖箱',()=>showReward(last),true))+btn('查看结算',()=>results(last))):''}
  ${previous.length>1?'<details><summary>历史结算</summary>'+previous.slice(0,-1).reverse().map(r=>row('雨港 · 第 '+r.rank+' 名',btn('查看结算 '+clock(r.total),()=>results(r)))).join('')+'</details>':''}`;
 paint(find('.hero canvas'),null,null,true);drawProfile(find('.profile'));
 const select=find('#carSelect');
 select.value=carId;
 if(active&&select.selectedIndex===-1){select.add(new Option(carName,carId));select.value=carId}
 const config=active?.config.slice(1)||A(carId)?.parts;
 find('#loadout').textContent=blocked||(config&&carId?config.map(t=>badge(A(t))).join(' / '):'E1 港湾引擎 / T1 公路胎 / W1 短尾翼');
 select.onchange=()=>{
  rememberRaceCar(Number(select.value));
  render();
  find('#carSelect').focus({preventScroll:true});
 };
}
function showCarPicker(){
 if(current||busy||switchingCar)return;
 const active=state.active;
 const choice=(car,carId=car?.id||0)=>{
  const label=raceCarName([carId]),racing=!!active&&carId===active.config[0];
  const reason=racing?'本场使用':raceBlock(car);
  const order=car?.lock&&state.orders.find(o=>o.id===car.lock);
  const action=racing?btn('继续比赛',()=>startRace(),true):
   order?btn('查看订单 '+order.id,()=>details(order)):
   btn('选择 '+label,()=>pickRaceCar(carId),carId===selectedCar,!!reason);
  return row('<b>'+label+'</b><br><small>'+escape(reason||(carId?'三个槽位已装齐':'随时可用'))+'</small>',action);
 };
 modal('选择参赛车辆',(active?'<p>本场使用 '+raceCarName(active.config)+'。换车需先确认退赛。</p>':'')+
  choice(null)+ownedCars().map(car=>choice(car)).join(''));
}
function pickRaceCar(car){
 const commit=()=>{rememberRaceCar(car);page='比赛';render();notice('已选择 '+raceCarName([car]));};
 return state.active?confirmRaceSwitch(state.active,car,commit):commit();
}
let switchingCar=false;
function confirmRaceSwitch(active,car,after){
 const owner=wallet;
 modal('退赛后换车','<p>将退出使用 '+raceCarName(active.config)+' 的本场比赛，并切换为 '+raceCarName([car])+'。退赛会放弃本场完赛奖励。</p>'+
  btn('确认退赛并换车',async()=>{
   if(switchingCar||wallet!==owner)return;
   switchingCar=true;
   try{
    await reload();
    if(wallet!==owner||(state.active&&state.active.id!==active.id))throw Error('当前赛事已变化，请重新选车');
    const next=A(car);
    if(car&&next?.owner!==state.address)throw Error('这辆车已不在当前车库');
    const reason=raceBlock(next);
    if(reason&&car!==state.active?.config[0])throw Error(reason);
    if(state.active?.done){
     const record=await api('finish',{id:active.id});
     await reload();rememberRaceCar(car);showReward(record);
     return;
    }
    if(state.active)await api('abandon',{id:active.id});
    await reload();
    if(wallet!==owner||state.active)throw Error('赛事状态已变化，请重新选车');
    await after();
   }finally{switchingCar=false;}
  },true));
}
async function startRace(){
 if(usesFabric()){window.location.assign('/');return;}
 if(busy||current)return;
 const blocked=!state.active&&raceBlock(A(selectedCar));
 if(blocked)throw Error(blocked);
 busy=true;raceSound.arm();keys=[0,0,0];
 try{
  dismiss();notice('');root.classList.add('is-racing');
  const leave=()=>{driveControls.clear();modal('退出本场比赛','<p>比赛仍在计时。确认退赛将释放车辆，本场没有完赛奖励。</p>'+btn('确认退赛',async()=>{
   if(!current)return;
   await api('abandon',{id:current.id});stopRace();await reload();render();
  },true))};
  const sound=btn(raceSound.muted?'声音关':'声音开',()=>{
   const muted=raceSound.toggle();find('.race-actions button').textContent=muted?'声音关':'声音开';
  });
  body.innerHTML=cockpitMarkup(sound+btn('退出比赛',leave));
  paintPreviews();
  const canvas=find('.race-world'), instruments=readInstruments(find('.raceview'),clock);
  find('#startlights').textContent='准备发车';
  driveControls=bindDriveControls(find('.raceview'),input=>{
   keys=input;onDriveInput?.();
  },()=>Boolean(find('.modal')));
  await new Promise(requestAnimationFrame);
  const active=state.active,car=A(selectedCar);
  const cfg=active?.config||(car?[car.id,...car.parts]:[0,0,0,0]);
  const spec=active?.spec||(car?carModels(car.parts):[1,3,5]);
  const ghostAppearance=ghostRec?carAppearance(ghostRec.config,ghostRec.spec):null;
  const grid=newRun(0,'0000',wallet,cfg,spec);
  grid.ghostAppearance=ghostAppearance;
  find('#race-car').textContent=raceCarName(cfg);
  await prepareTrack(canvas,grid);
  const opening=await api('start',{car:cfg[0],controlStream:true});
  if(opening.config[0]!==cfg[0]){
   stopRace();await reload();page='比赛';render();
   notice('当前已在用 '+raceCarName(opening.config)+' 参赛，请继续比赛或点「换车」。');
   return;
  }
  current=opening;header();
  find('#race-car').textContent=raceCarName(opening.config);
  const prediction=makePrediction(opening);
  let ended=false,inFlight=0,queued=false,lastSend=-Infinity,networkIssue=false;
  const frame=()=>{
   if(!current||ended)return;
   const now=performance.now(),wait=prediction.wait(now);
   const r=prediction.display(now);
   const ghostPose=ghostAt(ghost?.trace,r.t);
   if(ghostPose)ghostPose.appearance=ghostAppearance;
   paint(canvas,r,ghostPose);
   let difference=null;
   if(ghost?.trace){
    const track=ghost.trace;
    let lo=0,hi=track.length-1;
    while(lo<hi){const m=(lo+hi)>>1;if(track[m][1]<r.d)lo=m+1;else hi=m}
    const after=track[lo],before=track[Math.max(0,lo-1)];
    difference=r.t-(before[0]+(after[0]-before[0])*clamp((r.d-before[1])/(after[1]-before[1]||1),0,1));
   }
   const cue=instruments(r,rank(r),difference,wait);
   raceSound.update(r,cue);
   anim=requestAnimationFrame(frame);
  };
  const idNow=opening.id;
  const live=()=>current?.id===idNow&&!ended;
  function schedule(delay){
   clearTimeout(loop);loop=setTimeout(send,delay);
  }
  async function send(){
   if(!live())return;
   if(inFlight>=2){queued=true;return}
   inFlight++;lastSend=performance.now();
   const packet=prediction.packet();
   try{
    const next=await api('drive',{id:idNow,keys:[...keys],changes:packet});
    if(!live())return;
    if(networkIssue){notice('');networkIssue=false}
    prediction.accept(next);
    if(next.t>=current.t)current={...next,bots:opening.bots};
    if(next.done){
     ended=true;
     try{const result=await api('finish',{id:idNow});await reload();stopRace();showReward(result)}
     catch(error){ended=false;frame();throw error}
     return;
    }
    if(next.t>=239.95){ended=true;await api('abandon',{id:idNow});stopRace();await reload();render();notice('有效完赛时限已到，本场已释放车辆。')}
   }catch(error){if(live()){networkIssue=true;notice('赛事连接 · '+error.message)}}
   finally{
    inFlight--;
    if(live()){const delay=queued?0:90;queued=false;schedule(delay)}
   }
  }
  onDriveInput=()=>{
   if(!live()||!prediction.controls(keys))return;
   schedule(Math.max(0,12-(performance.now()-lastSend)));
  };
  prediction.controls(keys);frame();send();
 }catch(error){stopRace();await reload();render();throw error}finally{busy=false}}
function stopRace(){onDriveInput=null;driveControls?.destroy();driveControls=null;raceSound.stop();const cv=find('.race-world');if(cv)releaseTrack(cv);root.classList.remove('is-racing');clearTimeout(loop);cancelAnimationFrame(anim);current=null;keys=[0,0,0]}
async function loadGhost(r){ghost=await api('replay',{id:r.id});ghostRec=r}
let rewardView=null;
const viewedRewards=new Set();
function rewardKey(r){
 const registry=usesFabric()?['fabric',state.contracts.chainId,state.contracts.archive].join('/'):
  local?state.contracts.Archive:'practice';
 return ['rainport-revealed',registry,r.address,r.id].join('/');
}
function rewardSeen(r){
 const key=rewardKey(r);
 if(viewedRewards.has(key))return true;
 try{return localStorage.getItem(key)==='1'}catch{return false}
}
function markRewardSeen(r){
 const key=rewardKey(r);viewedRewards.add(key);
 try{localStorage.setItem(key,'1')}catch{}
}
function closeReward(){
 const view=rewardView;
 rewardView=null;
 if(view){view.reel?.destroy();raceSound.stopReward()}
}
function showReward(r,{replay=false,play=false}={}){
 if(!replay&&rewardSeen(r)){results(r);return}
 closeReward();dismiss();handlers.clear();page='比赛';header();notice('');
 writeRoute('#reward='+r.id+(replay?'&replay=1':''));
 const part=A(r.prize);
 if(r.prize&&!part){missingReward(r);return}
 const view={started:false,reel:null};rewardView=view;
 const reveal=()=>{if(rewardView===view)results(r,true)};
 function begin(){
  if(rewardView!==view||view.started)return;
  view.started=true;markRewardSeen(r);writeRoute('#result='+r.id);
  const host=find('.award-stage');host.dataset.rewardStage='opening';
  raceSound.armReward();
  const reel=mountRewardReel(host,{race:r,part:part||null,onReveal:reveal,sound:raceSound.rewardCue});
  if(rewardView===view){view.reel=reel;host.querySelector('.reward-skip')?.focus({preventScroll:true})}else reel.destroy();
 }
 const rowOdds=oddsForRank(r.rank);
 const probabilities=['未掉落',...rarity].map((name,i)=>'<li><i class="case-tier tier-'+i+'"></i>'+name+' <b>'+rowOdds[i]/100+'%</b></li>').join('');
 const crate='<div class="case-stage-art" aria-hidden="true"><img src="'+caseArt+'" alt="" draggable="false"></div>';
 const soundButton=btn(raceSound.muted?'声音关':'声音开',()=>{
  const muted=raceSound.toggle();
  find('.award-sound button').textContent=muted?'声音关':'声音开';
  if(!muted&&view.started)raceSound.armReward();
 });
 body.innerHTML='<section class="award-screen"><header class="award-header"><div><small>雨港冲刺赛 · '+(replay?'开箱回放':'已完赛')+'</small><h2>赛后奖箱</h2></div><div class="award-rank"><b>P'+r.rank+'</b><small> / 8</small><strong>'+clock(r.total)+'</strong></div></header>'+
  '<div class="award-stage" data-reward-stage="sealed">'+crate+'<div class="case-open-actions">'+btn('开启奖箱',begin,true)+btn('直接查看结果',reveal)+'</div></div>'+
  '<div class="award-meta"><div><h3>第 '+r.rank+' 名掉率</h3><ul class="award-odds">'+probabilities+'</ul></div><div class="actions"><span class="award-sound">'+soundButton+'</span>'+btn('查看本场奖池',oddsDialog)+'</div></div></section>';
 if(play)begin();else find('.case-open-actions button')?.focus({preventScroll:true});
}
function missingReward(r){
 body.innerHTML='<h2>正在读取配件 '+id(r.prize)+'</h2><p>赛事已经结算，重新读取可查看该编号的资料。</p>'+btn('重新读取奖励',async()=>{await reload();results(r)},true);
}
function results(r,focus=false){
 closeReward();
 lastResult=r;page='比赛';writeRoute('#result='+r.id);dismiss();handlers.clear();header();
 const part=A(r.prize);
 if(r.prize&&!part){missingReward(r);return}
 markRewardSeen(r);
 const diff=(n,i)=>ghostRec&&ghostRec.id!==r.id?'　'+(n>ghostRec.sectors[i]?'+':'')+(n-ghostRec.sectors[i]).toFixed(3)+' s':'';
 let reward='<section class="finish-reward empty" tabindex="-1" data-reward-result="0"><div><small>开箱结果</small><h3>本场未掉落部件</h3></div>'+btn('打开装配台',()=>openWorkshop({carId:r.config[0],race:r}))+'</section>';
 if(part){
  const owned=part.owner===state.address;
  const where=!owned?'当前车主 '+who(part.owner):part.mount?'已装在潮汐 GT '+id(part.mount):'已收入钱包 '+wallet+' 的部件仓库';
  const open=(rerun=false)=>openWorkshop({partId:part.id,carId:part.mount||r.config[0],race:r,rerun});
  const action=part.mount?'查看已装配件':part.lock?'查看挂牌配件':'装配掉落部件';
  reward='<section class="finish-reward drop-finish tier-'+(part.edition+1)+'" tabindex="-1" data-reward-result="'+part.id+'"><div class="finish-part"><img src="'+rewardArt(part.model)+'" alt=""><small>'+rarity[part.edition]+'</small></div><div><small>本场掉落 · '+names[slot(part.model)]+'</small><h3>'+badge(part)+'</h3><p>'+escape(where)+(part.lock?' · 已挂牌':'')+'</p><div class="actions">'+(owned?btn(action,()=>open(),true):'')+btn('查看展签',()=>label(part.id))+'</div></div></section>';
 }
 const retry=part?.owner===state.address&&!part.lock&&ownedCars().some(c=>!c.lock&&c.busy<=Date.now()/1000)?
  btn('装车再跑',()=>openWorkshop({partId:part.id,carId:part.mount||r.config[0],race:r,rerun:true})):'';
 body.innerHTML='<div class="label">RAINPORT / FINISH</div><h2>雨港完赛</h2><div class="stats">'+stat('最终名次','P'+r.rank+' / 8')+stat('总用时',clock(r.total))+stat('赛事','雨港')+'</div>'+
  row('S1　港区湿弯','<strong>'+clock(r.sectors[0])+diff(r.sectors[0],0)+'</strong>')+row('S2　沿岸直道','<strong>'+clock(r.sectors[1])+diff(r.sectors[1],1)+'</strong>')+
  reward+'<details><summary>八车完赛榜与赛事凭证</summary>'+r.standings.map((v,i)=>row('P'+(i+1)+'　'+escape(v.name),clock(v.time))).join('')+'<code>'+escape(r.id)+'</code>'+(r.tx||[]).map(h=>btn('回执 '+h.slice(0,10),()=>receipt(h))).join('')+'</details><div class="actions">'+retry+btn('重看开箱',()=>showReward(r,{replay:true,play:true}))+btn('跟随本圈幽灵',async()=>{await loadGhost(r);render()})+btn('返回发车区',render)+'</div>';
 if(focus)find('[data-reward-result]').focus({preventScroll:true});
}
async function tx(fn,args,title,after){
 const owner=wallet;
 const expectedSlot=fn==='fit'?A(args[0])?.parts[args[1]]:undefined;
 const signingNote=usesFabric()?'服务端使用 Fabric 演示身份 '+wallet+' 的证书与私钥签署本次交易。':
  local?'使用本机预授权演示钱包 '+wallet+' 签署本次交易。':'所有操作只影响练习存档。';
 modal(local?'等待签名':'确认练习操作','<p>'+escape(title)+'</p><p class="sub">'+signingNote+'</p>'+btn(local?'签署并提交':'确认',submit,true));
 async function submit(){
  if(wallet!==owner)throw Error((usesFabric()?'Fabric 身份':'钱包')+'已切换，请重新核对订单');
  modal('正在处理','<p>'+(local?'等待签名':'练习处理中')+'</p>');
  const message=find('.dialog p');
  let result;
  try{
   const task=await api('tx',{fn,args,expectedSlot});
   let shownSubmission=false;
   do{
    result=await api('job',{id:task.id});
    if(local&&result.hash&&!shownSubmission){
     message.textContent='已提交 · '+result.hash;
     shownSubmission=true;
     await new Promise(done=>setTimeout(done,350));
    }
    if(['已确认','练习已完成','失败','待核对'].includes(result.status))break;
    await new Promise(done=>setTimeout(done,150));
   }while(true);
   if(result.status==='失败')throw Error(result.error);
  }catch(e){
   if(wallet!==owner)return;
   if(fn==='fit'){try{await reload();render()}catch{}}
   modal('交易失败','<p>'+escape(e.message)+'</p>');
   return;
  }
  if(wallet!==owner)return;
  if(result.status==='待核对'){
   modal('交易已提交 · 待核对','<p>'+escape(result.error)+'</p><code>'+escape(result.hash)+'</code>'+
    '<div class="actions">'+btn('查询交易回执',()=>receipt(result.hash),true)+
    btn('重新读取库存',async()=>{await reload();render()})+'</div>');
   return;
  }
  try{await reload();render()}catch(e){
   modal(result.status,'<p>库存读取失败 · '+escape(e.message)+'</p>'+btn('重新读取库存',async()=>{await reload();render()}));return;
  }
  notice(result.status+(result.block?' · 区块 '+result.block:'')+(result.hash?' · '+result.hash.slice(0,14):''));
  if(after){try{await after()}catch(e){modal(fn==='fit'?'装配已确认':'操作已完成','<p>'+escape(e.message)+'</p>')}}
 }
}
function listing(t,kind){const a=A(t);const ids=kind===3?[t,...a.parts]:[t];modal('挂牌确认','<p>'+kinds[kind]+' · '+ids.map(n=>escape(badge(A(n)))).join(' / ')+'</p><label>总价（CR） <input type="number" id="askprice" min="1" step="1" value="'+(kind===3?500:68)+'"></label><p class="sub">有效期 7 天。成交手续费 2%，向下取整。</p>'+btn('预览订单',()=>{const p=Number(find('#askprice').value);if(!Number.isSafeInteger(p)||p<=0)throw Error('请输入正整数');return tx('list',[kind,t,p,expiry()],kinds[kind]+'　'+ids.map(id).join(' / ')+'　总价 '+cash(p)+'，手续费 '+cash(Math.floor(p*.02))+'，卖家实收 '+cash(p-Math.floor(p*.02)))},true))}
const expiry=()=>Math.floor(Date.now()/1000)+7*86400;
function openSeller(){tab=SELL_TAB;return switchPage('市场')}
function sellPart(partId){
 const part=A(partId);
 if(!part?.model||part.owner!==state.address||part.lock||part.mount)throw Error('部件状态已变化，请刷新后查看出售选项');
 modal('出售 '+badge(part),
  row('<b>指定编号</b><br><small>买家按此编号购买原件，可查看它的参赛履历。</small>',
   btn('按编号挂牌',()=>listing(part.id,2),true))+
  row('<b>同款撮合</b><br><small>与同型号、同版本的求购单按价格撮合。</small>',
   btn('按同款挂牌',()=>listing(part.id,1))));
}
function detachForSale(part,car){
 const index=car.parts.indexOf(part.id),seller=wallet;
 if(index<0)throw Error('装配已变化，请刷新后查看');
 return tx('fit',[car.id,index,0],'从底盘 '+id(car.id)+' 拆下 '+badge(part)+'。拆下后可选择挂牌方式和价格。',()=>{
  if(wallet===seller&&page==='市场'&&tab===SELL_TAB)sellPart(part.id);
 });
}
let workshopSlot=null, workshopPart=0, workshopRace=null, workshopRerun=false, workshopUpdate='';
function resetWorkshop(){
 workshopSlot=null;workshopPart=0;workshopRace=null;workshopRerun=false;workshopUpdate='';
}
function openWorkshop({partId=0,carId=0,race=null,slotIndex=null,rerun=false}={}){
 resetWorkshop();
 const part=A(Number(partId)),cars=ownedCars();
 const owned=part?.owner===state.address;
 const preferred=[owned&&part.mount,Number(carId),garageCar];
 const car=preferred.map(key=>cars.find(c=>c.id===key)).find(Boolean)||cars[0];
 garageCar=car?.id||0;
 workshopSlot=part?.model?slot(part.model)-1:[0,1,2].includes(slotIndex)?slotIndex:null;
 workshopPart=owned&&part.model?part.id:0;
 workshopRace=race;workshopRerun=!!rerun;
 if(part?.model&&!owned)workshopUpdate=badge(part)+' 当前归车手 '+who(part.owner)+' 所有。';
 page='车库';render();
}
function workshopRoute(){
 const params=new URLSearchParams();
 if(garageCar)params.set('car',garageCar);
 if(workshopSlot!==null)params.set('slot',workshopSlot);
 if(workshopPart)params.set('part',workshopPart);
 if(workshopRace)params.set('race',workshopRace.id);
 if(workshopRerun)params.set('rerun','1');
 return '#garage'+(params.size?'?'+params.toString():'');
}
function workshopLock(a){
 if(a.lock)return a.model===0?'整车已挂牌，撤单后可改装':'已挂牌，撤单后可装配';
 if(a.busy>Date.now()/1000)return '正在参赛，比赛结束后可改装';
 return '';
}
function workshopButton(key,title,handler,primary=false,disabled=false){
 return btn(title,handler,primary,disabled).replace('<button ','<button id="workshop-'+key+'" ');
}
function workshopMeasurements(model){
 const spec=partDynamics[model];
 if(spec.peakTorque)return [['峰值扭矩',spec.peakTorque,'N·m']];
 if(spec.wetFriction)return [['湿地摩擦系数',spec.wetFriction.toFixed(2),'']];
 const speed=100/3.6;
 return [['下压力',Math.round(spec.downforce*speed*speed),'N'],['空气阻力',Math.round(spec.drag*speed*speed),'N']];
}
function workshopComparison(equipped,candidate){
 const replacement=candidate&&candidate.id!==equipped?.id?candidate:null;
 if(!equipped&&!replacement)return '';
 const current=equipped?workshopMeasurements(equipped.model):[];
 const preview=workshopMeasurements((replacement||equipped).model);
 const unit=(v,u)=>v+(u?' '+u:'');
 return '<div class="workshop-measures"><table><thead><tr><th>驾驶参数'+
  (slot((replacement||equipped).model)===3?' · 100 km/h':'')+'</th><th>当前装配</th>'+
  (replacement?'<th>换装后</th>':'')+'</tr></thead><tbody>'+preview.map(([name,value,u],i)=>
  '<tr><td>'+name+'</td><td>'+(current.length?unit(current[i][1],u):'空槽')+'</td>'+
  (replacement?'<td>'+unit(value,u)+'</td>':'')+'</tr>').join('')+'</tbody></table></div>'+
  (replacement?'<p class="sub">'+(equipped?.model===replacement.model?'两件型号相同，驾驶参数相同，各自保留编号与履历。':
   ['','港湾引擎使用标准扭矩曲线。','高速引擎提升驱动扭矩，有利于在沿岸直道加速。','公路胎使用标准湿路抓地。','雨胎缩短湿地制动距离，入弯时更容易保持走线。','短尾翼的直道风阻较低。','高下压力尾翼提高高速弯中的抓地，也增加直道风阻。'][replacement.model])+'</p>':'');
}
async function raceWorkshopCar(car,race){
 const config=car?[...car.parts]:null;
 await reload();
 const target=car?.id||0,active=state.active;
 if(active&&active.config[0]===target){
  await startRace();
  return;
 }
 if(car){
  const latest=A(car.id);
  if(!latest||!availableCars().some(c=>c.id===car.id)||config.some((n,i)=>n!==latest.parts[i])){
   render();throw Error('参赛配置已变动，请重新核对底盘与三个槽位。');
  }
 }
 if(active)return confirmRaceSwitch(active,target,()=>raceWorkshopCar(car,race));
 if(race)await loadGhost(race);
 rememberRaceCar(target);page='比赛';writeRoute('');
 await startRace();
}
function changeWorkshopFit(car,slotIndex,part,again=false){
 const old=A(car.parts[slotIndex]),slotName=names[slotIndex+1],owner=wallet,race=workshopRace;
 const title='潮汐 GT '+id(car.id)+' · '+slotName+'槽。'+
  (part?'装入 '+badge(part)+'。':'')+(old?'拆下 '+badge(old)+'，存入你的部件仓库。':'')+
  (again?'装配确认后使用新配置追逐本圈幽灵。':'');
 return tx('fit',[car.id,slotIndex,part?.id||0],title,async()=>{
  if(wallet!==owner||page!=='车库'||garageCar!==car.id)return;
  const updated=A(car.id),expected=part?.id||0;
  if(updated?.parts[slotIndex]!==expected)throw Error('配置已变更，请重新核对当前装配。');
  workshopPart=expected;
  workshopUpdate=part?badge(part)+' 已装入 '+id(car.id)+' 的'+slotName+'槽。':'已拆下'+slotName+'。';
  if(old)workshopUpdate+=badge(old)+' 已回到部件仓库。';
  render();
  if(again&&updated.parts.every(Boolean))await raceWorkshopCar(updated,race);
 });
}
function workshopInventory(loose){
 const items=[...loose].reverse();
 return '<details class="workshop-stock"><summary>我的独立部件 · '+items.length+' 件</summary>'+
  (items.map(a=>'<div class="row" data-stock-id="'+a.id+'"><div><b>'+badge(a)+'</b><br><small>'+
   names[slot(a.model)]+'槽 · '+rarity[a.edition]+(a.lock?' · 已挂牌':a.origin?' · 比赛掉落':'')+
   '</small></div><div class="flex">'+(garageCar?btn('装配预览',()=>{workshopSlot=slot(a.model)-1;workshopPart=a.id;workshopUpdate='';render()}):'')+
   btn('展签',()=>label(a.id))+(a.lock?btn('查看订单',()=>details(state.orders.find(o=>o.id===a.lock))):
   btn('同款出售',()=>listing(a.id,1))+btn('编号出售',()=>listing(a.id,2)))+'</div></div>').join('')||
   '<p class="muted">仓库里暂时没有独立部件。</p>')+'</details>';
}
function garage(){
 const car=ownedCars().find(c=>c.id===garageCar),loose=mine().filter(a=>a.model&&!a.mount);
 const focused=A(workshopPart);
 if(workshopPart&&focused?.owner!==state.address){
  workshopUpdate=focused?badge(focused)+' 已转手，现由车手 '+who(focused.owner)+' 持有。':'此部件已不在当前钱包的库存中。';
  workshopPart=0;workshopRerun=false;
 }
 const statusMessage=workshopUpdate?'<p class="workshop-update" role="status">'+escape(workshopUpdate)+'</p>':'';
 const head='<div class="toolbar workshop-header"><h2>改装车库</h2><div class="flex"><label>自有底盘 <select id="garagecar"'+
  (car?'':' disabled')+'>'+(car?options(ownedCars(),car.id):'<option>暂无自有车</option>')+'</select></label>'+btn('换车',showCarPicker)+btn('去市场出售',openSeller)+'</div></div>';
 if(!car){
  body.innerHTML=head+statusMessage+'<section class="sheet workshop-empty"><h3>需要一台自有底盘</h3><p>比赛掉落的配件保存在钱包里。借用车使用固定配置，购买整车后可以为它换装。</p>'+
   (workshopPart?'<p>已持有 '+badge(A(workshopPart))+'。</p>':'')+
   '<div class="actions">'+btn('去市场看整车',()=>{tab=3;return switchPage('市场')},true)+
   workshopButton('race',state.active?.config[0]===0?'继续比赛':workshopRace?'用借用车追逐本圈幽灵':'使用借用车参赛',()=>raceWorkshopCar(null,workshopRace))+'</div></section>'+
   workshopInventory(loose);return;
 }
 if(workshopSlot===null){
  const empty=car.parts.indexOf(0),last=loose.filter(a=>!workshopLock(a)).at(-1);
  workshopSlot=empty>=0?empty:last?slot(last.model)-1:0;
 }
 const i=workshopSlot,slotName=names[i+1],equipped=A(car.parts[i]);
 const stock=loose.filter(a=>slot(a.model)===i+1).reverse();
 const candidate=stock.find(a=>a.id===workshopPart),locked=workshopLock(car);
 const available=candidate&&!locked&&!workshopLock(candidate);
 const missing=car.parts.map((n,index)=>n?'':names[index+1]).filter(Boolean);
 const currentInfo=locked||(!missing.length?'三个槽位已装齐':'待装 '+missing.join('、'));
 const lastDrop=workshopRace?.prize;
 const setSlot=n=>{workshopSlot=n;workshopPart=car.parts[n]||0;workshopRerun=false;workshopUpdate='';render();find('.workshop-slot[data-slot="'+n+'"]').focus({preventScroll:true})};
 const pins=car.parts.map((n,j)=>'<span class="pin pin-'+j+(j===i?' active':'')+'" data-part-anchor="'+j+'"><button type="button" data-pick-slot="'+j+'">'+names[j+1]+' '+(n?id(n):'空槽')+'</button></span>').join('');
 const slots=car.parts.map((n,j)=>'<button type="button" class="workshop-slot" data-slot="'+j+'" aria-pressed="'+(j===i)+'"><span>'+names[j+1]+'</span><b>'+badge(A(n))+'</b></button>').join('');
 const carActions=car.lock?btn('查看整车订单',()=>details(state.orders.find(o=>o.id===car.lock))):
  btn('整车挂牌',()=>listing(car.id,3),false,!!locked||!!missing.length);
 const candidateInfo=candidate?(candidate.id===lastDrop?'本场掉落 · ':candidate.origin?'比赛掉落 · ':'')+rarity[candidate.edition]+' · '+id(candidate.id):'';
 const equippedStatus=equipped?(equipped.id===lastDrop?'本场掉落 · ':'')+'已装在 '+id(car.id):'尚未安装';
 const partOptions='<option value="'+(equipped?.id||0)+'">'+(equipped?'保留 '+badge(equipped):'选择仓库部件')+'</option>'+
  stock.map(a=>'<option value="'+a.id+'"'+(a.id===candidate?.id?' selected':'')+'>'+badge(a)+' · '+rarity[a.edition]+(a.id===lastDrop?' · 本场掉落':'')+(a.lock?' · 已挂牌':'')+'</option>').join('');
 const resuming=state.active?.config[0]===car.id;
 const canRace=resuming||!missing.length&&!locked;
 const ghostRace=workshopRace;
 const fitAndRace=workshopRerun&&candidate&&ghostRace&&car.parts.every((n,j)=>n||j===i);
 const raceTitle=resuming?'继续比赛':candidate?'用当前配置参赛':ghostRace?'用此配置追逐本圈幽灵':'用此配置参赛';
 body.innerHTML=head+statusMessage+'<div class="workshop-grid"><section class="workshop-car"><div class="toolbar"><div><h3>潮汐 GT '+id(car.id)+'</h3><small>'+escape(currentInfo)+'</small></div>'+carActions+'</div>'+
  '<div class="car-studio">'+carPreview(car)+pins+'</div>'+
  '<div class="workshop-slots" aria-label="选择装配槽位">'+slots+'</div></section>'+
  '<section class="workshop-bench"><h3>'+slotName+'装配</h3><div class="workshop-mounted" data-equipped="'+(equipped?.id||0)+'"><div><small>'+equippedStatus+'</small><strong>'+badge(equipped)+'</strong></div>'+
  (equipped?btn('展签',()=>label(equipped.id)):'')+'</div>'+
  '<label for="workshop-part">仓库内的'+slotName+' · '+stock.length+' 件</label><select id="workshop-part"'+(!stock.length?' disabled':'')+'>'+partOptions+'</select>'+
  (candidate?'<p class="workshop-origin">'+candidateInfo+(candidate.lock?' · 部件已挂牌':'')+'</p>':'')+
  (!stock.length?'<p class="sub">暂无可替换的'+slotName+'。'+btn('查找同款',()=>{modelKey=(equipped?.model||i*2+1)*4;tab=1;return switchPage('市场')})+'</p>':'')+
  workshopComparison(equipped,candidate)+
  (candidate&&equipped?'<p class="sub">换下的 '+badge(equipped)+' 将回到部件仓库。</p>':'')+
  '<div class="actions workshop-tools">'+(candidate?workshopButton('fit','装入 '+id(candidate.id),()=>changeWorkshopFit(car,i,candidate),!fitAndRace,!available):'')+
  (fitAndRace?workshopButton('fit-race','装配并追逐本圈幽灵',()=>changeWorkshopFit(car,i,candidate,true),true,!available):'')+
  (equipped?workshopButton('remove','拆下 '+id(equipped.id),()=>changeWorkshopFit(car,i,null),false,!!locked):'')+'</div>'+
  (locked?'<p class="workshop-lock">'+escape(locked)+'。</p>':'')+
  '<div class="workshop-start">'+(ghostRace?'<small>本圈幽灵 · '+clock(ghostRace.total)+'</small>':'')+
  workshopButton('race',raceTitle,()=>raceWorkshopCar(car,ghostRace),!candidate,!canRace)+
  (!canRace?'<small>'+(locked||'还需安装'+missing.join('、')+'才能参赛')+'</small>':'')+
  '</div></section></div>'+workshopInventory(loose);
 find('#garagecar').onchange=e=>{
  garageCar=Number(e.target.value);
  if(!candidate)workshopPart=0;
  const next=A(garageCar),reason=raceBlock(next);
  if(!reason){rememberRaceCar(garageCar);workshopUpdate='下场参赛车辆已选为 '+raceCarName([garageCar])+'。'}
  else workshopUpdate=reason+'。';
  render();find('#garagecar').focus({preventScroll:true});
 };
 find('#workshop-part').onchange=e=>{workshopPart=Number(e.target.value);workshopUpdate='';render();find('#workshop-part').focus({preventScroll:true})};
 for(const button of body.querySelectorAll('[data-slot],[data-pick-slot]')){
  button.onclick=()=>setSlot(Number(button.dataset.slot??button.dataset.pickSlot));
 }
}
function recordFor(c){return state.records.filter(r=>r.config[0]===c).sort((a,b)=>a.total-b.total)[0]}
function compare(c,r){
 const config=[c.id,...c.parts];
 const exact=state.records.filter(v=>v.config.every((t,i)=>t===config[i])).sort((a,b)=>a.total-b.total)[0];
 const time=v=>v?clock(v.total)+' · 车手 '+escape(v.driver):'暂无成绩';
 return '<div class="config-records">'+stat('当前四件套最佳成绩',time(exact))+stat('底盘历史最佳成绩',time(r))+'</div>'+
 '<table><tr><th>槽位</th><th>创造纪录时的配置</th><th>当前配置</th></tr>'+config.map((n,i)=>{
  const old=r?.config[i],different=r&&old!==n;
  return '<tr'+(different?' class="changed"':'')+'><td>'+names[i]+'</td><td>'+(old?btn(badge(A(old)),()=>label(old)):'暂无纪录')+'</td><td>'+(n?btn(badge(A(n)),()=>label(n)):'空槽')+(different?' <small>已更换</small>':'')+'</td></tr>'
 }).join('')+'</table>';
}
function carPreview(car){
 const label=raceCarName([car.id])+' · '+car.parts.map((part,i)=>names[i+1]+' '+badge(A(part))).join('，');
 return '<canvas class="car-preview" data-car-preview="'+car.id+'" data-parts="'+car.parts.join(',')+'" role="img" aria-label="'+escape(label)+'"></canvas>';
}
function paintPreviews(){
 renderCarPreviews(body,canvas=>{
  const parts=canvas.dataset.parts.split(',').map(Number);
  return carAppearance([Number(canvas.dataset.carPreview),...parts],carModels(parts));
 });
}
function carDisplay(c){
 return '<div class="car-studio">'+carPreview(c)+c.parts.map((t,i)=>t?'<span class="pin pin-'+i+'" data-part-anchor="'+i+'">'+btn(names[i+1]+' '+id(t),()=>label(t))+'</span>':'').join('')+'</div>';
}
function museum(){
 const cars=state.assets.filter(c=>c.model===0).sort((a,b)=>Number(!!recordFor(b.id))-Number(!!recordFor(a.id)));
 body.innerHTML='<div class="label">COLLECTION HALL</div><h2>数字藏品展馆</h2><p class="muted">点选展车部件，查看原件履历。</p>'+cars.map(c=>{
  const r=recordFor(c.id),o=state.orders.find(v=>v.id===c.lock&&v.kind===3&&v.status===1);
  return '<section class="exhibit"><div>'+carDisplay(c)+'</div><div class="exhibit-info"><small>车主 '+escape(who(c.owner))+'</small><h3>潮汐 GT '+id(c.id)+'</h3>'+compare(c,r)+'<div class="actions">'+
   btn('挑战圈速',async()=>{await loadGhost(r);page='比赛';render()},false,!r)+
   btn('查看配置',()=>modal('展车配置 · '+id(c.id),compare(c,r)))+
   btn(o?'购买整车 '+cash(o.price):'整车未挂牌',()=>details(o),!!o,!o)+'</div></div></section>';
 }).join('');
}
function artFor(m,e,t){return '<div class="artbox edition-'+e+'"><span class="part-id">'+rarity[e]+' · '+id(t)+'</span>'+(slot(m)===2?'<div class="wheel"></div>':'<div class="metal">'+['H01','E1','E3','T1','R2','W1','W3'][m]+'</div>')+'</div>'}
function label(t){const a=A(t),source=state.records.find(r=>r.id===a.origin),uses=state.records.filter(r=>r.config.includes(t)),trades=state.orders.filter(o=>o.status===2&&o.kind!==4&&o.ids.includes(t)),o=state.orders.find(o=>o.id===a.lock);
 modal('藏品展签 · '+badge(a),artFor(a.model,a.edition,a.id)+'<p><b>'+rarity[a.edition]+'</b> · '+effect[a.model]+'</p>'+row('获得记录',a.origin?'第 '+a.originRank+' 名 · '+escape(who(a.first))+'<br><code>'+escape(a.origin)+'</code>':'创世发行 · '+escape(who(a.first)))+(source?btn('回看获得赛事',()=>viewReplay(source)):'')+'<h3>实际参赛</h3>'+(uses.map(r=>row(escape(r.driver)+' · '+id(r.config[0])+' · 第 '+r.rank+' 名<br><small>'+escape(r.id)+'</small>',btn('回放 '+clock(r.total),()=>viewReplay(r)))).join('')||'<p class="muted">尚无参赛记录</p>')+'<h3>车主与成交</h3>'+row('首任 '+escape(who(a.first))+'　现任 '+escape(who(a.owner)))+(trades.map(o=>row(stamp(o.when)+' · '+kinds[o.kind]+' · '+escape(who(o.maker))+' → '+escape(who(o.buyer)),btn(cash(o.paid),()=>details(o)))).join('')||'<p class="muted">暂无成交</p>')+(state.transfers||[]).filter(v=>v.id===t&&v.from&&v.from!=='0x0000000000000000000000000000000000000000'&&!trades.some(s=>s.hashes?.includes(v.hash))).map(v=>row('直接转移 · '+escape(who(v.from))+' → '+escape(who(v.to)),btn('区块 '+v.block,()=>receipt(v.hash)))).join('')+'<div class="actions">'+(o?.kind===2?btn(o.maker===state.address?'查看我的订单':'购买原件 '+id(t),()=>details(o),true):'')+(a.model&&a.owner===state.address?btn('在车库查看配件',()=>openWorkshop({partId:a.id,carId:a.mount||garageCar})):a.model===0&&a.owner===state.address?btn('改装这辆车',()=>openWorkshop({carId:a.id})):'' )+(a.model?btn('查找同款',()=>{modelKey=a.key;tab=1;page='市场';render()}):'')+'</div>')}
async function viewReplay(r){
 const replay=await api('replay',{id:r.id}),track=replay.trace;
 const duration=track.at(-1)[0];
 modal('雨港赛事回放','<canvas id="playback" style="width:100%"></canvas><p>'+(local?'链上三项摘要校验通过':'练习轨迹')+' · '+escape(r.driver)+' · '+clock(r.total)+'</p><input aria-label="回放进度" type="range" min="0" max="'+duration+'" step="0.01" value="0" style="width:100%">');
 const canvas=find('#playback'),slider=find('.dialog input');
 const ref=newRun(0,r.id,r.driver,r.config,r.spec,replay.physicsVersion??(track.at(-1).length>=9?2:1));
 let origin=performance.now(),cursor=0,inputIndex=0,raf=0,lastSlider=-Infinity;
 function draw(now){
  if(!canvas.isConnected)return;
  const t=clamp((now-origin)/1000,0,duration);
  while(cursor<track.length-2&&track[cursor+1][0]<t)cursor++;
  const a=track[cursor],b=track[Math.min(cursor+1,track.length-1)],mix=clamp((t-a[0])/(b[0]-a[0]||1),0,1);
  const lerp=i=>(a[i]||0)+((b[i]||0)-(a[i]||0))*mix;
  const inputs=replay.inputs||[];
  while(inputIndex+1<inputs.length&&inputs[inputIndex+1][0]<=t)inputIndex++;
  const keys=inputs[inputIndex]?.[0]<=t?inputs[inputIndex].slice(1):[0,0,0];
  paint(canvas,{...ref,t,d:lerp(1),x:lerp(2),v:lerp(3),yaw:lerp(4),steer:lerp(5),slip:lerp(6),rumble:lerp(7),impact:lerp(8),rivalDelay:a[9]||[],keys,brake:keys[1]},null);
  if(now-lastSlider>75||t>=duration){slider.value=t;lastSlider=now}
  if(t<duration)raf=requestAnimationFrame(draw);
 }
 slider.oninput=()=>{const time=Number(slider.value);cancelAnimationFrame(raf);cursor=0;inputIndex=0;origin=performance.now()-time*1000;raf=requestAnimationFrame(draw)};
 raf=requestAnimationFrame(draw);
}
function sellerView(){
 const orders=state.orders.filter(o=>o.maker===state.address&&o.status===1).reverse();
 const activeOrders=orders.map(o=>row('<b>'+kinds[o.kind]+' · '+cash(o.price)+'</b><br><small>'+
  (o.ids.length?o.ids.map(id).join(' / '):badgeModel(o.key))+'</small>',btn('订单 '+o.id,()=>details(o)))).join('');
 const parts=mine().filter(a=>a.model&&!a.lock).reverse();
 const partRows=parts.map(part=>{
  const car=A(part.mount);
  const blocked=car&&workshopLock(car);
  const location=blocked||(car?'装在底盘 '+id(car.id):'未装车')+' · '+rarity[part.edition]+'版';
  const action=car?btn('拆下并出售',()=>detachForSale(part,car),false,!!blocked):btn('出售部件',()=>sellPart(part.id),true);
  return '<div class="seller-item" data-sell-id="'+part.id+'">'+row('<b>'+badge(part)+'</b><br><small>'+escape(location)+'</small>',action)+'</div>';
 }).join('');
 const cars=ownedCars().filter(c=>!c.lock);
 const carRows=cars.map(car=>{
  const blocked=workshopLock(car)||(car.parts.every(Boolean)?'':'装齐引擎、轮胎和尾翼后可挂牌');
  const configuration=[car.id,...car.parts].filter(Boolean).map(id).join(' / ');
  return '<div class="seller-item" data-sell-id="'+car.id+'">'+row('<b>潮汐 GT '+id(car.id)+'</b><br><small>'+
   escape(blocked||configuration)+'</small>',btn('整车挂牌',()=>listing(car.id,3),false,!!blocked))+'</div>';
 }).join('');
 return '<div class="seller-stock"><section class="box"><h3>我的部件</h3>'+
  (partRows||'<p class="muted">当前没有未挂牌的部件。</p>')+'</section><section class="box"><h3>我的赛车</h3>'+
  (carRows||'<p class="muted">当前没有未挂牌的自有赛车。</p>')+'</section></div>'+
  '<section class="box"><h3>我的在挂订单</h3>'+(activeOrders||'<p class="muted">当前没有在挂订单。</p>')+'</section>';
}
function badgeModel(key){return models[Math.floor(key/4)]+' · '+rarity[key%4]+'版'}
function market(){body.innerHTML='<div class="label">RAINPORT EXCHANGE</div><div class="toolbar"><h2>交易市场</h2><b class="price">'+cash(state.balance)+'</b></div><div class="flex market-tabs">'+['按型号买部件','按编号买藏品','买整车','我要出售'].map((n,i)=>btn(n,()=>{tab=i+1;render()},tab===i+1)).join('')+'</div><div id="marketbody"></div>';const box=find('#marketbody');
 if(tab===SELL_TAB){box.innerHTML=sellerView();return}
 if(tab===1){const m=Math.floor(modelKey/4),e=modelKey%4;const open=state.orders.filter(o=>o.key===modelKey&&o.status===1),asks=open.filter(o=>o.kind===1).sort((a,b)=>a.price-b.price||a.id-b.id),bids=open.filter(o=>o.kind===4).sort((a,b)=>b.price-a.price||a.id-b.id),ask=asks.find(o=>o.maker!==state.address),bid=bids.find(o=>o.maker!==state.address);const sales=state.orders.filter(o=>o.key===modelKey&&[1,2].includes(o.kind)&&o.status===2&&o.when>=Date.now()/1000-604800).map(o=>o.paid).sort((a,b)=>a-b),median=sales.length?(sales[(sales.length-1)>>1]+sales[sales.length>>1])/2:null;
 const c=A(garageCar),equipped=c?A(c.parts[slot(m)-1]):null;
 const currentModel=equipped?.model||(!c?[1,3,5][slot(m)-1]:null);
 const difference=currentModel===m?'相同驾驶参数':currentModel===null?'当前槽位为空':({
  '1-2':'直道极速增加约 22 km/h','2-1':'直道极速降低约 22 km/h',
  '3-4':'湿路摩擦系数从 0.70 升至 0.86','4-3':'湿路摩擦系数从 0.86 降至 0.70',
  '5-6':'增加弯中下压力，直道空气阻力更大','6-5':'直道空气阻力更小，弯中下压力减小'
 }[currentModel+'-'+m]||effect[m]);

 box.innerHTML='<div class="box"><div class="toolbar"><select id="model">'+models.slice(1).map((v,i)=>'<option value="'+(i+1)+'" '+(m===i+1?'selected':'')+'>'+v+'</option>').join('')+'</select><select id="edition">'+rarity.map((v,i)=>'<option value="'+i+'" '+(e===i?'selected':'')+'>'+v+'版</option>').join('')+'</select></div><p>'+names[slot(m)]+'槽 · '+effect[m]+'</p><small>当前 '+(equipped?badge(equipped):c?'空槽':'借用车 · '+models[currentModel])+' · '+difference+'</small><div class="stats">'+stat('最低卖价',asks.length?cash(asks[0].price):'暂无挂单')+stat('最高求购',bids.length?cash(bids[0].price):'暂无求购')+stat('七日中位价',median===null?'暂无成交':cash(median))+stat('七日成交',sales.length+' 笔')+'</div><div class="actions">'+btn(ask?'买最低价 '+cash(ask.price):'暂无可买同款',()=>details(ask),true,!ask)+btn('挂求购单',()=>modal('求购 '+models[m]+' · '+rarity[e],'<p>最高愿付价将进入托管。低价成交会退回差额，撤单会退还剩余托管款。</p><input id="bidprice" aria-label="最高愿付价" type="number" min="1" value="50"> '+btn('预览求购',()=>{const p=Number(find('#bidprice').value);if(!Number.isSafeInteger(p)||p<1)throw Error('请输入正整数');return tx('bid',[modelKey,p,expiry()],'求购 '+models[m]+' · '+rarity[e]+'版，托管 '+cash(p))},true)))+btn('按最高求购卖出',()=>{const choices=mine().filter(a=>a.key===modelKey&&!a.lock&&!a.mount);modal('选择交付编号',choices.map(a=>row(badge(a),btn('以 '+cash(bid.price)+' 出售',()=>tx('list',[1,a.id,bid.price,expiry()],'按同款出售 '+badge(a)+'，最低成交价 '+cash(bid.price))))).join('')||'没有可出售的空闲同款部件。')},false,!bid)+'</div></div>'+[...asks,...bids].map(o=>row(kinds[o.kind]+' · '+escape(who(o.maker))+' · 订单 '+o.id,btn(cash(o.price),()=>details(o)))).join('');
 find('#model').setAttribute('aria-label','部件型号');find('#edition').setAttribute('aria-label','发行版本');find('#model').onchange=ev=>{modelKey=4*+ev.target.value+e;market()};find('#edition').onchange=ev=>{modelKey=m*4+ +ev.target.value;market()};}
 else{const all=state.orders.filter(o=>o.status===1&&o.kind===tab);box.innerHTML=all.map(o=>{const a=A(o.ids[0]);return '<div class="box">'+(tab===2?artFor(a.model,a.edition,a.id):carDisplay({id:o.ids[0],parts:o.ids.slice(1)}))+'<div class="toolbar"><h3>'+badge(a)+'</h3><span class="price">'+cash(o.price)+'</span></div><p class="sub">'+(tab===3?'交付 '+o.ids.map(id).join(' / '):rarity[a.edition]+' · 当前车主 '+escape(who(a.owner)))+'</p>'+btn(tab===2?'查看原件展签':'查看整车交付清单',()=>tab===2?label(a.id):details(o),true)+'</div>'}).join('')||'<p>当前没有有效挂单。</p>'}}
async function receipt(h){
 const rc=await api('receipt',{hash:h});
 const code=v=>'<code>'+escape(v)+'</code>';
 if(rc.ledger==='fabric'||usesFabric()){
  const status=rc.validationCode??rc.status;
  const confirmed=rc.successful??(rc.validationCode!=null?
   [0,'0','VALID'].includes(rc.validationCode):[true,1,'1','VALID','已确认'].includes(status));
  modal('Fabric 交易回执',row('区块号',escape(rc.block??'—'))+row('状态',confirmed?'已确认':'执行回退')+
   row('交易 ID',code(rc.hash))+row('通道',code(rc.channel??state.contracts.chainId))+row('链码',code(rc.contract))+
   (rc.from?row('发起身份',code(who(rc.from))):'')+
   (status!=null?row('验证状态',code(status)):''));
  return;
 }
 modal('节点交易回执',row('区块号',parseInt(rc.blockNumber,16))+row('状态',Number(rc.status)?'已确认':'执行回退')+
  row('交易哈希',code(rc.transactionHash))+row('发起地址',code(rc.from))+row('合约地址',code(rc.to))+row('事件条数',rc.logs.length));
}
function details(o){const a=A(o.ids[0]),r=o.kind===3?recordFor(a.id):null;const own=o.maker===state.address,p=o.paid||o.price,fee=Math.floor(p*.02);
 modal(kinds[o.kind]+' · 订单 '+o.id,'<div class="stats">'+stat('总价',cash(p))+stat('手续费',cash(fee))+stat('卖家实收',cash(p-fee))+'</div>'+row('订单状态',status[o.status])+row('有效至',stamp(o.expires))+row('交付清单',o.ids.length?o.ids.map(n=>badge(A(n))).join(' / '):badgeModel(o.key))+(o.kind===3?compare({id:o.ids[0],parts:o.ids.slice(1)},r):'')+'<div class="actions">'+(o.status===1&&own?btn('撤销订单',()=>tx('close',[o.id],'撤销订单 '+o.id+(o.kind===4?'，退回 '+cash(o.price):'，释放挂牌资产'))):o.status===1&&o.kind!==4?btn('购买 '+(o.kind===3?'整车 ':'')+id(o.ids[0]),()=>tx('buy',[o.id,o.price],'购买 '+o.ids.map(id).join(' / ')+'，总价 '+cash(p)+'，手续费 '+cash(fee)+'，卖家实收 '+cash(p-fee)),true):'')+(o.hashes||[]).map(h=>btn('回执 '+h.slice(0,9),()=>receipt(h))).join('')+'</div>')}
function walletView(){
 const fabric=usesFabric();
 const myOrders=state.orders.filter(o=>o.maker===state.address||o.buyer===state.address).slice().reverse();
 const escrow=myOrders.filter(o=>o.kind===4&&o.status===1&&o.maker===state.address).reduce((n,o)=>n+o.price,0);
 const ledgerInfo=fabric?'Hyperledger Fabric · 通道 '+state.contracts.chainId+' · 区块 '+state.block:
  local?'Ganache · chainId 31337 · 区块 '+state.block:'浏览器练习存档 · 交易不提交到节点';
 const fields=fabric?[
  ['通道',state.contracts.chainId],['链码',state.contracts.archive],['网关',state.contracts.rpc],['MSP',state.mspId]
 ].filter(([,value])=>value):Object.entries(state.contracts);
 const transactions=local?'<details><summary>'+(fabric?'链码与近期交易':'合约地址与近期签名')+'</summary>'+
  fields.map(([k,v])=>row(escape(k),'<code>'+escape(v)+'</code>')).join('')+
  state.history.filter(j=>j.w===wallet).slice(0,15).map(j=>row(escape(j.fn)+' · 区块 '+escape(j.b),btn('回执',()=>receipt(j.h)))).join('')+'</details>':'';
 body.innerHTML='<div class="label">DRIVER WALLET</div><div class="toolbar"><h2>'+(fabric?'演示身份':'演示钱包')+'</h2>'+
  '<select id="walletselect" aria-label="'+(fabric?'切换 Fabric 身份':'切换钱包')+'">'+['A','B','C'].map(w=>'<option '+(w===wallet?'selected':'')+'>'+w+'</option>').join('')+'</select></div>'+
  '<div class="stats">'+stat('可用余额',cash(state.balance))+stat('求购托管',cash(escrow))+stat('持有编号',mine().length)+'</div>'+
  '<p><code>'+escape(state.address)+'</code></p><small>'+escape(ledgerInfo)+'</small><h3>我的订单</h3>'+
  (myOrders.map(o=>row(kinds[o.kind]+' · '+status[o.status]+' · '+cash(o.paid||o.price),btn('订单 '+o.id,()=>details(o)))).join('')||'<p class="muted">暂无订单。</p>')+transactions;
 find('#walletselect').onchange=async e=>{
  wallet=e.target.value;
  try{sessionStorage.setItem('rp-wallet',wallet)}catch{}
  selectedCar=0;garageCar=0;resetWorkshop();lastResult=null;ghost=null;ghostRec=null;
  await safe(async()=>{await reload();render()})
 }
}
async function openGame(){
 try{
  closeReward();
  await reload();notice('');
  if(location.hash.startsWith('#reward=')){
   const params=new URLSearchParams(location.hash.slice(1));
   const race=state.records.find(r=>r.driver===wallet&&r.id===params.get('reward'));
   if(race){showReward(race,{replay:params.get('replay')==='1'});return}
  }
  if(location.hash==='#garage'||location.hash.startsWith('#garage?')){
   const q=new URLSearchParams(location.hash.split('?')[1]);
   const part=A(Number(q.get('part'))),car=A(Number(q.get('car')));
   const race=state.records.find(r=>r.id===q.get('race')&&r.driver===wallet);
   openWorkshop({partId:part?.owner===state.address?part.id:0,carId:car?.owner===state.address?car.id:0,
    slotIndex:/^[012]$/.test(q.get('slot')||'')?Number(q.get('slot')):null,race,rerun:q.get('rerun')==='1'});
   return;
  }
  const resultId=new URLSearchParams(location.hash.slice(1)).get('result');
  const target=state.records.find(r=>r.driver===wallet&&r.id===resultId);
  if(target)results(target);else {page='比赛';render()}
 }catch(e){
  body.innerHTML='<h2>等待本地节点</h2><p>启动游戏服务后即可连接到雨港。</p>'+btn('重新连接',openGame,true);
  notice('连接失败 · '+e.message);
 }
}
window.addEventListener('hashchange',()=>{if(!current&&!busy)openGame()});
openGame();
