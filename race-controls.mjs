const physicalKeys={
  KeyW:'w',ArrowUp:'w',KeyS:'s',ArrowDown:'s',Space:'s',
  KeyA:'a',ArrowLeft:'a',KeyD:'d',ArrowRight:'d'
};
const namedKeys={w:'w',arrowup:'w',s:'s',arrowdown:'s',' ':'s',a:'a',arrowleft:'a',d:'d',arrowright:'d'};

export function bindDriveControls(view, change, isBlocked) {
  const controller=new AbortController(),options={signal:controller.signal};
  const pedalBar=view.querySelector('.pedals');
  const buttons=[...pedalBar.querySelectorAll('[data-key]')];
  const sources=new Map(),touchGroups=new Map();
  const touchDevice=window.matchMedia('(any-pointer:coarse)'),narrow=window.matchMedia('(max-width:680px)');
  let inputMode='';
  let last=[0,0,0];
  function layout(){
    view.classList.toggle('touch-controls',narrow.matches||inputMode==='touch'||(!inputMode&&touchDevice.matches));
  }
  layout();
  touchDevice.addEventListener('change',layout,options);
  narrow.addEventListener('change',layout,options);

  function publish() {
    let gas=false,brake=false,steer=0;
    // Insertion order reflects the last deliberate direction change.
    for(const key of sources.values()){
      if(key==='w')gas=true;
      if(key==='s')brake=true;
      if(key==='a')steer=-1;
      if(key==='d')steer=1;
    }
    const next=[Number(gas&&!brake),Number(brake),steer];
    if(last.every((v,i)=>v===next[i]))return;
    last=next;
    const down={w:!!next[0],s:brake,a:steer===-1,d:steer===1};
    for(const button of buttons){
      const pressed=down[button.dataset.key];
      button.classList.toggle('down',pressed);
      button.setAttribute('aria-pressed',String(pressed));
    }
    change(next);
  }

  function set(source,key){
    if(sources.get(source)===key)return;
    sources.delete(source);
    if(key)sources.set(source,key);
    publish();
  }
  function clear(){
    sources.clear();touchGroups.clear();publish();
  }
  function keyboard(event,pressed){
    const code=event.code||event.key.toLowerCase();
    const key=physicalKeys[code]||namedKeys[event.key.toLowerCase()];
    if(!key)return;
    if(pressed){
      if(isBlocked()||event.altKey||event.metaKey||event.ctrlKey)return;
      if(code==='Space'&&event.target.closest?.('.race-actions'))return;
      event.preventDefault();
      if(!event.repeat){
        if(!touchGroups.size&&inputMode!=='keyboard'){inputMode='keyboard';layout()}
        set('keyboard:'+code,key);
      }
    }else set('keyboard:'+code,undefined);
  }
  window.addEventListener('keydown',e=>keyboard(e,true),options);
  window.addEventListener('keyup',e=>keyboard(e,false),options);
  window.addEventListener('blur',clear,options);
  window.addEventListener('pagehide',clear,options);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clear()},options);

  view.addEventListener('pointerdown',e=>{
    if(e.pointerType==='touch'&&inputMode!=='touch'){inputMode='touch';layout()}
  },{...options,capture:true});
  pedalBar.addEventListener('pointerdown',e=>{
    const button=e.target.closest('[data-key]');
    if(!button||isBlocked()||(e.pointerType==='mouse'&&e.button!==0))return;
    e.preventDefault();
    touchGroups.set(e.pointerId,button.closest('.drive-pad'));
    button.setPointerCapture(e.pointerId);
    set(e.pointerId,button.dataset.key);
  },options);
  pedalBar.addEventListener('pointermove',e=>{
    const group=touchGroups.get(e.pointerId);
    if(!group)return;
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-key]');
    set(e.pointerId,target&&group.contains(target)?target.dataset.key:undefined);
  },options);
  function release(e){
    touchGroups.delete(e.pointerId);
    set(e.pointerId,undefined);
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])pedalBar.addEventListener(type,release,options);
  pedalBar.addEventListener('contextmenu',e=>e.preventDefault(),options);
  return {clear,destroy(){clear();controller.abort()}};
}
