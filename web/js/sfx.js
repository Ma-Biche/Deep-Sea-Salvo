// Procedural sound: no audio assets needed. Every sound is a few oscillators
// or filtered noise with an envelope, throttled so rapid fire stays pleasant.
let ctx = null, master = null, noiseBuf = null, ambient = null;
let volume = 0.6, muted = false;
const last = {};

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

function throttle(key, ms) {
  const now = performance.now();
  if (last[key] && now - last[key] < ms) return false;
  last[key] = now;
  return true;
}

function env(g, t, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
}

function tone(type, f0, f1, dur, peak = 0.2, delay = 0) {
  if (!ensure()) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, 0.005, peak, dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise(dur, freq, q = 1, peak = 0.2, type = 'lowpass', delay = 0) {
  if (!ensure()) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, 0.005, peak, dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
}

const shotPitch = { normal: 520, spread: 440, homing: 700, explosive: 180, pierce: 900, chain: 1200 };

export const sfx = {
  unlock() { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); this.startAmbient(); },
  setVolume(v) { volume = v; if (master) master.gain.value = muted ? 0 : v; },
  toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : volume; return muted; },
  get muted() { return muted; },
  shoot(kind) {
    if (!throttle('shoot', 55)) return;
    const f = shotPitch[kind] || 520;
    tone('square', f, f * 0.45, 0.07, 0.05);
    noise(0.05, 2500, 0.7, 0.04, 'highpass');
  },
  hit(crit) {
    if (!throttle('hit', 35)) return;
    tone('triangle', crit ? 1400 : 800 + Math.random() * 200, 300, 0.06, crit ? 0.1 : 0.05);
  },
  kill(mine) {
    if (!throttle('kill', 40)) return;
    tone('sine', 300, 900, 0.12, 0.12); // bubble pop
    if (mine) { tone('triangle', 1318, 0, 0.12, 0.08, 0.04); tone('triangle', 1975, 0, 0.18, 0.07, 0.1); }
  },
  boom() { if (!throttle('boom', 80)) return; noise(0.45, 600, 0.8, 0.35); tone('sine', 120, 40, 0.4, 0.3); },
  zap() { if (!throttle('zap', 60)) return; tone('sawtooth', 1800, 200, 0.14, 0.06); noise(0.1, 4000, 2, 0.05, 'bandpass'); },
  levelUp() { [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, 0, 0.2, 0.12, i * 0.08)); },
  horn() { tone('sawtooth', 98, 92, 1.4, 0.14); tone('sawtooth', 147, 139, 1.4, 0.08); noise(1.2, 300, 1, 0.08); },
  fanfare() { [392, 523, 659, 784, 659, 1047].forEach((f, i) => tone('square', f, 0, 0.18, 0.06, i * 0.11)); },
  click() { tone('triangle', 900, 500, 0.04, 0.05); },
  event() { tone('triangle', 660, 0, 0.12, 0.09); tone('triangle', 990, 0, 0.2, 0.09, 0.12); },
  splash() { if (!throttle('splash', 90)) return; noise(0.12, 1400, 0.8, 0.03, 'bandpass'); },
  startAmbient() {
    if (!ctx || ambient) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = ctx.createGain(); g.gain.value = 0.035;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.12; lg.gain.value = 0.02;
    lfo.connect(lg).connect(g.gain);
    s.connect(f).connect(g).connect(master);
    s.start(); lfo.start();
    ambient = s;
  },
};
