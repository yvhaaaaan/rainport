import {gt27Atlas} from './gt27-environment.mjs';
import {gt27Meshes} from './car-geometry.mjs';

// Each surface keeps its original metal, lacquer, glass or rubber response. A single
// indexed mesh per part lets a full field share geometry without changing materials
// for every grille strip, spoke and brake disc.
const gt27Surfaces = [
  [0x258d82, .52, .24], [0x29323a, .52, .31], [0x222a31, .27, .37],
  [0x294554, .69, .12], [0xd0d5d8, .78, .23], [0x697277, .69, .28],
  [0x27292a, .02, .82], [0x171b1e, .01, .88], [0xffecd2, .21, .27],
  [0xff7937, .34, .27], [0xc7eeff, .05, .14], [0xff2531, .08, .19],
  [0x9a9b9e, .70, .43], [0x31393d, .05, .67], [0x11171b, .13, .43]
];
const gt27Shared = new WeakMap();

function gt27Library(T) {
  if(gt27Shared.has(T)) return gt27Shared.get(T);
  const cache = {meshes:new Map(), textures:new Map()};
  gt27Shared.set(T,cache);
  return cache;
}

function gt27Geometry(T,name){
  const meshes=gt27Library(T).meshes;
  if(meshes.has(name)) return meshes.get(name);
  const bytes=s=>Uint8Array.from(atob(s), c=>c.charCodeAt(0));
  const [vertices,faces]=gt27Meshes[name].map(bytes);
  const raw=new DataView(vertices.buffer);
  const count=vertices.length/10;
  const pos=new Float32Array(count*3), normal=new Int8Array(count*3);
  const rgb=new Uint8Array(count*3), surface=new Uint8Array(count*3);
  const palette=gt27Surfaces.map(([c])=>new T.Color(c));
  for(let i=0;i<count;i++){
    const src=i*10, k=i*3, mat=vertices[src+9], c=palette[mat];
    for(let j=0;j<3;j++){
      pos[k+j]=raw.getInt16(src+j*2,true)*.001;
      normal[k+j]=raw.getInt8(src+6+j);
    }
    rgb[k]=Math.round(c.r*255);rgb[k+1]=Math.round(c.g*255);rgb[k+2]=Math.round(c.b*255);
    surface[k]=Math.round(gt27Surfaces[mat][2]*255);
    surface[k+1]=Math.round(gt27Surfaces[mat][1]*255);
    // 0 = coloured lacquer, 1 = standard surface, 2 = headlight, 3 = brake lens.
    surface[k+2]=mat===0?0:mat===10?170:mat===11?255:85;
  }
  const mesh=new T.BufferGeometry();
  mesh.setAttribute('position',new T.BufferAttribute(pos,3));
  mesh.setAttribute('normal',new T.BufferAttribute(normal,3,true));
  mesh.setAttribute('color',new T.BufferAttribute(rgb,3,true));
  mesh.setAttribute('gtSurface',new T.BufferAttribute(surface,3,true));
  mesh.setIndex(new T.BufferAttribute(new Uint16Array(faces.buffer),1));
  mesh.computeBoundingSphere();
  meshes.set(name,mesh);
  return mesh;
}

function gt27Material(T,paint,braking,ghost){
  if(ghost)return new T.MeshBasicMaterial({color:0x79eddf,transparent:true,opacity:.31,depthWrite:false});
  const material=new T.MeshStandardMaterial({
    color:0xffffff,vertexColors:true,roughness:1,metalness:1,side:T.DoubleSide,envMapIntensity:1.2
  });
  material.onBeforeCompile=shader=>{
    shader.uniforms.gtFinish=paint;
    shader.uniforms.gtBrake=braking;
    shader.vertexShader=shader.vertexShader.replace('#include <common>',
      '#include <common>\nattribute vec3 gtSurface; varying vec3 gtCoefficients; uniform vec3 gtFinish;')
      .replace('#include <color_vertex>',
        '#include <color_vertex>\n gtCoefficients=gtSurface; if(gtSurface.b<0.16) vColor.rgb=gtFinish;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',
      '#include <common>\nvarying vec3 gtCoefficients; uniform float gtBrake;')
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\n roughnessFactor=gtCoefficients.r;')
      .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\n metalnessFactor=gtCoefficients.g;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n if(gtCoefficients.b>.84){totalEmissiveRadiance+=vec3(2.2+3.0*gtBrake,.015,.023);}else if(gtCoefficients.b>.50){totalEmissiveRadiance+=vec3(1.3,1.7,2.0);}');
  };
  material.customProgramCacheKey=()=>'gt27-surface-v1';
  return material;
}

// Load the prefiltered HDR atlas directly. Generating a separate PMREM for this
// fixed environment at every grid and replay used to stall the first displayed frame.
function gt27Reflections(T){
  const cache=gt27Library(T);
  if(cache.reflections)return cache.reflections;
  const width=336,height=256,pixels=width*height;
  const rgba=new Uint16Array(pixels*4),radiance=new Uint16Array(256);
  for(let i=0;i<256;i++)radiance[i]=T.DataUtils.toHalfFloat((i/116)**2);
  const packed=atob(gt27Atlas);
  let src=0;
  for(let c=0;c<3;c++){
    let value=0,dst=0;
    while(dst<pixels){
      const header=packed.charCodeAt(src++),run=(header&127)+1;
      for(let j=0;j<run;j++,dst++){
        if(header<128)value=(value+packed.charCodeAt(src++))&255;
        rgba[dst*4+c]=radiance[value];
      }
    }
  }
  for(let i=3;i<rgba.length;i+=4)rgba[i]=0x3c00;
  const tex=new T.DataTexture(rgba,width,height,T.RGBAFormat,T.HalfFloatType);
  tex.mapping=T.CubeUVReflectionMapping;tex.colorSpace=T.LinearSRGBColorSpace;
  tex.minFilter=T.LinearFilter;tex.magFilter=T.LinearFilter;tex.needsUpdate=true;
  cache.reflections=tex;return tex;
}

function gt27RearFascia(T){
  const meshes=gt27Library(T).meshes,key='rear-fascia';
  if(meshes.has(key))return meshes.get(key);
  const pos=[],rgb=[],surface=[];
  function strip(vertices,mat){
    const c=new T.Color(gt27Surfaces[mat][0]);
    for(let i=0;i<vertices.length-2;i++){
      const face=i%2?[i+1,i,i+2]:[i,i+1,i+2];
      for(const n of face){
        pos.push(...vertices[n]);rgb.push(c.r,c.g,c.b);
        surface.push(gt27Surfaces[mat][2],gt27Surfaces[mat][1],mat===11?1:1/3);
      }
    }
  }
  for(const side of [-1,1]){
    const line=(points,heights,mat)=>{
      const v=[];
      for(let i=0;i<points.length;i++){const [x,y,z]=points[i];v.push([side*x,y,z],[side*x,y+heights[i],z]);}
      strip(v,mat);
    };
    line([[0,.466,-2.338],[.28,.45,-2.341],[.64,.434,-2.342],[.84,.455,-2.337],[.96,.48,-2.18]],
      [.088,.102,.115,.078,.037],1);
    line([[.17,.516,-2.349],[.35,.501,-2.351],[.67,.493,-2.352],[.823,.518,-2.347],[.943,.532,-2.203]],
      [.009,.014,.020,.016,.009],11);
    line([[.52,.463,-2.351],[.65,.458,-2.352],[.79,.477,-2.349]],
      [.006,.008,.008],11);
    line([[.01,.186,-2.34],[.32,.191,-2.341],[.53,.20,-2.341],[.62,.31,-2.34],[.83,.326,-2.337],[.94,.31,-2.18]],
      [.024,.025,.031,.025,.024,.025],2);
    const roof=[[-.596,1.176],[-.28,1.215],[.08,1.210],[.277,1.164]];
    strip(roof.flatMap(([z,y])=>[[side*.088,y+.003,z],[side*.13,y+.003,z]]),8);
    const deck=[[-2.286,.599],[-2.16,.665],[-1.82,.711],[-1.48,.719]];
    strip(deck.flatMap(([z,y])=>[[side*.09,y+.013,z],[side*.138,y+.013,z]]),8);
  }
  const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));
  geo.setAttribute('color',new T.Float32BufferAttribute(rgb,3));geo.setAttribute('gtSurface',new T.Float32BufferAttribute(surface,3));
  geo.computeVertexNormals();meshes.set(key,geo);return geo;
}

function gt27Texture(T,type){
  const textures=gt27Library(T).textures;
  if(textures.has(type))return textures.get(type);
  const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
  const c=canvas.getContext('2d');
  if(type==='plate'){
    c.fillStyle='#ccd2c9';c.fillRect(1,24,126,80);
    c.strokeStyle='#3c4240';c.lineWidth=5;c.strokeRect(5,28,118,72);
    c.font='bold 40px sans-serif';c.textAlign='center';c.fillStyle='#182024';c.fillText('GT 27',64,79);
  }else if(type==='tail-pair'){
    const single=gt27Texture(T,'reflection').image;
    c.drawImage(single,0,0,51,128);c.drawImage(single,77,0,51,128);
  }else if(type==='shadow'){
    const gradient=c.createRadialGradient(64,64,0,64,64,64);
    gradient.addColorStop(0,'#fff');gradient.addColorStop(.64,'rgba(255,255,255,.93)');
    gradient.addColorStop(.88,'rgba(255,255,255,.37)');gradient.addColorStop(1,'rgba(255,255,255,0)');
    c.fillStyle=gradient;c.fillRect(0,0,128,128);
    // Contact patches below the four tyres, baked together to keep one draw call.
    for(const x of [26,102])for(const y of [31,97]){
      const foot=c.createRadialGradient(x,y,1,x,y,12);
      foot.addColorStop(0,'#fff');foot.addColorStop(.45,'rgba(255,255,255,.92)');foot.addColorStop(1,'rgba(255,255,255,0)');
      c.fillStyle=foot;c.fillRect(x-12,y-12,24,24);
    }
  }else{
    const glow=c.createRadialGradient(64,64,0,64,64,62);
    glow.addColorStop(0,'rgba(255,255,255,.94)');
    glow.addColorStop(.25,'rgba(255,255,255,.64)');
    glow.addColorStop(.61,'rgba(255,255,255,.16)');glow.addColorStop(1,'rgba(255,255,255,0)');
    c.fillStyle=glow;c.fillRect(0,0,128,128);
    if(type==='reflection'){
      c.globalCompositeOperation='destination-out';
      for(let i=0;i<45;i++){
        c.fillStyle='rgba(0,0,0,'+(.18+((i*11)%17)/27)+')';
        c.fillRect(0,(i*37)%128,128,1+(i%2));
      }
    }
  }
  const texture=new T.CanvasTexture(canvas);texture.colorSpace=T.SRGBColorSpace;
  textures.set(type,texture);return texture;
}

function createRaceCar(T,{color=0xe8763e,ghost=false,player=false}={}){
  const object=new T.Group(), body=new T.Group();
  object.name=ghost?'GT27 ghost':player?'GT27 driver':'GT27 rival';
  object.add(body);
  const pivot=new T.Group();pivot.rotation.y=Math.PI;body.add(pivot);
  const brakeLevel={value:0}, paint={value:new T.Color(color)};
  const finish=gt27Material(T,paint,brakeLevel,ghost);
  const ownedMaterials=[finish], ownedGeometry=[];
  const mesh=(name,parent)=>{const m=new T.Mesh(gt27Geometry(T,name),finish);parent.add(m);return m;};
  const wheels=[];
  let wingMesh, engineMesh;
  if(player && !ghost){
    mesh('Chassis',pivot);
    for(const side of [-1,1])for(const longitudinal of [1.36,-1.4]){
      const mount=new T.Group();mount.position.set(side*.898,.353,longitudinal);
      pivot.add(mount);
      const wheel=mesh('RoadWheel',mount);
      wheel.rotation.y=side<0?Math.PI:0;
      wheels.push({wheel,mount,front:longitudinal>0});
    }
    wingMesh=mesh('SprintWing',pivot);wingMesh.position.set(0,.68,-1.94);
    engineMesh=mesh('HarborV8',pivot);engineMesh.position.set(0,.28,-1.30);
    const plateMat=new T.MeshBasicMaterial({map:gt27Texture(T,'plate'),transparent:true,depthWrite:false});
    const plateGeo=new T.PlaneGeometry(.37,.20);
    const plate=new T.Mesh(plateGeo,plateMat);plate.position.set(0,.435,-2.341);plate.rotation.y=Math.PI;
    pivot.add(plate);ownedMaterials.push(plateMat);ownedGeometry.push(plateGeo);
  }else mesh('rival',pivot);
  if(!ghost){
    const detail=new T.Mesh(gt27RearFascia(T),finish);
    pivot.add(detail);
    finish.envMap=gt27Reflections(T);
  }

  const patches=[];
  const glows=[], fans=[];
  if(!ghost){
    const plane=new T.PlaneGeometry(1,1);ownedGeometry.push(plane);
    const groundPatch=(type,col,w,h,x,z,alpha,add)=>{
      const mat=new T.MeshBasicMaterial({map:gt27Texture(T,type),color:col,transparent:true,opacity:alpha,
        depthWrite:false,blending:add?T.AdditiveBlending:T.NormalBlending,polygonOffset:true,polygonOffsetFactor:-2});
      const patch=new T.Mesh(plane,mat);patch.rotation.x=-Math.PI/2;
      patch.scale.set(w,h,1);patch.position.set(x,.028,z);patch.renderOrder=add?2:1;
      object.add(patch);ownedMaterials.push(mat);return patch;
    };
    groundPatch('shadow',0x010305,3.05,5.7,0,.01,.92,false);
    if(!player)patches.push(groundPatch('tail-pair',0xf41c12,1.8,2.0,0,2.42,.33,true));
    if(player)for(const x of [-.54,.54]){
      patches.push(groundPatch('reflection',0xf41c12,.72,2.0,x,2.42,.33,true));
      const mat=new T.SpriteMaterial({map:gt27Texture(T,'glow'),color:0xff251b,opacity:.61,
        blending:T.AdditiveBlending,depthWrite:false});
      const glow=new T.Sprite(mat);glow.position.set(x,.534,2.351);glow.scale.set(.71,.13,1);
      body.add(glow);glows.push(glow);ownedMaterials.push(mat);
    }
    if(player)for(const side of [-1,1]){
      const mat=new T.SpriteMaterial({map:gt27Texture(T,'glow'),color:0xb6d6e3,transparent:true,depthWrite:false,opacity:0});
      const fan=new T.Sprite(mat);fan.position.set(side*.90,.20,2.4);object.add(fan);ownedMaterials.push(mat);fans.push(fan);
    }
  }
  let steering=0, pitch=0, wheelAngle=0, oldTire=-1,oldWing=-1,oldEngine=-1;
  function update({speed=0,steer=0,brake=0,throttle=0,slip=0,wing=5,spec,dt=.016,time=0}={}){
    const v=Math.max(0,speed), s=Math.min(1,v/40), span=Math.max(0,Math.min(.1,dt));
    const damp=1-Math.exp(-span*11);
    steering+=(Math.max(-1,Math.min(1,steer))-steering)*damp;
    pitch+=((Number(brake)*-.027+Number(throttle)*.009)*s-pitch)*damp;
    body.rotation.set(pitch,0,steering*s*.026);
    body.position.y=.004*s*Math.sin(time*29);
    brakeLevel.value=Number(brake)||0;
    if(wheels.length){
      wheelAngle=(wheelAngle+v*span/.353)%(Math.PI*2);
      const tire=spec?.[1]===4?4:3;
      if(tire!==oldTire){for(const {wheel} of wheels)wheel.geometry=gt27Geometry(T,tire===4?'RainWheel':'RoadWheel');oldTire=tire;}
      for(const {mount,front} of wheels){mount.rotation.order='YXZ';mount.rotation.y=front?-steering*.27:0;mount.rotation.x=wheelAngle;}
      const wingId=spec?.[2]??wing,engineId=spec?.[0]??1;
      if(oldWing!==wingId){wingMesh.geometry=gt27Geometry(T,wingId===6?'AeroWing':'SprintWing');oldWing=wingId;}
      if(oldEngine!==engineId){engineMesh.geometry=gt27Geometry(T,engineId===2?'SprintV8':'HarborV8');oldEngine=engineId;}
    }
    for(const p of patches){p.material.opacity=.28+brakeLevel.value*.48;p.scale.y=1.6+s*.9+brakeLevel.value*.55;}
    for(const g of glows){g.material.opacity=.52+brakeLevel.value*.41;g.scale.y=.12+brakeLevel.value*.09;}
    for(let i=0;i<fans.length;i++){
      const fan=fans[i], ripple=Math.sin(time*17+i*2);
      const spray=Math.max(0,Math.min(1,(v-8)/35));
      fan.visible=spray>.012;fan.scale.set(.65+spray*.9,.20+spray*.49,1);
      fan.position.z=2.20+spray*.71+ripple*.06;fan.position.y=.18+spray*.06;
      fan.material.opacity=spray*(.115+Math.min(1,Math.abs(slip))*.085+ripple*.016);
    }
  }
  return {object,update,dispose(){for(const m of ownedMaterials)m.dispose();for(const g of ownedGeometry)g.dispose();}};
}
export {createRaceCar};
