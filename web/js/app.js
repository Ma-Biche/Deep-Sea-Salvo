import { World, escapeHtml } from './scene.js';
import { sfx } from './sfx.js';

const $ = id => document.getElementById(id);
const S = {
  defs: null, me: null, god: false, token: localStorage.getItem('dss_token'), ws: null, opened: false, kicked: false,
  room: null, slot: -1, roster: [], offer: null, aim: null, down: false, autofire: false,
  sent: { x: 0, z: 0, f: false, t: 0 }, zone: -1, lastCoins: null, combo: 0, comboT: 0, pendingBuy: null, shopTab: 'weapons',
  settings: Object.assign({ volume: 0.6, shake: true, numbers: true }, JSON.parse(localStorage.getItem('dss_settings') || '{}')),
};
let world;

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    S.defs = await (await fetch('api/defs')).json();
  } catch (e) {
    $('load-text').textContent = 'The server is not reachable. Start it with "go run ." and reload.';
    return;
  }
  world = new World($('world'), $('fx-layer'));
  window.__world = world; // handy for debugging in the console
  world.onShot = (slot, w) => { if (slot === S.slot) sfx.shoot(w.kind); };
  world.onBoom = () => sfx.boom();
  world.onZap = () => sfx.zap();
  world.onCoin = () => { const el = document.querySelector('.purse'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); };
  applySettings();
  try {
    await world.load(S.defs, p => { $('load-fill').style.width = `${Math.round(p * 100)}%`; });
  } catch (e) {
    console.error(e);
    $('load-text').textContent = 'Some assets failed to load. Check the browser console, then reload.';
    return;
  }
  let last = performance.now();
  const frame = now => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    tickUi(dt);
    world.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  hide('screen-loading');
  if (S.token) connect(); else show('screen-auth');
  bindUi();
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ------------------------------------------------------------------ auth
async function auth(mode) {
  const name = $('auth-name').value.trim(), pass = $('auth-pass').value;
  $('auth-error').textContent = '';
  try {
    const res = await fetch(`api/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Name: name, Pass: pass }) });
    const j = await res.json();
    if (!res.ok) { $('auth-error').textContent = j.error || 'Sign-in failed.'; return; }
    S.token = j.token; localStorage.setItem('dss_token', j.token);
    connect();
  } catch (e) {
    $('auth-error').textContent = 'The server is not reachable.';
  }
}

// ------------------------------------------------------------------ network
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws?token=${encodeURIComponent(S.token)}`);
  S.ws = ws; S.opened = false; S.kicked = false;
  ws.onopen = () => { S.opened = true; };
  ws.onmessage = ev => { try { dispatch(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null;
    if (!S.opened) { // token rejected
      localStorage.removeItem('dss_token'); S.token = null;
      hideAllScreens(); show('screen-auth');
      $('auth-error').textContent = 'Please log in again.';
      return;
    }
    leaveGameView();
    openModal('lost');
    if (S.kicked) $('lost-msg').textContent = 'You signed in from another tab or device.';
  };
}
function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
setInterval(() => send({ t: 'ping', c: performance.now() }), 15000);

function dispatch(m) {
  switch (m.t) {
    case 'hello':
      S.me = m.me; showLobby(); break;
    case 'me': {
      const prev = S.me;
      S.me = m.me; S.god = !!m.god;
      if (prev && m.me.level > prev.level) { sfx.levelUp(); toast(`Level ${m.me.level}!`, 'good'); }
      renderMe(); break;
    }
    case 'joined':
      S.room = m.code; S.slot = m.slot; S.zone = -1;
      enterGameView(); break;
    case 'joinError': $('join-error').textContent = m.msg; break;
    case 'room':
      S.roster = m.players; world.setRoster(m.players, S.slot); renderRoster(); break;
    case 's':
      if (!S.room) break;
      world.applySnapshot(m, performance.now());
      if (m.ev) { world.handleEvents(m.ev); uiEvents(m.ev); }
      renderStatus(m.st);
      for (const p of m.p) if (p[0] === S.slot) { if (p[4] > S.combo) S.comboT = 2; S.combo = p[4]; }
      break;
    case 'offer': S.offer = m.ids.length ? m : null; renderSkills(); break;
    case 'toast': toast(m.msg, m.kind); break;
    case 'redeem':
      $('redeem-msg').textContent = m.msg; $('redeem-msg').className = m.ok ? 'good' : 'error';
      if (m.ok) sfx.fanfare();
      break;
    case 'summary': showSummary(m.s); break;
    case 'left': S.me = m.me; leaveGameView(); showLobby(); break;
    case 'kicked': S.kicked = true; break;
  }
}

// ------------------------------------------------------------------ screens
function hideAllScreens() { ['screen-auth', 'screen-lobby', 'hud'].forEach(hide); }

function showLobby() {
  hideAllScreens(); show('screen-lobby');
  world.attract = true;
  world.setPreview(S.me);
  renderMe();
}

function enterGameView() {
  closeModal();
  hideAllScreens(); show('hud');
  world.attract = false; world.clearEntities(); world.setPreview(null);
  $('room-code-val').textContent = S.room;
  S.offer = null; renderSkills();
  renderMe();
}

function leaveGameView() {
  S.room = null; S.slot = -1; S.down = false; S.autofire = false; S.offer = null;
  world.setRoster([], -1); world.clearEntities(); world.setLocalAim(null, false);
  hide('skill-tray'); hide('autofire-pill');
}

// ------------------------------------------------------------------ rendering
const STAT_NAMES = { attackSpeed: 'fire rate', damage: 'damage', range: 'range', critChance: 'crit chance', projectileSpeed: 'shot speed', coinBonus: 'coins', xpBonus: 'XP' };
function buffText(buffs) {
  return Object.entries(buffs || {}).map(([k, v]) => `+${Math.round(v * 100)}% ${STAT_NAMES[k] || k}`).join(', ');
}
function thumb(id) { return `assets/thumbs/${id}-thumb.png`; }
function weaponOwned(id) { return S.me.weapons.includes(id) || S.god; }

function renderMe() {
  const me = S.me; if (!me) return;
  $('lobby-name').textContent = me.name;
  $('lobby-level').textContent = me.level;
  $('lobby-coins').textContent = me.coins.toLocaleString();
  $('lobby-best').textContent = me.bestScore.toLocaleString();
  $('lobby-avatar').src = thumb(me.char);
  $('pick-char').innerHTML = S.defs.chars.map(c => `<button class="tile ${c === me.char ? 'on' : ''}" data-char="${c}" aria-label="${c}"><img src="${thumb(c)}" alt=""></button>`).join('');
  $('pick-boat').innerHTML = S.defs.boats.map(b => {
    const owned = me.boats.includes(b.id);
    const price = owned ? '' : `<span class="price">${S.pendingBuy === b.id ? 'Tap to buy' : b.cost.toLocaleString()}</span>`;
    return `<button class="tile ${b.id === me.boat ? 'on' : ''}" data-boat="${b.id}" title="${escapeHtml(b.name)}: ${buffText(b.buffs)}"><img src="${thumb(b.id)}" alt="${escapeHtml(b.name)}">${price}</button>`;
  }).join('');
  const cur = S.defs.boats.find(b => b.id === me.boat);
  $('boat-buff').textContent = cur ? `${cur.name}: ${buffText(cur.buffs)}` : '';
  if (me.pendingPicks > 0) { $('lobby-picks').textContent = `You have ${me.pendingPicks} upgrade pick${me.pendingPicks > 1 ? 's' : ''} waiting. Start a room to choose.`; show('lobby-picks'); }
  else hide('lobby-picks');
  if (!S.room) world.setPreview(me);
  // HUD
  const coinsEl = $('hud-coins');
  coinsEl.textContent = me.coins.toLocaleString();
  $('hud-level').textContent = me.level;
  $('hud-xp').style.width = `${Math.min(100, me.xp / me.nextXP * 100)}%`;
  $('god-pill').classList.toggle('hidden', !S.god);
  $('god-row').classList.toggle('hidden', !me.godUnlocked);
  $('set-god').checked = me.godOn;
  renderWeaponBar();
  if (!$('modal').classList.contains('hidden') && $('modal-armory').classList.contains('on')) renderShop();
}

function renderWeaponBar() {
  $('weapon-bar').innerHTML = S.defs.weapons.map((w, i) => {
    const owned = weaponOwned(w.id);
    return `<button class="wslot ${S.me.weapon === w.id ? 'on' : ''} ${owned ? '' : 'locked'}" data-weapon="${w.id}" title="${escapeHtml(w.name)}">
      <span class="k">${i + 1}</span><img src="${thumb(w.model)}" alt="${escapeHtml(w.name)}">${owned ? '' : `<span class="cost">${w.cost.toLocaleString()}</span>`}</button>`;
  }).join('');
}

function renderRoster() {
  const total = S.roster.reduce((a, p) => a + p.dmg, 0) || 1;
  $('roster').innerHTML = S.roster.map(p => `<li class="${p.slot === S.slot ? 'me' : ''}" style="--c:${p.color}">
      <span class="flag"></span>
      <span class="nm">${escapeHtml(p.name)}${p.god ? ' (god)' : ''}<small>Lv ${p.level}, ${p.kills} kills, ${p.coins} coins</small></span>
      <span class="sc">${p.score.toLocaleString()}<small>${Math.round(p.dmg / total * 100)}% dmg</small></span></li>`).join('');
}

function renderStatus(st) {
  if (!st) return;
  if (st.z !== S.zone) {
    if (S.zone !== -1) zoneTransition(st.z);
    else world.setZone(st.z);
    S.zone = st.z;
  }
  const z = S.defs.zones[st.z];
  const inBoss = st.boss && (st.ph === 'boss' || st.ph === 'clear');
  $('boss-card').classList.toggle('hidden', !inBoss);
  $('zone-card').classList.toggle('hidden', !!inBoss);
  if (inBoss) {
    const b = S.defs.fish[st.boss.ty];
    $('boss-name').textContent = b.title;
    $('boss-fill').style.width = `${st.boss.hp / 10}%`;
    $('boss-share').innerHTML = st.boss.share.map(([slot, pm]) => `<span style="width:${pm / 10}%;background:${S.defs.colors[slot]}"></span>`).join('');
  } else {
    $('zone-name').textContent = st.lp ? `${z.name} (tide ${st.lp + 1})` : z.name;
    $('zone-fill').style.width = `${st.pr / 10}%`;
    $('zone-sub').textContent = st.ph === 'warn' ? 'The boss is surfacing!' : st.ph === 'clear' ? 'Zone cleared' : `Boss surfaces at 100% (${Math.floor(st.pr / 10)}%)`;
  }
  if (st.ev) {
    const e = S.defs.events.find(x => x.id === st.ev[0]);
    $('event-text').textContent = `${e.name}: ${st.ev[1]}s`;
    show('event-pill');
  } else hide('event-pill');
}

function renderSkills() {
  if (!S.offer) { hide('skill-tray'); return; }
  show('skill-tray');
  $('skill-left').textContent = S.offer.left > 1 ? `(${S.offer.left} picks)` : '';
  $('skill-cards').innerHTML = S.offer.ids.map(id => {
    const s = S.defs.skills.find(x => x.id === id);
    const cur = Math.round((S.me.skills[id] || 0) * 100);
    return `<button class="skill" data-skill="${id}"><i class="ico" style="--i:url(assets/icons/${s.icon}.png)"></i><b>${escapeHtml(s.name)}</b><small>${escapeHtml(s.desc)}</small><small>Now +${cur}%</small></button>`;
  }).join('');
}

function renderShop() {
  const me = S.me;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === S.shopTab));
  if (S.shopTab === 'weapons') {
    $('shop-list').innerHTML = S.defs.weapons.map(w => {
      const owned = me.weapons.includes(w.id);
      const rate = (1000 / w.fireRate).toFixed(1);
      const dps = Math.round(w.damage * (w.kind === 'spread' ? 3 : 1) * 1000 / w.fireRate);
      const extra = w.kind === 'explosive' ? `, blast radius ${w.radius}` : w.kind === 'pierce' ? `, pierces ${w.pierce}` : w.kind === 'chain' ? `, arcs to ${w.chain}` : w.kind === 'homing' ? ', homing' : '';
      const btn = owned ? (me.weapon === w.id ? `<button class="btn" disabled>Equipped</button>` : `<button class="btn lagoon" data-equip-weapon="${w.id}">Equip</button>`)
        : `<button class="btn brass" data-buy-weapon="${w.id}" ${me.coins < w.cost ? 'disabled' : ''}>Buy ${w.cost.toLocaleString()}</button>`;
      return `<div class="item ${owned ? 'owned' : ''}"><img src="${thumb(w.model)}" alt=""><div><h4>${escapeHtml(w.name)}</h4><p>${escapeHtml(w.desc)}</p>
        <p class="spec">${dps} damage/s${w.kind === 'spread' ? ' if all 3 hit' : ''}: ${w.damage} per hit, ${rate} shots/s${extra}</p></div>${btn}</div>`;
    }).join('');
  } else {
    $('shop-list').innerHTML = S.defs.boats.map(b => {
      const owned = me.boats.includes(b.id);
      const btn = owned ? (me.boat === b.id ? `<button class="btn" disabled>In use</button>` : `<button class="btn lagoon" data-equip-boat="${b.id}">Use</button>`)
        : `<button class="btn brass" data-buy-boat="${b.id}" ${me.coins < b.cost ? 'disabled' : ''}>Buy ${b.cost.toLocaleString()}</button>`;
      return `<div class="item ${owned ? 'owned' : ''}"><img src="${thumb(b.id)}" alt=""><div><h4>${escapeHtml(b.name)}</h4><p class="buff">${buffText(b.buffs)}</p><p class="spec">Stacks with your upgrade picks.</p></div>${btn}</div>`;
    }).join('');
  }
}

function showSummary(s) {
  const cells = [['Score', s.score], ['Coins', s.coins], ['Kills', s.kills], ['Damage', s.damage], ['XP', s.xp], ['Best combo', s.bestCombo]];
  $('summary-body').innerHTML = cells.map(([k, v]) => `<div><b>${Number(v).toLocaleString()}</b><span>${k}</span></div>`).join('');
  openModal('summary');
}

// ------------------------------------------------------------------ game events → UI
function uiEvents(evs) {
  for (const e of evs) {
    switch (e.k) {
      case 'k': {
        const mine = e.loot.some(l => l[0] === S.slot && l[1] > 0);
        sfx.kill(mine);
        break;
      }
      case 'h': if (e.s === S.slot) sfx.hit(!!e.c); break;
      case 'event': {
        const d = S.defs.events.find(x => x.id === e.id);
        banner(d.name, d.desc); sfx.event(); break;
      }
      case 'bossWarn': {
        const b = S.defs.fish[e.ty];
        banner(`${b.title} approaches`, 'Every hit counts toward your share of its hoard.', true, 3200);
        sfx.horn(); world.addShake(0.8); break;
      }
      case 'bossFlee': toast(`${S.defs.fish[e.ty].title} is fleeing. Finish it fast!`, 'bad'); break;
      case 'escaped': toast(`${S.defs.fish[e.ty].title} escaped. The zone meter dropped to half.`, 'bad'); break;
      case 'clear': banner('Zone cleared!', `+${e.bonus} coins each. Next: ${e.next}`, false, 3500); sfx.fanfare(); break;
      case 'join': if (e.s !== S.slot) toast(`${escapeHtml(e.n)} joined the crew.`); break;
      case 'leave': toast(`${escapeHtml(e.n)} left.`); break;
    }
  }
}

function zoneTransition(z) {
  const cover = document.createElement('div');
  cover.style.cssText = 'position:fixed;inset:0;background:#062033;z-index:15;opacity:0;transition:opacity .6s;pointer-events:none';
  document.body.appendChild(cover);
  requestAnimationFrame(() => { cover.style.opacity = 1; });
  setTimeout(() => {
    world.setZone(z); world.clearEntities();
    banner(S.defs.zones[z].name, 'New waters, tougher fish, better loot.', false, 3000);
    cover.style.opacity = 0;
    setTimeout(() => cover.remove(), 700);
  }, 650);
}

let bannerTimer;
function banner(title, sub, danger = false, ms = 2600) {
  $('banner-title').textContent = title; $('banner-sub').textContent = sub || '';
  const b = $('banner');
  b.classList.toggle('danger', danger);
  b.classList.remove('hidden'); b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => hide('banner'), ms);
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

// ------------------------------------------------------------------ modals
function openModal(view) {
  show('modal');
  document.querySelectorAll('.mview').forEach(v => v.classList.toggle('on', v.id === `modal-${view}`));
  if (view === 'armory') renderShop();
  if (view === 'redeem') { $('redeem-msg').textContent = ''; $('redeem-input').value = ''; setTimeout(() => $('redeem-input').focus(), 30); }
  if (view === 'settings') { $('set-volume').value = S.settings.volume; $('set-shake').checked = S.settings.shake; $('set-numbers').checked = S.settings.numbers; }
  S.down = false;
}
function closeModal() { hide('modal'); }

function applySettings() {
  sfx.setVolume(S.settings.volume);
  world.shakeOn = S.settings.shake; world.numbersOn = S.settings.numbers;
  localStorage.setItem('dss_settings', JSON.stringify(S.settings));
}

// ------------------------------------------------------------------ input
function bindUi() {
  $('auth-form').addEventListener('submit', e => { e.preventDefault(); sfx.unlock(); auth('login'); });
  $('auth-register').addEventListener('click', () => { sfx.unlock(); auth('register'); });
  $('btn-create').addEventListener('click', () => { sfx.unlock(); sfx.click(); $('join-error').textContent = ''; send({ t: 'create' }); });
  const join = () => { sfx.unlock(); const code = $('join-code').value.trim().toUpperCase(); if (code.length !== 5) { $('join-error').textContent = 'Room codes have 5 characters.'; return; } send({ t: 'join', code }); };
  $('btn-join').addEventListener('click', join);
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  $('btn-logout').addEventListener('click', () => { localStorage.removeItem('dss_token'); S.token = null; const ws = S.ws; S.ws = null; if (ws) ws.close(); world.setPreview(null); hideAllScreens(); show('screen-auth'); });
  $('btn-leave').addEventListener('click', () => { send({ t: 'leave' }); closeModal(); });
  $('btn-reconnect').addEventListener('click', () => { closeModal(); connect(); });
  $('room-code').addEventListener('click', () => { navigator.clipboard?.writeText(S.room).then(() => toast('Room code copied. Send it to your crew.', 'good')).catch(() => toast(`Room code: ${S.room}`)); });

  document.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    const d = t.dataset;
    if (d.open) { openModal(d.open); sfx.click(); }
    else if ('close' in d) closeModal();
    else if (d.tab) { S.shopTab = d.tab; renderShop(); }
    else if (d.char) { send({ t: 'equip', kind: 'char', id: d.char }); sfx.click(); }
    else if (d.boat) {
      if (S.me.boats.includes(d.boat)) { send({ t: 'equip', kind: 'boat', id: d.boat }); S.pendingBuy = null; }
      else if (S.pendingBuy === d.boat) { send({ t: 'buy', kind: 'boat', id: d.boat }); S.pendingBuy = null; }
      else { S.pendingBuy = d.boat; renderMe(); }
      sfx.click();
    }
    else if (d.weapon) equipWeapon(d.weapon);
    else if (d.buyWeapon) send({ t: 'buy', kind: 'weapon', id: d.buyWeapon });
    else if (d.buyBoat) send({ t: 'buy', kind: 'boat', id: d.buyBoat });
    else if (d.equipWeapon) send({ t: 'equip', kind: 'weapon', id: d.equipWeapon });
    else if (d.equipBoat) send({ t: 'equip', kind: 'boat', id: d.equipBoat });
    else if (d.skill) { send({ t: 'skill', id: d.skill }); S.offer = null; renderSkills(); sfx.levelUp(); }
  });
  $('modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });
  $('redeem-form').addEventListener('submit', e => { e.preventDefault(); send({ t: 'redeem', code: $('redeem-input').value }); });
  $('set-volume').addEventListener('input', e => { S.settings.volume = +e.target.value; applySettings(); });
  $('set-shake').addEventListener('change', e => { S.settings.shake = e.target.checked; applySettings(); });
  $('set-numbers').addEventListener('change', e => { S.settings.numbers = e.target.checked; applySettings(); });
  $('set-god').addEventListener('change', e => send({ t: 'god', on: e.target.checked }));

  const canvas = $('world');
  const aimAt = e => { const a = world.pick(e.clientX, e.clientY); if (a) S.aim = a; };
  canvas.addEventListener('pointerdown', e => { sfx.unlock(); if (!S.room) return; aimAt(e); S.down = true; canvas.setPointerCapture?.(e.pointerId); });
  canvas.addEventListener('pointermove', e => { if (S.room) aimAt(e); });
  const up = () => { S.down = false; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); window.addEventListener('blur', up);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') { if (!$('modal').classList.contains('hidden')) closeModal(); else if (S.room) openModal('menu'); return; }
    if (!S.room) return;
    if (e.code === 'Space') { e.preventDefault(); S.autofire = !S.autofire; $('autofire-pill').classList.toggle('hidden', !S.autofire); return; }
    if (e.key === 'm' || e.key === 'M') { toast(sfx.toggleMute() ? 'Sound off' : 'Sound on'); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= S.defs.weapons.length) equipWeapon(S.defs.weapons[n - 1].id);
  });
}

function equipWeapon(id) {
  if (weaponOwned(id)) { send({ t: 'equip', kind: 'weapon', id }); sfx.click(); return; }
  const w = S.defs.weapons.find(x => x.id === id);
  toast(`${escapeHtml(w.name)} is locked. It costs ${w.cost.toLocaleString()} coins in the Armory.`);
  S.shopTab = 'weapons'; openModal('armory');
}

// Runs every frame: sends aim at up to 20 Hz, drives local aim visuals.
function tickUi(dt) {
  if (!S.room) return;
  const now = performance.now();
  const firing = S.autofire || (S.down && $('modal').classList.contains('hidden'));
  const aim = S.aim || { x: 0, z: -4 };
  world.setLocalAim(aim, true);
  const moved = Math.abs(aim.x - S.sent.x) + Math.abs(aim.z - S.sent.z) > 0.08;
  if (now - S.sent.t > 50 && (moved || firing !== S.sent.f || now - S.sent.t > 400)) {
    send({ t: 'aim', x: +aim.x.toFixed(2), z: +aim.z.toFixed(2), f: firing });
    S.sent = { x: aim.x, z: aim.z, f: firing, t: now };
  }
  // combo meter
  S.comboT = Math.max(0, S.comboT - dt);
  const c = S.combo;
  $('combo').classList.toggle('on', c >= 3);
  $('combo-n').textContent = c;
  $('combo-m').textContent = (1 + Math.min(c, 100) * 0.02).toFixed(1);
  $('combo-fill').style.width = `${S.comboT / 2 * 100}%`;
}

boot();
