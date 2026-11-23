import {CUT,L,botD,clamp} from './physics.mjs';
import {bindCourseGuide} from './course-guide.mjs';

export function cockpitMarkup(actions) {
  return `<section class="raceview" aria-label="雨港比赛">
    <canvas class="race-world" aria-label="雨港赛道追尾视角"></canvas>
    <div class="timing-board"><span class="hud-title">雨港 <i>/</i> 冲刺赛</span>
      <div class="race-position"><strong id="position">P8</strong><small>/ 8</small></div>
      <span id="sector">S1　港区湿弯</span>
      <div class="turn-guide" hidden><i aria-hidden="true"></i><div><strong></strong><small></small></div></div>
    </div>
    <div class="race-actions">${actions}</div>
    <div id="startlights" role="status"></div>
    <div class="split-clock"><small>单圈用时</small><b id="raceclock">0:00.000</b><span id="delta"></span></div>
    <div class="race-dash"><div class="rev-lights" aria-hidden="true"></div>
      <div class="dash-readout"><div class="speed-face"><strong id="speed">0</strong><small>km/h</small></div>
      <div class="gear-face"><b id="gear">1</b><small>挡位</small></div></div>
    </div>
    <div class="course-strip" aria-label="赛道进度"><div class="wet-length"></div><div class="sector-divider"></div>
      ${Array.from({length:7},()=>'<i class="rival-dot"></i>').join('')}<b class="player-dot"></b></div>
    <div class="pedals">
      <div class="drive-pad steer-pad" role="group" aria-label="转向">
        <button type="button" data-key="a" aria-label="左转" aria-pressed="false"><kbd>A</kbd><i aria-hidden="true"></i></button>
        <button type="button" data-key="d" aria-label="右转" aria-pressed="false"><kbd>D</kbd><i aria-hidden="true"></i></button>
      </div>
      <div class="drive-pad throttle-pad" role="group" aria-label="踏板">
        <button type="button" data-key="s" aria-label="刹车" aria-pressed="false"><kbd>S</kbd>刹车</button>
        <button type="button" data-key="w" aria-label="油门" aria-pressed="false"><kbd>W</kbd>油门</button>
      </div>
    </div>
  </section>`;
}

export function readInstruments(view,clock) {
  const at = id=>view.querySelector('#'+id);
  const speed=at('speed'),position=at('position'),sector=at('sector'),timer=at('raceclock');
  const gear=at('gear'),delta=at('delta'),lights=at('startlights'),revs=view.querySelector('.rev-lights');
  const opponents=view.querySelectorAll('.rival-dot'),player=view.querySelector('.player-dot');
  const launchHint=window.matchMedia('(pointer:coarse)').matches?'按住油门起步，左手控制方向':'W / ↑ 加速 · S / 空格刹车';
  const guide=bindCourseGuide(view.querySelector('.turn-guide'));
  let last=-1, previousCue='';
  function update(r,place,gap,secondsToStart) {
    const cue=secondsToStart>0?String(Math.ceil(secondsToStart)):r.t<1.05?'出发':'';
    if(cue!==previousCue){
      lights.textContent=cue;lights.className=cue==='出发'?'go':cue?'red':'';
      previousCue=cue;
    }
    // HUD instruments update at 16 Hz; car motion follows the display refresh rate.
    const stamp=performance.now();
    if(stamp-last<60)return cue;
    last=stamp;
    speed.textContent=Math.round(Math.hypot(r.v,r.bodySideSpeed||0)*3.6);
    position.textContent='P'+place;
    timer.textContent=clock(r.t);
    sector.textContent=r.d<CUT?'S1　港区湿弯':'S2　沿岸直道';
    guide(r,secondsToStart);
    gear.textContent=r.gear||Math.min(6,Math.max(1,Math.ceil(r.v/10)));
    revs.style.setProperty('--fill',Math.round(clamp(((r.rpm||1100)-1000)/5700,0,1)*100)+'%');
    delta.textContent=gap===null?(r.d<12?launchHint:'剩余 '+((L-r.d)/1000).toFixed(2)+' km'):'幽灵 '+(gap>0?'+':'')+gap.toFixed(2)+' s';
    delta.className=gap!==null&&gap<0?'ahead':'';
    player.style.left=clamp(r.d/L*100,0,100)+'%';
    opponents.forEach((dot,i)=>{dot.style.left=clamp(botD(Math.max(0,r.t-(r.rivalDelay?.[i]||0)),r.bots[i])/L*100,0,100)+'%';});
    return cue;
  }
  return update;
}
