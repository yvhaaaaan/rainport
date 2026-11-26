import * as THREE from 'three';
import {L,CUT,curve,botD,botX} from './physics.mjs';
import {createRaceCar} from './car-model.mjs';

const HALF=6.8, LAMP=32, SLAB=192;
const clamp=THREE.MathUtils.clamp;
function randomSequence(seed){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
}
// Integrated horizontal alignment shared by the road, barriers, vehicles and camera.
const pathX=new Float32Array(L+240), pathZ=new Float32Array(L+240), headings=new Float32Array(L+240);
for(let i=1;i<pathX.length;i++){
  const heading=headings[i-1]+curve(i-.5)*.0039;
  headings[i]=heading;
  pathX[i]=pathX[i-1]+Math.sin(heading);
  pathZ[i]=pathZ[i-1]-Math.cos(heading);
}
function station(d,out={}){
  if(d<0){out.x=0;out.z=-d;out.y=0;out.a=0;return out;}
  const i=Math.min(Math.floor(d),headings.length-2),f=d-i;
  out.x=pathX[i]+(pathX[i+1]-pathX[i])*f;out.z=pathZ[i]+(pathZ[i+1]-pathZ[i])*f;
  out.y=.55*Math.sin(d/175)+.32*Math.sin(d/74);out.a=headings[i]+(headings[i+1]-headings[i])*f;return out;
}
const roadSample={};
function point(d,lateral,height=0,target=new THREE.Vector3()){
  const p=station(d,roadSample);
  return target.set(p.x+lateral*Math.cos(p.a),p.y+height,p.z+lateral*Math.sin(p.a));
}
function picture(width,height,draw){
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;draw(canvas.getContext('2d'),width,height);
  const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;return tex;
}
function sky(scene){
  const material=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,fog:false,
    vertexShader:'varying vec3 dir; void main(){dir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`
      varying vec3 dir;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 f=fract(p);f=f*f*(3.-2.*f);p=floor(p);return mix(mix(hash(p),hash(p+vec2(1,0)),f.x),mix(hash(p+vec2(0,1)),hash(p+vec2(1)),f.x),f.y);}
      void main(){
        vec3 n=normalize(dir);float h=max(n.y,0.);
        vec3 c=mix(vec3(.032,.057,.081),vec3(.003,.008,.019),smoothstep(0.,.48,h));
        vec2 u=n.xz/(.18+h)*2.45;float clouds=noise(u)*.56+noise(u*2.3)*.28+noise(u*5.)*.16;
        c+=vec3(.012,.017,.025)*(clouds-.46)*2.2;
        c+=vec3(.045,.023,.009)*exp(-h*11.)*smoothstep(-.8,.6,-n.x);
        float moon=max(dot(n,normalize(vec3(-.34,.32,-1.))),0.);
        c+=vec3(.10,.17,.24)*pow(moon,180.)+vec3(.65,.73,.80)*smoothstep(.99982,.99994,moon);
        gl_FragColor=vec4(c,1.);
        #include <colorspace_fragment>
      }`});
  const mesh=new THREE.Mesh(new THREE.SphereGeometry(840,32,16),material);
  // Draw the background after opaque geometry; buildings and asphalt mask its procedural clouds.
  mesh.renderOrder=10;scene.add(mesh);return mesh;
}
function makeRoad(scene,start,end,grain){
  const positions=[],uv=[],indices=[];
  for(let d=start;d<=end;d+=2){
    for(const lateral of [-HALF,HALF]){
      const p=point(d,lateral);positions.push(p.x,p.y,p.z);uv.push(lateral,d);
    }
    if(d>start){const i=positions.length/3-4;indices.push(i,i+1,i+2,i+1,i+3,i+2)}
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);
  const material=new THREE.ShaderMaterial({uniforms:{grain:{value:grain},viewer:{value:0},lane:{value:0},heading:{value:0}},
    vertexShader:`varying vec2 st;varying float depth;void main(){st=uv;vec4 mv=modelViewMatrix*vec4(position,1.);depth=-mv.z;gl_Position=projectionMatrix*mv;}`,
    fragmentShader:`
      varying vec2 st;varying float depth;uniform sampler2D grain;uniform float viewer,lane,heading;
      float ring(float v,float center,float radius){return 1.-smoothstep(radius,radius+max(fwidth(v),.015),abs(v-center));}
      void main(){
        float x=st.x,d=st.y,forward=d-viewer;
        float grit=texture2D(grain,st*vec2(.37,.21)).r;
        float water=texture2D(grain,st*vec2(.09,.022)).g;
        float vein=texture2D(grain,st*vec2(.29,.075)).b;
        vec3 base=mix(vec3(.011,.019,.026),vec3(.032,.047,.062),water*.78+grit*.22);
        base*=.86+.25*grit;
        float track=exp(-pow((abs(x)-1.14)/.45,2.))+exp(-pow((abs(x)-3.65)/.6,2.));
        base*=1.-track*.28;
        float lamp=mod(d+16.,32.)-16.;
        float warm=exp(-pow(abs(x+5.0+(vein-.5)*1.3)/1.75,2.))*exp(-pow(abs(lamp+4.)/9.1,2.));
        float cool=exp(-pow(abs(x-5.1-(vein-.5)*1.2)/1.75,2.))*exp(-pow(abs(lamp+4.)/8.8,2.));
        float fresnel=.35+.65*smoothstep(1.,55.,depth);
        float ripple=texture2D(grain,st*vec2(.18,.69)).g;
        float glints=.1+2.5*pow(water,1.7)*smoothstep(.24,.86,ripple);
        base+=(warm*vec3(.77,.262,.052)+cool*vec3(.115,.344,.61))*glints*fresnel;
        float shoulder=ring(abs(x),6.47,.072);
        float dash=1.-smoothstep(3.5,3.68,abs(mod(d,16.)-8.));
        float paint=max(shoulder,ring(x,0.,.061)*dash*.62);
        base=mix(base,vec3(.42,.47,.45),paint*(.44+.44*grit));
        float curb=smoothstep(6.61,6.68,abs(x));
        base=mix(base,mix(vec3(.44,.156,.039),vec3(.34,.38,.375),step(1.,mod(d/2.5,2.))),curb*.85);
        float beamx=x-lane-heading*min(max(forward,0.),32.)*.45;
        float reach=smoothstep(1.2,6.,forward)*(1.-smoothstep(25.,68.,forward));
        float spread=1.3+max(0.,forward)*.075;
        float beam=(exp(-pow((beamx-.82)/spread,2.))+exp(-pow((beamx+.82)/spread,2.)))*.5*reach;
        base+=vec3(.073,.087,.104)*beam*(.66+.6*grit);
        float gridD=mod(d+1.,8.);float grid=ring(abs(x),2.05,.62)*(1.-smoothstep(.06,.16,abs(gridD-1.)));
        if(d>=-37.&&d<0.)base=mix(base,vec3(.62,.63,.54),grid);
        if(abs(d-3780.)<.81)base=mix(base,vec3(.68),.78*mod(floor(x*1.6)+floor(d*1.6),2.));
        float mist=1.-exp(-pow(max(depth,0.)*.0029,1.75));
        gl_FragColor=vec4(mix(base,vec3(.032,.057,.081),mist),1.);
        #include <colorspace_fragment>
      }`});
  const road=new THREE.Mesh(g,material);scene.add(road);return material;
}
function roadNoise(){
  const rand=randomSequence(74618);
  const n=128,grid=Array.from({length:n*n},()=>rand());
  function noise(x,y,period){
    x=x/period;y=y/period;const ix=Math.floor(x),iy=Math.floor(y);
    let a=x-ix,b=y-iy;a=a*a*(3-2*a);b=b*b*(3-2*b);
    const span=n/period,get=(dx,dy)=>grid[((iy+dy)%span)*n+(ix+dx)%span];
    return (get(0,0)*(1-a)+get(1,0)*a)*(1-b)+(get(0,1)*(1-a)+get(1,1)*a)*b;
  }
  const data=new Uint8Array(n*n*4);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const k=4*(y*n+x);data[k]=rand()*255;data[k+1]=(noise(x,y,16)*.62+noise(x,y,4)*.38)*255;
    data[k+2]=noise(x,y,8)*255;data[k+3]=255;
  }
  const tex=new THREE.DataTexture(data,n,n);tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  tex.generateMipmaps=true;tex.minFilter=THREE.LinearMipmapLinearFilter;tex.magFilter=THREE.LinearFilter;tex.needsUpdate=true;return tex;
}

function makeScenery(scene){
  const boxGeo=new THREE.BoxGeometry(1,1,1),rand=randomSequence(203);
  const structure=new THREE.MeshLambertMaterial({color:0xe2e6e6});
  const lit=new THREE.MeshBasicMaterial();
  const rib=picture(256,64,(ctx,w,h)=>{
    ctx.fillStyle='#b8bdc0';ctx.fillRect(0,0,w,h);
    for(let i=0;i<w;i+=6){ctx.fillStyle='#798588';ctx.fillRect(i,2,2,h-5);ctx.fillStyle='#d1d8d7';ctx.fillRect(i+2,3,1,h-6)}
    ctx.fillStyle='#6e7577';ctx.fillRect(0,2,w,3);ctx.fillRect(0,h-4,w,2);
    ctx.font='bold 12px monospace';ctx.fillStyle='#f4f0de';ctx.fillText('RAINPORT',12,19);
    ctx.fillStyle='#dedcc5';ctx.fillRect(w-14,5,7,7);
  });
  const container=new THREE.MeshLambertMaterial({map:rib,color:0xe9e9e9});
  const windows=picture(128,128,(ctx,w,h)=>{
    ctx.fillStyle='#1c2b39';ctx.fillRect(0,0,w,h);
    for(let y=3;y<h;y+=8)for(let x=2;x<w;x+=7){
      const n=rand();ctx.fillStyle=n<.4?'#233441':n<.68?'#405361':n<.87?'#697983':'#c1ac81';ctx.fillRect(x,y,4,3);
    }
  });
  const facade=new THREE.MeshBasicMaterial({map:windows});
  const paving=picture(256,256,(ctx,w,h)=>{
    ctx.fillStyle='#7a7d7c';ctx.fillRect(0,0,w,h);
    for(let i=0;i<3000;i++){ctx.fillStyle=rand()<.5?'#727774':'#818483';ctx.fillRect(rand()*w,rand()*h,rand()*4+1,1)}
    ctx.fillStyle='#606462';ctx.fillRect(0,0,w,2);ctx.fillRect(0,0,2,h);
  });
  paving.wrapS=paving.wrapT=THREE.RepeatWrapping;
  const apron=new THREE.MeshLambertMaterial({map:paving,color:0x606467});
  const pavement=[],tiles=[],tileIndices=[];
  for(let d=-100;d<=L+140;d+=4){
    for(const x of [-170,33]){
      const p=point(d,x,-.075);pavement.push(p.x,p.y,p.z);tiles.push(x/7,d/7);
    }
    if(d> -100){const i=pavement.length/3-4;tileIndices.push(i,i+1,i+2,i+1,i+3,i+2)}
  }
  const pavementGeo=new THREE.BufferGeometry();
  pavementGeo.setAttribute('position',new THREE.Float32BufferAttribute(pavement,3));pavementGeo.setAttribute('uv',new THREE.Float32BufferAttribute(tiles,2));
  pavementGeo.setIndex(tileIndices);pavementGeo.computeVertexNormals();scene.add(new THREE.Mesh(pavementGeo,apron));
  const signs=new Map();
  function signMaterial(label,sub){
    const key=label+sub;if(signs.has(key))return signs.get(key);
    const tex=picture(512,96,(ctx,w,h)=>{
      ctx.fillStyle='#142126';ctx.fillRect(0,0,w,h);
      ctx.fillStyle='#df803a';ctx.fillRect(0,0,w,7);ctx.fillRect(12,20,9,53);
      ctx.font='bold 44px "Microsoft YaHei", sans-serif';ctx.fillStyle='#eeeadd';ctx.fillText(label,33,66);
      ctx.textAlign='right';ctx.font='bold 22px monospace';ctx.fillStyle='#a9c1bc';ctx.fillText(sub,w-15,62);
    });
    const mat=new THREE.MeshBasicMaterial({map:tex});signs.set(key,mat);return mat;
  }
  const groupList=[],bulbs=[];
  const cube=new THREE.Object3D(),col=new THREE.Color(),up=new THREE.Vector3(0,1,0);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(10000,10000),new THREE.MeshLambertMaterial({color:0x253136}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-2.8;scene.add(ground);
  const containerPaint=[0x864f3e,0x475f69,0x827247,0x50695b,0x794940,0x455963];
  for(let start=-SLAB;start<L+SLAB;start+=SLAB){
    const group=new THREE.Group(),batches=new Map();scene.add(group);groupList.push({start,group});
    function add(mat,color){
      let list=batches.get(mat);if(!list){list=[];batches.set(mat,list)}
      cube.updateMatrix();list.push([cube.matrix.clone(),color]);
    }
    function block(d,x,y,sx,sy,sz,color,mat=structure,turn=0){
      cube.position.copy(point(d,x,y));cube.rotation.set(0,-station(d).a+turn,0);cube.scale.set(sx,sy,sz);add(mat,color);
    }
    function beam(a,b,width,color,mat=structure,depth=width){
      const delta=b.clone().sub(a);cube.position.copy(a).add(b).multiplyScalar(.5);
      cube.quaternion.setFromUnitVectors(up,delta.clone().normalize());cube.scale.set(width,delta.length(),depth);add(mat,color);
    }
    function tie(d1,x1,y1,d2,x2,y2,width,color){
      beam(point(d1,x1,y1),point(d2,x2,y2),width,color);
    }
    function banner(d,label,sub){
      for(const side of [-1,1]){
        tie(d,side*8.3,.1,d,side*8.3,6.65,.27,0x607174);
        tie(d+2,side*8.3,.1,d+2,side*8.3,6.65,.27,0x607174);
        for(let h=0;h<6;h+=1.45)tie(d,side*8.3,h,d+2,side*8.3,h+1.45,.11,0x718180);
      }
      for(const h of [5.8,7.05])for(const q of [d,d+2])tie(q,-8.4,h,q,8.4,h,.18,0x657376);
      for(let x=-8.4;x<7;x+=1.65)tie(d+2,x,5.8,d+2,x+1.65,7.05,.12,0x83918d);
      block(d,0,6.45,13.0,1.68,.27,0xffffff,signMaterial(label,sub));
    }
    // The reflection in the road shader is aligned with these real lamp positions.
    for(let d=start;d<start+SLAB;d+=LAMP){
      for(const side of [-1,1]){
        const x=side*8.35,h=side<0?7.7:6.55,head=side*6.35;
        block(d,x,.58,.47,1.5,.52,0x606967);
        tie(d,x,.65,d,x,h,.13,0x657479);tie(d,x,h,d,head,h+.34,.115,0x7a8788);
        block(d,head,h+.27,.93,.16,.47,0x394850);
        block(d,head,h+.16,.85,.055,.42,side<0?0xffdaa0:0xc0e4f4,lit);
        bulbs.push({p:point(d,head,h+.13),d,side});
      }
    }
    for(let d=start;d<start+SLAB;d+=8){
      for(const side of [-1,1]){
        const x=side*7.98;
        beam(point(d,side*7.50,-.01),point(d+8,side*7.50,-.01),1.31,0x414a4c,structure,.125);
        beam(point(d,x,.43),point(d+8,x,.43),.25,0x75858b,structure,.18);
        beam(point(d,x,.72),point(d+8,x,.72),.19,0x98a5aa,structure,.15);
        block(d,x,.35,.20,1.05,.19,0x47545d);
        block(d,x,.068,.49,.16,.51,0x41494c);
        if(d%16===0)block(d,x-side*.10,.74,.13,.13,.065,side<0?0xf08e45:0xd7e1c9,lit);
        if(d%32===0){
          block(d,side*7.05,.085,.30,.032,1.08,0x242d31);
          for(let n=-3;n<=3;n++)block(d+n*.14,side*7.05,.105,.29,.035,.042,0x637070);
        }
      }
    }
    for(let d=start+8;d<start+SLAB;d+=32){
      const coastline=d>CUT;
      for(const side of coastline?[-1]:[-1,1]){
        const yard=side*(13.7+rand()*9);
        for(const offset of [0,13.1]){
          const rows=rand()<.4?1:rand()<.8?2:3;
          for(let h=0;h<rows;h++)block(d+offset,yard,h*2.50+1.19,2.48,2.5,12.05,containerPaint[Math.floor(rand()*containerPaint.length)],container);
          block(d+offset,yard,-.018,3.15,.045,12.5,0x172328);
        }
        if(d%96===8){
          const dock=side*(40+rand()*7),wall=0x657077;
          block(d+12,dock,3.9,14,7.9,41,wall);
          block(d+12,dock,7.95,15,.39,42,0x435359);
          for(let j=0;j<5;j++){
            block(d-2+j*7,dock-side*7.04,2.25,.16,4.4,4.9,0x3d4b4f);
            block(d-2+j*7,dock-side*7.20,5.20,.38,.13,1.7,j%2?0xffc582:0xffd59c,lit);
          }
        }
        if(rand()<.53){
          const yy=11+rand()*26,farX=side*(77+rand()*55);
          block(d,farX,yy*.5,13+rand()*13,yy,14+rand()*23,0xb7c5c9,facade);
        }
      }
      if(coastline){
        block(d,25,-.36,33,.50,33,0x293c42);
        block(d,125,-.80,166,.36,34,0x536e77);
        for(let n=0;n<4;n++)block(d+rand()*28,50+rand()*115,-.59,.1+rand()*.5,.02,.5+rand()*7,0x719298);
      }
    }
    if(start>CUT&&Math.round(start/SLAB)%3===0){
      const mid=start+82,berth=48;
      block(mid,berth,.67,9.3,2.4,46,0x3d3836);
      block(mid,berth,1.89,9.7,1.14,46,0x394e58);
      for(let n=0;n<4;n++){
        block(mid+25+n*3.2,berth,1.06,9.4-n*2.0,2.8,3.24,0x3f5157);
      }
      block(mid-13,berth,4.02,7.6,3.3,8.1,0x8c9998);
      block(mid-13,berth,5.56,8.4,.92,9.2,0x7a9094);
      for(let n=0;n<6;n++)block(mid-16+n*1.25,berth-4.23,5.59,.09,.42,.82,0xe0caa1,lit);
      block(mid-12,berth,7.58,1.76,3.0,2.12,0x865b41);
      tie(mid-7,berth,5.9,mid-7,berth,12.4,.18,0x879291);
      for(let i=0;i<3;i++)for(let j=0;j<2;j++)block(mid+i*9.4,berth+(j-.5)*3.4,3.63,2.53,2.49,8.82,containerPaint[(i+j)%containerPaint.length],container);
    }
    // Ship-to-shore cranes have four legs, portal girders, a lattice jib and hanging spreader.
    const d=start+96,side=(start>=CUT||Math.floor(start/SLAB)%2===0)?-1:1;
    const cx=side*(36+rand()*7),cranePaint=0xaa704c,craneDark=0x694d40;
    for(const dz of [-5.5,5.5])for(const dx of [-5.1,5.1]){
      const x=cx+dx;
      tie(d+dz,x,0,d+dz*.65,cx+dx*.62,18,.74,cranePaint);
      block(d+dz,x,.40,1.9,.75,3.2,0x526066);
    }
    for(const dz of [-3.6,3.6])tie(d+dz,cx-3.3,17.8,d+dz,cx+3.3,17.8,.86,cranePaint);
    for(const x of [cx-3.3,cx+3.3]){
      tie(d-3.7,x,18,d+3.7,x,18,.9,cranePaint);
      tie(d,x,18,d,x,28,.68,cranePaint);
    }
    const jibStart=cx+side*11,jibEnd=cx-side*29;
    for(const zz of [-1.3,1.3]){
      for(const y of [23.5,25.2])tie(d+zz,jibStart,y,d+zz,jibEnd,y,.35,cranePaint);
      for(let i=0;i<10;i++){
        const a=jibStart+(jibEnd-jibStart)*i/10,b=jibStart+(jibEnd-jibStart)*(i+1)/10;
        tie(d+zz,a,23.5,d+zz,b,25.2,.16,craneDark);
      }
      tie(d+zz,cx,29.3,d+zz,jibEnd,25.2,.11,craneDark);
      tie(d+zz,cx,29.3,d+zz,jibStart,25.2,.11,craneDark);
    }
    block(d,cx-side*8,22.7,3.4,2.2,3.8,0x8f9e9e);
    block(d-.05,cx-side*8,22.9,3.5,.75,3.9,0x354e5a);
    for(const q of [-.65,.65])tie(d+q,jibEnd+side,23.2,d+q,jibEnd+side,13,.065,0x49545a);
    block(d,jibEnd+side,12.7,2.9,.37,2.1,0xba852e);
    block(d,cx,29.45,.28,.25,.28,0xf56639,lit);
    if(start===0)banner(29,'雨 港','RAINPORT / GRID');
    if(start<=CUT&&start+SLAB>CUT)banner(CUT,'沿岸直道','COAST / S2');
    if(start<=L&&start+SLAB>L)banner(L,'终 点','RAINPORT / FINISH');
    if(start>0&&start<CUT&&start%384===0){
      const turn=curve(start+85)>0?'› › ›':'‹ ‹ ‹';
      block(start+58,curve(start+85)>0?-8.6:8.6,2.4,2.5,.72,.14,0xffffff,signMaterial(turn,''));
    }
    for(const [mat,list] of batches){
      const inst=new THREE.InstancedMesh(boxGeo,mat,list.length);
      list.forEach(([matrix,color],i)=>{inst.setMatrixAt(i,matrix);inst.setColorAt(i,col.set(color))});
      inst.computeBoundingSphere();group.add(inst);
    }
  }
  const glowTex=picture(64,64,(ctx,w,h)=>{
    const g=ctx.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0,'rgba(255,255,255,.95)');g.addColorStop(.078,'rgba(255,255,255,.52)');g.addColorStop(.24,'rgba(255,255,255,.13)');g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
  });
  // Project the same 20 lamp halos in a single instanced billboard batch.
  const haloGeo=new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1,1));
  const centers=new THREE.InstancedBufferAttribute(new Float32Array(20*3),3).setUsage(THREE.DynamicDrawUsage);
  haloGeo.setAttribute('center',centers);haloGeo.instanceCount=20;
  const haloMat=new THREE.ShaderMaterial({
    uniforms:{halo:{value:glowTex},warm:{value:new THREE.Color(0xffb875)},cool:{value:new THREE.Color(0x9fdfff)}},
    transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,
    vertexShader:`attribute vec3 center;varying vec2 coord;varying float side;
      void main(){coord=uv;side=float(gl_InstanceID%2);vec4 mv=viewMatrix*vec4(center,1.);
      mv.xy+=position.xy*vec2(4.2,2.9);gl_Position=projectionMatrix*mv;}`,
    fragmentShader:`varying vec2 coord;varying float side;uniform sampler2D halo;uniform vec3 warm,cool;
      void main(){gl_FragColor=vec4(mix(warm,cool,side),texture2D(halo,coord).a*.6);
      #include <colorspace_fragment>
      }`
  });
  const halos=new THREE.Mesh(haloGeo,haloMat);
  halos.frustumCulled=false;scene.add(halos);
  let lastFirst=-1;
  return function update(distance){
    for(const {start,group} of groupList)group.visible=start+SLAB>distance-80&&start<distance+540;
    const first=Math.max(0,2*Math.ceil((distance-12+SLAB)/LAMP));
    if(first===lastFirst)return;
    lastFirst=first;
    haloGeo.instanceCount=Math.min(20,Math.max(0,bulbs.length-first));
    for(let i=0;i<haloGeo.instanceCount;i++){const p=bulbs[first+i].p;centers.setXYZ(i,p.x,p.y,p.z);}
    centers.needsUpdate=true;
  }
}

function rain(scene){
  const rand=randomSequence(917),count=195,slots=Array.from({length:count},()=>[rand()*38,rand()*16,rand()*49,.7+rand()*.8]);
  const vertex=new Float32Array(count*6),geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(vertex,3).setUsage(THREE.DynamicDrawUsage));
  const drops=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:0xa3bfd0,transparent:true,opacity:.18,depthWrite:false}));
  drops.frustumCulled=false;scene.add(drops);
  const wrap=(n,mod)=>n-Math.floor(n/mod)*mod;
  return (camera,r)=>{
    const origin=camera.position;
    for(let i=0;i<count;i++){
      const [x,y,z,s]=slots[i],j=i*6;
      vertex[j]=origin.x+wrap(x-origin.x+r.t*2.5,38)-19;
      vertex[j+1]=origin.y+wrap(y-origin.y-r.t*14*s,16)-5;
      vertex[j+2]=origin.z+wrap(z-origin.z,49)-35;
      vertex[j+3]=vertex[j]+.05;vertex[j+4]=vertex[j+1]-.34*s;vertex[j+5]=vertex[j+2]+.025+r.v*.004;
    }
    geo.attributes.position.needsUpdate=true;
  };
}
// Measure GPU work asynchronously. Delayed HTTP input, a busy main thread or a
// background tab must never lower the resolution of a device that can render in time.
function gpuBudget(renderer){
  const gl=renderer.getContext(),timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let sample=null,open=false,next=0,hot=0,cool=0,scale=1;
  function begin(now){
    if(!timer||now<next||document.hidden)return scale;
    next=now+.5;
    if(sample){
      if(!gl.getQueryParameter(sample,gl.QUERY_RESULT_AVAILABLE))return scale;
      if(!gl.getParameter(timer.GPU_DISJOINT_EXT)){
        const ms=gl.getQueryParameter(sample,gl.QUERY_RESULT)*1e-6;
        hot=ms>16?hot+1:0;cool=ms<8?cool+1:0;
        if(hot>=4){scale=Math.max(.60,scale-.10);hot=0;}
        else if(cool>=14){scale=Math.min(1,scale+.05);cool=0;}
      }
      gl.deleteQuery(sample);sample=null;
    }
    // An external graphics profiler may already be measuring this frame.
    if(!gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){
      sample=gl.createQuery();
      if(sample){gl.beginQuery(timer.TIME_ELAPSED_EXT,sample);open=true;}
    }
    return scale;
  }
  function end(){if(open){gl.endQuery(timer.TIME_ELAPSED_EXT);open=false;}}
  function dispose(){end();if(sample)gl.deleteQuery(sample);}
  return {begin,end,dispose};
}
const opponentColors=[0xf1ac3f,0x8cbdc9,0xc84137,0x8eae6d,0xe6e2d2,0x9367ae,0x49a29a];
export function createTrackScene(canvas,first){
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.setClearColor(0x596f7c);renderer.outputColorSpace=THREE.SRGBColorSpace;
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x314456,.0034);
  // The car paint supplies its own environment. Diffuse harbour geometry needs no prefiltered cubemap.
  const dome=sky(scene),camera=new THREE.PerspectiveCamera(54,2,.12,900);
  const hemi=new THREE.HemisphereLight(0xc4e7ff,0x5d5550,.78);scene.add(hemi);
  const key=new THREE.DirectionalLight(0xffd7ae,1.34);key.position.set(-64,67,-32);scene.add(key);
  const rim=new THREE.DirectionalLight(0x96d8ff,1.1);rim.position.set(36,25,40);scene.add(rim);
  const sodium=new THREE.PointLight(0xffaa5b,98,33,2),dockLight=new THREE.PointLight(0x8fd7ff,84,30,2);scene.add(sodium,dockLight);
  const budget=gpuBudget(renderer);
  const grain=roadNoise(),road=makeRoad(scene,-100,L+140,grain);
  const yard=makeScenery(scene),weather=rain(scene);
  const player=createRaceCar(THREE,{color:first.config?.[0]?0x1da499:0xed733d,player:true});
  const rivals=opponentColors.map(color=>createRaceCar(THREE,{color}));
  const ghostCar=createRaceCar(THREE,{color:0x6be7df,ghost:true});
  for(const car of [player,...rivals,ghostCar])scene.add(car.object);
  let previous=-10,lastRace=null,previousWall=0,lastAspect=0,lastWidth=0,lastHeight=0,roll=0;
  const aim=new THREE.Vector3(),desired=new THREE.Vector3(),desiredAim=new THREE.Vector3(),coursePose={};
  function place(car,d,x,yaw,motion){
    point(d,x*HALF,.024,car.object.position);
    car.object.rotation.set(0,-roadSample.a-yaw,0);
    car.update(motion);
  }
  function render(r,ghost){
    const wall=performance.now()*.001,dt=clamp(wall-previousWall,.001,.12);
    const jump=r.id!==lastRace||Math.abs(r.t-previous)>1.1||r.t<previous-.15;
    const width=canvas.clientWidth||900,height=canvas.clientHeight||450;
    // Bound the pixel budget on mobile and ultra-wide displays.
    const scale=budget.begin(wall);
    const density=Math.min(window.devicePixelRatio||1,1.35,Math.sqrt(1400000/(width*height)))*scale;
    const rw=Math.max(2,Math.round(width*density)),rh=Math.max(2,Math.round(height*density));
    if(rw!==lastWidth||rh!==lastHeight){renderer.setSize(rw,rh,false);lastWidth=rw;lastHeight=rh;canvas.dataset.renderScale=String(Math.round(scale*100));}
    const steer=r.steer??r.keys?.[2]??0,gripLoss=r.slip||0,rumble=r.rumble||0;
    const yaw=r.yaw??steer*.03, gas=r.keys?.[0]||0,brake=r.keys?.[1]||0;
    place(player,r.d,r.x,yaw,{speed:r.v,steer,brake,throttle:gas,spec:r.spec,dt,time:r.t,slip:gripLoss});
    rivals.forEach((car,i)=>{
      if(r.opponents){
        const peer=r.opponents[i];
        car.object.visible=!!peer&&peer.d>r.d-12&&peer.d<r.d+340;
        if(car.object.visible)place(car,peer.d,peer.x,peer.yaw||0,{speed:peer.v,steer:peer.steer||0,brake:peer.keys?.[1]||0,dt,time:r.t});
        return;
      }
      const entry=r.bots[i];if(!entry){car.object.visible=false;return}
      const time=Math.max(0,r.t-(r.rivalDelay?.[i]||0)),d=botD(time,entry);
      car.object.visible=d>r.d-12&&d<r.d+340;
      if(!car.object.visible)return;
      const x=botX(time,entry,i),next=botD(time+.12,entry),velocity=(next-d)/.12;
      const side=(botX(time+.12,entry,i)-x)*HALF/.12;
      const decel=((next-d)-(d-botD(Math.max(0,time-.12),entry)))/.0144;
      const heading=clamp(Math.atan2(side,Math.max(7,velocity)),-.26,.26);
      place(car,d,x,heading,{speed:velocity,steer:heading*2.8,brake:Number(decel<-.9),dt,time});
    });
    ghostCar.object.visible=!!ghost&&Math.abs(ghost.d-r.d)<240;
    if(ghostCar.object.visible)place(ghostCar,ghost.d,ghost.x,ghost.yaw||0,{speed:ghost.v||0,steer:ghost.steer||0,dt,time:r.t});
    const speed=clamp(r.v/52,0,1),lead=8+speed*6,back=6.65+speed*.75;
    const carAt=player.object.position,course=station(r.d,coursePose);
    const followAngle=course.a+yaw*.53,sideLag=(r.lateralV||0)*.20;
    const shake=rumble*.042+(r.impact||0)*.065;
    desired.set(carAt.x-Math.sin(followAngle)*back-Math.cos(course.a)*sideLag,
      carAt.y+2.10+speed*.25+Math.sin(r.t*55)*shake,
      carAt.z+Math.cos(followAngle)*back-Math.sin(course.a)*sideLag);
    point(r.d+lead,r.x*HALF*.79,.37+speed*.14,desiredAim);
    camera.position.lerp(desired,jump?1:1-Math.exp(-dt*16));aim.lerp(desiredAim,jump?1:1-Math.exp(-dt*13));
    const targetRoll=clamp(-(r.lateralV||0)*.009-curve(r.d)*speed*.019,-.038,.038);
    roll=jump?targetRoll:THREE.MathUtils.lerp(roll,targetRoll,1-Math.exp(-dt*7));
    camera.up.set(Math.cos(course.a)*roll,1,Math.sin(course.a)*roll).normalize();camera.lookAt(aim);
    const aspect=width/height,targetFov=clamp(50+speed*8+Math.max(0,1.25-aspect)*15,50,69);
    if(Math.abs(targetFov-camera.fov)>.05||aspect!==lastAspect){camera.aspect=aspect;camera.fov=targetFov;camera.updateProjectionMatrix();lastAspect=aspect}
    dome.position.copy(camera.position);
    road.uniforms.viewer.value=r.d;road.uniforms.lane.value=r.x*HALF;road.uniforms.heading.value=yaw;
    const closestLamp=Math.round(r.d/LAMP)*LAMP;
    point(closestLamp,-6.35,8,sodium.position);point(closestLamp,6.35,6.75,dockLight.position);
    yard(r.d);weather(camera,r);
    renderer.render(scene,camera);budget.end();if(canvas.dataset.renderer!=='webgl2')canvas.dataset.renderer='webgl2';
    lastRace=r.id;previous=r.t;previousWall=wall;
  }
  function dispose(){
    budget.dispose();
    const geos=new Set(),mats=new Set(),textures=new Set([grain]);
    scene.traverse(o=>{
      if(o.geometry)geos.add(o.geometry);
      const list=Array.isArray(o.material)?o.material:[o.material];
      for(const mat of list)if(mat){mats.add(mat);for(const v of Object.values(mat))if(v?.isTexture)textures.add(v)}
      if(o.isInstancedMesh)o.dispose();
    });
    for(const mat of mats){
      for(const uniform of Object.values(mat.uniforms||{}))if(uniform.value?.isTexture)textures.add(uniform.value);
    }
    for(const geo of geos)geo.dispose();for(const mat of mats)mat.dispose();for(const tex of textures)tex.dispose();
    renderer.dispose();renderer.forceContextLoss();
  }
  async function prepare(grid){
    // Compile while the grid is being presented; do not start official timing
    // until the driver has completed uploads, shader compilation and the first draw.
    await renderer.compileAsync(scene,camera);
    render(grid,null);
    const gl=renderer.getContext(),fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
    if(!fence)return;
    gl.flush();
    try{
      while(!gl.isContextLost()&&gl.clientWaitSync(fence,0,0)===gl.TIMEOUT_EXPIRED){
        await new Promise(resolve=>setTimeout(resolve,12));
      }
    }finally{gl.deleteSync(fence);}
  }
  return {render,prepare,dispose};
}

