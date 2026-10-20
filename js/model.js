// Data model, sampling and the share-code codec. Mirrors StealzersAnim exactly:
//  body clips  -> ActorEngine (BODY_FORMAT.md): integer-tick sampling, rotation X->Y->Z
//  block rigs  -> Engine (FORMAT.md): fractional sampling, rotation Y->X->Z, block parts centred on pos
// Format v2 (additive): many easing curves + bezier, body bone scale, root pitch/roll/scale, stepped property channels
// (visible, brightness, glow, block/item swap, text) and sound/particle events. Old clips export byte-identical fields.
export const BONES = ['head', 'torso', 'arm_r', 'arm_l', 'leg_r', 'leg_l'];
export const BODY_TRACKS = ['root', ...BONES];
export const FAMILIES = ['sine', 'quad', 'cubic', 'quart', 'quint', 'expo', 'circ', 'back', 'elastic', 'bounce'];
const FAMILY_EASES = FAMILIES.flatMap(f => [f + '_in', f + '_out', f + '_in_out']);
export const BODY_EASES = ['linear', 'in', 'out', 'inout', 'back', 'elastic', 'bounce', ...FAMILY_EASES, 'step', 'hold', 'instant', 'bezier'];
export const RIG_EASES = ['linear', 'in', 'out', 'in_out', 'back', 'elastic', 'bounce', 'step', ...FAMILY_EASES, 'hold', 'instant', 'bezier'];
/** Stepped property channels: each value holds from its key until the next key of that channel. */
export const CHANNELS = {
  visible: { label: 'Show / hide', body: true, rig: true },
  brightness: { label: 'Brightness', body: true, rig: true },
  glow: { label: 'Glow', body: false, rig: true },
  block: { label: 'Block swap', body: false, rig: true, type: 'block' },
  item: { label: 'Item swap', body: false, rig: true, type: 'item' },
  text: { label: 'Text', body: false, rig: true, type: 'text' },
};
export const MOTION_FIELDS = ['pos', 'rot', 'scale', 'yaw', 'pitch', 'roll', 'opacity'];
// Same numbers as ActorEngine.PIVOTS (blocks; +X = the player's right, -Z = the player's front)
export const PIVOTS = { head: [0, 1.4, 0], arm_r: [0.25, 1.4, 0], arm_l: [-0.25, 1.4, 0], torso: [0, 1.4, 0], leg_r: [0.125, 0.7, 0], leg_l: [-0.125, 0.7, 0] };
export const LIMITS = {
  body: { length: 200, keys: 128, pos: 0.75, rot: 720, yaw: 360, tilt: 180, scale: 4, rootScale: [0.1, 4], at: 4 },
  rig: { length: 1200, keys: 256, parts: 64, pos: 128, rot: 36000, scale: 32, at: 128 },
  events: 128, count: 32, volume: 2, spread: 4,
};
export const NAME_RE = /^[a-z0-9_]{1,64}$/;
export const CODE_PREFIX = 'PSMP1:';
export const PART_PREFIX = 'PSMP1P:';
// The dialog payload of a vanilla client is capped at 32 KiB of NBT (2 bytes per char), so codes are split above this.
export const CHUNK = 12000;
/** Minecraft cuts typed chat/commands at 256 characters. */
export const CHAT_LIMIT = 256;

const v3 = (v, d = 0) => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number') ? v.map(Number) : [d, d, d];
const clone = o => JSON.parse(JSON.stringify(o));

export function normEase(e, body) {
  let s = String(e || 'linear').toLowerCase().replace(/-/g, '_');
  if (s.endsWith('_inout')) s = s.slice(0, -6) + '_in_out';
  if (body && s === 'in_out') s = 'inout';
  if (!body && s === 'inout') s = 'in_out';
  return s;
}

const backOut = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const elasticOut = t => t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
function bounceOut(t) {
  const n1 = 7.5625, d1 = 2.75; let x = t;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}
function easeIn(fam, t) {
  switch (fam) {
    case 'sine': return 1 - Math.cos(t * Math.PI / 2);
    case 'quad': return t * t;
    case 'cubic': return t * t * t;
    case 'quart': return t * t * t * t;
    case 'quint': return t * t * t * t * t;
    case 'expo': return t <= 0 ? 0 : Math.pow(2, 10 * t - 10);
    case 'circ': return 1 - Math.sqrt(Math.max(0, 1 - t * t));
    case 'back': return 1 - backOut(1 - t);
    case 'elastic': return 1 - elasticOut(1 - t);
    case 'bounce': return 1 - bounceOut(1 - t);
    default: return t;
  }
}
const bez = (p1, p2, s) => { const u = 1 - s; return 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s; };
/** CSS cubic-bezier(x1,y1,x2,y2), same bisection as StealzersAnim Easing.cubicBezier. */
export function cubicBezier(b, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0, hi = 1, s = t;
  for (let i = 0; i < 40; i++) { s = (lo + hi) / 2; if (bez(b[0], b[2], s) < t) lo = s; else hi = s; }
  return bez(b[1], b[3], s);
}

/** Same maths as dev.stealzers.anim.Easing (legacy names keep their old curves). */
export function ease(name, t, bezier) {
  const e = normEase(name, false);
  switch (e) {
    case 'linear': return t;
    case 'in': return t * t * t;
    case 'out': return 1 - Math.pow(1 - t, 3);
    case 'in_out': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'back': return backOut(t);
    case 'elastic': return elasticOut(t);
    case 'bounce': return bounceOut(t);
    case 'step': case 'hold': return t < 1 ? 0 : 1;
    case 'instant': return t > 0 ? 1 : 0;
    case 'bezier': return Array.isArray(bezier) && bezier.length === 4 ? cubicBezier(bezier, t) : t;
  }
  const i = e.indexOf('_');
  if (i < 0) return t;
  const fam = e.slice(0, i), mode = e.slice(i + 1);
  if (mode === 'in') return easeIn(fam, t);
  if (mode === 'out') return 1 - easeIn(fam, 1 - t);
  if (mode === 'in_out') return t < 0.5 ? easeIn(fam, 2 * t) / 2 : 1 - easeIn(fam, 2 - 2 * t) / 2;
  return t;
}
export function easeFamily(e) {
  const s = normEase(e, false);
  if (s === 'linear') return 'linear';
  if (['in', 'out', 'in_out'].includes(s)) return 'cubic';
  if (['step', 'hold', 'instant'].includes(s)) return 'step';
  if (s === 'bezier') return 'bezier';
  if (['back', 'elastic', 'bounce'].includes(s)) return s;
  return s.split('_')[0];
}

const lerp = (a, b, u) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * u);

/** ActorEngine.sample at an integer tick. */
function sampleBodyInt(keys, t) {
  let a = keys[0], b = a;
  for (const k of keys) { b = k; if (k.t >= t) break; a = k; }
  let u = a.t === b.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  u = ease(b.ease, u, b.bezier);
  return { pos: lerp(a.pos, b.pos, u), rot: lerp(a.rot, b.rot, u), scale: lerp(a.scale || [1, 1, 1], b.scale || [1, 1, 1], u) };
}

/** Engine.sample (rigs) at a fractional tick. */
function sampleRig(keys, tick) {
  if (tick <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (tick <= b.t) {
      const e = ease(b.ease, (tick - a.t) / Math.max(1, b.t - a.t), b.bezier);
      return { pos: lerp(a.pos, b.pos, e), rot: lerp(a.rot, b.rot, e), scale: lerp(a.scale, b.scale, e) };
    }
  }
  return keys[keys.length - 1];
}

/** Pose of a track. Body clips advance per whole tick in game; the client interpolates linearly between ticks. */
export function sample(track, tick, kind) {
  const keys = track.keys;
  if (!keys.length) return { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };
  if (kind === 'rig') { const s = sampleRig(keys, tick); return { pos: [...s.pos], rot: [...s.rot], scale: [...s.scale] }; }
  const f = Math.floor(tick), c = Math.ceil(tick);
  const a = sampleBodyInt(keys, f);
  if (c === f) return a;
  const b = sampleBodyInt(keys, c), u = tick - f;
  return { pos: lerp(a.pos, b.pos, u), rot: lerp(a.rot, b.rot, u), scale: lerp(a.scale, b.scale, u) };
}

export function keyAt(track, t) { return track.keys.find(k => k.t === t); }
export function sortKeys(track) { track.keys.sort((a, b) => a.t - b.t); }
export function track(project, name) { return project.tracks.find(t => t.name === name); }

export function newBody(id = 'my_pose') {
  return {
    id, kind: 'body', length: 40, step: 1, loop: false, extra: {}, events: [],
    tracks: BODY_TRACKS.map(name => ({ name, type: name === 'root' ? 'root' : 'bone', material: '', props: {}, keys: [{ t: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' }] })),
  };
}

export function newRig(id = 'my_rig') {
  return {
    id, kind: 'rig', length: 40, step: 1, loop: false, extra: {}, events: [],
    tracks: [{ name: 'cube', type: 'block', material: 'white_concrete', props: {}, keys: [{ t: 0, pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' }] }],
  };
}

// Part settings (brightness/glow/text...) live in track.props; stepped channel keys are stored next to them as
// track.props['@visible'] = [{t, v}, ...] etc., so they never collide with the part setting of the same name.
export function normalizeChannels(p) {
  for (const t of p.tracks) {
    t.props = t.props || {};
    for (const ch of Object.keys(CHANNELS)) {
      const list = t.props['@' + ch];
      if (Array.isArray(list)) list.sort((a, b) => a.t - b.t);
    }
  }
  if (!Array.isArray(p.events)) p.events = [];
  if (p.extra && Array.isArray(p.extra.events)) { if (!p.events.length) p.events = p.extra.events; delete p.extra.events; }
  return p;
}
export function channel(tr, ch) {
  const list = (tr.props || {})['@' + ch] || [];
  return list;
}
export function channelAt(tr, ch, tick) {
  let v;
  for (const k of channel(tr, ch)) { if (k.t > tick) break; v = k.v; }
  return v;
}
export function setChannelKey(tr, ch, t, v) {
  tr.props = tr.props || {};
  const list = tr.props['@' + ch] = (tr.props['@' + ch] || []).filter(k => k.t !== t);
  list.push({ t, v }); list.sort((a, b) => a.t - b.t);
}
export function deleteChannelKey(tr, ch, t) {
  const list = (tr.props || {})['@' + ch];
  if (!list) return;
  tr.props['@' + ch] = list.filter(k => k.t !== t);
  if (!tr.props['@' + ch].length) delete tr.props['@' + ch];
}
const partSettings = props => Object.fromEntries(Object.entries(props || {}).filter(([k]) => !k.startsWith('@')));

// ------------------------------------------------------------------ Anim format <-> project

/** Merges motion keys and channel keys per tick (a channel-only tick becomes a key without pos/rot/scale). */
function mergeKeys(tr, motionKey, chans) {
  const byT = new Map();
  for (const k of tr.keys) byT.set(k.t, motionKey(k));
  for (const ch of chans) for (const c of channel(tr, ch)) {
    const o = byT.get(c.t) || { t: c.t };
    o[ch] = c.v; byT.set(c.t, o);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t).map(o => {
    if (o.ease === undefined) return o;
    const { ease: e, ...rest } = o; return { ...rest, ease: e }; // ease stays last, like the server's writer
  });
}

export function toAnim(p) {
  const events = (p.events || []).map(e => clean(e));
  if (p.kind === 'body') {
    const bones = {};
    for (const b of BONES) {
      const t = track(p, b);
      if (!t || !t.keys.length) continue;
      bones[b] = mergeKeys(t, k => {
        const o = { t: k.t, rot: k.rot.map(round), pos: k.pos.map(round) };
        const s = k.scale || [1, 1, 1];
        if (s.some(x => x !== 1)) o.scale = s.map(round);
        if (k.bezier) o.bezier = k.bezier.map(round);
        o.ease = k.ease; return o;
      }, ['visible', 'brightness']);
    }
    const r = track(p, 'root');
    const extra = clone(p.extra || {}); delete extra.events;
    const out = { id: p.id, type: 'body', length: p.length, ...extra };
    if (events.length) out.events = events;
    out.bones = bones;
    out.root = r && r.keys.length ? r.keys.map(k => {
      const o = { t: k.t, pos: k.pos.map(round), yaw: round(k.rot[1]) };
      if (k.rot[0]) o.pitch = round(k.rot[0]);
      if (k.rot[2]) o.roll = round(k.rot[2]);
      if (k.scale && k.scale[0] !== 1) o.scale = round(k.scale[0]);
      if (k.bezier) o.bezier = k.bezier.map(round);
      o.ease = k.ease; return o;
    }) : [];
    return out;
  }
  const parts = {};
  for (const t of p.tracks) {
    const part = { type: t.type };
    if (t.type === 'block' || t.type === 'item') part[t.type] = t.material;
    Object.assign(part, clone(partSettings(t.props)));
    part.keys = mergeKeys(t, k => {
      const o = { t: k.t, pos: k.pos.map(round), rot: k.rot.map(round), scale: k.scale.map(round), ...clone(k.extra || {}) };
      if (k.bezier) o.bezier = k.bezier.map(round);
      o.ease = k.ease; return o;
    }, Object.keys(CHANNELS));
    parts[t.name] = part;
  }
  const extra = clone(p.extra || {}); delete extra.events;
  const out = { id: p.id, length: p.length, step: p.step, loop: !!p.loop, ...extra, parts };
  if (events.length) out.events = events;
  return out;
}
function clean(e) {
  const o = { t: e.t };
  for (const k of ['sound', 'volume', 'pitch', 'particle', 'count', 'spread', 'at', 'color']) if (e[k] !== undefined && e[k] !== '' && e[k] !== null) o[k] = Array.isArray(e[k]) ? e[k].map(round) : typeof e[k] === 'number' ? round(e[k]) : e[k];
  return o;
}

const round = n => Math.round(n * 10000) / 10000 || 0;

export function isBody(obj) { return obj && (obj.type === 'body' || (obj.bones && typeof obj.bones === 'object')); }

export function fromAnim(obj, fallbackId = 'imported') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Not an animation object');
  const id = String(obj.id ?? fallbackId).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'imported';
  const warnings = [];
  const events = Array.isArray(obj.events) ? obj.events.filter(e => e && typeof e.t === 'number').map(e => ({ ...e, t: Math.round(e.t) })).sort((a, b) => a.t - b.t) : [];
  if (isBody(obj)) {
    if (obj.type && obj.type !== 'body') throw new Error('type must be body');
    const p = newBody(id); p.length = Number(obj.length) || 40; p.events = events;
    for (const k of Object.keys(obj)) if (!['id', 'type', 'length', 'bones', 'root', 'events'].includes(k)) p.extra[k] = obj[k];
    for (const t of p.tracks) t.keys = [];
    for (const [b, list] of Object.entries(obj.bones || {})) {
      const t = track(p, b);
      if (!t || b === 'root') { warnings.push('Ignored unknown bone ' + b); continue; }
      t.keys = readKeys(list, true, warnings, t);
    }
    track(p, 'root').keys = (Array.isArray(obj.root) ? obj.root : []).filter(k => k && typeof k.t === 'number')
      .map(k => {
        const o = { t: k.t, pos: v3(k.pos), rot: [Number(k.pitch) || 0, Number(k.yaw) || 0, Number(k.roll) || 0], scale: typeof k.scale === 'number' ? [k.scale, k.scale, k.scale] : [1, 1, 1], ease: bodyEase(k.ease, warnings) };
        if (Array.isArray(k.bezier)) o.bezier = k.bezier.map(Number);
        return o;
      }).sort((a, b) => a.t - b.t);
    for (const t of p.tracks) if (!t.keys.length) t.keys.push({ t: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' });
    return { project: normalizeChannels(p), warnings };
  }
  const p = newRig(id); p.tracks = []; p.events = events;
  p.length = Number(obj.length) || 40; p.step = Number(obj.step) || 1; p.loop = !!obj.loop;
  for (const k of Object.keys(obj)) if (!['id', 'length', 'step', 'loop', 'parts', 'events'].includes(k)) p.extra[k] = obj[k];
  for (const [name, ps] of Object.entries(obj.parts || {})) {
    if (!ps || typeof ps !== 'object') continue;
    const type = String(ps.type || 'block').toLowerCase();
    const t = { name, type, material: '', props: {}, keys: [] };
    if (type === 'block' || type === 'item') t.material = String(ps[type] || 'stone').toLowerCase().replace('minecraft:', '');
    for (const [k, v] of Object.entries(ps)) if (k !== 'type' && k !== 'keys' && !((type === 'block' || type === 'item') && k === type)) t.props[k] = v;
    t.keys = readKeys(ps.keys, false, warnings, t);
    if (!t.keys.length) t.keys.push({ t: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' });
    p.tracks.push(t);
  }
  return { project: normalizeChannels(p), warnings };
}

function bodyEase(e, warnings) {
  let s = normEase(e, true);
  if (!BODY_EASES.includes(s)) { warnings.push('Ease ' + e + ' is not supported for body clips; using linear'); s = 'linear'; }
  return s;
}

function readKeys(list, body, warnings, tr) {
  if (!Array.isArray(list)) return [];
  const raw = list.filter(k => k && typeof k.t === 'number').sort((a, b) => a.t - b.t);
  let lp = [0, 0, 0], lr = [0, 0, 0], ls = [1, 1, 1];
  const out = [];
  const chans = Object.keys(CHANNELS).filter(c => body ? CHANNELS[c].body : CHANNELS[c].rig);
  for (const k of raw) {
    const t = Math.round(k.t);
    let prop = false;
    for (const ch of chans) if (k[ch] !== undefined) { setChannelKey(tr, ch, t, k[ch]); prop = true; }
    const motion = MOTION_FIELDS.some(f => k[f] !== undefined);
    if (prop && !motion) continue;
    const key = {
      t,
      pos: Array.isArray(k.pos) ? v3(k.pos) : body ? [0, 0, 0] : [...lp],
      rot: Array.isArray(k.rot) ? v3(k.rot) : body ? [0, 0, 0] : [...lr],
      scale: Array.isArray(k.scale) ? v3(k.scale, 1) : typeof k.scale === 'number' ? [k.scale, k.scale, k.scale] : body ? [1, 1, 1] : [...ls],
      ease: 'linear',
    };
    if (Array.isArray(k.bezier)) key.bezier = k.bezier.map(Number);
    if (body) key.ease = bodyEase(k.ease, warnings);
    else {
      let e = normEase(k.ease, false);
      if (!RIG_EASES.includes(e)) { warnings.push('Unknown ease ' + k.ease + '; using linear'); e = 'linear'; }
      key.ease = e;
      const extra = {};
      for (const [n, v] of Object.entries(k)) if (!['t', 'pos', 'rot', 'scale', 'ease', 'bezier', ...chans].includes(n)) extra[n] = v;
      if (Object.keys(extra).length) key.extra = extra;
    }
    if (out.length && out[out.length - 1].t === key.t) out.pop();
    out.push(key);
    lp = key.pos; lr = key.rot; ls = key.scale;
  }
  return out;
}

// ------------------------------------------------------------------ validation (same limits as the server / StealzersAnim)

export function validate(p) {
  const e = [], body = p.kind === 'body', L = body ? LIMITS.body : LIMITS.rig;
  const fin = (v, m) => v.every(n => Number.isFinite(n) && Math.abs(n) <= m);
  if (!NAME_RE.test(p.id)) e.push('Name must be a-z, 0-9 or _ (max 64 characters)');
  if (!Number.isInteger(p.length) || p.length < 1 || p.length > L.length) e.push(`Length must be 1..${L.length} ticks`);
  if (!body) {
    if (!Number.isInteger(p.step) || p.step < 1 || p.step > 20) e.push('Step must be 1..20');
    if (!p.tracks.length) e.push('Add at least one part');
    if (p.tracks.length > L.parts) e.push(`At most ${L.parts} parts`);
  }
  const eases = body ? BODY_EASES : RIG_EASES;
  for (const t of p.tracks) {
    if (!NAME_RE.test(t.name)) e.push(`Part name "${t.name}" must be a-z, 0-9 or _`);
    if (!t.keys.length) e.push(`${t.name}: no keyframes`);
    const ticks = new Set(t.keys.map(k => k.t));
    for (const ch of Object.keys(CHANNELS)) for (const c of channel(t, ch)) ticks.add(c.t);
    if (ticks.size > L.keys) e.push(`${t.name}: at most ${L.keys} keyframes (motion and property keys together)`);
    if (!body && (t.type === 'block' || t.type === 'item') && !/^[a-z0-9_./-]+$/.test(t.material || '')) e.push(`${t.name}: missing ${t.type} id`);
    let prev = -1;
    for (const k of t.keys) {
      const at = `${t.name} @${k.t}`;
      if (!Number.isInteger(k.t) || k.t < 0 || k.t > p.length) e.push(`${at}: tick outside 0..${p.length}`);
      if (k.t <= prev) e.push(`${at}: duplicate tick`);
      prev = k.t;
      const s = k.scale || [1, 1, 1];
      if (body) {
        if (!fin(k.pos, L.pos)) e.push(`${at}: offsets must stay within ±${L.pos} block`);
        if (t.name === 'root') {
          if (!fin([k.rot[1]], L.yaw)) e.push(`${at}: yaw within ±360°`);
          if (!fin([k.rot[0], k.rot[2]], L.tilt)) e.push(`${at}: pitch/roll within ±180°`);
          if (!(s[0] >= L.rootScale[0] && s[0] <= L.rootScale[1])) e.push(`${at}: body scale 0.1..4`);
        } else {
          if (!fin(k.rot, L.rot)) e.push(`${at}: rotation within ±720°`);
          if (!fin(s, L.scale) || s.some(x => x < 0)) e.push(`${at}: bone scale 0..4`);
        }
      } else {
        if (!fin(k.pos, L.pos)) e.push(`${at}: position within ±128`);
        if (!fin(k.rot, L.rot)) e.push(`${at}: rotation within ±36000°`);
        if (!fin(s, L.scale) || s.some(x => x < 0)) e.push(`${at}: scale 0..32`);
      }
      if (!eases.includes(k.ease)) e.push(`${at}: unknown ease ${k.ease}`);
      if (k.ease === 'bezier' && !validBezier(k.bezier)) e.push(`${at}: bezier needs x1,x2 in 0..1 and y1,y2 in -2..3`);
    }
    for (const ch of Object.keys(CHANNELS)) for (const c of channel(t, ch)) {
      const at = `${t.name} ${CHANNELS[ch].label.toLowerCase()} @${c.t}`;
      if (!Number.isInteger(c.t) || c.t < 0 || c.t > p.length) e.push(`${at}: tick outside 0..${p.length}`);
      if (body ? !CHANNELS[ch].body || t.name === 'root' : !CHANNELS[ch].rig) e.push(`${at}: not available here`);
      if (CHANNELS[ch].type && CHANNELS[ch].type !== t.type) e.push(`${at}: only for ${CHANNELS[ch].type} parts`);
      if (ch === 'visible' && typeof c.v !== 'boolean') e.push(`${at}: must be on or off`);
      if (ch === 'brightness' && !(Number.isInteger(c.v) && c.v >= -1 && c.v <= 15)) e.push(`${at}: -1..15`);
      if (ch === 'glow' && !(c.v === 'off' || /^#[0-9a-fA-F]{6}$/.test(c.v))) e.push(`${at}: #rrggbb or off`);
      if ((ch === 'block' || ch === 'item') && !/^[a-z0-9_]+$/.test(String(c.v))) e.push(`${at}: needs an id like red_concrete`);
      if (ch === 'text' && String(c.v).length > 512) e.push(`${at}: at most 512 characters`);
    }
  }
  const ev = p.events || [];
  if (ev.length > LIMITS.events) e.push(`At most ${LIMITS.events} events`);
  for (const x of ev) {
    const at = `event @${x.t}`;
    if (!Number.isInteger(x.t) || x.t < 0 || x.t > p.length) e.push(`${at}: tick outside 0..${p.length}`);
    if (!x.sound && !x.particle) e.push(`${at}: needs a sound or a particle`);
    if (x.sound && !/^[a-z0-9_.:/-]{1,128}$/.test(x.sound)) e.push(`${at}: sound ids look like entity.blaze.shoot`);
    if (x.particle && !/^[a-zA-Z0-9_]{1,64}$/.test(x.particle)) e.push(`${at}: particle ids look like flame or dust`);
    if (x.count !== undefined && !(x.count >= 0 && x.count <= LIMITS.count)) e.push(`${at}: count 0..32`);
    if (x.volume !== undefined && !(x.volume >= 0 && x.volume <= LIMITS.volume)) e.push(`${at}: volume 0..2`);
    if (x.pitch !== undefined && !(x.pitch >= 0 && x.pitch <= 2)) e.push(`${at}: pitch 0..2`);
    if (x.spread !== undefined && !(x.spread >= 0 && x.spread <= LIMITS.spread)) e.push(`${at}: spread 0..4`);
    if (x.color !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(x.color)) e.push(`${at}: colour #rrggbb`);
    if (x.at !== undefined && !(Array.isArray(x.at) && x.at.length === 3 && fin(x.at, L.at))) e.push(`${at}: position within ±${L.at}`);
  }
  return e;
}
export function validBezier(b) { return Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] >= 0 && b[0] <= 1 && b[2] >= 0 && b[2] <= 1 && b[1] >= -2 && b[1] <= 3 && b[3] >= -2 && b[3] <= 3; }

// ------------------------------------------------------------------ share codes: PSMP1:<base64url(deflate-raw(utf8 json))>

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return CODE_PREFIX + b64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decode(code) {
  const s = code.replace(/\s+/g, '');
  if (!s.startsWith(CODE_PREFIX)) throw new Error('Codes start with ' + CODE_PREFIX);
  const bytes = await pipe(unb64url(s.slice(CODE_PREFIX.length)), new DecompressionStream('deflate-raw'));
  if (bytes.length > 1 << 20) throw new Error('Code too large');
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Splits a long code into parts the in-game dialog accepts one at a time: PSMP1P:<i>:<n>:<tag>:<slice>. */
export function split(code, size = CHUNK) {
  if (code.length <= size) return [code];
  const data = code.slice(CODE_PREFIX.length), n = Math.ceil(data.length / size);
  let h = 0;
  for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) | 0;
  const tag = (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
  return Array.from({ length: n }, (_, i) => `${PART_PREFIX}${i + 1}:${n}:${tag}:${data.slice(i * size, (i + 1) * size)}`);
}

export { clone };
