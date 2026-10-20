import * as M from './model.js';
import { Stage, buildBody, buildRig, poseModel, loadSkin, fallbackColor, textures, THREE } from './scene.js';
import { icon } from './icons.js';
import yaml from '../vendor/js-yaml.mjs';

const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k === 'class' ? e.className = v : e.setAttribute(k, v); e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const deg = r => r * 180 / Math.PI;
const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 10000) / 10000;
const STORE = 'psmpAnimator.v1';
const TRACK_ICON = { root: 'arrows-move', head: 'user', torso: 'box', arm_r: 'chevron-right', arm_l: 'chevron-left', leg_r: 'chevron-right', leg_l: 'chevron-left' };
const TRACK_LABEL = { root: 'Root (whole body)', head: 'Head', torso: 'Torso', arm_r: 'Right arm', arm_l: 'Left arm', leg_r: 'Right leg', leg_l: 'Left leg' };
const COMMON_IDS = ['white_concrete', 'black_concrete', 'red_concrete', 'blue_concrete', 'light_blue_concrete', 'purple_concrete', 'magenta_concrete', 'yellow_concrete', 'lime_concrete', 'orange_concrete', 'glass', 'white_stained_glass', 'light_blue_stained_glass', 'purple_stained_glass', 'red_stained_glass', 'sea_lantern', 'glowstone', 'shroomlight', 'obsidian', 'crying_obsidian', 'end_rod', 'amethyst_block', 'diamond_block', 'gold_block', 'iron_block', 'netherite_block', 'redstone_block', 'lapis_block', 'emerald_block', 'quartz_block', 'stone', 'oak_planks', 'magma_block', 'blackstone', 'deepslate', 'tnt', 'beacon',
  'diamond_sword', 'netherite_sword', 'iron_sword', 'trident', 'bow', 'blaze_rod', 'stick', 'nether_star', 'ender_pearl', 'ender_eye', 'heart_of_the_sea', 'totem_of_undying', 'fire_charge', 'snowball', 'feather', 'amethyst_shard', 'echo_shard', 'compass', 'clock', 'book', 'paper', 'arrow', 'spectral_arrow'];

// ------------------------------------------------------------------ state
let store = { projects: {}, current: null, settings: { skin: '', arms: 'auto', onion: false, loop: true, zoom: 14, gizmo: 'rotate', space: 'local' } };
let P = null;
let tick = 0, playing = false, playStart = 0, playFrom = 0, speed = 1;
let sel = null;            // selected track name
let selKeys = new Set();   // `${track}@${t}`
let clipboard = null;
const undoStack = [], redoStack = [];
let skin = null, stage, ghostModels = [], dragSnap = false;

function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && s.projects) store = { ...store, ...s, settings: { ...store.settings, ...s.settings } }; } catch { }
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  $('#savedState').textContent = 'Saving…';
  saveTimer = setTimeout(() => {
    if (P) { store.projects[P.id] = P; store.current = P.id; }
    try { localStorage.setItem(STORE, JSON.stringify(store)); $('#savedState').textContent = 'Saved in this browser'; }
    catch (e) { $('#savedState').textContent = 'Not saved: ' + e.message; }
  }, 250);
}

// ------------------------------------------------------------------ helpers
const T = n => M.track(P, n);
const body = () => P.kind === 'body';
const itick = () => Math.max(0, Math.min(P.length, Math.round(tick)));
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast' + (err ? ' err' : ''), err ? 4200 : 2200);
  $('#status').textContent = msg;
}
function snapshot() { undoStack.push(JSON.stringify(P)); if (undoStack.length > 150) undoStack.shift(); redoStack.length = 0; updateUndo(); }
function commit(fn, structural = false) { snapshot(); fn(); changed(structural); }
function changed(structural = false) {
  if (structural) rebuildModel();
  pose(); renderOutliner(); renderInspector(); renderTimeline(); save();
}
function updateUndo() { $('#undoBtn').disabled = !undoStack.length; $('#redoBtn').disabled = !redoStack.length; }
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(P)); restore(undoStack.pop()); toast('Undone'); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(P)); restore(redoStack.pop()); toast('Redone'); }
function restore(json) {
  const was = P.id, n = JSON.parse(json);
  if (n.id !== was) delete store.projects[was];
  P = n; if (sel && !T(sel)) sel = null; selKeys.clear(); tick = Math.min(tick, P.length);
  updateUndo(); changed(true); renderTitle();
}
function limitFor(name, ch) {
  if (!body()) return ch === 'pos' ? M.LIMITS.rig.pos : ch === 'rot' ? M.LIMITS.rig.rot : M.LIMITS.rig.scale;
  return ch === 'pos' ? M.LIMITS.body.pos : name === 'root' ? M.LIMITS.body.yaw : M.LIMITS.body.rot;
}
function clampCh(name, ch, v) { const L = limitFor(name, ch); return Math.max(ch === 'scale' ? 0 : -L, Math.min(L, v)); }

/** Key at the current tick, created from the current pose if missing (auto-key). */
function ensureKey(tr, t = itick()) {
  let k = M.keyAt(tr, t);
  if (!k) {
    const s = M.sample(tr, t, P.kind);
    k = { t, pos: s.pos.map(r4), rot: s.rot.map(r4), scale: s.scale.map(r4), ease: body() ? 'inout' : 'in_out' };
    tr.keys.push(k); M.sortKeys(tr);
  }
  return k;
}
function setVec(name, ch, vec) {
  const tr = T(name); if (!tr) return;
  const k = ensureKey(tr);
  k[ch] = vec.map((v, i) => r4(clampCh(name, ch, Number.isFinite(v) ? v : k[ch][i])));
  if (body() && name === 'root' && ch === 'rot') k.rot = [0, k.rot[1], 0];
}

// ------------------------------------------------------------------ 3D
function rebuildModel() {
  const model = body() ? buildBody(skin.texture, armsSlim()) : buildRig(P);
  stage.setModel(model); stage.setFront(P.kind);
  rebuildGhosts();
  attachGizmo();
}
function armsSlim() { const a = store.settings.arms; return a === 'slim' || (a === 'auto' && skin && skin.slim); }
function rebuildGhosts() {
  ghostModels = store.settings.onion ? [0x6aa0ff, 0x6ee7a8].map(c => body() ? buildBody(null, armsSlim(), c) : buildRig(P, c)) : [];
  stage.setGhosts(ghostModels);
}
function keyTicks() { const s = new Set(); for (const t of P.tracks) for (const k of t.keys) s.add(k.t); return [...s].sort((a, b) => a - b); }
function pose() {
  if (!stage.model) return;
  poseModel(stage.model, P, tick);
  if (ghostModels.length) {
    const ks = keyTicks(), t = itick();
    const prev = [...ks].reverse().find(k => k < t), next = ks.find(k => k > t);
    ghostModels[0].root.visible = prev !== undefined && !playing; ghostModels[1].root.visible = next !== undefined && !playing;
    if (prev !== undefined) poseModel(ghostModels[0], P, prev);
    if (next !== undefined) poseModel(ghostModels[1], P, next);
  }
  updateClock();
}
function attachGizmo() {
  let mode = store.settings.gizmo;
  if (body() && mode === 'scale') mode = store.settings.gizmo = 'rotate';
  stage.selected = sel;
  stage.gizmo.setSpace(store.settings.space);
  stage.attach(playing ? null : sel, mode);
  document.querySelectorAll('#gizmoSeg button').forEach(b => { b.classList.toggle('on', b.dataset.v === mode); b.disabled = b.dataset.v === 'scale' && body(); });
  document.querySelectorAll('#spaceSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === store.settings.space));
}

/** Euler (degrees) for a quaternion, choosing the equivalent solution nearest the previous values so keys interpolate the short way. */
function nearEuler(q, order, prev) {
  const e = new THREE.Euler().setFromQuaternion(q, order);
  let a = [deg(e.x), deg(e.y), deg(e.z)], b;
  if (order === 'XYZ') b = [a[0] + 180, 180 - a[1], a[2] + 180];
  else b = [180 - a[0], a[1] + 180, a[2] + 180]; // YXZ: X is the middle angle
  const unwrap = v => v.map((x, i) => x + 360 * Math.round((prev[i] - x) / 360));
  a = unwrap(a); b = unwrap(b);
  const cost = v => v.reduce((s, x, i) => s + Math.abs(x - prev[i]), 0);
  return (cost(a) <= cost(b) ? a : b).map(r2);
}

function gizmoChanged(obj) {
  if (!sel || playing) return;
  if (!dragSnap) { snapshot(); dragSnap = true; }
  const tr = T(sel), cur = M.sample(tr, itick(), P.kind), mode = stage.gizmo.mode;
  if (body()) {
    if (sel === 'root') {
      if (mode === 'rotate') setVec('root', 'rot', [0, r2(-nearEuler(obj.quaternion, 'XYZ', [0, -cur.rot[1], 0])[1]), 0]);
      else setVec('root', 'pos', obj.position.toArray());
    } else if (mode === 'rotate') setVec(sel, 'rot', nearEuler(obj.quaternion, 'XYZ', cur.rot));
    else { const p = M.PIVOTS[sel]; setVec(sel, 'pos', [obj.position.x - p[0], obj.position.y - p[1], obj.position.z - p[2]]); }
  } else {
    if (mode === 'rotate') setVec(sel, 'rot', nearEuler(obj.quaternion, 'YXZ', cur.rot));
    else if (mode === 'translate') setVec(sel, 'pos', obj.position.toArray());
    else setVec(sel, 'scale', obj.scale.toArray());
  }
  pose(); renderInspector(); renderTimeline();
}

// ------------------------------------------------------------------ playback
function setTick(t, keepPlaying = false) {
  if (!keepPlaying && playing) stop();
  tick = Math.max(0, Math.min(P.length, t));
  pose(); renderInspector(); placePlayhead();
}
function play() {
  if (playing) return;
  if (itick() >= P.length) tick = 0;
  playing = true; playStart = performance.now(); playFrom = tick;
  $('#playBtn').innerHTML = icon('player-pause'); attachGizmo(); pose();
}
function stop() {
  playing = false; tick = Math.round(tick);
  $('#playBtn').innerHTML = icon('player-play'); attachGizmo(); pose(); renderInspector(); placePlayhead();
}
function frame() {
  if (!playing) return;
  let t = playFrom + (performance.now() - playStart) / 50 * speed;
  if (t > P.length) {
    if (store.settings.loop) { playFrom = 0; playStart = performance.now(); t = 0; }
    else { tick = P.length; stop(); return; }
  }
  tick = t; pose(); placePlayhead();
}
function updateClock() {
  $('#tickNow').textContent = Math.floor(tick); $('#tickLen').textContent = P.length;
  $('#secs').textContent = (tick / 20).toFixed(2) + ' s';
}
function jumpKey(dir) {
  const ks = (sel ? T(sel).keys.map(k => k.t) : keyTicks());
  const t = itick(), n = dir > 0 ? ks.find(k => k > t) : [...ks].reverse().find(k => k < t);
  if (n !== undefined) setTick(n);
}

// ------------------------------------------------------------------ outliner
function renderOutliner() {
  const ul = $('#outliner'); ul.innerHTML = '';
  for (const t of P.tracks) {
    const li = h('li', { class: t.name === sel ? 'sel' : '' });
    if (body()) li.innerHTML = icon(TRACK_ICON[t.name] || 'box') + `<span class="nm">${TRACK_LABEL[t.name] || t.name}</span><span class="sub">${t.keys.length}</span>`;
    else {
      const sw = t.type === 'block' || t.type === 'item' ? `<span class="swatch" style="background:#${fallbackColor(t.material).toString(16).padStart(6, '0')}"></span>` : icon(t.type === 'text' ? 'pencil' : 'sparkles');
      li.innerHTML = sw + `<span class="nm">${esc(t.name)}</span><span class="sub">${esc(t.type === 'block' || t.type === 'item' ? t.material : t.type)}</span>`
        + `<span class="row-act"><button data-a="dup" data-tip="Duplicate">${icon('copy')}</button><button data-a="del" data-tip="Delete part">${icon('trash')}</button></span>`;
    }
    li.onclick = e => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'del') return deletePart(t.name);
      if (a === 'dup') return duplicatePart(t.name);
      select(t.name);
    };
    ul.appendChild(li);
  }
  $('#addPartBtn').style.display = body() ? 'none' : '';
  $('#skinPanel').style.display = body() ? '' : 'none';
  $('#modeNote').innerHTML = body()
    ? 'A <b>body clip</b> poses the player\'s real skinned body in game (other players see it on you). Pivots, rotation order and limits match StealzersAnim exactly: neck and shoulders at 1.4 blocks, hips at 0.7, rotations applied X then Y then Z, offsets up to ±0.75 block, up to 200 ticks.'
    : 'A <b>block rig</b> is an effect made of block and item displays, like the ability effects. Positions are block centres in blocks; rotations apply Y then X then Z. The arrow on the floor marks the front: it faces you when you preview in game.';
}
function select(name) {
  sel = name && T(name) ? name : null;
  stage.selected = sel; attachGizmo(); renderOutliner(); renderInspector(); renderTimeline();
}
function uniquePart(base) { let n = base.replace(/[^a-z0-9_]/g, '_').slice(0, 56) || 'part', i = 2, out = n; while (T(out)) out = n + '_' + i++; return out; }
function deletePart(name) {
  if (P.tracks.length <= 1) return toast('A rig needs at least one part', true);
  commit(() => { P.tracks = P.tracks.filter(t => t.name !== name); if (sel === name) sel = null; }, true);
  toast('Deleted ' + name + ' (Ctrl+Z brings it back)');
}
function duplicatePart(name) {
  if (P.tracks.length >= M.LIMITS.rig.parts) return toast('At most 64 parts', true);
  const src = T(name), copy = M.clone(src); copy.name = uniquePart(name);
  commit(() => { P.tracks.splice(P.tracks.indexOf(src) + 1, 0, copy); sel = copy.name; }, true);
}

// ------------------------------------------------------------------ inspector
function curve(e) {
  let d = '';
  for (let i = 0; i <= 24; i++) { const x = i / 24, y = M.ease(e, x); d += (i ? 'L' : 'M') + (2 + x * 40).toFixed(1) + ' ' + (25 - y * 22).toFixed(1); }
  return `<svg class="curve" viewBox="0 0 44 28"><rect x="0" y="0" width="44" height="28" rx="5"/><path d="${d}"/></svg>`;
}
const fmt = (v, ch) => String(ch === 'rot' ? r2(v) : Math.abs(v) >= 100 ? r2(v) : r4(v));
function vecRow(label, ch, vals, step) {
  const axes = ['x', 'y', 'z'];
  return `<div class="vec" data-ch="${ch}"><span>${label}</span>` + vals.map((v, i) => v === null ? '<span></span>' :
    `<div class="num ${axes[i]}"><b data-i="${i}">${axes[i].toUpperCase()}</b><input type="number" step="${step}" data-i="${i}" value="${fmt(v, ch)}" title="${r4(v)}"></div>`).join('') + '</div>';
}
function renderInspector() {
  const el = $('#inspector');
  if (document.activeElement && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && !playing && renderInspector.hold) return;
  let html = '';
  if (sel) {
    const tr = T(sel), t = itick(), k = M.keyAt(tr, t), s = M.sample(tr, tick, P.kind);
    const label = body() ? TRACK_LABEL[sel] : sel;
    html += `<section><div class="insp-head"><h3>${esc(label)}</h3>${k ? '<span class="badge key">Keyframe</span>' : '<span class="badge">Between keys</span>'}</div>`;
    if (body() && sel === 'root') {
      html += vecRow('Offset', 'pos', s.pos, 0.0625) + vecRow('Turn', 'rot', [null, s.rot[1], null], 5);
    } else {
      html += vecRow(body() ? 'Offset' : 'Position', 'pos', s.pos, 0.0625) + vecRow('Rotation', 'rot', s.rot, 5);
      if (!body()) html += vecRow('Scale', 'scale', s.scale, 0.05);
    }
    const eases = body() ? M.BODY_EASES : M.RIG_EASES;
    html += `<div class="keybox">`;
    if (k) html += `<div class="row"><span>Ease in</span><select id="easeSel">${eases.map(e => `<option ${e === k.ease ? 'selected' : ''}>${e}</option>`).join('')}</select>${curve(k.ease)}</div>
      <div class="row"><span>Tick</span><span style="width:auto;color:var(--text);font-family:var(--mono)">${t}</span><span class="spacer"></span><button class="mini" id="delKeyBtn">Delete key</button></div>`;
    else html += `<div class="empty">No keyframe on tick ${t}. Changing a value adds one here.</div><div><button class="mini" id="addKeyHere">Add keyframe</button></div>`;
    html += `</div>`;
    if (body()) html += `<div class="btn-row"><button class="btn" id="mirrorBtn" data-tip="Copy this pose to the other side (M)">${icon('flip-vertical')}Mirror</button><button class="btn" id="resetBtn" data-tip="Back to the rest pose on this tick (0)">${icon('refresh')}Reset</button></div>`;
    html += `</section>`;
    if (!body()) {
      html += `<section><div class="ph"><span>Part</span></div><div class="form">
        <label>Name</label><input id="pName" value="${esc(tr.name)}" spellcheck="false">
        <label>Type</label><select id="pType">${['block', 'item', 'text', 'sprite'].map(x => `<option ${x === tr.type ? 'selected' : ''} ${(x === 'text' || x === 'sprite') && tr.type !== x ? 'disabled' : ''}>${x}</option>`).join('')}</select>
        ${tr.type === 'block' || tr.type === 'item' ? `<label>${tr.type === 'block' ? 'Block' : 'Item'} id</label><input id="pMat" list="ids" value="${esc(tr.material)}" spellcheck="false">` : ''}
        ${tr.type === 'text' ? `<label>Text</label><input id="pText" value="${esc(tr.props.text || '')}">` : ''}
        <label>Brightness</label><select id="pBright"><option value="-1">World light</option>${Array.from({ length: 16 }, (_, i) => `<option value="${i}" ${tr.props.brightness === i ? 'selected' : ''}>${i}${i === 15 ? ' (full bright)' : ''}</option>`).join('')}</select>
        <label>Glow</label><div class="check"><input type="checkbox" id="pGlowOn" ${tr.props.glow ? 'checked' : ''}><input type="color" id="pGlow" value="${glowHex(tr.props.glow)}"></div>
      </div><p class="note" id="texNote"></p></section>`;
    }
  } else html += `<section><div class="empty">Select a ${body() ? 'limb' : 'part'} in the viewport or the outliner to pose it.</div></section>`;
  html += `<section><div class="ph"><span>Animation</span></div><div class="form">
    <label>Name</label><input id="aName" value="${esc(P.id)}" spellcheck="false" title="a-z, 0-9 and _ only; this is the name in game">
    <label>Type</label><span class="muted">${body() ? 'Body clip (player pose)' : 'Block rig (effect)'}</span>
    ${body() ? '' : `<label>Step</label><input id="aStep" type="number" min="1" max="20" value="${P.step}" title="Ticks between samples in game (1 = smoothest)">
    <label>Loop</label><div class="check"><input type="checkbox" id="aLoop" ${P.loop ? 'checked' : ''}><span class="muted">repeat in game</span></div>`}
  </div></section>`;
  el.innerHTML = html + `<datalist id="ids">${COMMON_IDS.map(i => `<option value="${i}">`).join('')}</datalist>`;
  wireInspector();
}
function glowHex(g) {
  if (!g) return '#7c8cff';
  const s = String(g); if (s.startsWith('#')) return s.length === 7 ? s : '#7c8cff';
  return '#' + Number(s).toString(16).padStart(6, '0');
}
function wireInspector() {
  const el = $('#inspector');
  el.querySelectorAll('.vec').forEach(row => {
    const ch = row.dataset.ch;
    row.querySelectorAll('input').forEach(inp => {
      inp.onfocus = () => renderInspector.hold = true;
      inp.onblur = () => { renderInspector.hold = false; };
      inp.onchange = () => {
        const s = M.sample(T(sel), itick(), P.kind)[ch].slice();
        s[+inp.dataset.i] = Number(inp.value);
        commit(() => setVec(sel, ch, s));
      };
      inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
    });
    row.querySelectorAll('b').forEach(b => b.onpointerdown = e => {
      e.preventDefault(); if (playing) stop();
      const i = +b.dataset.i, x0 = e.clientX, base = M.sample(T(sel), itick(), P.kind)[ch].slice();
      const rate = ch === 'rot' ? 0.5 : ch === 'pos' ? 0.005 : 0.01;
      let moved = false;
      const mv = ev => {
        if (!moved) { snapshot(); moved = true; }
        const v = base.slice(); v[i] = base[i] + (ev.clientX - x0) * rate * (ev.shiftKey ? 0.2 : 1);
        if (ch === 'rot') v[i] = Math.round(v[i] * (ev.shiftKey ? 10 : 1)) / (ev.shiftKey ? 10 : 1);
        setVec(sel, ch, v); pose(); renderTimeline();
        const inp = row.querySelector(`input[data-i="${i}"]`); if (inp) inp.value = r4(M.sample(T(sel), itick(), P.kind)[ch][i]);
      };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) changed(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
  });
  const on = (id, ev, fn) => { const n = el.querySelector(id); if (n) n[ev] = fn; };
  on('#easeSel', 'onchange', e => commit(() => { M.keyAt(T(sel), itick()).ease = e.target.value; }));
  on('#delKeyBtn', 'onclick', () => deleteKeys([[sel, itick()]]));
  on('#addKeyHere', 'onclick', () => addKey(false));
  on('#mirrorBtn', 'onclick', mirror);
  on('#resetBtn', 'onclick', resetBone);
  on('#aName', 'onchange', e => rename(e.target.value));
  on('#aStep', 'onchange', e => { const v = Math.round(+e.target.value); if (v >= 1 && v <= 20) commit(() => P.step = v); else { toast('Step must be 1..20', true); renderInspector(); } });
  on('#aLoop', 'onchange', e => commit(() => P.loop = e.target.checked));
  on('#pName', 'onchange', e => {
    const n = e.target.value.trim().toLowerCase();
    if (!M.NAME_RE.test(n)) { toast('Part names use a-z, 0-9 and _', true); return renderInspector(); }
    if (T(n) && n !== sel) { toast('There is already a part called ' + n, true); return renderInspector(); }
    commit(() => { T(sel).name = n; sel = n; }, true);
  });
  on('#pType', 'onchange', e => commit(() => { T(sel).type = e.target.value; }, true));
  on('#pMat', 'onchange', e => { const v = e.target.value.trim().toLowerCase().replace('minecraft:', ''); commit(() => { T(sel).material = v; }, true); });
  on('#pText', 'onchange', e => commit(() => { T(sel).props.text = e.target.value; }, true));
  on('#pBright', 'onchange', e => commit(() => { const v = +e.target.value; if (v < 0) delete T(sel).props.brightness; else T(sel).props.brightness = v; }));
  const glow = () => commit(() => { const tr = T(sel); if (el.querySelector('#pGlowOn').checked) tr.props.glow = el.querySelector('#pGlow').value; else delete tr.props.glow; });
  on('#pGlowOn', 'onchange', glow); on('#pGlow', 'onchange', glow);
  const note = el.querySelector('#texNote');
  if (note && sel) {
    const tr = T(sel);
    if (tr.type === 'block' || tr.type === 'item') textures(tr.type, tr.material).then(tx => {
      note.innerHTML = tx.kind ? `Showing the vanilla ${tx.kind} texture.` : `No vanilla texture found for <code>${esc(tr.material)}</code>, so it is drawn as a plain colour. Check the id if this is a typo; the server rejects unknown ids.`;
      if (tx.kind === 'block' && tr.type === 'item') note.innerHTML += ' Block items show as a cube.';
    });
    else note.textContent = tr.type === 'text' ? 'Text parts are shown approximately; check them in game.' : 'Sprites need the server pack; shown here as a label.';
  }
}
function rename(v) {
  const n = String(v).trim().toLowerCase();
  if (!M.NAME_RE.test(n)) { toast('Names use a-z, 0-9 and _ (max 64), e.g. gojo_wave', true); return renderInspector(); }
  if (n === P.id) return;
  if (store.projects[n]) { toast('You already have a project called ' + n, true); return renderInspector(); }
  commit(() => { delete store.projects[P.id]; P.id = n; });
  renderTitle();
}

// ------------------------------------------------------------------ keyframe ops
function addKey(all) {
  if (playing) stop();
  const names = all || !sel ? P.tracks.map(t => t.name) : [sel];
  commit(() => { for (const n of names) ensureKey(T(n)); });
  toast(`Keyframe on tick ${itick()}${names.length > 1 ? ' for every ' + (body() ? 'bone' : 'part') : ''}`);
}
function deleteKeys(list) {
  list = list.filter(([n, t]) => M.keyAt(T(n), t));
  if (!list.length) return;
  const blocked = list.filter(([n]) => T(n).keys.length - list.filter(x => x[0] === n).length < 1);
  if (blocked.length) return toast('Every track keeps at least one keyframe', true);
  commit(() => { for (const [n, t] of list) { const tr = T(n); tr.keys = tr.keys.filter(k => k.t !== t); } selKeys.clear(); });
  toast(`Deleted ${list.length} keyframe${list.length > 1 ? 's' : ''}`);
}
function selectedKeyList() { return [...selKeys].map(s => { const i = s.lastIndexOf('@'); return [s.slice(0, i), +s.slice(i + 1)]; }).filter(([n, t]) => T(n) && M.keyAt(T(n), t)); }
function copy() {
  const list = selectedKeyList();
  if (list.length) {
    const t0 = Math.min(...list.map(x => x[1]));
    clipboard = list.map(([n, t]) => ({ track: n, dt: t - t0, key: M.clone(M.keyAt(T(n), t)) }));
    toast(`Copied ${list.length} keyframe${list.length > 1 ? 's' : ''}`);
  } else {
    clipboard = P.tracks.map(tr => { const s = M.sample(tr, itick(), P.kind); return { track: tr.name, dt: 0, key: { pos: s.pos, rot: s.rot, scale: s.scale, ease: body() ? 'inout' : 'in_out' } }; });
    toast('Copied the pose on tick ' + itick());
  }
}
function paste() {
  if (!clipboard) return toast('Nothing copied yet', true);
  const t0 = itick(), out = clipboard.filter(c => T(c.track) && t0 + c.dt <= P.length);
  if (!out.length) return toast('Nothing to paste here', true);
  commit(() => {
    selKeys.clear();
    for (const c of out) {
      const tr = T(c.track), t = t0 + c.dt;
      tr.keys = tr.keys.filter(k => k.t !== t);
      tr.keys.push({ ...M.clone(c.key), t }); M.sortKeys(tr);
      selKeys.add(c.track + '@' + t);
    }
  });
  toast(`Pasted on tick ${t0}`);
}
const MIRROR = { arm_r: 'arm_l', arm_l: 'arm_r', leg_r: 'leg_l', leg_l: 'leg_r', head: 'head', torso: 'torso' };
function mirror() {
  if (!body() || !sel || sel === 'root') return toast('Select a limb to mirror', true);
  const s = M.sample(T(sel), itick(), 'body'), to = MIRROR[sel];
  commit(() => { setVec(to, 'rot', [s.rot[0], -s.rot[1], -s.rot[2]]); setVec(to, 'pos', [-s.pos[0], s.pos[1], s.pos[2]]); });
  toast(to === sel ? 'Mirrored ' + TRACK_LABEL[sel] : `Copied to ${TRACK_LABEL[to].toLowerCase()} (mirrored)`);
}
function resetBone() {
  if (!sel) return;
  commit(() => { setVec(sel, 'pos', [0, 0, 0]); setVec(sel, 'rot', [0, 0, 0]); if (!body()) setVec(sel, 'scale', [1, 1, 1]); });
}
function setLength(v) {
  v = Math.round(v);
  const L = body() ? M.LIMITS.body.length : M.LIMITS.rig.length;
  const last = Math.max(...P.tracks.flatMap(t => t.keys.map(k => k.t)));
  if (!(v >= 1 && v <= L)) { toast(`Length must be 1..${L} ticks`, true); return $('#lengthInput').value = P.length; }
  if (v < last) { toast(`There are keyframes up to tick ${last}; delete or move them first`, true); return $('#lengthInput').value = P.length; }
  commit(() => { P.length = v; tick = Math.min(tick, v); });
}

// ------------------------------------------------------------------ timeline
const ppt = () => store.settings.zoom;
const ROW = 26;
function renderTimeline() {
  const names = $('#tlNames'), rows = $('#rows'), ruler = $('#ruler'), inner = $('#tlInner');
  const W = (P.length + 1) * ppt() + 40;
  inner.style.width = Math.max(W, $('#tlLanes').clientWidth) + 'px';
  names.innerHTML = ''; rows.innerHTML = '';
  for (const t of P.tracks) {
    const n = h('div', { class: t.name === sel ? 'sel' : '' }, (body() ? icon(TRACK_ICON[t.name] || 'box') : '') + `<span>${esc(body() ? TRACK_LABEL[t.name] : t.name)}</span>`);
    n.onclick = () => select(t.name); names.appendChild(n);
    const r = h('div', { class: 'row' + (t.name === sel ? ' sel' : '') }); r.dataset.track = t.name;
    const end = h('div', { class: 'end' }); end.style.left = (P.length * ppt() + 6) + 'px'; r.appendChild(end);
    for (const k of t.keys) {
      const d = h('div', { class: `kf ease-${k.ease}` + (selKeys.has(t.name + '@' + k.t) ? ' sel' : ''), 'data-tip': `${body() ? TRACK_LABEL[t.name] : t.name} · tick ${k.t} · ${k.ease}` });
      d.style.left = (k.t * ppt() + 6) + 'px'; d.dataset.t = k.t; d.dataset.track = t.name;
      r.appendChild(d);
    }
    rows.appendChild(r);
  }
  // ruler
  let html = '';
  const every = ppt() >= 20 ? 5 : ppt() >= 9 ? 10 : 20;
  for (let t = 0; t <= P.length; t++) {
    const x = t * ppt() + 6;
    if (t % every === 0) html += `<span class="${t % 20 === 0 ? 'sec' : ''}" style="left:${x}px">${t}</span>`;
    else if (ppt() >= 8) html += `<span class="minor" style="left:${x}px"></span>`;
  }
  ruler.innerHTML = html;
  placePlayhead();
  updateClock();
  $('#lengthInput').value = P.length;
}
function placePlayhead() { $('#playhead').style.left = (tick * ppt() + 6) + 'px'; }
function tickAt(e) { const r = $('#tlInner').getBoundingClientRect(); return Math.max(0, Math.min(P.length, Math.round((e.clientX - r.left - 6) / ppt()))); }
function wireTimeline() {
  const lanes = $('#tlLanes');
  lanes.addEventListener('scroll', () => { $('#tlNames').scrollTop = lanes.scrollTop; });
  lanes.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(ppt() * (e.deltaY < 0 ? 1.15 : 0.87)); } }, { passive: false });
  lanes.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const kf = e.target.closest('.kf');
    if (kf) return dragKeys(e, kf);
    const row = e.target.closest('.row');
    if (row && !e.shiftKey && !e.ctrlKey) selKeys.clear();
    if (row && row.dataset.track !== sel) select(row.dataset.track);
    setTick(tickAt(e)); renderTimeline();
    const mv = ev => setTick(tickAt(ev));
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  lanes.addEventListener('dblclick', e => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('.kf')) return;
    const t = tickAt(e); setTick(t); select(row.dataset.track); addKey(false);
  });
  lanes.addEventListener('contextmenu', e => {
    const kf = e.target.closest('.kf');
    if (!kf) return;
    e.preventDefault();
    const id = kf.dataset.track + '@' + kf.dataset.t;
    if (!selKeys.has(id)) { selKeys.clear(); selKeys.add(id); renderTimeline(); }
    const list = selectedKeyList(), eases = body() ? M.BODY_EASES : M.RIG_EASES;
    const cur = M.keyAt(T(kf.dataset.track), +kf.dataset.t).ease;
    menu(e.clientX, e.clientY, [
      { label: 'Ease into this key' },
      ...eases.map(x => ({ text: x, on: x === cur, run: () => commit(() => list.forEach(([n, t]) => M.keyAt(T(n), t).ease = x)) })),
      '-',
      { text: 'Copy', icon: 'copy', run: copy },
      { text: `Delete ${list.length > 1 ? list.length + ' keys' : 'key'}`, icon: 'trash', run: () => deleteKeys(list) },
    ]);
  });
}
function dragKeys(e, kf) {
  const id = kf.dataset.track + '@' + kf.dataset.t;
  if (e.shiftKey || e.ctrlKey) { selKeys.has(id) ? selKeys.delete(id) : selKeys.add(id); }
  else if (!selKeys.has(id)) { selKeys.clear(); selKeys.add(id); }
  if (kf.dataset.track !== sel) { sel = kf.dataset.track; attachGizmo(); renderOutliner(); }
  setTick(+kf.dataset.t); renderTimeline();
  const list = selectedKeyList(), x0 = e.clientX;
  let dt = 0;
  const els = list.map(([n, t]) => document.querySelector(`.kf[data-track="${CSS.escape(n)}"][data-t="${t}"]`));
  const mv = ev => {
    dt = Math.round((ev.clientX - x0) / ppt());
    els.forEach((el, i) => { if (el) { el.style.left = ((list[i][1] + dt) * ppt() + 6) + 'px'; el.classList.toggle('ghost', dt !== 0); } });
  };
  const up = () => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
    if (!dt) return renderTimeline();
    const moving = new Set(list.map(([n, t]) => n + '@' + t));
    const bad = list.some(([n, t]) => t + dt < 0 || t + dt > P.length || (M.keyAt(T(n), t + dt) && !moving.has(n + '@' + (t + dt))));
    if (bad) { toast('Keys can\'t move there (outside the clip or onto another key)', true); return renderTimeline(); }
    commit(() => {
      const keys = list.map(([n, t]) => [n, M.keyAt(T(n), t)]);
      for (const [, k] of keys) k.t += dt;
      for (const tr of P.tracks) M.sortKeys(tr);
      selKeys = new Set(list.map(([n, t]) => n + '@' + (t + dt)));
    });
    setTick(tick + dt);
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}
function setZoom(z) { store.settings.zoom = Math.max(4, Math.min(48, z)); $('#zoomInput').value = store.settings.zoom; renderTimeline(); save(); }

// ------------------------------------------------------------------ menus / modals
function menu(x, y, items) {
  const m = $('#menu'); m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(h('hr')); continue; }
    if (it.label) { m.appendChild(h('div', { class: 'lbl' }, esc(it.label))); continue; }
    const b = h('button', { class: it.on ? 'on' : '' }, (it.icon ? icon(it.icon) : '') + `<span>${esc(it.text)}</span>`);
    b.onclick = () => { closeMenu(); it.run(); };
    m.appendChild(b);
  }
  m.classList.add('show');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => addEventListener('pointerdown', closeMenuOutside), 0);
}
function closeMenuOutside(e) { if (!$('#menu').contains(e.target)) closeMenu(); }
function closeMenu() { $('#menu').classList.remove('show'); removeEventListener('pointerdown', closeMenuOutside); }
function modal(title, body, buttons = [{ text: 'Close' }]) {
  const m = $('#modal');
  m.innerHTML = `<header><h2>${title}</h2><button class="btn ghost icon-only" data-x>${icon('x')}</button></header><div class="body">${body}</div><footer></footer>`;
  const f = m.querySelector('footer');
  for (const b of buttons) {
    const e = h('button', { class: 'btn ' + (b.cls || '') }, (b.icon ? icon(b.icon) : '') + esc(b.text));
    e.onclick = async () => { if (b.run && (await b.run()) === false) return; closeModal(); };
    f.appendChild(e);
  }
  m.querySelector('[data-x]').onclick = closeModal;
  $('#modalBack').classList.add('show');
  return m;
}
function closeModal() { $('#modalBack').classList.remove('show'); }

function newDialog() {
  const m = modal('New animation', `<div class="cards">
    <button class="card" data-k="body"><strong>${icon('user')}Body clip</strong><span>Pose the player's real skinned body: arms, legs, head, torso and the whole body. Up to 10 seconds.</span></button>
    <button class="card" data-k="rig"><strong>${icon('cube')}Block rig</strong><span>An effect built from blocks and items that move, spin and scale, like the ability effects.</span></button></div>
    <div class="form" style="margin-top:12px"><label>Name</label><input id="newName" placeholder="e.g. gojo_wave" spellcheck="false"></div>
    <p>Lowercase letters, numbers and _ only. This is the name you use in game.</p>`, [{ text: 'Cancel' }]);
  const nameIn = m.querySelector('#newName');
  nameIn.value = uniqueProject('my_animation');
  setTimeout(() => nameIn.select(), 30);
  m.querySelectorAll('.card').forEach(c => c.onclick = () => {
    const n = nameIn.value.trim().toLowerCase();
    if (!M.NAME_RE.test(n)) return toast('Names use a-z, 0-9 and _ (max 64)', true);
    if (store.projects[n]) return toast('You already have a project called ' + n, true);
    closeModal();
    openProject(c.dataset.k === 'body' ? M.newBody(n) : M.newRig(n));
    toast(c.dataset.k === 'body' ? 'New body clip. Click a limb and rotate it, then add keyframes along the timeline.' : 'New block rig. Add parts and animate them.');
  });
}
function uniqueProject(base) { let n = base, i = 2; while (store.projects[n]) n = base + '_' + i++; return n; }

async function openDialog() {
  let examples = [];
  try { examples = await (await fetch('examples/index.json')).json(); } catch { }
  const list = Object.values(store.projects).sort((a, b) => a.id.localeCompare(b.id));
  const m = modal('Open', `<div class="tabs seg"><button class="on" data-tab="mine">Your projects (${list.length})</button><button data-tab="ex">Examples from the server (${examples.length})</button><button data-tab="file">From a file</button></div>
    <div data-pane="mine"><div class="list">${list.map(p => `<div class="item ${P && p.id === P.id ? 'cur' : ''}" data-id="${esc(p.id)}"><span class="dot ${p.kind === 'rig' ? 'rig' : ''}"></span><span class="nm">${esc(p.id)}</span><span class="meta">${p.kind === 'body' ? 'body clip' : 'block rig'} · ${p.length} ticks</span>
      <button class="btn ghost icon-only" data-a="dup" data-tip="Duplicate">${icon('copy')}</button><button class="btn ghost icon-only danger" data-a="del" data-tip="Delete">${icon('trash')}</button></div>`).join('') || '<p>No projects yet.</p>'}</div></div>
    <div data-pane="ex" hidden><p>The animations that ship with the server. Open one to use it as a starting point. Sending it back under the same name replaces the server's version (the game asks first).</p>
      <div class="list">${examples.map(x => `<div class="item" data-ex="${esc(x.file)}"><span class="dot ${x.kind === 'rig' ? 'rig' : ''}"></span><span class="nm">${esc(x.id)}</span><span class="meta">${x.kind === 'body' ? 'body clip' : 'block rig'} · ${x.length} ticks</span></div>`).join('')}</div></div>
    <div data-pane="file" hidden><p>Open a <code>.yml</code> or <code>.json</code> animation file (StealzersAnim format), for example one from <code>plugins/StealzersAnim/animations</code>.</p><button class="btn" id="pickFile">${icon('upload')}Choose file</button></div>`);
  m.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    m.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    m.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
  });
  m.querySelectorAll('[data-id]').forEach(it => it.onclick = e => {
    const id = it.dataset.id, a = e.target.closest('button')?.dataset.a;
    if (a === 'del') {
      if (!confirm(`Delete the project ${id} from this browser?`)) return;
      delete store.projects[id];
      if (P && P.id === id) { const rest = Object.keys(store.projects); P = null; openProject(rest.length ? store.projects[rest[0]] : M.newBody('my_animation')); }
      save(); closeModal(); openDialog(); return;
    }
    if (a === 'dup') { const c = M.clone(store.projects[id]); c.id = uniqueProject(id + '_copy'); store.projects[c.id] = c; save(); closeModal(); openProject(c); return; }
    closeModal(); openProject(store.projects[id]);
  });
  m.querySelectorAll('[data-ex]').forEach(it => it.onclick = async () => {
    try { const obj = await (await fetch('examples/' + it.dataset.ex)).json(); closeModal(); importObject(obj, 'example'); }
    catch (e) { toast('Could not load the example: ' + e.message, true); }
  });
  const pf = m.querySelector('#pickFile'); if (pf) pf.onclick = () => { closeModal(); $('#fileInput').click(); };
}

function importObject(obj, from) {
  const { project, warnings } = M.fromAnim(obj, 'imported');
  if (store.projects[project.id] && !confirm(`You already have a project called ${project.id}. Replace it? (Cancel keeps both.)`)) project.id = uniqueProject(project.id);
  openProject(project);
  const errs = M.validate(project);
  toast(`Opened ${project.id} from ${from}` + (warnings.length ? ' · ' + warnings[0] : '') + (errs.length ? ' · ' + errs[0] : ''), !!(warnings.length || errs.length));
}
async function importText(text, from) {
  text = text.trim();
  if (!text) return;
  if (text.startsWith(M.PART_PREFIX)) throw new Error('That is one part of a split code. Paste the full code from /animator export instead.');
  const obj = text.startsWith(M.CODE_PREFIX) ? await M.decode(text) : yaml.load(text);
  importObject(obj, from);
}
function pasteDialog() {
  const m = modal('Paste a code', `<p>Paste a code from <code>/animator export &lt;name&gt;</code> in game, or the text of an animation file.</p>
    <textarea id="pasteArea" rows="7" placeholder="PSMP1:…" spellcheck="false"></textarea>`, [{ text: 'Cancel' }, {
    text: 'Open', cls: 'primary', run: async () => {
      try { await importText(m.querySelector('#pasteArea').value, 'a code'); }
      catch (e) { toast('That code could not be read: ' + e.message, true); return false; }
    }
  }]);
  setTimeout(() => m.querySelector('#pasteArea').focus(), 30);
}

async function exportDialog() {
  if (playing) stop();
  const errs = M.validate(P);
  if (errs.length) return modal('Fix these first', `<p>The server would refuse this animation:</p><ul class="errors">${errs.slice(0, 8).map(e => `<li>${esc(e)}</li>`).join('')}</ul>`);
  const obj = M.toAnim(P), code = await M.encode(obj), parts = M.split(code);
  const quick = `/animator import ${P.id} ${code}`;
  const kindTxt = body() ? 'body clip' : 'block rig';
  let html = `<ol class="steps"><li>Copy the code below.</li><li>In Minecraft type <code>/animator import</code> and press Enter.</li><li>Click the big box, press <b>Ctrl+V</b>, check the name and press <b>Import</b>.</li><li>Press <b>Preview</b> to watch it${body() ? ' on a stand-in in front of you' : ' in front of you'}.</li></ol>`;
  if (parts.length === 1) {
    html += `<div class="codebox"><textarea id="codeOut" readonly spellcheck="false">${esc(code)}</textarea></div>
      <div class="code-meta"><span>${kindTxt} <b>${esc(P.id)}</b> · ${P.length} ticks</span><span>${code.length.toLocaleString()} characters</span></div>`;
    if (quick.length <= 256) html += `<p>Short enough to type as one chat command too: <button class="mini" id="copyCmd">Copy command</button></p>`;
  } else {
    html += `<p>This animation is big, so its code comes in ${parts.length} parts. Paste part 1 into the dialog; the game then asks for the next part.</p><div class="list">${parts.map((p, i) => `<div class="item"><span class="nm">Part ${i + 1} of ${parts.length}</span><span class="meta">${p.length.toLocaleString()} characters</span><button class="btn" data-part="${i}" style="opacity:1">${icon('copy')}Copy</button></div>`).join('')}</div>`;
  }
  const m = modal('Send to Minecraft', html, [
    { text: 'Download .yml', icon: 'download', run: () => { download(P.id + '.yml', `# ${P.id} - ${kindTxt} made with the PatentSMP Animator (web)\n` + JSON.stringify(obj, null, 2) + '\n'); return false; } },
    ...(parts.length === 1 ? [{ text: 'Copy code', icon: 'copy', cls: 'primary', run: () => { clip(code, 'Code copied. Now type /animator import in game.'); return false; } }] : [{ text: 'Done', cls: 'primary' }]),
  ]);
  const cc = m.querySelector('#copyCmd'); if (cc) cc.onclick = () => clip(quick, 'Command copied. Paste it into chat (T, then Ctrl+V).');
  m.querySelectorAll('[data-part]').forEach(b => b.onclick = () => clip(parts[+b.dataset.part], `Part ${+b.dataset.part + 1} copied`));
  const ta = m.querySelector('#codeOut'); if (ta) ta.onclick = () => ta.select();
}
async function clip(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { const ta = h('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(msg); }
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/yaml' })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

function addPartDialog() {
  if (P.tracks.length >= M.LIMITS.rig.parts) return toast('At most 64 parts', true);
  const m = modal('Add a part', `<div class="form"><label>Type</label><div class="seg" id="apType"><button class="on" data-v="block">Block</button><button data-v="item">Item</button></div>
    <label>Id</label><input id="apId" list="ids2" value="white_concrete" spellcheck="false"><label>Name</label><input id="apName" placeholder="optional" spellcheck="false"></div>
    <p>Any vanilla block or item id, like <code>red_concrete</code>, <code>sea_lantern</code> or <code>diamond_sword</code>. The new part starts where the selected part is.</p>
    <datalist id="ids2">${COMMON_IDS.map(i => `<option value="${i}">`).join('')}</datalist>`, [{ text: 'Cancel' }, {
    text: 'Add', cls: 'primary', run: () => {
      const type = m.querySelector('#apType .on').dataset.v, id = m.querySelector('#apId').value.trim().toLowerCase().replace('minecraft:', '');
      if (!/^[a-z0-9_]+$/.test(id)) { toast('Ids look like red_concrete', true); return false; }
      const nm = m.querySelector('#apName').value.trim().toLowerCase();
      if (nm && !M.NAME_RE.test(nm)) { toast('Part names use a-z, 0-9 and _', true); return false; }
      const name = nm ? (T(nm) ? uniquePart(nm) : nm) : uniquePart(id);
      const from = sel ? M.sample(T(sel), itick(), 'rig') : { pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
      commit(() => { P.tracks.push({ name, type, material: id, props: {}, keys: [{ t: 0, pos: from.pos.map(r4), rot: from.rot.map(r4), scale: from.scale.map(r4), ease: 'linear' }] }); sel = name; }, true);
      toast('Added ' + name);
    }
  }]);
  m.querySelectorAll('#apType button').forEach(b => b.onclick = () => m.querySelectorAll('#apType button').forEach(x => x.classList.toggle('on', x === b)));
}

function helpDialog() {
  const k = (a, b) => `<span>${a}</span><span>${b}</span>`;
  modal('Shortcuts and help', `<div class="keys-grid">
    ${k('<kbd>Space</kbd>', 'Play / pause')}${k('<kbd>←</kbd> <kbd>→</kbd>', 'Previous / next tick')}${k('<kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd>', 'Previous / next keyframe')}
    ${k('<kbd>Home</kbd> <kbd>End</kbd>', 'Start / end')}${k('<kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd>', 'Move / rotate / scale gizmo')}${k('<kbd>K</kbd>', 'Keyframe the selection (Shift+K: everything)')}
    ${k('<kbd>Delete</kbd>', 'Delete selected keyframes')}${k('<kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>V</kbd>', 'Copy / paste keyframes (or the whole pose)')}${k('<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd>', 'Undo / redo')}
    ${k('<kbd>M</kbd>', 'Mirror the limb to the other side')}${k('<kbd>0</kbd>', 'Reset the selection on this tick')}${k('<kbd>O</kbd> <kbd>L</kbd>', 'Onion skin / loop')}
    ${k('<kbd>1</kbd> <kbd>3</kbd> <kbd>7</kbd> <kbd>5</kbd>', 'Front / side / top / 3/4 view')}${k('<kbd>F</kbd>', 'Frame the selection (or everything)')}${k('<kbd>Tab</kbd>', 'Select the next bone or part')}${k('<kbd>Esc</kbd>', 'Deselect')}
    ${k('Drag a letter', 'X, Y, Z labels in the panel scrub the value (Shift = fine)')}${k('Timeline', 'Click to scrub, drag keys to retime, double-click to add, right-click for ease')}
  </div>
  <p style="margin-top:14px">Changing a value on a tick without a keyframe adds one there. 20 ticks are one second. Your work saves in this browser automatically; use <b>Send to Minecraft</b> to get a code, then <code>/animator import</code> in game. <code>/animator export &lt;name&gt;</code> in game gives a code you can open here with <b>Paste code</b>.</p>`);
}

// ------------------------------------------------------------------ projects + skin
function openProject(p) {
  if (playing) stop();
  P = p; store.projects[P.id] = P; store.current = P.id;
  sel = body() ? 'arm_r' : (P.tracks[0] && P.tracks[0].name); selKeys.clear(); tick = 0;
  undoStack.length = 0; redoStack.length = 0; updateUndo();
  rebuildModel(); stage.view('persp', P.kind); if (!body()) setTimeout(() => stage.frame(null), 400); changed(); renderTitle(); save();
}
function renderTitle() {
  $('#projectName').textContent = P.id; $('#kindDot').className = 'dot' + (body() ? '' : ' rig');
  document.title = P.id + ' · PatentSMP Animator';
}
async function setSkin(name) {
  $('#skinNote').textContent = name ? 'Loading ' + name + '…' : 'Loading…';
  skin = await loadSkin(name);
  store.settings.skin = name; save();
  const face = $('#skinFace').getContext('2d'); face.imageSmoothingEnabled = false; face.clearRect(0, 0, 8, 8);
  face.drawImage(skin.canvas, 8, 8, 8, 8, 0, 0, 8, 8); face.drawImage(skin.canvas, 40, 8, 8, 8, 0, 0, 8, 8);
  $('#skinNote').innerHTML = skin.failed ? `Couldn't find a skin for <b>${esc(name)}</b>; showing Steve.` : skin.source === 'default' ? 'Default Steve skin. In game everyone sees your own skin.' : `Skin of <b>${esc(name)}</b>${skin.slim ? ' (slim arms detected)' : ''}. Just for the preview: in game the clip uses whoever plays it.`;
  if (P && body()) { rebuildModel(); pose(); }
}

// ------------------------------------------------------------------ wiring
function tooltips() {
  const tip = $('#tip');
  document.addEventListener('pointerover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.classList.remove('show'); return; }
    tip.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect(); tip.classList.add('show');
    const tr = tip.getBoundingClientRect();
    tip.style.left = Math.max(6, Math.min(innerWidth - tr.width - 6, r.left + r.width / 2 - tr.width / 2)) + 'px';
    tip.style.top = (r.bottom + 6 + tr.height > innerHeight ? r.top - tr.height - 6 : r.bottom + 6) + 'px';
  });
}
function keys(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || $('#modalBack').classList.contains('show')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const go = fn => { e.preventDefault(); fn(); };
  if (ctrl && k === 'z') return go(e.shiftKey ? redo : undo);
  if (ctrl && k === 'y') return go(redo);
  if (ctrl && k === 'c') return go(copy);
  if (ctrl && k === 'v') return go(paste);
  if (ctrl && k === 's') return go(() => { save(); toast('Saved in this browser. Use Send to Minecraft to get a code.'); });
  if (ctrl) return;
  switch (e.key) {
    case ' ': return go(() => playing ? stop() : play());
    case 'ArrowLeft': return go(() => e.shiftKey ? jumpKey(-1) : setTick(itick() - 1));
    case 'ArrowRight': return go(() => e.shiftKey ? jumpKey(1) : setTick(itick() + 1));
    case 'Home': return go(() => setTick(0));
    case 'End': return go(() => setTick(P.length));
    case 'Delete': case 'Backspace': return go(() => deleteKeys(selectedKeyList().length ? selectedKeyList() : sel ? [[sel, itick()]] : []));
    case 'Escape': return go(() => { selKeys.clear(); select(null); });
    case 'Tab': return go(() => { const i = P.tracks.findIndex(t => t.name === sel); select(P.tracks[(i + (e.shiftKey ? -1 + P.tracks.length : 1)) % P.tracks.length].name); });
    case '?': return go(helpDialog);
  }
  switch (k) {
    case 'w': return go(() => setGizmo('translate'));
    case 'e': return go(() => setGizmo('rotate'));
    case 'r': return go(() => setGizmo('scale'));
    case 'k': return go(() => addKey(e.shiftKey));
    case 'm': return go(mirror);
    case '0': return go(resetBone);
    case 'o': return go(toggleOnion);
    case 'l': return go(toggleLoop);
    case '1': return go(() => stage.view('front', P.kind));
    case '3': return go(() => stage.view('right', P.kind));
    case '7': return go(() => stage.view('top', P.kind));
    case '5': return go(() => stage.view('persp', P.kind));
    case 'f': return go(() => stage.frame(sel));
  }
}
function setGizmo(m) {
  if (m === 'scale' && body()) return toast('Body bones only move and rotate', true);
  store.settings.gizmo = m; attachGizmo(); save();
}
function toggleOnion() { store.settings.onion = !store.settings.onion; $('#onionBtn').classList.toggle('on', store.settings.onion); rebuildGhosts(); pose(); save(); }
function toggleLoop() { store.settings.loop = !store.settings.loop; $('#loopBtn').classList.toggle('on', store.settings.loop); save(); }

async function init() {
  load();
  $('#undoBtn').innerHTML = icon('arrow-back-up'); $('#redoBtn').innerHTML = icon('arrow-forward-up'); $('#helpBtn').innerHTML = icon('help-circle');
  $('#newBtn').insertAdjacentHTML('afterbegin', icon('plus')); $('#openBtn').insertAdjacentHTML('afterbegin', icon('folder'));
  $('#pasteBtn').insertAdjacentHTML('afterbegin', icon('clipboard')); $('#exportBtn').insertAdjacentHTML('afterbegin', icon('brand-minecraft'));
  $('#startBtn').innerHTML = icon('player-skip-back'); $('#prevKeyBtn').innerHTML = icon('chevron-left'); $('#nextKeyBtn').innerHTML = icon('chevron-right');
  $('#playBtn').innerHTML = icon('player-play'); $('#loopBtn').innerHTML = icon('repeat');
  $('#keyBtn').insertAdjacentHTML('afterbegin', icon('keyframe'));
  const g = { translate: ['arrows-move', 'Move'], rotate: ['rotate-clockwise-2', 'Rotate'], scale: ['arrows-maximize', 'Scale'] };
  document.querySelectorAll('#gizmoSeg button').forEach(b => { b.innerHTML = icon(g[b.dataset.v][0]) + g[b.dataset.v][1]; b.onclick = () => setGizmo(b.dataset.v); });
  document.querySelectorAll('#spaceSeg button').forEach(b => b.onclick = () => { store.settings.space = b.dataset.v; attachGizmo(); save(); });
  document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => stage.view(b.dataset.v, P.kind));
  document.querySelectorAll('#armSeg button').forEach(b => b.onclick = () => { store.settings.arms = b.dataset.v; document.querySelectorAll('#armSeg button').forEach(x => x.classList.toggle('on', x === b)); rebuildModel(); pose(); save(); });
  document.querySelectorAll('#armSeg button').forEach(x => x.classList.toggle('on', x.dataset.v === store.settings.arms));
  $('#onionBtn').classList.toggle('on', store.settings.onion); $('#onionBtn').insertAdjacentHTML('afterbegin', icon('layers-subtract'));
  $('#loopBtn').classList.toggle('on', store.settings.loop);
  $('#zoomInput').value = store.settings.zoom; $('#zoomInput').oninput = e => setZoom(+e.target.value);

  stage = new Stage($('#viewport'), {
    pick: name => { if (name) select(name); else if (sel) select(null); },
    drag: on => { if (on && playing) stop(); if (!on && dragSnap) { dragSnap = false; changed(); } },
    change: gizmoChanged,
    frame,
  });

  $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
  $('#newBtn').onclick = newDialog; $('#openBtn').onclick = openDialog; $('#projectBtn').onclick = openDialog;
  $('#pasteBtn').onclick = pasteDialog; $('#exportBtn').onclick = exportDialog; $('#helpBtn').onclick = helpDialog;
  $('#addPartBtn').onclick = addPartDialog;
  $('#playBtn').onclick = () => playing ? stop() : play();
  $('#startBtn').onclick = () => setTick(0);
  $('#prevKeyBtn').onclick = () => jumpKey(-1); $('#nextKeyBtn').onclick = () => jumpKey(1);
  $('#loopBtn').onclick = toggleLoop; $('#onionBtn').onclick = toggleOnion;
  $('#keyBtn').onclick = () => addKey(false);
  $('#lengthInput').onchange = e => setLength(+e.target.value);
  $('#speedSel').onchange = e => { speed = +e.target.value; if (playing) { playFrom = tick; playStart = performance.now(); } };
  $('#skinLoad').onclick = () => setSkin($('#skinName').value.trim());
  $('#skinName').onkeydown = e => { if (e.key === 'Enter') setSkin(e.target.value.trim()); };
  $('#skinName').value = store.settings.skin || '';
  $('#fileInput').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await importText(await f.text(), f.name); } catch (err) { toast('Could not open ' + f.name + ': ' + err.message, true); }
  };
  $('#modalBack').addEventListener('pointerdown', e => { if (e.target.id === 'modalBack') closeModal(); });
  addEventListener('keydown', keys);
  addEventListener('resize', () => renderTimeline());
  tooltips(); wireTimeline();

  skin = await loadSkin(null);
  const start = store.current && store.projects[store.current] ? store.projects[store.current] : M.newBody('my_animation');
  openProject(start);
  if (store.settings.skin) setSkin(store.settings.skin);
  else setSkin('');
  window.animator = { get project() { return P; }, setTick, select, setVec: (n, ch, v) => commit(() => setVec(n, ch, v)), addKey, exportCode: async () => M.encode(M.toAnim(P)), importText, M, stage, openProject };
}
init();
