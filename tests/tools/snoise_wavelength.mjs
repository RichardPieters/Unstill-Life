// Direct JS port of src/shared/shaders/noise.glsl snoise() — used to MEASURE
// the noise's dominant wavelength instead of assuming 2*pi/k.
// Ported from webgl-noise (https://github.com/ashima/webgl-noise), MIT License,
// Copyright (C) 2011 Ashima Arts, (C) 2011-2016 Stefan Gustavson; full text in
// LICENSES/webgl-noise-MIT.txt.
const f=Math.floor, ab=Math.abs;
const mod289=x=>x-f(x/289)*289;
const perm=x=>mod289((x*34+1)*x);
const tinv=r=>1.79284291400159-0.85373472095314*r;
const step=(e,x)=>x>=e?1:0;
function snoise(vx,vy,vz){
  const Cx=1/6, Cy=1/3;
  const s=(vx+vy+vz)*Cy;
  let ix=f(vx+s), iy=f(vy+s), iz=f(vz+s);
  const t=(ix+iy+iz)*Cx;
  const x0x=vx-ix+t, x0y=vy-iy+t, x0z=vz-iz+t;
  const gx=step(x0y,x0x), gy=step(x0z,x0y), gz=step(x0x,x0z);
  const lx=1-gx, ly=1-gy, lz=1-gz;
  const i1x=Math.min(gx,lz), i1y=Math.min(gy,lx), i1z=Math.min(gz,ly);
  const i2x=Math.max(gx,lz), i2y=Math.max(gy,lx), i2z=Math.max(gz,ly);
  const x1=[x0x-i1x+Cx,x0y-i1y+Cx,x0z-i1z+Cx];
  const x2=[x0x-i2x+Cy,x0y-i2y+Cy,x0z-i2z+Cy];
  const x3=[x0x-0.5,x0y-0.5,x0z-0.5];
  ix=mod289(ix); iy=mod289(iy); iz=mod289(iz);
  const pz=[iz+0,iz+i1z,iz+i2z,iz+1].map(perm);
  const py=pz.map((v,k)=>perm(v+iy+[0,i1y,i2y,1][k]));
  const p =py.map((v,k)=>perm(v+ix+[0,i1x,i2x,1][k]));
  const n_=0.142857142857, nsx=n_*2.0, nsy=n_*0.5-1.0, nsz=n_*1.0;   // ns = n_*D.wyz - D.xzx, D=(0,.5,1,2) => (2n_, .5n_-1, n_)
  const j=p.map(v=>v-49*f(v*nsz*nsz));
  const x_=j.map(v=>f(v*nsz)), y_=j.map((v,k)=>f(v-7*x_[k]));
  const X=x_.map(v=>v*nsx+nsy), Y=y_.map(v=>v*nsx+nsy);
  const h=X.map((v,k)=>1-ab(v)-ab(Y[k]));
  const b0=[X[0],X[1],Y[0],Y[1]], b1=[X[2],X[3],Y[2],Y[3]];
  const s0=b0.map(v=>f(v)*2+1), s1=b1.map(v=>f(v)*2+1);
  const sh=h.map(v=>-step(0,-v)===0?(v<=0?-1:0):(v<=0?-1:0));   // sh = -step(h,0) => -1 if h<=0 else 0
  const a0=[b0[0]+s0[0]*sh[0], b0[2]+s0[2]*sh[0], b0[1]+s0[1]*sh[1], b0[3]+s0[3]*sh[1]];
  const a1=[b1[0]+s1[0]*sh[2], b1[2]+s1[2]*sh[2], b1[1]+s1[1]*sh[3], b1[3]+s1[3]*sh[3]];
  let P=[[a0[0],a0[1],h[0]],[a0[2],a0[3],h[1]],[a1[0],a1[1],h[2]],[a1[2],a1[3],h[3]]];
  const nrm=P.map(q=>tinv(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]));
  P=P.map((q,k)=>q.map(c=>c*nrm[k]));
  const X0=[x0x,x0y,x0z], XS=[X0,x1,x2,x3];
  const m=XS.map(q=>Math.max(0.6-(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]),0));
  let acc=0;
  for(let k=0;k<4;k++){const mm=m[k]*m[k]*m[k]*m[k]; acc+=mm*(P[k][0]*XS[k][0]+P[k][1]*XS[k][1]+P[k][2]*XS[k][2]);}
  return 42*acc;
}
// Measure dominant wavelength: mean spacing between zero crossings * 2, averaged
// over many parallel lines at random offsets and directions.
let cross=0, span=0, sum2=0, n=0;
const STEP=0.002, LEN=400;
for(let line=0;line<40;line++){
  const oy=Math.random()*1000, oz=Math.random()*1000, ox=Math.random()*1000;
  let prev=snoise(ox,oy,oz), c=0;
  for(let i=1;i*STEP<LEN;i++){
    const v=snoise(ox+i*STEP,oy,oz);
    if((prev<0)!==(v<0)) c++;
    prev=v; sum2+=v*v; n++;
  }
  cross+=c; span+=LEN;
}
const lambda = 2*span/cross;
console.log('zero crossings:', cross, 'over', span, 'input units');
console.log('mean zero-crossing spacing =', (span/cross).toFixed(4), 'input units');
console.log('=> dominant wavelength lambda ≈', lambda.toFixed(4), 'INPUT units');
console.log('rms amplitude =', Math.sqrt(sum2/n).toFixed(4));
console.log('');
console.log('So snoise(p*k) has world-space wavelength lambda_world ≈', lambda.toFixed(3), '/ k');
const cell=32;
console.log('');
console.log('band          k        lambda_world   samples/period @', cell, 'u cell   verdict');
const bands=[['base oct0',0.006],['base oct1',0.012],['mid oct0',0.02],['mid oct1',0.04],['mid oct2',0.08],['mid oct3',0.16],['fine',0.08]];
for(const [name,k] of bands){
  const lw=lambda/k, sp=lw/cell;
  console.log(name.padEnd(12), String(k).padEnd(8), lw.toFixed(1).padStart(10), sp.toFixed(2).padStart(18), '   ', sp>=2?'SURVIVES':'ALIASES');
}
console.log('');
console.log('Max Nyquist-safe k at cell c:  k <= lambda/(2c)');
for(const c of [8,16,32,64]) console.log('  cell', String(c).padStart(3), 'u  ->  k_max =', (lambda/(2*c)).toFixed(5), ' (lambda_world_min =', (2*c).toFixed(0), 'u)');
