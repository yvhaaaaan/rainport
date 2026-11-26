import {findPlayerKey,loadPlayerKey,signPlayerAction} from './player-keys.mjs';
import {digest,reviewDuel} from './duel-review.mjs';
import {paint,releaseTrack} from './art.mjs';
import {models,rarity} from './physics.mjs';
import {cockpitMarkup,readInstruments} from './race-hud.mjs';
import {bindDriveControls} from './race-controls.mjs';

const $ = s => document.querySelector(s);
const main = $('#duel'), nav = $('nav'), notice = msg => $('.toast').textContent = msg;
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action,label,data='',hot=false) => '<button type="button" class="'+(hot?'hot':'ghost')+'" data-act="'+action+'" data-value="'+esc(data)+'">'+esc(label)+'</button>';
const serial = n => '#'+String(n).padStart(3,'0');
const nameOf = a => models[a.model]+' '+serial(a.id)+' · '+rarity[a.edition];
const short = id => id?.slice(-8) || '';
const until = ms => new Date(ms).toLocaleTimeString('zh-CN',{hour12:false});
const list = rows => rows.join('')||'<p class="note">暂无记录</p>';
const row = (label,actions='') => '<div class="row"><div>'+label+'</div><div class="flex">'+actions+'</div></div>';
const sheet = (title,content) => '<section class="sheet"><h2>'+esc(title)+'</h2>'+content+'</section>';
const raceClock = t => Math.floor(t/60)+':'+(t%60).toFixed(3).padStart(6,'0');
let domain, key, alias=sessionStorage.getItem('duel.alias')||'', token=sessionStorage.getItem('duel.token')||'';
let room=null, inventory, race, chain, review, timer, busy=false, generation=0;
let pending=[],localInputs=[],seq=0, keys=[0,0,0], screen='';
const logKey=()=> 'duel.inputs.'+room.id+'.'+key.id;
function addInput(input) {
  const event=[++seq,...input];
  pending.push(event);localInputs.push(event);
}
function saveInputs() {
  if(!room || !key || !localInputs.length)return;
  try {sessionStorage.setItem(logKey(),JSON.stringify(localInputs));}catch{}
}
function logMatches() {
  return localInputs.every(([n,...input])=>{
    const recorded=room.log[n-1];
    // An outstanding packet may arrive after the finish line and be discarded.
    return !recorded ? n>room.received : input.every((value,i)=>value===recorded[i+2]);
  });
}
window.addEventListener('pagehide',saveInputs);

async function api(route, body={}) {
  const headers={'Content-Type':'application/json'};
  if(token) headers.Authorization='Bearer '+token;
  const response=await fetch('/api/duel/'+route,{method:'POST',headers,body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok) throw Error(result.error||'联机服务暂时不可用');
  return result;
}
async function signed(action,args) {
  const player=await api('player');
  const envelope=await signPlayerAction(key,domain,player.nonce+1,action,args);
  return api('action',{envelope});
}
function stopRace() {
  if(race){race.controls.destroy();cancelAnimationFrame(race.raf);releaseTrack(race.canvas);race=null;}
  $('#rainport').classList.remove('is-racing');
}
function entry() {
  generation++;clearTimeout(timer);stopRace();room=null;review=null;chain=null;screen='entry';nav.innerHTML='';
  $('.account').textContent='Fabric 联机';
  main.innerHTML='<div class="entry"><div class="coast"><h1>雨港双人赛</h1><p>两名车手，六辆 AI，一圈 3.78 公里。</p></div>'+
    '<form><h2>车手登录</h2><label for="alias">本机账号名</label><input id="alias" maxlength="80" autocomplete="username" value="'+esc(alias)+'" required>'+
    '<p class="note">第一次参赛请注册。签名密钥保存在这个浏览器中，清除网站数据将失去该身份。</p><div class="actions">'+button('login','登录','',true)+button('register','注册新车手')+'</div></form></div>';
}
function header() {
  $('.account').textContent=alias+' · '+short(key.id);
  nav.innerHTML=room?'':button('lobby','发车区')+button('inventory','我的库存')+button('market','部件市场')+button('logout','退出登录');
}
async function login(register) {
  alias=$('#alias').value.trim();
  key=register?await loadPlayerKey(alias):await findPlayerKey(alias);
  if(!key) throw Error('本浏览器找不到这个账号的密钥，请核对账号名或注册');
  if(register) await api('register',{envelope:await signPlayerAction(key,domain,1,'register',[])});
  const {challenge}=await api('challenge',{id:key.id});
  const result=await api('login',{envelope:await signPlayerAction(key,domain,0,'login',[challenge])});
  token=result.token;sessionStorage.setItem('duel.alias',alias);sessionStorage.setItem('duel.token',token);
  await home();
}
async function home() {
  const active=(await api('current')).room;
  if(active){accept(active);schedule();return;}
  await lobby();
}
async function lobby() {
  generation++;clearTimeout(timer);stopRace();room=null;chain=null;review=null;screen='lobby';
  inventory=await api('inventory');header();
  const options=inventory.assets.filter(a=>!a.model&&!a.lock&&a.parts.every(Boolean)&&a.busy<=Date.now()/1000)
    .map(a=>'<option value="'+a.id+'">'+esc(nameOf(a))+'</option>').join('');
  main.innerHTML='<h1>双人发车区</h1><div class="panel-grid">'+sheet('邀请好友',
    '<label for="car">参赛车辆</label><select id="car">'+options+'</select><div class="actions">'+button('create','创建房间','',true)+button('match','快速匹配')+'</div>'+
    '<label for="code">好友房间码</label><div class="actions"><input id="code" maxlength="6" placeholder="6 位房间码" autocomplete="off">'+button('join','加入房间')+'</div>')+
    sheet('比赛规则','<p>两人到齐后锁定车辆，在同一时刻发车。使用方向键或 WASD 驾驶，触屏可用方向和踏板按钮。</p><p>完赛后双方分别提交驾驶记录、复算用时并签名。确认一致后发奖，拒签或超时将退赛并解锁车辆。</p>')+'</div>';
}
function schedule(ms=room?.phase==='racing'?85:1100) {
  clearTimeout(timer);if(room)timer=setTimeout(poll,ms);
}
async function poll() {
  if(!room)return;
  if(busy){schedule();return;}
  const ticket=generation,code=room.code;
  try {
    const packet=pending.slice(0,64);
    const next=await api(room.phase==='racing'?'drive':'poll',{code,changes:packet});
    if(ticket!==generation||busy)return;
    accept(next);
    if(['review','closed'].includes(next.phase)&&next.manifest)await updateReview(ticket);
  }catch(e){
    if(ticket===generation){
      notice(e.message);
      if(room?.phase==='racing'&&/序号.*(冲突|重发)|最后确认的序号/.test(e.message)){
        const latest=await api('poll',{code}).catch(()=>null);
        if(latest&&ticket===generation){
          accept(latest);
          if(latest.phase==='racing'&&!latest.drivers.find(d=>d.id===key.id).done){
            pending=[];seq=latest.received;addInput(keys);
          }
        }
      }
    }
  }
  finally{if(ticket===generation)schedule();}
}
function accept(next) {
  const old=room;room=next;header();
  if(old?.id!==next.id){
    pending=[];seq=next.received||0;keys=[0,0,0];chain=null;review=null;localInputs=[];
    try{localInputs=JSON.parse(sessionStorage.getItem(logKey())||'[]').filter(e=>Array.isArray(e)&&e[0]<=seq);}catch{}
  }
  pending=pending.filter(event=>event[0]>next.received);
  seq=Math.max(seq,next.received||0);
  if(next.phase==='racing'){
    if(!race)startCockpit();
    race.latest=performance.now();return;
  }
  stopRace();
  if(next.phase==='waiting'||next.phase==='starting'){
    screen='waiting';
    main.innerHTML=sheet(next.phase==='waiting'?'等待另一位车手':'正在登记发车配置',
      '<p>将房间码发给好友</p><strong class="room-code" id="room-code">'+esc(next.code)+'</strong><p class="note">'+next.members.length+' / 2 名车手已加入</p>'+button('leave','退出房间'));return;
  }
  if(next.phase==='closed'&&!next.manifest){
    screen='closed';main.innerHTML=sheet('房间已关闭','<p>'+esc(next.reason)+'</p>'+button('leave','返回发车区'));return;
  }
  if(screen!=='review'){saveInputs();screen='review';main.innerHTML=sheet('赛果复核','<p>正在读取 Fabric 记录…</p>');}
}
function startCockpit() {
  screen='racing';$('#rainport').classList.add('is-racing');
  main.innerHTML=cockpitMarkup('<span id="peer-position"></span>'+button('refuse','退出比赛'));
  const view=$('.raceview'),canvas=$('.race-world'),instruments=readInstruments(view,raceClock);
  const controls=bindDriveControls(view,next=>{if(!race||room?.phase!=='racing')return;keys=next;addInput(keys);},()=>busy||room?.phase!=='racing');
  race={canvas,controls,latest:performance.now()};
  // On reconnect explicitly reset any pedal held by the previous browser session.
  addInput([0,0,0]);
  function draw(now) {
    if(!race||room?.phase!=='racing')return;
    const own=room.drivers.find(p=>p.id===key.id),peer=room.drivers.find(p=>p.id!==key.id);
    const player=room.manifest.players.find(p=>p.id===key.id);
    const elapsed=Math.min(.10,Math.max(0,(now-race.latest)/1000));
    const predict=p=>({...p,d:p.done?p.d:Math.min(3780,p.d+p.v*elapsed)});
    const car={...predict(own),keys,config:player.config,spec:player.spec,opponents:[peer,...room.bots].map(predict)};
    paint(canvas,car);instruments(car,own.rank,null,(room.startMs-room.serverMs)/1000-elapsed);
    $('#peer-position').textContent='对手 P'+peer.rank+' · '+Math.round(peer.d)+' m';
    if(own.done)$('#startlights').textContent='已完赛，等待对手';
    race.raf=requestAnimationFrame(draw);
  }
  $('#race-car').textContent='双人赛 · '+room.code;
  race.raf=requestAnimationFrame(draw);
}
const reasons={expired:'确认超时',refused:'车手拒签或退赛',disagreement:'双方赛果摘要不一致'};
async function updateReview(ticket=generation) {
  const state=await api('info',{id:room.manifest.id});
  if(ticket!==generation||!room)return;
  chain=state;
  if(chain.logs&&!review&&room.drivers){
    try{review=await reviewDuel(chain,room.drivers);}
    catch(error){review={error:error.message};}
  }
  if(ticket===generation)showReview();
}
function showReview() {
  const i=chain.manifest.players.findIndex(p=>p.id===key.id),finished=['settled','closed'].includes(chain.status);
  const source='/duel/verifiers/'+chain.manifest.verifierHash+'.mjs';
  let content='<p>房间 '+esc(room.code)+' · 确认截止 '+until(chain.deadline*1000)+'</p>'+
    '<details><summary>本场规则与链上记录</summary><p class="hash">'+esc(chain.manifest.id)+'</p><a href="'+source+'" target="_blank" rel="noopener">查看本场验证程序源码</a><p class="hash">SHA-256 '+esc(chain.manifest.verifierHash)+'</p>'+
    (chain.logs?'<details><summary>两份原始驾驶输入</summary><pre>'+esc(JSON.stringify(chain.logs))+'</pre></details>':'')+'</details>';
  if(room.reason)content+='<p>'+esc(room.reason)+'</p>';
  if(chain.status==='closed')content+='<p>本场已关闭 · '+esc(reasons[chain.reason]||chain.reason)+'。车辆已解锁，本场无奖励。</p>';
  else if(chain.status==='settled'){
    content+='<h3>双方已签名，Fabric 已结算</h3>'+chain.results.map((r,n)=>row((n===i?'你':'对手')+' · 第 '+r.rank+' 名 · '+r.totalMs+' ms',chain.prizes[n]?'获得部件 '+serial(chain.prizes[n]):'未掉落')).join('');
  }else if(!chain.logs){
    content+='<p>已提交记录摘要 '+chain.commitments.filter(Boolean).length+' / 2</p>';
    if(!chain.commitments[i]&&room.log){
      content+='<details><summary>查看将签署的 '+room.log.length+' 条驾驶输入</summary><p>每行依次为序号、生效模拟步、油门、刹车、转向。</p><pre>'+
        esc(room.log.map(e=>e.join('　')).join('\n'))+'</pre></details>';
      content+=logMatches()?button('commit','签名提交我的驾驶记录','',true):'<p class="bad">记录和本机发送的操作不符，请拒签。</p>';
    }
  }
  if(review?.error)content+='<p class="bad">复核失败 · '+esc(review.error)+'</p>';
  if(review?.results){
    content+='<h3>此设备的复算结果</h3>'+review.results.map((r,n)=>{
      const live=room.drivers.find(d=>d.id===r.id);
      return row((n===i?'你':'对手')+' · 第 '+r.rank+' 名 · '+r.totalMs+' ms',
        '与完赛计时相差 '+(r.totalMs-live.totalMs)+' ms · 名次差 '+(r.rank-live.rank));
    }).join('')+'<p class="hash">赛果摘要 '+esc(review.resultHash)+'</p>';
    if(chain.status==='review'){
      content+='<p>已签名 '+chain.confirmations.filter(Boolean).length+' / 2</p>';
      if(!chain.confirmations[i]&&!review.differences.length)content+=button('confirm','签名确认复算结果','',true);
    }
  }
  content+='<div class="actions">'+(finished?button('leave','返回发车区'):button('refuse','拒签并退出本场'))+'</div>';
  const signature=JSON.stringify([chain.manifest.id,chain.status,chain.commitments,chain.confirmations.map(Boolean),room.phase,review?.resultHash,review?.error]);
  if(screen==='review'&&main.dataset.review===signature)return;
  main.dataset.review=signature;screen='review';main.innerHTML=sheet('赛果复核',content);
}

async function warehouse(target) {
  inventory=await api('inventory');screen=target;header();
  const mine=inventory.assets, orders=inventory.orders, market=target==='market';
  const getItem=id=>[...mine,...inventory.items].find(a=>a.id===id);
  let html='<h1>'+(market?'部件市场':'我的库存')+'</h1><p>可用余额 '+inventory.player.balance+' CR</p>';
  if(!market){
    html+=sheet('我的赛车和部件',list(mine.map(a=>{
      let actions=button('label','部件履历',a.id);
      if(!a.model)actions='已装 '+a.parts.map(serial).join(' / ');
      else if(a.mount)actions+=' 装在 '+serial(a.mount);
      else if(!a.lock)actions+=button('offer','挂牌',a.id);
      else actions+=' 已挂牌';
      return row(esc(nameOf(a)),actions);
    })));
  }else{
    const open=orders.filter(o=>o.status===1&&o.expires>Date.now()/1000);
    const cheapest=new Set();
    const askRows=open.sort((a,b)=>a.price-b.price||a.id-b.id).map(o=>{
      const a=getItem(o.ids[0]),label=a?nameOf(a):serial(o.ids[0]);
      const own=o.maker===key.id,available=o.kind!==1||!cheapest.has(o.key);
      if(o.kind===1&&!own)cheapest.add(o.key);
      return row(esc(label)+' · '+(o.kind===1?'同款卖单':'指定编号')+' · '+o.price+' CR',
        (a?button('label','履历',a.id):'')+(own?button('cancel','签名撤单',o.id):available?button('buy','签名买入',o.id):'同款优先成交最低价'));
    });
    html+=sheet('在售部件',list(askRows));
    const expired=orders.filter(o=>o.maker===key.id&&o.status===1&&o.expires<=Date.now()/1000);
    if(expired.length)html+=sheet('到期卖单',list(expired.map(o=>row('订单 '+serial(o.id)+' · 部件 '+serial(o.ids[0]),button('cancel','签名取回部件',o.id)))));
    html+=sheet('我的成交记录',list(orders.filter(o=>o.status===2).map(o=>row('订单 '+serial(o.id)+' · '+o.paid+' CR · '+(o.buyer===key.id?'买入':'卖出'),button('receipt','交易回执',o.hashes.at(-1))))));
  }
  main.innerHTML=html+'<section id="detail" aria-live="polite"></section>';
}
function offer(value) {
  const a=inventory.assets.find(a=>a.id===value);
  $('#detail').innerHTML=sheet('出售 '+nameOf(a),
    '<label for="ask-kind">挂牌方式</label><select id="ask-kind"><option value="2">按编号出售</option><option value="1">按同款出售</option></select>'+
    '<label for="price">售价（CR）</label><input id="price" type="number" value="68" min="1" max="1000000000" step="1">'+
    '<p class="note">订单有效期 7 天，成交手续费为 2%，向下取整。</p>'+button('list','签名挂牌',a.id,true));
  $('#detail').scrollIntoView({block:'nearest'});
}
async function showLabel(value) {
  const a=[...inventory.assets,...inventory.items].find(a=>a.id===value);
  let details='<p>首任持有者 <span class="hash">'+esc(a.first)+'</span></p>';
  if(a.origin){
    details+='<p class="hash">来源比赛 '+esc(a.origin)+' · 第 '+a.originRank+' 名</p>';
    const {kind,race:source}=await api('origin',{asset:a.id});
    if(kind==='duel'){
      details+='<p class="hash">赛果摘要 '+esc(source.resultHash)+'</p>'+list(source.confirmations.map(c=>row(
        '<span class="hash">'+esc(c.envelope.id)+'<br>签名 '+esc(c.envelope.signature)+'</span>',button('receipt','确认回执',c.tx))));
    }else{
      details+='<p>历史单人赛 · 由当时的裁判签署</p><p class="hash">'+esc(source.summary)+'</p>'+
        (source.tx||[]).map(h=>button('receipt','历史赛事回执',h)).join('');
    }
  }else details+='<p>来源 · 初始发行</p>';
  const transfers=await api('transfers',{asset:a.id});
  details+='<h3>成交履历</h3>'+list(transfers.map(t=>row('成交 · <span class="hash">'+esc(short(t.from))+' → '+esc(short(t.to))+'</span>',button('receipt','成交回执',t.hash))));
  $('#detail').innerHTML=sheet(nameOf(a),details)+'<div id="proof"></div>';
  $('#detail').scrollIntoView({block:'nearest'});
}
async function showReceipt(hash) {
  const rc=await api('receipt',{hash});
  const box=$('#proof')||$('#detail');
  box.innerHTML=sheet('Fabric 交易回执','<p>区块 '+rc.block+' · '+esc(rc.validationCode)+'</p><p class="hash">'+esc(rc.hash)+'</p>');
  box.scrollIntoView({block:'nearest'});
}
async function handle(action,value) {
  if(action==='register'||action==='login')return login(action==='register');
  if(action==='logout'){
    await api('logout');sessionStorage.removeItem('duel.token');token='';key=null;entry();return;
  }
  if(action==='lobby')return home();
  if(action==='market'||action==='inventory')return warehouse(action);
  if(action==='offer')return offer(+value);
  if(action==='label')return showLabel(+value);
  if(action==='receipt')return showReceipt(value);
  if(action==='list'){
    const price=Number($('#price').value);
    if(!Number.isSafeInteger(price)||price<1||price>1e9)throw Error('请输入 1 至 10 亿的整数价格');
    await signed('list',[Number($('#ask-kind').value),+value,price,Math.floor(Date.now()/1000)+7*86400]);
    return warehouse('market');
  }
  if(action==='buy'||action==='cancel'){
    const o=inventory.orders.find(o=>o.id===+value);
    if(!o)throw Error('请刷新订单');
    await signed(action==='buy'?'buy':'close',action==='buy'?[o.id,o.price]:[o.id]);return warehouse('market');
  }
  if(['create','join','match'].includes(action)){
    const car=Number($('#car')?.value);
    if(!car)throw Error('请先选择可用的赛车');
    try {accept(await api(action,{car,code:$('#code').value.trim().toUpperCase()}));}
    catch(err){const active=(await api('current')).room;if(active)accept(active);throw err;}
    return;
  }
  if(action==='commit'){
    if(!Array.isArray(room.log)||!logMatches())throw Error('驾驶记录未通过本机核对');
    await signed('duelCommit',[room.manifest.id,await digest(room.log)]);
  }else if(action==='confirm'){
    if(!review?.results||review.differences.length)throw Error('请先完成并核对本机复算');
    await signed('duelConfirm',[room.manifest.id,review.inputHashes,review.results,review.resultHash]);
  }else if(action==='refuse'){
    if(!window.confirm('退出将关闭本场比赛，双方都不会发奖。确认退出？'))return;
    await signed('duelRefuse',[room.manifest.id]);
    await api('leave',{code:room.code});return lobby();
  }else if(action==='leave'){
    await api('leave',{code:room.code});return lobby();
  }else return;
  await updateReview();
}
async function invoke(action,value='') {
  if(busy)return;
  busy=true;generation++;clearTimeout(timer);notice('');
  try{await handle(action,value);}
  catch(e){notice(e.message);}
  finally{busy=false;if(room)schedule();}
}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');if(b&&!b.disabled)void invoke(b.dataset.act,b.dataset.value);
});
document.addEventListener('submit',e=>{e.preventDefault();if(screen==='entry')void invoke('login');});
try{
  ({domain}=await api('domain'));
  if(!crypto.subtle)throw Error('请使用 HTTPS 或 localhost 打开联机入口');
  if(alias&&token&&(key=await findPlayerKey(alias))) {
    try {await home();} catch(e){entry();notice(e.message);}
  }else entry();
}catch(e){main.textContent=e.message;}
