// Synthesize engine firing pulses, intake, tyre scrub and wind from the live car telemetry.
export function makeRaceAudio() {
  let context, master, crank, intake, engineLevel, exhaust, wind, tyres, thud, tyreFilter;
  let muted=false, lastImpact=0, lastCue='', nextUpdate=0, rewardBus;
  try { muted=localStorage.getItem('rainport-muted')==='1'; } catch {}
  function audioContext(){
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!context&&Audio){try{context=new Audio()}catch{return null}}
    return context;
  }
  function arm() {
    if(!audioContext())return;
    if (!master) {
      master=context.createGain(); master.gain.value=0; master.connect(context.destination);
      const volume=(value,dest)=>{const node=context.createGain();node.gain.value=value;node.connect(dest);return node;};
      const filter=(type,hz,dest)=>{const f=context.createBiquadFilter();f.type=type;f.frequency.value=hz;f.connect(dest);return f;};
      const tone=(type,hz,dest)=>{const o=context.createOscillator();o.type=type;o.frequency.value=hz;o.connect(dest);o.start();return o;};
      engineLevel=volume(0,master);
      exhaust=filter('lowpass',620,engineLevel);exhaust.Q.value=.58;
      crank=tone('sawtooth',57,volume(.46,exhaust));
      intake=tone('triangle',114,volume(.48,exhaust));
      const buffer=context.createBuffer(1,context.sampleRate*2,context.sampleRate);
      const samples=buffer.getChannelData(0);
      for(let i=0;i<samples.length;i++)samples[i]=Math.random()*2-1;
      const air=context.createBufferSource();air.buffer=buffer;air.loop=true;
      wind=volume(0,master);tyres=volume(0,master);thud=volume(0,master);
      const rush=filter('lowpass',1450,wind);
      tyreFilter=filter('bandpass',1360,tyres);tyreFilter.Q.value=1.3;
      air.connect(rush);air.connect(tyreFilter);air.connect(filter('lowpass',175,thud));air.start();
    }
    lastCue='';lastImpact=0;nextUpdate=0;
    context.resume().catch(()=>{});
  }
  function update(r, cue) {
    if(!context)return;
    const now=context.currentTime, gas=r.keys[0], v=r.v;
    // Web Audio ramps continuously between control updates, including on 165 Hz displays.
    if(now<nextUpdate&&(!cue||lastCue===cue))return;
    nextUpdate=now+1/40;
    const rpm=r.rpm||Math.min(7300,1050+105*v);
    const hz=Math.max(39,rpm/60*3);
    function move(param,value,speed=.054){param.setTargetAtTime(value,now,speed);}
    move(master.gain,muted||document.hidden?0:.38);
    move(crank.frequency,hz);move(intake.frequency,hz*.506);
    move(engineLevel.gain,.135+gas*.14+v*.0005);
    move(exhaust.frequency,Math.min(3000,420+rpm*(gas?.26:.095)));
    move(wind.gain,.01+.12*(v/55)**2);
    move(tyres.gain,Math.min(.38,(r.slip||0)*.36+(r.rumble||0)*.30));
    move(tyreFilter.frequency,1010+v*12);
    const impact=r.impact||0;
    if(impact>.25 && lastImpact<.15)thud.gain.setValueAtTime(.55*impact,now);
    move(thud.gain,0,.1);lastImpact=impact;
    if(cue&&cue!==lastCue){
      lastCue=cue;
      const beep=context.createOscillator(),env=context.createGain();
      beep.type='sine';beep.frequency.value=cue==='出发'?910:540;
      beep.connect(env);env.connect(master);
      env.gain.setValueAtTime(.12,now);env.gain.exponentialRampToValueAtTime(.001,now+(cue==='出发'?.32:.12));
      beep.start(now);beep.stop(now+.34);beep.onended=()=>{beep.disconnect();env.disconnect();};
    }
  }
  function armReward(){
    if(muted||document.hidden||!audioContext())return;
    if(!rewardBus){rewardBus=context.createGain();rewardBus.connect(context.destination)}
    rewardBus.gain.value=.7;context.resume().catch(()=>{});
  }
  function stopReward(){
    if(!rewardBus)return;
    rewardBus.gain.value=0;
    if(!master||master.gain.value===0)context.suspend().catch(()=>{});
  }
  function rewardCue(kind){
    if(muted||document.hidden||!rewardBus||context.state!=='running')return;
    const now=context.currentTime;
    function note(hz,start,length,level,type){
      const tone=context.createOscillator(),env=context.createGain();
      tone.type=type;tone.frequency.value=hz;tone.connect(env);env.connect(rewardBus);
      env.gain.setValueAtTime(.0001,start);env.gain.exponentialRampToValueAtTime(level,start+.003);
      env.gain.exponentialRampToValueAtTime(.0001,start+length);
      tone.start(start);tone.stop(start+length+.01);tone.onended=()=>{tone.disconnect();env.disconnect()};
    }
    if(kind==='tick'){note(1400,now,.026,.058,'triangle');return}
    if(kind==='win'){note(440,now,.18,.12,'sine');note(659,now+.10,.32,.10,'sine')}
    if(kind==='empty')note(205,now,.19,.08,'sine');
  }
  function stop() {if(master){master.gain.cancelScheduledValues(context.currentTime);master.gain.value=0;context.suspend().catch(()=>{});}}
  function toggle() { muted=!muted;if(muted)stopReward();try{localStorage.setItem('rainport-muted',muted?'1':'0');}catch{} return muted; }
  return {arm,update,stop,toggle,armReward,rewardCue,stopReward,get muted(){return muted;}};
}
