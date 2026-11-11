// ============================================================
// MENU SCENES (2026-11-11) — live backdrops for the start screen + main menu.
// Owner: random each visit, with the scene names along the bottom to switch.
//
//   Black Hole / Event Horizon / Earth — the owner's pictures, animated IN a
//     fragment shader: the accretion disk flows around the hole (two-phase
//     flow map on the picture's own pixels), lanes ride the flow, the photon
//     ring shimmers, stars twinkle, clouds churn; Earth's clouds drift, city
//     lights flicker, the atmosphere pulses.
//   Orbit — fully procedural (planet, clouds, moon, sun flare).
//   Gas Giant — the looping menu video (UI._menuVideoEl).
//
// ONE host element, created once and MOVED between the title's and the menu's
// .mm-bgvideo (so PRESS START continues the same shot). It draws only while it
// is on screen and the tab is visible; render resolution adapts to frame time.
// ============================================================
(function () {
'use strict';
const COMMON = `
precision highp float;
uniform vec2 R; uniform float T; uniform float F; // resolution, time, lightning flash
float h11(float p){ p=fract(p*.1031); p*=p+33.33; p*=p+p; return fract(p); }
float h21(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 h22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<6;i++){ s+=a*n2(p); p=m*p; a*=.5; } return s; }
float fbm3(vec2 p){ float s=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<3;i++){ s+=a*n2(p); p=m*p; a*=.5; } return s; }

vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
float stars(vec2 uv, float dens){
  float s=0.;
  for(int l=0;l<3;l++){
    float sc = dens*(1.+float(l)*1.7);
    vec2 g = uv*sc; vec2 id=floor(g); vec2 f=fract(g)-.5;
    vec2 o = h22(id)-.5; float r = h21(id+7.1);
    float d = length(f-o*.8);
    float tw = .6+.4*sin(T*(1.+r*3.)+r*40.);
    s += smoothstep(.06,0.,d) * step(.86,r) * tw * (1.-float(l)*.28);
  }
  return s;
}
vec3 finish(vec3 c, vec2 fc){
  vec2 q = fc/R; c *= .35+.65*pow(16.*q.x*q.y*(1.-q.x)*(1.-q.y), .22); // vignette
  c = aces(c);
  c = pow(c, vec3(1./2.2));
  c += (h21(fc+fract(T)*100.)-.5)*.025; // grain
  return c;
}
`;
const ORBIT = COMMON + `
vec3 planetTex(vec3 n, float t){
  // spin the sphere, lat/long
  float a = t*.012;
  vec3 r = vec3(n.x*cos(a)-n.z*sin(a), n.y, n.x*sin(a)+n.z*cos(a));
  vec2 ll = vec2(atan(r.z, r.x), asin(clamp(r.y,-1.,1.)));
  vec2 p = ll*vec2(2.2,2.6);
  float land = fbm(p*1.3+3.);
  float isLand = smoothstep(.52,.56,land);
  vec3 ocean = mix(vec3(.004,.02,.07), vec3(.01,.06,.16), fbm3(p*4.));
  vec3 ground = mix(vec3(.05,.07,.03), vec3(.16,.13,.08), fbm3(p*6.));
  ground = mix(ground, vec3(.7,.72,.75), smoothstep(.75,.95,abs(ll.y)/1.57)); // ice caps
  vec3 c = mix(ocean, ground, isLand);
  return vec3(c);
}
void main(){
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (fc-.5*R)/R.y;
  float t = T;
  // slow drifting camera
  uv = uv*(1.-.03*sin(t*.05)) + vec2(sin(t*.031)*.02, cos(t*.027)*.012);
  vec3 col = vec3(0);
  // deep space: nebula wisps + stars
  float neb = fbm(uv*1.4+vec2(t*.004,0.));
  col += vec3(.02,.03,.08)*neb + vec3(.05,.015,.06)*pow(fbm(uv*2.3-4.),3.)*1.5;
  col += vec3(.85,.9,1.)*stars(uv+vec2(t*.002,0.), 60.);
  vec3 L = normalize(vec3(.75,.42,.32));
  // sun just beyond the upper limb
  vec2 sunP = vec2(.38,.02);
  // ---- planet: huge sphere, limb sweeping across the lower frame
  vec2 pc = vec2(-.35,-1.45); float PR = 1.38;
  vec2 d = uv-pc; float r = length(d);
  float atm = 0.;
  if (r < PR){
    vec3 n = normalize(vec3(d/PR, sqrt(max(0.,1.-dot(d,d)/(PR*PR)))));
    float ndl = dot(n,L);
    vec3 albedo = planetTex(n,t);
    // clouds, drifting faster than the ground, cast soft shadow
    float a2 = t*.02; vec3 rc = vec3(n.x*cos(a2)-n.z*sin(a2), n.y, n.x*sin(a2)+n.z*cos(a2));
    vec2 cp = vec2(atan(rc.z,rc.x), asin(rc.y))*vec2(3.,3.4);
    float cl = smoothstep(.45,.85, fbm(cp*1.2+vec2(0.,t*.01)));
    float day = smoothstep(-.12,.25,ndl);
    vec3 lit = albedo*(.12+1.6*max(ndl,0.)) + vec3(.9,.95,1.)*cl*max(ndl+.05,0.)*1.3;
    // ocean specular glint
    vec3 V = vec3(0,0,1); vec3 H = normalize(L+V);
    lit += vec3(1.,.85,.6)*pow(max(dot(n,H),0.),60.)*(1.-cl)*.9*day;
    // night side: city lights
    float city = step(.83, n2(cp*22.))*smoothstep(.5,.6,fbm(cp*2.))*(1.-cl);
    vec3 night = vec3(1.,.6,.25)*city*.9*(1.-day);
    col = mix(night, lit, day);
    // atmosphere inside the disc (fresnel)
    float fr = pow(1.-n.z, 3.);
    col += vec3(.25,.55,1.)*fr*(.25+1.4*smoothstep(-.3,.5,ndl));
    // terminator warm band
    col += vec3(1.,.45,.15)*exp(-pow(ndl*7.,2.))*.25;
  }
  // atmosphere halo outside the limb
  float hd = r-PR;
  if (hd > 0.){
    vec2 dn = normalize(d);
    float side = smoothstep(-.5,.9, dot(vec3(dn,0.), L));
    col += vec3(.2,.5,1.)*exp(-hd*28.)*(.35+1.8*side);
    col += vec3(.5,.8,1.)*exp(-hd*90.)*side*1.2;
  }
  // ---- moon: small, dim, softly cratered
  vec2 mc = vec2(.6,.2); float MR = .042;
  vec2 md = uv-mc; float mr = length(md);
  if (mr < MR){
    vec3 n = normalize(vec3(md/MR, sqrt(max(0.,1.-dot(md,md)/(MR*MR)))));
    float maria = smoothstep(.45,.65, fbm3(n.xy*2.2+4.));
    vec3 alb = vec3(.36,.35,.34)*(1.-.35*maria)*(.9+.2*n2(n.xy*30.));
    col = alb*pow(max(dot(n,L),0.),.8)*1.1 + vec3(.004,.006,.012);
  }
  col += vec3(.3,.5,1.)*exp(-max(mr-MR,0.)*90.)*.05;
  // ---- sun: occluded by the limb, then flares
  float sd = length(uv-sunP);
  float occl = smoothstep(PR-.004, PR+.03, length(sunP-pc)+.0);
  float pulse = .9+.1*sin(t*.4);
  vec3 sun = vec3(1.,.92,.8)*(.004/(sd*sd+.0004))*.35;
  sun += vec3(1.,.8,.55)*exp(-sd*7.)*.35;
  // anamorphic streak + ghosts
  sun += vec3(.6,.75,1.)*exp(-abs(uv.y-sunP.y)*260.)*exp(-abs(uv.x-sunP.x)*1.6)*.55;
  vec2 gdir = -sunP;
  for(int i=1;i<4;i++){ vec2 gp = sunP + gdir*float(i)*.55; col += vec3(.2,.35,.6)*exp(-length(uv-gp)*(18.+float(i)*10.))*.10*occl; }
  col += sun*occl*pulse;
  gl_FragColor = vec4(finish(col*1.05, fc),1.);
}`;
const PHOTO = COMMON + `
uniform sampler2D I; uniform vec4 Q; uniform vec2 S; uniform float M;
uniform vec4 H; uniform vec4 P; uniform vec3 E;
vec3 tex(vec2 px){ vec2 u = px/S; if (u.x<0.||u.y<0.||u.x>1.||u.y>1.) return vec3(0); return texture2D(I, u).rgb; }
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float lum(vec3 c){ return dot(c, vec3(.3,.59,.11)); }
vec3 flowSample(vec2 px, vec2 off, float rate, float jit){
  float p0 = fract(T*rate + jit), p1 = fract(T*rate + jit + .5);
  return mix(tex(px - off*p0), tex(px - off*p1), abs(2.*p0 - 1.));
}
float starMask(vec2 px, vec3 base){
  float l = lum(base);
  float ring = (lum(tex(px+vec2(4,0)))+lum(tex(px-vec2(4,0)))+lum(tex(px+vec2(0,4)))+lum(tex(px-vec2(0,4))))*.25;
  return smoothstep(.12,.3, l-ring) * smoothstep(.25,.5,l) * (1.-smoothstep(.05,.2, base.r-base.b));
}
vec3 holeFx(vec2 px, vec3 base){
  vec2 c = H.xy; float hr = H.z; float tilt = H.w;
  vec2 d = px - c;
  vec2 dd = rot(-tilt)*d;                         // disk frame: x along the band
  float rC = length(d)/hr;
  float rB = length(vec2(dd.x, dd.y/P.x))/hr;      // elliptical radius on the band
  vec2 tC = normalize(vec2(-d.y, d.x));            // around the lensed ring
  vec2 tB = rot(tilt)*vec2(-sign(dd.y + 1e-3), 0.); // along the band, near/far sides opposite
  float ringW = smoothstep(2.1, 1.25, rC);
  vec2 fd = normalize(mix(tB, tC, ringW));
  float sp = P.y * inversesqrt(max(min(rB, rC), 1.));
  float l0 = lum(base);
  float warm = smoothstep(.02, .2, base.r - base.b);
  float mask = smoothstep(.14,.5,l0) * (.3+.7*warm) * smoothstep(.97,1.08,rC);
  vec3 col = mix(base, flowSample(px, fd*sp, .06, n2(px*.01)*.7), mask);
  // lanes streaming along the disk
  float a = atan(dd.y/P.x, dd.x);
  float lanes = fbm(vec2(min(rB,rC)*7., a*2.5 + T*.35*pow(max(min(rB,rC),1.),-1.5)));
  col += vec3(1.,.8,.55) * mask * (lanes-.45) * .55 * l0;
  // photon ring shimmer + breathing glow
  col += vec3(1.,.92,.8) * exp(-pow((rC-1.02)*22.,2.)) * (.06 + .05*sin(T*1.6 + atan(d.y,d.x)*3.));
  col += col * mask * .14 * sin(T*.42);
  col += vec3(1.,.72,.42) * exp(-max(rC-1.,0.)*1.6) * (1.-step(rC,1.)) * .025 * (1.+sin(T*.42));
  // stars twinkle
  float st = starMask(px, base) * step(2.5, rC);
  float tw = .55 + .9*pow(.5+.5*sin(T*(1.3+h21(floor(px/3.))*3.) + h21(floor(px/3.)+7.)*40.), 2.);
  col = mix(col, base*tw, st);
  // clouds (P.z = where they start, 0..1 of the picture height)
  if (P.z < 1.5){
    float cm = smoothstep(P.z, P.z + .08, px.y/S.y) * (1. - mask);
    vec2 coff = vec2(-P.w, 0.) + vec2(0., 2.*sin(px.x*.012 + T*.1));
    vec3 cf = flowSample(px, coff, .035, n2(px*.006)*.8);
    float churn = fbm(px*.0045 + vec2(T*.025, T*.008));
    cf *= .88 + .3*churn;
    cf += vec3(1.,.7,.4) * pow(churn,3.) * .06 * smoothstep(P.z+.25, P.z, px.y/S.y);   // disk light on the tops
    col = mix(col, cf, cm);
  }
  return col;
}
vec3 earthFx(vec2 px, vec3 base){
  vec2 d = px - E.xy; float r = length(d)/E.z;
  vec3 col = base;
  float l0 = lum(base);
  float city = smoothstep(.06,.25, base.r - base.b) * smoothstep(.25,.55,l0);
  if (r < 1.){
    float z = sqrt(max(0., 1.-r*r));
    float cloud = (1.-city) * smoothstep(.12,.4,l0) * smoothstep(1.,.93,r);
    vec3 fl = flowSample(px, vec2(P.y*z, P.y*.15*z), .045, n2(px*.008)*.7);
    col = mix(base, fl, cloud);
    float id = h21(floor(px/2.));
    float tw = .55 + .75*pow(.5+.5*sin(T*(.9+id*2.6) + id*50.), 3.);
    col = mix(col, base*tw*1.25, city);
  }
  float rim = exp(-pow((r-1.)*E.z/14., 2.));
  col += vec3(.18,.42,1.) * rim * (.12 + .1*sin(T*.55));
  float ang = atan(d.y, d.x);
  float gl = exp(-pow(ang - (3.14159 + .9*sin(T*.035)), 2.)*30.);
  col += vec3(.7,.85,1.) * rim * gl * .5;
  float st = starMask(px, base) * step(1.04, r);
  col = mix(col, base*(.5+.9*pow(.5+.5*sin(T*(1.2+h21(floor(px/3.))*3.)+h21(floor(px/3.)+3.)*40.),2.)), st);
  return col;
}
void main(){
  vec2 sc = vec2(gl_FragCoord.x, R.y - gl_FragCoord.y);
  vec2 px = (sc - Q.xy) / Q.zw * S;
  vec3 base = tex(px);
  vec3 col = M < .5 ? holeFx(px, base) : earthFx(px, base);
  vec2 q = gl_FragCoord.xy/R;
  col *= .82 + .18*pow(16.*q.x*q.y*(1.-q.x)*(1.-q.y), .18);   // light vignette — the edges stay lit
  col += (h21(gl_FragCoord.xy + fract(T)*91.) - .5) * .02;
  gl_FragColor = vec4(col, 1.);
}`;

const SCENES = [
  { id: 'blackhole', name: 'Black Hole',    kind: 'photo', src: 'menu/black-hole.jpg',    mode: 0, hole: [316, 498, 96, -0.42],  squash: .16, flow: 16, cloudY: 2,   cloudFlow: 0,  focus: [.43, .38], fx: 'dust' },
  { id: 'horizon',   name: 'Event Horizon', kind: 'photo', src: 'menu/event-horizon.jpg', mode: 0, hole: [366, 385, 268, -0.27], squash: .22, flow: 22, cloudY: .58, cloudFlow: 12, focus: [.5, .33],  fx: 'dust' },
  { id: 'earth',     name: 'Earth',         kind: 'photo', src: 'menu/earth.jpg',         mode: 1, sphere: [1093, 581, 870], flow: 7, focus: [.75, .5], layout: 'right', fx: 'sat' },
  { id: 'orbit',     name: 'Orbit',         kind: 'shader' },
  { id: 'giant',     name: 'Gas Giant',     kind: 'video' },
];
const VS = 'attribute vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }';

const MenuScene = {
  SCENES,
  current: null,
  host: null, gl: null, cv: null, fx: null, fctx: null,
  _progs: null, _tex: {}, _raf: 0, _t0: 0, _onScreen: true, _scale: 1, _scale0: 1, _ft: 16, _last: 0, _settle: 0,

  // ---- public ----
  mount(container) {
    if (!container) return;
    const h = this._host();
    if (h.parentNode !== container) container.appendChild(h);
    this._apply();
  },
  set(id) {
    const sc = SCENES.find(s => s.id === id);
    if (!sc || (this.current && this.current.id === id)) return;
    const h = this._host();
    h.classList.add('is-switching');
    clearTimeout(this._swT);
    this._swT = setTimeout(() => {
      this.current = sc;
      this._apply();
      h.classList.remove('is-switching');
    }, 380);
    this._markBar(id);
  },
  barHTML() {
    const cur = this._pick().id;
    return `<nav class="mm-scene-bar" aria-label="Menu backdrop">${SCENES.map(s =>
      `<button type="button" class="mm-scene-opt${s.id === cur ? ' is-on' : ''}" data-scene="${s.id}" aria-pressed="${s.id === cur}" onclick="MenuScene.set('${s.id}')">${s.name}</button>`).join('')}</nav>`;
  },

  // ---- internals ----
  _pick() {
    if (!this.current) this.current = SCENES[Math.floor(Math.random()*SCENES.length)];   // random each visit
    return this.current;
  },
  _markBar(id) {
    document.querySelectorAll('.mm-scene-opt').forEach(b => {
      const on = b.dataset.scene === id; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
  },
  _host() {
    if (this.host) return this.host;
    const h = this.host = document.createElement('div');
    h.className = 'mm-scene';
    h.setAttribute('aria-hidden', 'true');
    this.cv = document.createElement('canvas'); this.cv.className = 'mm-scene-gl';
    this.fx = document.createElement('canvas'); this.fx.className = 'mm-scene-fx';
    h.appendChild(this.cv); h.appendChild(this.fx);
    this.fctx = this.fx.getContext('2d');
    try {
      const gl = this.cv.getContext('webgl', { antialias: false, premultipliedAlpha: false, powerPreference: 'low-power' });
      if (gl) this._initGL(gl);
    } catch (e) { this.gl = null; }
    try {
      new IntersectionObserver((es) => { this._onScreen = es.some(e => e.isIntersecting); this._kick(); }).observe(h);
    } catch (e) {}
    document.addEventListener('visibilitychange', () => this._kick());
    window.addEventListener('resize', () => this._resize());
    this._pick();
    return h;
  },
  _initGL(gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = (fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = n => gl.getUniformLocation(p, n);
      return { p, R: u('R'), T: u('T'), F: u('F'), I: u('I'), Q: u('Q'), S: u('S'), M: u('M'), H: u('H'), P: u('P'), E: u('E') }; };
    this._progs = { orbit: prog(ORBIT), photo: prog(PHOTO) };
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.gl = gl;
    this.cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; this._apply(); });
  },
  _texFor(sc) {
    if (this._tex[sc.id] !== undefined) return this._tex[sc.id];
    this._tex[sc.id] = null;
    const img = new Image();
    img.onload = () => {
      const gl = this.gl; if (!gl) return;
      sc.w = img.naturalWidth; sc.h = img.naturalHeight;
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR));
      [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE));
      this._tex[sc.id] = t;
      if (this._reduced()) this._frame(performance.now());
    };
    img.src = sc.src;
    return null;
  },
  _reduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } },
  // Which layer shows: the video for Gas Giant (or when WebGL is unavailable),
  // the canvas for everything else.
  _apply() {
    const sc = this._pick(), h = this._host();
    const video = sc.kind === 'video' || !this.gl;
    h.classList.toggle('is-video', video);
    const v = (typeof UI !== 'undefined' && UI._menuVideoEl) ? UI._menuVideoEl() : null;
    if (video && v) { if (v.parentNode !== h) h.insertBefore(v, h.firstChild); }
    else if (v && v.parentNode === h) h.removeChild(v);
    try { UI._syncMenuVideo(); } catch (e) {}
    this._markBar(sc.id);
    this._resize();
    this._kick();
  },
  _resize() {
    if (!this.cv) return;
    const low = document.body && document.body.classList.contains('low-fx');
    // FULL NATIVE RESOLUTION (owner: "make it hd"). This used to start at
    // 0.8x of min(DPR, 1.5) — on a 2x screen that drew 1.2 canvas px per CSS
    // px and the browser stretched it, softening everything. Now it starts at
    // the real device ratio (capped at 2); the adaptive loop still steps it
    // down on a device that can't hold the frame rate.
    this._scale0 = Math.min(window.devicePixelRatio || 1, 2) * (low ? .6 : 1);
    // Start AT the target the first time (the field's initial 1 is only a
    // placeholder — "only ever lower it" kept a 2x screen at 1x forever).
    if (!this._scaleSet || this._scale > this._scale0) { this._scale = this._scale0; this._scaleSet = true; }
    const w = Math.max(1, Math.round(innerWidth*this._scale)), hh = Math.max(1, Math.round(innerHeight*this._scale));
    if (this.cv.width !== w || this.cv.height !== hh) { this.cv.width = w; this.cv.height = hh; if (this.gl) this.gl.viewport(0, 0, w, hh); }
    if (this.fx.width !== innerWidth || this.fx.height !== innerHeight) { this.fx.width = innerWidth; this.fx.height = innerHeight; }
  },
  _running() {
    return !!(this.host && this.host.isConnected && this._onScreen && !document.hidden && this.gl && this.current && this.current.kind !== 'video');
  },
  _kick() {
    if (this._running()) {
      if (this._reduced()) { cancelAnimationFrame(this._raf); this._raf = 0; this._frame(performance.now()); return; }
      if (!this._raf) { if (!this._t0) this._t0 = performance.now(); this._raf = requestAnimationFrame((n) => this._loop(n)); }
    } else if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; this._last = 0; }
  },
  _loop(now) {
    this._raf = 0;
    if (!this._running()) return;
    if (this._last) this._ft = this._ft*.92 + Math.min(now - this._last, 100)*.08;
    this._last = now;
    if (++this._settle > 45) {   // adaptive resolution: fewer pixels, never fewer frames
      if (this._ft > 21 && this._scale > .35) { this._scale *= .85; this._settle = 0; this._resizeTo(); }
      else if (this._ft < 13 && this._scale < this._scale0) { this._scale = Math.min(this._scale0, this._scale/.9); this._settle = 0; this._resizeTo(); }
    }
    this._frame(now);
    this._raf = requestAnimationFrame((n) => this._loop(n));
  },
  _resizeTo() { const w = Math.round(innerWidth*this._scale), h = Math.round(innerHeight*this._scale); this.cv.width = w; this.cv.height = h; this.gl.viewport(0, 0, w, h); },
  _frame(now) {
    const gl = this.gl, sc = this.current; if (!gl || !sc) return;
    const T = (now - (this._t0 || now))/1000 + 40;
    if (sc.kind === 'shader') {
      const P = this._progs.orbit; gl.useProgram(P.p);
      gl.uniform2f(P.R, this.cv.width, this.cv.height); gl.uniform1f(P.T, T); gl.uniform1f(P.F, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this._fxClear();
      return;
    }
    const tex = this._texFor(sc);
    if (!tex) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
    const P = this._progs.photo; gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(P.I, 0);
    const r = this._rect(sc, T);
    gl.uniform2f(P.R, this.cv.width, this.cv.height); gl.uniform1f(P.T, T);
    gl.uniform4f(P.Q, r[0], r[1], r[2], r[3]); gl.uniform2f(P.S, sc.w, sc.h); gl.uniform1f(P.M, sc.mode);
    if (sc.mode === 0) { gl.uniform4f(P.H, sc.hole[0], sc.hole[1], sc.hole[2], sc.hole[3]); gl.uniform4f(P.P, sc.squash, sc.flow, sc.cloudY, sc.cloudFlow); }
    else { gl.uniform3f(P.E, sc.sphere[0], sc.sphere[1], sc.sphere[2]); gl.uniform4f(P.P, 1, sc.flow, 2, 0); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this._fxFrame(sc, T);
  },
  // Where the picture sits (canvas px, top-left origin) with a slow camera push.
  // Portrait screens: cover. Wide: the hole pictures frame their focus point
  // right of the menu column; Earth stands full height on the right edge.
  _rect(sc, T) {
    const W = this.cv.width, H = this.cv.height, kb = 1.03 + .045*(.5 - .5*Math.cos(T*2*Math.PI/48));
    if (sc.layout === 'right' && W > H) {
      const s = (H*1.12/sc.h)*kb, w = sc.w*s, h = sc.h*s;
      return [W - w, (H - h)/2, w, h];
    }
    const s = Math.max(W/sc.w, H/sc.h)*kb, w = sc.w*s, h = sc.h*s;
    let x = (W > H ? W*.62 : W*.5) - sc.focus[0]*w, y = (W > H ? H*.42 : H*.5) - sc.focus[1]*h;
    x = Math.min(0, Math.max(W - w, x)); y = Math.min(0, Math.max(H - h, y));
    return [x + Math.sin(T*.05)*W*.006, y + Math.cos(T*.043)*H*.005, w, h];
  },
  _motes: null, _satT: -1, _fxDirty: false,
  _fxClear() { if (this._fxDirty) { this.fctx.clearRect(0, 0, this.fx.width, this.fx.height); this._fxDirty = false; } },
  _fxFrame(sc, T) {
    const c = this.fctx, w = this.fx.width, h = this.fx.height;
    c.clearRect(0, 0, w, h); this._fxDirty = true;
    if (sc.fx === 'dust') {
      if (!this._motes) this._motes = Array.from({ length: 50 }, () => ({ x: Math.random(), y: Math.random(), r: .4 + Math.random()*1.3, s: .002 + Math.random()*.006, a: Math.random()*6.28 }));
      for (const m of this._motes) {
        m.y -= m.s*.05; m.x += Math.sin(T*.3 + m.a)*.00015; if (m.y < -.02) { m.y = 1.02; m.x = Math.random(); }
        const a = .2 + .3*Math.sin(T*1.2 + m.a); if (a <= 0) continue;
        c.fillStyle = `rgba(255,214,160,${a})`; c.beginPath(); c.arc(m.x*w, m.y*h, m.r, 0, 6.283); c.fill();
      }
    } else if (sc.fx === 'sat') {
      if (this._satT < 0 || T - this._satT > 25) this._satT = T;
      const k = (T - this._satT)/10;
      if (k < 1) { const sx = w*(.25 + .5*k), sy = h*(.1 + .45*k), a = Math.sin(k*Math.PI)*.9;
        c.fillStyle = `rgba(230,240,255,${a})`; c.beginPath(); c.arc(sx, sy, 1.6, 0, 6.283); c.fill();
        if (Math.floor(T*1.5) % 2 === 0) { c.fillStyle = `rgba(255,90,70,${a})`; c.beginPath(); c.arc(sx + 3, sy + 1, 1.1, 0, 6.283); c.fill(); } }
    }
  },
};
window.MenuScene = MenuScene;
})();
