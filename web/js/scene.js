import * as THREE from 'three';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import * as SkeletonUtils from '../vendor/utils/SkeletonUtils.js';

const WATER_Y = 0;
const BLASTER_YAW = 0;
const SEABED_Y = -4.6;
const A = 'assets/';

// Shared wave function: the water shader uses the same formula so boats bob
// exactly with the surface.
export function waveHeight(x, z, t) {
  return 0.13 * Math.sin(0.33 * x + 1.1 * t) + 0.09 * Math.sin(0.47 * z - 0.9 * t + 0.3 * x) + 0.05 * Math.sin(1.3 * x + 0.7 * z + 1.7 * t);
}
const WAVE_GLSL = `
float waveH(vec2 p, float t){
  return 0.13*sin(0.33*p.x+1.1*t) + 0.09*sin(0.47*p.y-0.9*t+0.3*p.x) + 0.05*sin(1.3*p.x+0.7*p.y+1.7*t);
}`;

function hexColor(h) { return new THREE.Color(h); }
const tmpV = new THREE.Vector3();

// ---------------------------------------------------------------- shaders
const fishVert = `
uniform float uTime, uPhase, uWag, uFlip;
varying vec2 vUv; varying float vDist;
void main(){
  vUv = uv; if (uFlip > 0.5) vUv.x = 1.0 - vUv.x;
  vec3 p = position;
  float tail = pow(1.0 - vUv.x, 1.7);
  p.y += sin(uTime * 8.0 + uPhase - vUv.x * 4.0) * uWag * tail;
  p.x += sin(uTime * 8.0 + uPhase) * uWag * 0.25 * tail * (uFlip > 0.5 ? -1.0 : 1.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const fishFrag = `
uniform sampler2D uMap; uniform vec3 uTint, uWater; uniform float uTintAmt, uFlash, uGlow, uOpacity, uTime, uWaterAmt, uRage;
varying vec2 vUv; varying float vDist;
void main(){
  vec4 c = texture2D(uMap, vUv);
  if (c.a < 0.4) discard;
  vec3 col = c.rgb;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, uTint * (0.35 + l * 1.15), uTintAmt);
  col += uTint * uGlow * (0.25 + 0.2 * sin(uTime * 6.0));
  col = mix(col, vec3(1.0, 0.25, 0.15), uRage * (0.35 + 0.25 * sin(uTime * 10.0)));
  col = mix(col, uWater, uWaterAmt);
  col = mix(col, vec3(1.0), uFlash);
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

const waterVert = `
uniform float uTime; varying vec3 vW; varying vec3 vN;
${WAVE_GLSL}
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  float h = waveH(w.xz, uTime);
  w.y += h;
  float e = 0.15;
  float hx = waveH(w.xz + vec2(e, 0.0), uTime) - h;
  float hz = waveH(w.xz + vec2(0.0, e), uTime) - h;
  vN = normalize(vec3(-hx / e, 1.0, -hz / e));
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const waterFrag = `
uniform vec3 uShallow, uDeep, uFog, uSun; uniform float uTime, uLight; uniform sampler2D uSky;
varying vec3 vW; varying vec3 vN;
vec3 skyAt(vec3 d){ vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5); return texture2D(uSky, uv).rgb; }
void main(){
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN + vec3(0.03 * sin(vW.x * 3.0 + uTime * 2.0), 0.0, 0.03 * cos(vW.z * 3.3 - uTime * 1.7)));
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 col = mix(uShallow, uDeep, 0.3 + 0.5 * fres);
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  col = mix(col, skyAt(R), 0.18 + 0.6 * fres);
  vec3 L = normalize(uSun);
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 90.0) * 1.6 * uLight;
  float sparkle = smoothstep(0.93, 1.0, sin(vW.x * 2.1 + uTime * 1.3) * sin(vW.z * 2.7 - uTime)) * 0.35;
  col += vec3(spec + sparkle * uLight);
  float dist = length(cameraPosition.xz - vW.xz);
  float a = mix(0.2, 0.85, fres);
  // opaque toward the horizon so the seabed edge never shows
  float far = smoothstep(26.0, 60.0, length(vW.xz - vec2(0.0, -3.0)));
  a = mix(a, 1.0, far);
  col = mix(col, uFog, smoothstep(45.0, 140.0, dist));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const floorVert = `
varying vec2 vUv; varying vec3 vW;
void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const floorFrag = `
uniform sampler2D uMap; uniform vec3 uDeep, uLightCol; uniform float uTime, uLight, uRepeat;
varying vec2 vUv; varying vec3 vW;
float caus(vec2 p, float t){
  float a = sin(p.x * 1.7 + t) * sin(p.y * 1.3 - t * 0.8);
  float b = sin((p.x + p.y) * 1.1 + t * 1.4) * sin((p.x - p.y) * 0.9 - t * 1.1);
  return pow(abs(a + b) * 0.5, 3.0);
}
void main(){
  vec3 c = texture2D(uMap, vW.xz / uRepeat).rgb;
  float k = caus(vW.xz * 0.9, uTime * 0.9) + caus(vW.xz * 1.7 + 3.0, uTime * 1.3) * 0.6;
  vec3 col = c * (0.55 + 0.35 * uLight) + uLightCol * k * 0.55 * uLight;
  float dist = length(vW.xz - vec2(0.0, -3.0));
  col = mix(col, uDeep, 0.35 + 0.65 * smoothstep(14.0, 38.0, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const swayVert = `
uniform float uTime, uPhase; varying vec2 vUv;
void main(){
  vUv = uv; vec3 p = position;
  p.x += sin(uTime * 1.3 + uPhase) * 0.18 * uv.y * uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const swayFrag = `
uniform sampler2D uMap; uniform vec3 uWater; uniform float uWaterAmt; varying vec2 vUv;
void main(){ vec4 c = texture2D(uMap, vUv); if (c.a < 0.45) discard; gl_FragColor = vec4(mix(c.rgb, uWater, uWaterAmt), 1.0);
  #include <colorspace_fragment>
}`;

const pointsVert = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
varying float vA; varying vec3 vC;
void main(){ vA = aAlpha; vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
  gl_PointSize = aSize * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }`;
const pointsFrag = `
varying float vA; varying vec3 vC;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
  gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.1, r));
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- particles
class Particles {
  constructor(max, blending) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max); this.size0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: pointsVert, fragmentShader: pointsFrag, transparent: true, depthWrite: false, blending }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }
  emit(x, y, z, color, count, { speed = 3, size = 0.35, life = 0.6, grav = -2, up = 0 } = {}) {
    const c = hexColor(color);
    for (let k = 0; k < count; k++) {
      if (this.n >= this.max) return;
      const i = this.n++;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI - Math.PI / 2, s = speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.cos(th) * Math.cos(ph) * s; this.vel[i * 3 + 1] = Math.sin(ph) * s + up; this.vel[i * 3 + 2] = Math.sin(th) * Math.cos(ph) * s;
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.size0[i] = size * (0.6 + Math.random() * 0.8); this.grav[i] = grav;
    }
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.copy(this.n - 1, i); this.n--; i--; continue; }
      this.vel[i * 3 + 1] += this.grav[i] * dt;
      const damp = Math.exp(-dt * 2.5);
      this.vel[i * 3] *= damp; this.vel[i * 3 + 2] *= damp;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, f * 2); this.size[i] = this.size0[i] * (0.4 + 0.6 * f);
    }
    for (let i = this.n; i < Math.min(this.max, this.n + 8); i++) this.alpha[i] = 0;
    this.geo.setDrawRange(0, this.n);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) this.geo.attributes[k].needsUpdate = true;
  }
  copy(a, b) {
    for (let k = 0; k < 3; k++) { this.pos[b * 3 + k] = this.pos[a * 3 + k]; this.vel[b * 3 + k] = this.vel[a * 3 + k]; this.col[b * 3 + k] = this.col[a * 3 + k]; }
    this.life[b] = this.life[a]; this.maxLife[b] = this.maxLife[a]; this.size0[b] = this.size0[a]; this.grav[b] = this.grav[a];
  }
}

// ---------------------------------------------------------------- world
export class World {
  constructor(canvas, fxLayer) {
    this.canvas = canvas; this.fxLayer = fxLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    // two poses: gameplay (fits the whole fishing ground) and menu (hero shot with the horizon)
    this.poses = {
      game: { pos: new THREE.Vector3(0, 16, 22), tgt: new THREE.Vector3(0, -1.5, 0.5), fov: 48 },
      menu: { pos: new THREE.Vector3(-3, 5.5, 21), tgt: new THREE.Vector3(3, 1.2, -12), fov: 50 },
    };
    this.camPos = this.poses.menu.pos.clone(); this.camTgt = this.poses.menu.tgt.clone(); this.camFov = 50;
    this.shake = 0; this.shakeOn = true; this.numbersOn = true;
    this.time = 0;
    this.hemi = new THREE.HemisphereLight(0xdff6ff, 0x2a4a55, 1.5);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(12, 25, 10);
    this.scene.add(this.hemi, this.sun);
    this.fishes = new Map(); this.bullets = new Map(); this.rigs = new Map();
    this.coins = []; this.flashes = []; this.texts = []; this.zaps = [];
    this.mySlot = -1; this.defs = null; this.attract = true; this.attractFish = [];
    this.raycaster = new THREE.Raycaster();
    this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1.7);
    this.zoneIdx = -1;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Pull back on narrow screens so the whole fishing ground fits.
    const k = Math.pow(Math.max(1, (16 / 9) / this.camera.aspect), 0.8);
    this.camDist = k;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------ loading
  async load(defs, onProgress) {
    this.defs = defs;
    this.fishY = defs.field.fishY;
    this.aimPlane.constant = -this.fishY;
    const tl = new THREE.TextureLoader();
    const gl = new GLTFLoader();
    const tex = {}; const models = {};
    const spriteNames = new Set(['bubble_a', 'bubble_b', 'bubble_c', 'rock_a', 'rock_b', 'terrain_sand_a', 'terrain_dirt_a']);
    defs.fish.forEach(f => spriteNames.add(f.sprite));
    defs.zones.forEach(z => { z.weeds.forEach(w => spriteNames.add(w)); spriteNames.add(z.floor); });
    const modelNames = new Set([...defs.boats.map(b => b.id), ...defs.weapons.map(w => w.model), ...defs.chars,
      'buoy', 'buoy-flag', 'ship-large', 'ship-ocean-liner', 'ship-cargo-a', 'cargo-container-a', 'cargo-container-b', 'cargo-container-c',
      'ramp-wide', 'cargo-pile-a', 'crate-medium', 'windmill', 'watermill', 'tree-high', 'tree', 'tree-crooked', 'tree-high-round',
      'rock-large', 'rock-wide', 'rock-small', 'lantern', 'stall-red', 'stall-green', 'cart', 'fountain-round', 'banner-red', 'banner-green', 'fence', 'poles', 'hedge']);
    const total = spriteNames.size + modelNames.size + defs.zones.length;
    let done = 0;
    const tick = () => onProgress && onProgress(++done / total);
    const jobs = [];
    for (const n of spriteNames) jobs.push(tl.loadAsync(`${A}fish/${n}.png`).then(t => {
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      if (n.startsWith('terrain')) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
      tex[n] = t; tick();
    }).catch(e => { console.warn('texture', n, e); tick(); }));
    this.skies = {};
    for (const z of defs.zones) jobs.push(tl.loadAsync(`${A}sky/skybox-${z.sky}.jpg`).then(t => {
      t.colorSpace = THREE.SRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping; this.skies[z.sky] = t; tick();
    }).catch(e => { console.warn('sky', z.sky, e); tick(); }));
    for (const n of modelNames) jobs.push(gl.loadAsync(`${A}models/${n}.glb`).then(g => { models[n] = g; tick(); }).catch(e => { console.warn('model', n, e); tick(); }));
    await Promise.all(jobs);
    this.tex = tex; this.models = models;
    this.buildStatic();
  }

  model(name) {
    const g = this.models[name];
    return g ? g.scene.clone(true) : new THREE.Group();
  }

  fit(obj, size, axis = 'max') {
    const b = new THREE.Box3().setFromObject(obj); const s = b.getSize(new THREE.Vector3());
    const cur = axis === 'y' ? s.y : Math.max(s.x, s.z);
    obj.scale.multiplyScalar(size / (cur || 1));
    return obj;
  }

  place(name, x, y, z, { scale = 1, rot = 0, fit = 0 } = {}) {
    const m = this.model(name);
    if (fit) this.fit(m, fit); else m.scale.setScalar(scale);
    m.position.set(x, y, z); m.rotation.y = rot;
    this.decor.add(m);
    return m;
  }

  // ------------------------------------------------ static scene
  buildStatic() {
    const s = this.scene;
    // water surface
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: waterVert, fragmentShader: waterFrag, transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uShallow: { value: hexColor('#2fc3d6') }, uDeep: { value: hexColor('#0a5f86') }, uFog: { value: hexColor('#9ad9ea') },
        uSun: { value: new THREE.Vector3(0.5, 0.9, 0.3) }, uLight: { value: 1 }, uSky: { value: null } },
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(320, 320, 200, 200), this.waterMat);
    water.rotation.x = -Math.PI / 2; water.position.y = WATER_Y; water.renderOrder = 10;
    s.add(water);
    // seabed
    this.floorMat = new THREE.ShaderMaterial({
      vertexShader: floorVert, fragmentShader: floorFrag,
      uniforms: { uMap: { value: this.tex.terrain_sand_a }, uDeep: { value: hexColor('#0a5f86') }, uLightCol: { value: hexColor('#e8fbff') }, uTime: { value: 0 }, uLight: { value: 1 }, uRepeat: { value: 2.6 } },
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 90), this.floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, SEABED_Y, -6);
    s.add(floor);

    this.decor = new THREE.Group(); s.add(this.decor);
    this.weeds = new THREE.Group(); s.add(this.weeds);
    this.fishG = new THREE.Group(); s.add(this.fishG);
    this.fxG = new THREE.Group(); s.add(this.fxG);

    // particles
    this.sparks = new Particles(2500, THREE.AdditiveBlending); s.add(this.sparks.mesh);
    this.puffs = new Particles(1200, THREE.NormalBlending); s.add(this.puffs.mesh);
    this.buildBubbles();
    this.buildShore();

    // shared geometries/materials
    this.fishGeo = new THREE.PlaneGeometry(1, 1, 14, 2);
    this.fishMatBase = new THREE.ShaderMaterial({
      vertexShader: fishVert, fragmentShader: fishFrag, transparent: true,
      uniforms: { uMap: { value: null }, uTime: { value: 0 }, uPhase: { value: 0 }, uWag: { value: 0.06 }, uFlip: { value: 0 },
        uTint: { value: new THREE.Color(1, 1, 1) }, uTintAmt: { value: 0 }, uFlash: { value: 0 }, uGlow: { value: 0 }, uOpacity: { value: 1 },
        uWater: { value: hexColor('#0a5f86') }, uWaterAmt: { value: 0.06 }, uRage: { value: 0 } },
    });
    const shadowTex = this.radialTexture();
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.28 });
    this.shadowGeo = new THREE.PlaneGeometry(1, 1); this.shadowGeo.rotateX(-Math.PI / 2);
    this.hpGeo = new THREE.PlaneGeometry(1, 1);
    this.bulletGeo = new THREE.SphereGeometry(0.16, 10, 8);
    this.trailGeo = new THREE.CylinderGeometry(0.02, 0.13, 1, 8, 1, true); this.trailGeo.rotateX(Math.PI / 2); this.trailGeo.translate(0, 0, 0.5);
    this.coinGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 16); this.coinGeo.rotateX(Math.PI / 2);
    this.coinMat = new THREE.MeshStandardMaterial({ color: 0xffc83d, metalness: 0.6, roughness: 0.3, emissive: 0x6b4a00 });
    this.ringGeo = new THREE.RingGeometry(0.8, 1, 48); this.ringGeo.rotateX(-Math.PI / 2);
    this.shieldGeo = new THREE.SphereGeometry(1, 24, 16);
    // aim reticle
    this.reticle = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
    this.reticle.scale.setScalar(0.55); this.reticle.renderOrder = 20; this.reticle.visible = false;
    s.add(this.reticle);
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.aimLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.55, depthTest: false }));
    this.aimLine.renderOrder = 19; this.aimLine.visible = false; this.aimLine.frustumCulled = false;
    s.add(this.aimLine);
    this.setZone(0, true);
  }

  radialTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  buildBubbles() {
    const n = 140; const pos = new Float32Array(n * 3); this.bubbleSpeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 44; pos[i * 3 + 1] = SEABED_Y + Math.random() * 4.4; pos[i * 3 + 2] = -14 + Math.random() * 20;
      this.bubbleSpeed[i] = 0.4 + Math.random() * 0.9;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.bubbles = new THREE.Points(g, new THREE.PointsMaterial({ map: this.tex.bubble_a, size: 0.55, transparent: true, depthWrite: false, opacity: 0.75, sizeAttenuation: true }));
    this.bubbles.frustumCulled = false;
    this.scene.add(this.bubbles);
  }

  buildShore() {
    // Island village on the far horizon, built from the fantasy town kit.
    const iz = -66;
    const sand = new THREE.Mesh(new THREE.CylinderGeometry(22, 26, 3, 40), new THREE.MeshStandardMaterial({ color: 0xe9d8a6, roughness: 1 }));
    sand.scale.set(2.4, 1, 0.8); sand.position.set(4, -1.1, iz); this.decor.add(sand);
    const grass = new THREE.Mesh(new THREE.CylinderGeometry(18, 20, 0.6, 40), new THREE.MeshStandardMaterial({ color: 0x7fc25a, roughness: 1 }));
    grass.scale.set(2.4, 1, 0.72); grass.position.set(4, 0.55, iz - 1); this.decor.add(grass);
    const top = 0.85;
    this.windmill = this.place('windmill', -14, top, iz - 4, { fit: 9, rot: 0.4 });
    this.place('watermill', 20, top, iz + 2, { fit: 8, rot: -0.5 });
    const trees = ['tree-high', 'tree', 'tree-crooked', 'tree-high-round'];
    for (let i = 0; i < 16; i++) {
      const x = -30 + i * 4.2 + Math.sin(i * 7) * 1.5, z = iz - 5 - Math.cos(i * 3) * 3;
      this.place(trees[i % 4], x, top, z, { fit: 3.5 + (i % 3), rot: i });
    }
    this.place('stall-red', -4, top, iz + 3, { fit: 3.6, rot: 0.2 });
    this.place('stall-green', 3, top, iz + 3.5, { fit: 3.6, rot: -0.2 });
    this.place('fountain-round', 9, top, iz + 1, { fit: 4 });
    this.place('cart', -8, top, iz + 5, { fit: 2.4, rot: 1 });
    this.place('lantern', 13, top, iz + 6, { fit: 2.4 });
    this.place('lantern', -18, top, iz + 6, { fit: 2.4 });
    this.place('banner-red', 0, top, iz + 6, { fit: 3 });
    this.place('banner-green', 6, top, iz + 6, { fit: 3 });
    for (let i = 0; i < 6; i++) this.place('fence', -12 + i * 2.1, top, iz + 7, { fit: 2.1 });
    this.place('rock-large', 30, -0.4, iz + 8, { fit: 5, rot: 1 });
    this.place('rock-wide', -34, -0.4, iz + 8, { fit: 6 });
    this.place('rock-small', 24, -0.2, iz + 10, { fit: 2.2 });
    // ships and harbor
    this.farShips = [
      this.place('ship-large', -52, 0, -40, { fit: 14, rot: 1.2 }),
      this.place('ship-ocean-liner', 95, 0, -120, { fit: 30, rot: -1.4 }),
      this.place('ship-cargo-a', -30, 0, -78, { fit: 12, rot: -1.9 }),
    ];
    // field markers
    const bx = 19, marks = [[-bx, -12], [bx, -12], [-bx, 5], [bx, 5], [-bx, -3.5], [bx, -3.5]];
    this.buoys = marks.map(([x, z], i) => this.place(i % 2 ? 'buoy-flag' : 'buoy', x, -0.2, z, { fit: 1.1 }));
    // side docks by the boats
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) this.place('ramp-wide', sx * 19.5, 0.05, 6 + i * 2.2, { fit: 2.6, rot: Math.PI / 2 });
      this.place('cargo-container-' + (sx < 0 ? 'a' : 'b'), sx * 20, 0.3, 7.5, { fit: 3, rot: 0.1 * sx });
      this.place('cargo-container-c', sx * 20, 1.55, 7.7, { fit: 3, rot: -0.15 * sx });
      this.place('crate-medium', sx * 18.6, 0.3, 10.5, { fit: 1.3, rot: 0.6 });
      this.place('cargo-pile-a', sx * 22.5, 0, 4, { fit: 3 });
    }
  }

  // ------------------------------------------------ zones
  setZone(i, instant) {
    const z = this.defs.zones[i];
    this.zoneIdx = i;
    const sky = this.skies[z.sky];
    this.scene.background = sky;
    this.waterMat.uniforms.uSky.value = sky;
    const u = this.waterMat.uniforms;
    u.uShallow.value.set(z.water); u.uDeep.value.set(z.deep); u.uFog.value.set(z.fog); u.uLight.value = z.light;
    this.floorMat.uniforms.uMap.value = this.tex[z.floor] || this.tex.terrain_sand_a;
    this.floorMat.uniforms.uDeep.value.set(z.deep);
    this.floorMat.uniforms.uLight.value = z.light;
    this.hemi.intensity = 0.8 + 0.9 * z.light; this.sun.intensity = 0.8 + 1.6 * z.light;
    this.deepColor = hexColor(z.deep);
    this.fishes.forEach(f => f.mat.uniforms.uWater.value.copy(this.deepColor));
    // new seaweed garden
    this.weeds.clear();
    let seed = i * 97 + 13; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const names = [...z.weeds, 'rock_a', 'rock_b'];
    for (let k = 0; k < 70; k++) {
      const n = names[Math.floor(rnd() * names.length)]; const t = this.tex[n]; if (!t) continue;
      const mat = new THREE.ShaderMaterial({ vertexShader: swayVert, fragmentShader: swayFrag,
        uniforms: { uMap: { value: t }, uTime: { value: 0 }, uPhase: { value: rnd() * 6 }, uWater: { value: this.deepColor }, uWaterAmt: { value: 0.25 } } });
      const edge = rnd() < 0.7;
      const sz = (n.startsWith('rock') ? 1.4 + rnd() * 1.4 : 1.6 + rnd() * 2.2) * (edge ? 1 : 0.7);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), mat);
      const x = edge ? (rnd() < 0.5 ? -1 : 1) * (15 + rnd() * 10) : (rnd() - 0.5) * 34;
      const zz = edge ? -14 + rnd() * 20 : -16 + rnd() * 6;
      m.position.set(x, SEABED_Y + sz / 2 - 0.05, zz);
      m.userData.sway = mat;
      this.weeds.add(m);
    }
  }

  // ------------------------------------------------ boats / captains
  makeRig(info) {
    const g = new THREE.Group();
    const boat = this.model(info.boat);
    this.fit(boat, 3.3);
    const bb = new THREE.Box3().setFromObject(boat); const size = bb.getSize(new THREE.Vector3());
    const alongZ = size.z >= size.x;
    const holder = new THREE.Group(); holder.add(boat);
    if (!alongZ) holder.rotation.y = Math.PI / 2;
    boat.position.y = -bb.min.y - size.y * 0.28;
    g.add(holder);
    holder.updateMatrixWorld(true);
    // find the deck: cast down near the stern (toward the camera)
    const zs = [0.35, 0.1, 0.6, -0.1];
    let deckY = 0.35;
    const rc = new THREE.Raycaster();
    for (const zz of zs) {
      rc.set(new THREE.Vector3(0, 10, zz), new THREE.Vector3(0, -1, 0));
      const hits = rc.intersectObject(holder, true);
      if (hits.length) { deckY = hits[0].point.y; if (deckY < 1.4) break; }
    }
    deckY = Math.min(deckY, 1.3) + 0.25; // stand on the thwart, not in the bilge
    const charSrc = this.models[info.char];
    const ch = charSrc ? SkeletonUtils.clone(charSrc.scene) : new THREE.Group();
    this.fit(ch, 1.5, 'y');
    ch.position.set(0, deckY, 0.3);
    g.add(ch);
    let mixer = null, idle = null, shoot = null;
    if (charSrc && charSrc.animations.length) {
      mixer = new THREE.AnimationMixer(ch);
      const find = n => THREE.AnimationClip.findByName(charSrc.animations, n);
      idle = mixer.clipAction(find('holding-right') || find('idle'));
      shoot = mixer.clipAction(find('holding-right-shoot') || find('holding-right'));
      idle.play();
    }
    const hand = ch.getObjectByName('arm-right');
    const rig = { fresh: true, targetX: 0, g, holder, ch, mixer, idle, shoot, hand, slot: info.slot, info, deckY, blaster: null, weapon: -1, firing: false, aimX: 0, aimZ: -5, recoil: 0 };
    this.setRigWeapon(rig, info.w || 0);
    // flag in the player's color
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6), new THREE.MeshStandardMaterial({ color: 0x5b4a3a }));
    pole.position.set(-0.85, 0.8 + deckY * 0.5, 1.25);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.42), new THREE.MeshStandardMaterial({ color: info.color, side: THREE.DoubleSide }));
    flag.position.set(-0.35, 0.55, 0); pole.add(flag);
    rig.flag = flag; g.add(pole);
    // name label
    const label = document.createElement('div');
    label.className = 'ft'; label.style.color = info.color; label.style.fontSize = '15px';
    this.fxLayer.appendChild(label);
    rig.label = label;
    this.scene.add(g);
    return rig;
  }

  setRigWeapon(rig, wi) {
    if (rig.weapon === wi) return;
    rig.weapon = wi;
    if (rig.blaster) rig.blaster.parent.remove(rig.blaster);
    const w = this.defs.weapons[wi];
    const b = this.model(w.model);
    this.fit(b, 0.8);
    // Kenney blasters point down -Z; the character's right arm bone points forward.
    // Mounted on the body at right-hand height, barrel along the captain's
    // facing (+Z). The idle clip keeps the arms down, so a bone mount would
    // bury the gun in the torso.
    const wrap = new THREE.Group(); wrap.add(b);
    b.rotation.y = BLASTER_YAW;
    const s = rig.ch.scale.x || 1;
    wrap.scale.setScalar(1 / s);
    wrap.position.set(-0.16, 0.2, 0.2); // character-local units (unscaled model)
    rig.ch.add(wrap);
    rig.blaster = wrap;
  }

  setRoster(players, mySlot) {
    this.mySlot = mySlot;
    const seen = new Set();
    for (const p of players) {
      seen.add(p.slot);
      let rig = this.rigs.get(p.slot);
      if (rig && (rig.info.boat !== p.boat || rig.info.char !== p.char)) { this.removeRig(p.slot); rig = null; }
      if (!rig) { rig = this.makeRig(p); this.rigs.set(p.slot, rig); }
      rig.info = p;
      rig.label.innerHTML = `${escapeHtml(p.name)} <small>Lv ${p.level}</small>`;
      rig.targetX = p.x ?? 0;
      if (rig.fresh) { rig.g.position.x = rig.targetX; rig.fresh = false; }
      rig.g.position.z = this.defs.field.boatZ;
      this.setRigWeapon(rig, p.w);
    }
    for (const slot of [...this.rigs.keys()]) if (!seen.has(slot)) this.removeRig(slot);
  }

  removeRig(slot) {
    const r = this.rigs.get(slot); if (!r) return;
    this.scene.remove(r.g); r.label.remove(); this.rigs.delete(slot);
  }

  // Lobby preview: your own boat at the center.
  setPreview(me) {
    if (!me) { this.removeRig(-1); return; }
    const info = { slot: -1, name: me.name, level: me.level, boat: me.boat, char: me.char, color: '#ffbf3f', w: this.defs.weapons.findIndex(w => w.id === me.weapon) };
    for (const slot of [...this.rigs.keys()]) if (slot !== -1) this.removeRig(slot);
    const r = this.rigs.get(-1);
    if (r && r.info.boat === info.boat && r.info.char === info.char) { this.setRigWeapon(r, info.w); r.label.innerHTML = ''; return; }
    info.x = 6.5;
    this.removeRig(-1);
    const rig = this.makeRig(info);
    rig.targetX = 6.5; rig.fresh = false;
    rig.g.position.set(6.5, 0, this.defs.field.boatZ);
    rig.label.innerHTML = '';
    this.rigs.set(-1, rig);
  }

  // ------------------------------------------------ fish
  spriteAspect(name) { return name.includes('long') ? 0.5 : name === 'fish_brown' ? 1 : 0.75; }

  makeFish(id, ty) {
    const d = this.defs.fish[ty];
    const mat = this.fishMatBase.clone();
    const u = mat.uniforms;
    u.uMap.value = this.tex[d.sprite];
    u.uPhase.value = Math.random() * 6.28;
    u.uWater.value = this.deepColor.clone();
    if (d.tint) { u.uTint.value.set(d.tint); u.uTintAmt.value = d.id === 'golden' || d.id === 'critical' ? 0.85 : 0.55; }
    u.uGlow.value = d.glow || 0;
    u.uWag.value = d.boss ? 0.05 : 0.07;
    const mesh = new THREE.Mesh(this.fishGeo, mat);
    mesh.scale.set(d.size, d.size, 1);
    mesh.renderOrder = 2;
    const shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    shadow.scale.set(d.size * 0.8, 1, d.size * 0.35);
    const depth = d.boss ? -0.4 : ((id * 37) % 7 - 3) * 0.12;
    this.fishG.add(mesh, shadow);
    const f = { id, ty, d, mesh, mat, shadow, x: 0, z: 0, tx: 0, tz: 0, vx: 0, vz: 0, lastT: 0, dir: 1, hp: 1000, flags: 0, y: this.fishY + depth,
      flash: 0, dying: 0, gone: 0, tilt: 0, shield: null, hpBar: null, alpha: 0 };
    return f;
  }

  removeFish(f) {
    this.fishG.remove(f.mesh, f.shadow);
    f.mat.dispose();
    if (f.shield) this.fishG.remove(f.shield);
    if (f.hpBar) { this.fishG.remove(f.hpBar); f.hpBar.children.forEach(m => m.material.dispose()); }
    this.fishes.delete(f.id);
  }

  // ------------------------------------------------ snapshots
  applySnapshot(s, now) {
    const seenF = new Set();
    for (const a of s.f) {
      const [id, ty, x, z, hp, flags, dir] = a;
      seenF.add(id);
      let f = this.fishes.get(id);
      if (!f) { f = this.makeFish(id, ty); f.x = f.tx = x; f.z = f.tz = z; this.fishes.set(id, f); }
      else if (!f.dying) {
        const dt = Math.max(0.03, (now - f.lastT) / 1000);
        f.vx = (x - f.tx) / dt; f.vz = (z - f.tz) / dt;
        if (Math.abs(x - f.x) > 6) { f.x = x; f.z = z; } // teleport (blink)
      }
      f.tx = x; f.tz = z; f.lastT = now; f.hp = hp; f.flags = flags; f.dir = dir;
    }
    for (const f of this.fishes.values()) if (!seenF.has(f.id) && !f.dying && !f.gone) f.gone = 0.001;

    const seenB = new Set();
    for (const a of s.b) {
      const [id, slot, x, z, wi] = a;
      seenB.add(id);
      let b = this.bullets.get(id);
      if (!b) { b = this.makeBullet(id, slot, wi, x, z, now); this.bullets.set(id, b); }
      else {
        const dt = Math.max(0.03, (now - b.lastT) / 1000);
        b.vx = (x - b.tx) / dt; b.vz = (z - b.tz) / dt;
      }
      b.tx = x; b.tz = z; b.lastT = now;
    }
    for (const b of this.bullets.values()) if (!seenB.has(b.id)) { this.fxG.remove(b.g); this.bullets.delete(b.id); }

    for (const p of s.p) {
      const [slot, ax, az, fire, combo, wi] = p;
      const r = this.rigs.get(slot); if (!r) continue;
      r.aimX = ax; r.aimZ = az; r.firing = !!fire;
      this.setRigWeapon(r, wi);
    }
  }

  makeBullet(id, slot, wi, x, z, now) {
    const w = this.defs.weapons[wi];
    const col = hexColor(w.color);
    const g = new THREE.Group();
    const core = new THREE.Mesh(this.bulletGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const trail = new THREE.Mesh(this.trailGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    trail.scale.set(1, 1, 1.4);
    core.scale.setScalar(w.kind === 'explosive' ? 1.6 : 1);
    g.add(core, trail);
    this.fxG.add(g);
    const rr = this.rigs.get(slot);
    const ox = rr ? rr.targetX : 0, oz = this.defs.field.boatZ - 0.9;
    const dx = x - ox, dz = z - oz, len = Math.hypot(dx, dz) || 1;
    const b = { id, slot, w, g, trail, ox, oz, x, z, tx: x, tz: z, vx: dx / len * w.speed, vz: dz / len * w.speed, lastT: now, splashed: false };
    const r = this.rigs.get(slot);
    if (r) r.recoil = 1;
    this.onShot && this.onShot(slot, w);
    // muzzle puff
    this.sparks.emit(ox, 1.0, oz + 0.3, w.color, 5, { speed: 2, size: 0.4, life: 0.25, grav: 0 });
    return b;
  }

  // ------------------------------------------------ events
  handleEvents(evs) {
    for (const e of evs) {
      switch (e.k) {
        case 'h': {
          const f = this.fishes.get(e.f); if (!f) break;
          f.flash = 1;
          this.puffs.emit(f.x, f.y, f.z, '#ffffff', 3, { speed: 2, size: 0.25, life: 0.4, grav: 1.5 });
          const col = this.playerColor(e.s);
          this.sparks.emit(f.x, f.y, f.z, col, e.c ? 10 : 4, { speed: e.c ? 5 : 3, size: e.c ? 0.5 : 0.3, life: 0.3, grav: 0 });
          // Damage numbers: only your own hits, at most one per fish every 0.25s, crits always.
          const nowT = this.time;
          if (this.numbersOn && e.s === this.mySlot && (e.c || nowT - (f.lastNum || 0) > 0.25)) {
            f.lastNum = nowT;
            const v = e.d >= 10 ? Math.round(e.d) : Math.round(e.d * 10) / 10;
            this.floatText(f.x, f.y + 0.6, f.z, e.c ? `${v}!` : `${v}`, e.c ? 'crit' : 'dmg', null, 0.6);
          }
          break;
        }
        case 'k': this.onKill(e); break;
        case 'boom': this.explosion(e.x, e.z, e.r, this.playerColor(e.s)); break;
        case 'zap': this.zap(e.pts, this.playerColor(e.s)); break;
        case 'fx':
          if (e.fx === 'revive') this.sparks.emit(e.x, this.fishY, e.z, '#ffe8c4', 18, { speed: 3, size: 0.5, life: 0.6, grav: 0 });
          else if (e.fx === 'blink') this.sparks.emit(e.x, this.fishY - 0.9, e.z, '#c38bff', 40, { speed: 6, size: 0.6, life: 0.7, grav: 0 });
          else if (e.fx === 'enrage') { this.sparks.emit(e.x, this.fishY - 0.9, e.z, '#ff6b4a', 60, { speed: 7, size: 0.7, life: 0.8, grav: 0 }); this.addShake(0.6); }
          else if (e.fx === 'summon') this.puffs.emit(e.x, this.fishY, e.z, '#ffffff', 20, { speed: 3, size: 0.4, life: 0.8, grav: 2 });
          break;
        case 'clear': this.addShake(1); break;
      }
    }
  }

  playerColor(slot) { return (this.defs.colors[slot] || '#ffffff'); }

  onKill(e) {
    const f = this.fishes.get(e.f);
    const x = e.x, z = e.z, y = f ? f.y : this.fishY;
    if (f) { f.dying = 0.001; f.x = x; f.z = z; }
    const d = this.defs.fish[e.ty];
    const burst = d.boss ? 120 : 14;
    this.sparks.emit(x, y, z, d.tint || '#ffe45e', burst, { speed: d.boss ? 9 : 4, size: d.boss ? 0.8 : 0.45, life: 0.6, grav: 0 });
    this.puffs.emit(x, y, z, '#dff6ff', d.boss ? 60 : 8, { speed: 3, size: 0.45, life: 1, grav: 3 });
    if (d.boss) this.addShake(1.2);
    const multi = e.loot.length > 1;
    e.loot.forEach(([slot, coins, pct], i) => {
      const mine = slot === this.mySlot;
      const col = this.playerColor(slot);
      // Always show your own loot; teammates' only when it's worth noticing.
      if (coins > 0 && (mine || coins >= 5 || d.boss)) {
        const txt = multi ? `+${coins}<small> ${pct}%</small>` : `+${coins}`;
        this.floatText(x + (i - (e.loot.length - 1) / 2) * 1.2, y + 1.2, z, txt, 'loot' + (mine ? ' mine' : ''), col, 1.1);
      }
      const n = Math.min(d.boss ? 24 : 8, 1 + Math.floor(coins / 3));
      const r = this.rigs.get(slot);
      if (!r) return;
      for (let k = 0; k < n; k++) this.spawnCoin(x, y, z, r, mine, k * 0.04);
    });
  }

  spawnCoin(x, y, z, rig, mine, delay) {
    if (this.coins.length > 220) return;
    const m = new THREE.Mesh(this.coinGeo, this.coinMat);
    m.position.set(x, y, z); m.visible = false;
    this.fxG.add(m);
    const p0 = new THREE.Vector3(x + (Math.random() - 0.5) * 1.2, y, z + (Math.random() - 0.5) * 1.2);
    const p1 = new THREE.Vector3(x + (Math.random() - 0.5) * 3, 3.5 + Math.random() * 2, z + 2);
    this.coins.push({ m, p0, p1, rig, t: -delay, dur: 0.75 + Math.random() * 0.25, mine, spin: Math.random() * 6 });
  }

  explosion(x, z, r, col) {
    const y = this.fishY;
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    flash.position.set(x, y, z); this.fxG.add(flash);
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.position.set(x, y, z); this.fxG.add(ring);
    this.flashes.push({ m: flash, t: 0, dur: 0.35, r, kind: 'flash' }, { m: ring, t: 0, dur: 0.45, r, kind: 'ring' });
    this.sparks.emit(x, y, z, '#ff9b54', 40, { speed: 8, size: 0.6, life: 0.5, grav: 0 });
    this.puffs.emit(x, y, z, '#ffffff', 16, { speed: 4, size: 0.6, life: 1, grav: 3 });
    this.addShake(0.35);
    this.onBoom && this.onBoom();
  }

  zap(pts, col) {
    const y = this.fishY;
    for (let k = 0; k < 3; k++) {
      const v = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        for (let s = 0; s < 6; s++) {
          const t = s / 6;
          v.push(new THREE.Vector3(ax + (bx - ax) * t + (s ? (Math.random() - 0.5) * 0.6 : 0), y + (Math.random() - 0.5) * 0.4, az + (bz - az) * t + (s ? (Math.random() - 0.5) * 0.6 : 0)));
        }
      }
      const last = pts[pts.length - 1]; v.push(new THREE.Vector3(last[0], y, last[1]));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color: k ? col : 0xffffff, transparent: true, opacity: 1, depthTest: false, blending: THREE.AdditiveBlending }));
      line.renderOrder = 15; line.frustumCulled = false;
      this.fxG.add(line); this.zaps.push({ m: line, t: 0, dur: 0.28 });
    }
    for (const [x, z] of pts) this.sparks.emit(x, y, z, '#bff7ff', 6, { speed: 3, size: 0.4, life: 0.3, grav: 0 });
    this.onZap && this.onZap();
  }

  floatText(x, y, z, html, cls, color, dur) {
    if (this.texts.length > 70) { const o = this.texts.shift(); o.el.remove(); }
    const el = document.createElement('div');
    el.className = 'ft ' + cls; el.innerHTML = html;
    if (color) el.style.color = color;
    this.fxLayer.appendChild(el);
    this.texts.push({ el, p: new THREE.Vector3(x, y, z), t: 0, dur, jx: (Math.random() - 0.5) * 20 });
  }

  addShake(a) { if (this.shakeOn) this.shake = Math.min(1.5, this.shake + a); }

  // ------------------------------------------------ aiming
  pick(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.aimPlane, p)) return null;
    return { x: p.x, z: p.z };
  }

  setLocalAim(aim, show) {
    const r = this.rigs.get(this.mySlot);
    if (!aim || !show || !r) { this.reticle.visible = false; this.aimLine.visible = false; return; }
    this.reticle.visible = true;
    this.reticle.position.set(aim.x, this.fishY + 0.02, aim.z);
    this.reticle.material.color.set(this.playerColor(this.mySlot));
    const ox = r.g.position.x, oz = this.defs.field.boatZ - 0.9;
    const pos = this.aimLine.geometry.attributes.position;
    pos.setXYZ(0, ox, 0.9, oz); pos.setXYZ(1, aim.x, this.fishY, aim.z); pos.needsUpdate = true;
    this.aimLine.computeLineDistances();
    this.aimLine.material.color.set(this.playerColor(this.mySlot));
    this.aimLine.visible = true;
    r.aimX = aim.x; r.aimZ = aim.z; // immediate local feedback
  }

  // ------------------------------------------------ attract mode (menus)
  updateAttract(dt) {
    if (!this.attract) {
      if (this.attractFish.length) { this.attractFish.forEach(f => this.removeFish(f)); this.attractFish = []; }
      return;
    }
    if (this.attractFish.length < 14 && Math.random() < dt * 2) {
      const choices = [0, 1, 2, 4, 5, 6, 8, 9];
      const ty = choices[Math.floor(Math.random() * choices.length)];
      const f = this.makeFish(-1 - Math.floor(Math.random() * 1e9), ty);
      f.dir = Math.random() < 0.5 ? 1 : -1;
      f.x = f.tx = -f.dir * 20; f.z = f.tz = -10 + Math.random() * 13;
      f.vx = f.dir * this.defs.fish[ty].speed * 0.6; f.vz = 0; f.attract = true; f.base = f.z;
      this.fishes.set(f.id, f); this.attractFish.push(f);
    }
    for (let i = this.attractFish.length - 1; i >= 0; i--) {
      const f = this.attractFish[i];
      f.tx += f.vx * dt; f.tz = f.base + Math.sin(this.time + f.id) * 0.8; f.lastT = performance.now();
      if (Math.abs(f.tx) > 22) { this.removeFish(f); this.attractFish.splice(i, 1); }
    }
  }

  clearEntities() {
    for (const f of [...this.fishes.values()]) if (!f.attract) this.removeFish(f);
    for (const b of this.bullets.values()) this.fxG.remove(b.g);
    this.bullets.clear();
  }

  // ------------------------------------------------ frame
  update(dt) {
    this.time += dt;
    const t = this.time, now = performance.now();
    this.waterMat.uniforms.uTime.value = t;
    this.floorMat.uniforms.uTime.value = t;
    this.updateAttract(dt);

    // camera: ease between menu and game poses
    const pose = this.attract ? this.poses.menu : this.poses.game;
    const k = this.attract ? 1 : this.camDist;
    const ease = 1 - Math.exp(-dt * 2.5);
    tmpV.copy(pose.pos); tmpV.y *= k; tmpV.z = pose.pos.z * k - (k - 1) * 4;
    this.camPos.lerp(tmpV, ease); this.camTgt.lerp(pose.tgt, ease);
    this.camFov += (pose.fov - this.camFov) * ease;
    if (Math.abs(this.camera.fov - this.camFov) > 0.01) { this.camera.fov = this.camFov; this.camera.updateProjectionMatrix(); }
    const drift = this.attract ? Math.sin(t * 0.15) * 1.2 : 0;
    this.camera.position.set(this.camPos.x + drift, this.camPos.y, this.camPos.z);
    this.camera.lookAt(this.camTgt.x + drift * 0.3, this.camTgt.y, this.camTgt.z);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.2);
      const s = this.shake * this.shake * 0.5;
      this.camera.position.x += (Math.random() - 0.5) * s; this.camera.position.y += (Math.random() - 0.5) * s;
    }
    this.camera.updateMatrixWorld();
    const camQ = this.camera.quaternion;

    // weeds face the camera around Y
    const yaw = Math.atan2(this.camera.position.x, this.camera.position.z);
    this.weeds.children.forEach(m => { m.rotation.y = Math.atan2(this.camera.position.x - m.position.x, this.camera.position.z - m.position.z) * 0.9 + yaw * 0.1; m.userData.sway.uniforms.uTime.value = t; });

    // bubbles
    const bp = this.bubbles.geometry.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      let y = bp.getY(i) + this.bubbleSpeed[i] * dt;
      if (y > -0.2) y = SEABED_Y;
      bp.setY(i, y); bp.setX(i, bp.getX(i) + Math.sin(t * 2 + i) * dt * 0.2);
    }
    bp.needsUpdate = true;

    // fish
    const smooth = 1 - Math.exp(-dt * 14);
    for (const f of [...this.fishes.values()]) {
      const u = f.mat.uniforms;
      u.uTime.value = t;
      if (f.hpBar) f.hpBar.visible = false;
      if (f.dying) {
        f.dying += dt;
        const p = f.dying / 1.3;
        f.y += dt * 1.2; f.tilt += dt * 5;
        u.uOpacity.value = Math.max(0, 1 - p);
        f.mesh.position.set(f.x, f.y, f.z);
        f.mesh.quaternion.copy(camQ); f.mesh.rotateZ(Math.PI * Math.min(1, f.dying * 2) * (f.dir > 0 ? 1 : -1));
        f.shadow.material = this.shadowMat;
        if (p >= 1) this.removeFish(f);
        continue;
      }
      if (f.gone) {
        f.gone += dt; u.uOpacity.value = Math.max(0, 1 - f.gone * 2.5);
        f.x += f.dir * dt * 8;
        f.mesh.position.x = f.x;
        if (f.gone > 0.4) this.removeFish(f);
        continue;
      }
      const age = Math.min(0.15, (now - f.lastT) / 1000);
      const px = f.tx + f.vx * age, pz = f.tz + f.vz * age;
      f.x += (px - f.x) * smooth; f.z += (pz - f.z) * smooth;
      f.alpha = Math.min(1, f.alpha + dt * 3);
      const hidden = f.flags & 2;
      u.uOpacity.value = hidden ? 0.15 : f.alpha;
      u.uFlip.value = f.dir < 0 ? 1 : 0;
      f.flash = Math.max(0, f.flash - dt * 7); u.uFlash.value = f.flash * 0.8;
      u.uRage.value = f.flags & 4 ? 1 : 0;
      const bob = Math.sin(t * 2 + f.id) * 0.08;
      f.mesh.position.set(f.x, f.y + bob, f.z);
      const wantTilt = Math.max(-0.35, Math.min(0.35, -f.vz * 0.06 * f.dir));
      f.tilt += (wantTilt - f.tilt) * smooth;
      f.mesh.quaternion.copy(camQ); f.mesh.rotateZ(f.tilt);
      f.shadow.position.set(f.x, SEABED_Y + 0.03, f.z);
      // shield bubble for armored bosses
      if (f.flags & 1) {
        if (!f.shield) { f.shield = new THREE.Mesh(this.shieldGeo, new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.25, depthWrite: false })); this.fishG.add(f.shield); }
        f.shield.visible = true; f.shield.position.copy(f.mesh.position); f.shield.scale.setScalar(f.d.size * 0.55 + Math.sin(t * 8) * 0.05);
      } else if (f.shield) f.shield.visible = false;
      // HP bar for damaged non-boss fish. Both layers are transparent so they
      // sort together (opaque fill + transparent backing hid the fill before),
      // and each fish owns its fill material so the colour can follow its HP.
      if (!f.d.boss && f.hp < 1000) {
        if (!f.hpBar) {
          f.hpBar = new THREE.Group();
          const bg = new THREE.Mesh(this.hpGeo, new THREE.MeshBasicMaterial({ color: 0x06131e, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }));
          const fg = new THREE.Mesh(this.hpGeo, new THREE.MeshBasicMaterial({ color: 0x7ee081, transparent: true, depthTest: false, depthWrite: false }));
          bg.renderOrder = 40; fg.renderOrder = 41;
          f.hpBar.add(bg, fg); f.hpFg = fg; f.hpShown = f.hp / 1000;
          this.fishG.add(f.hpBar);
        }
        const w = Math.max(1.2, Math.min(2.6, f.d.size * 0.65));
        const frac = Math.max(0, f.hp / 1000);
        f.hpShown += (frac - f.hpShown) * Math.min(1, dt * 12);
        const bar = f.hpBar;
        bar.visible = !(f.flags & 2);
        bar.position.set(f.x, f.y + bob + f.d.size * this.spriteAspect(f.d.sprite) * 0.5 + 0.25, f.z);
        bar.quaternion.copy(camQ);
        bar.children[0].scale.set(w + 0.12, 0.28, 1);
        f.hpFg.scale.set(Math.max(0.001, w * f.hpShown), 0.17, 1);
        f.hpFg.position.x = -w * (1 - f.hpShown) / 2;
        f.hpFg.material.color.setHSL(0.33 * f.hpShown, 0.75, 0.55); // green -> yellow -> red
      }
    }

    // bullets
    for (const b of this.bullets.values()) {
      const age = Math.min(0.12, (now - b.lastT) / 1000);
      const px = b.tx + b.vx * age, pz = b.tz + b.vz * age;
      b.x += (px - b.x) * 0.6; b.z += (pz - b.z) * 0.6;
      const traveled = Math.hypot(b.x - b.ox, b.z - b.oz);
      const y = this.fishY + (1.0 - this.fishY) * Math.max(0, 1 - traveled / 4.5);
      if (!b.splashed && y < 0.05) { b.splashed = true; this.puffs.emit(b.x, 0.05, b.z, '#ffffff', 4, { speed: 1.5, size: 0.35, life: 0.35, grav: -4, up: 1.5 }); }
      b.g.position.set(b.x, y, b.z);
      tmpV.set(b.x - b.vx, y + (y > this.fishY + 0.01 ? 1.2 : 0), b.z - b.vz);
      b.g.lookAt(tmpV);
    }

    // boats
    for (const r of this.rigs.values()) {
      r.g.position.x += (r.targetX - r.g.position.x) * (1 - Math.exp(-dt * 4));
      const x = r.g.position.x, z = r.g.position.z;
      r.g.position.y = waveHeight(x, z, t) - 0.05;
      r.g.rotation.z = (waveHeight(x + 1, z, t) - waveHeight(x - 1, z, t)) * 0.35;
      r.g.rotation.x = (waveHeight(x, z + 1, t) - waveHeight(x, z - 1, t)) * -0.35;
      const dx = r.aimX - x, dz = r.aimZ - z;
      const want = Math.atan2(dx, dz); // Kenney characters face +Z, so this turns them toward the aim point
      let cur = r.ch.rotation.y;
      let diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
      r.ch.rotation.y = cur + diff * Math.min(1, dt * 12);
      if (r.mixer) {
        const shooting = r.firing && r.slot >= 0;
        if (shooting && !r.shoot.isRunning()) { r.shoot.reset().fadeIn(0.1).play(); r.idle.fadeOut(0.1); }
        if (!shooting && r.shoot.isRunning()) { r.idle.reset().fadeIn(0.2).play(); r.shoot.fadeOut(0.2); }
        r.mixer.update(dt);
      }
      r.recoil = Math.max(0, r.recoil - dt * 8);
      if (r.blaster) r.blaster.position.z = 0.2 - r.recoil * 0.03;
      r.flag.rotation.y = Math.sin(t * 3 + r.slot) * 0.25;
      this.project(tmpV.set(x, 2.9 + r.deckY, z), r.label, -0.5);
    }
    if (this.windmill) this.windmill.rotation.z = 0;

    // coins fly home
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      c.t += dt;
      if (c.t < 0) continue;
      c.m.visible = true;
      const p = Math.min(1, c.t / c.dur);
      const e = p * p * (3 - 2 * p);
      const target = tmpV.set(c.rig.g.position.x, 1.6 + c.rig.deckY, c.rig.g.position.z);
      const a = c.p0, m = c.p1;
      const ix = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * m.x + e * e * target.x;
      const iy = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * m.y + e * e * target.y;
      const iz = (1 - e) * (1 - e) * a.z + 2 * (1 - e) * e * m.z + e * e * target.z;
      c.m.position.set(ix, iy, iz);
      c.m.rotation.y = c.spin + t * 10;
      if (p >= 1) {
        this.fxG.remove(c.m); this.coins.splice(i, 1);
        this.sparks.emit(ix, iy, iz, '#ffd84a', 2, { speed: 1.5, size: 0.3, life: 0.3, grav: 0 });
        if (c.mine && this.onCoin) this.onCoin();
      }
    }

    // explosion flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]; f.t += dt; const p = f.t / f.dur;
      if (p >= 1) { this.fxG.remove(f.m); f.m.material.dispose(); this.flashes.splice(i, 1); continue; }
      if (f.kind === 'flash') f.m.scale.setScalar(f.r * (0.3 + 0.7 * p));
      else f.m.scale.setScalar(f.r * (0.3 + 0.9 * p));
      f.m.material.opacity = 0.9 * (1 - p);
    }
    for (let i = this.zaps.length - 1; i >= 0; i--) {
      const z = this.zaps[i]; z.t += dt;
      z.m.material.opacity = 1 - z.t / z.dur;
      if (z.t >= z.dur) { this.fxG.remove(z.m); z.m.geometry.dispose(); this.zaps.splice(i, 1); }
    }
    this.sparks.update(dt); this.puffs.update(dt);

    // floating texts
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const tx = this.texts[i]; tx.t += dt; const p = tx.t / tx.dur;
      if (p >= 1) { tx.el.remove(); this.texts.splice(i, 1); continue; }
      this.project(tx.p, tx.el, -0.5, -p * 50, tx.jx * p, p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3, p < 0.12 ? 0.6 + p * 3.3 : 1);
    }

    this.renderer.render(this.scene, this.camera);
  }

  project(v, el, ax = -0.5, oy = 0, ox = 0, op = 1, sc = 1) {
    tmpV.copy(v).project(this.camera);
    if (tmpV.z > 1) { el.style.opacity = 0; return; }
    const x = (tmpV.x * 0.5 + 0.5) * window.innerWidth + ox;
    const y = (-tmpV.y * 0.5 + 0.5) * window.innerHeight + oy;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${sc})`;
    el.style.opacity = op;
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
