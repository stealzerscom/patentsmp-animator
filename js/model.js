// Data model, sampling and the share-code codec. Mirrors StealzersAnim exactly:
//  body clips  -> ActorEngine (BODY_FORMAT.md): integer-tick sampling, eases linear|in|out|inout, rotation X->Y->Z
//  block rigs  -> Engine (FORMAT.md): fractional sampling, 8 eases, rotation Y->X->Z, block parts centred on pos
export const BONES = ['head', 'torso', 'arm_r', 'arm_l', 'leg_r', 'leg_l'];
export const BODY_TRACKS = ['root', ...BONES];
export const BODY_EASES = ['linear', 'in', 'out', 'inout'];
export const RIG_EASES = ['linear', 'in', 'out', 'in_out', 'back', 'elastic', 'bounce', 'step'];
// Same numbers as ActorEngine.PIVOTS (blocks; +X = the player's right, -Z = the player's front)
export const PIVOTS = { head: [0, 1.4, 0], arm_r: [0.25, 1.4, 0], arm_l: [-0.25, 1.4, 0], torso: [0, 1.4, 0], leg_r: [0.125, 0.7, 0], leg_l: [-0.125, 0.7, 0] };
export const LIMITS = {
  body: { length: 200, keys: 128, pos: 0.75, rot: 720, yaw: 360 },
  rig: { length: 1200, keys: 256, parts: 64, pos: 128, rot: 36000, scale: 32 },
};
export const NAME_RE = /^[a-z0-9_]{1,64}$/;
export const CODE_PREFIX = 'PSMP1:';
export const PART_PREFIX = 'PSMP1P:';
// The dialog payload of a vanilla client is capped at 32 KiB of NBT (2 bytes per char), so codes are split above this.
export const CHUNK = 12000;

const v3 = (v, d = 0) => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number') ? v.map(Number) : [d, d, d];
const clone = o => JSON.parse(JSON.stringify(o));

export function ease(name, t) {
  switch (name) {
    case 'in': return t * t * t;
    case 'out': return 1 - Math.pow(1 - t, 3);
    case 'inout': case 'in_out': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'back': { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
    case 'elastic': return t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
    case 'bounce': {
      const n1 = 7.5625, d1 = 2.75; let x = t;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
      if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
      return n1 * (x -= 2.625 / d1) * x + 0.984375;
    }
    case 'step': return t < 1 ? 0 : 1;
    default: return t;
  }
}

const lerp = (a, b, u) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * u);

/** ActorEngine.sample at an integer tick. */
function sampleBodyInt(keys, t) {
  let a = keys[0], b = a;
  for (const k of keys) { b = k; if (k.t >= t) break; a = k; }
  let u = a.t === b.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  u = ease(b.ease, u);
  return { pos: lerp(a.pos, b.pos, u), rot: lerp(a.rot, b.rot, u), scale: [1, 1, 1] };
}

/** Engine.sample (rigs) at a fractional tick. */
function sampleRig(keys, tick) {
  if (tick <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (tick <= b.t) {
      const e = ease(b.ease, (tick - a.t) / Math.max(1, b.t - a.t));
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
  return { pos: lerp(a.pos, b.pos, u), rot: lerp(a.rot, b.rot, u), scale: [1, 1, 1] };
}

export function keyAt(track, t) { return track.keys.find(k => k.t === t); }
export function sortKeys(track) { track.keys.sort((a, b) => a.t - b.t); }
export function track(project, name) { return project.tracks.find(t => t.name === name); }

export function newBody(id = 'my_pose') {
  return {
    id, kind: 'body', length: 40, step: 1, loop: false, extra: {},
    tracks: BODY_TRACKS.map(name => ({ name, type: name === 'root' ? 'root' : 'bone', material: '', props: {}, keys: [{ t: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' }] })),
  };
}

export function newRig(id = 'my_rig') {
  return {
    id, kind: 'rig', length: 40, step: 1, loop: false, extra: {},
    tracks: [{ name: 'cube', type: 'block', material: 'white_concrete', props: {}, keys: [{ t: 0, pos: [0, 0.5, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' }] }],
  };
}

// ------------------------------------------------------------------ Anim format <-> project

export function toAnim(p) {
  if (p.kind === 'body') {
    const bones = {};
    for (const b of BONES) {
      const t = track(p, b);
      if (t && t.keys.length) bones[b] = t.keys.map(k => ({ t: k.t, rot: k.rot.map(round), pos: k.pos.map(round), ease: k.ease }));
    }
    const r = track(p, 'root');
    const out = { id: p.id, type: 'body', length: p.length, ...clone(p.extra || {}), bones };
    out.root = r && r.keys.length ? r.keys.map(k => ({ t: k.t, pos: k.pos.map(round), yaw: round(k.rot[1]), ease: k.ease })) : [];
    return out;
  }
  const parts = {};
  for (const t of p.tracks) {
    const part = { type: t.type };
    if (t.type === 'block' || t.type === 'item') part[t.type] = t.material;
    Object.assign(part, clone(t.props || {}));
    part.keys = t.keys.map(k => ({ t: k.t, pos: k.pos.map(round), rot: k.rot.map(round), scale: k.scale.map(round), ...clone(k.extra || {}), ease: k.ease }));
    parts[t.name] = part;
  }
  return { id: p.id, length: p.length, step: p.step, loop: !!p.loop, ...clone(p.extra || {}), parts };
}

const round = n => Math.round(n * 10000) / 10000 || 0;

export function isBody(obj) { return obj && (obj.type === 'body' || (obj.bones && typeof obj.bones === 'object')); }

export function fromAnim(obj, fallbackId = 'imported') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Not an animation object');
  const id = String(obj.id ?? fallbackId).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'imported';
  const warnings = [];
  if (isBody(obj)) {
    if (obj.type && obj.type !== 'body') throw new Error('type must be body');
    const p = newBody(id); p.length = Number(obj.length) || 40;
    for (const k of Object.keys(obj)) if (!['id', 'type', 'length', 'bones', 'root'].includes(k)) p.extra[k] = obj[k];
    for (const t of p.tracks) t.keys = [];
    for (const [b, list] of Object.entries(obj.bones || {})) {
      const t = track(p, b);
      if (!t || b === 'root') { warnings.push('Ignored unknown bone ' + b); continue; }
      t.keys = readKeys(list, true, warnings);
    }
    track(p, 'root').keys = (Array.isArray(obj.root) ? obj.root : []).filter(k => k && typeof k.t === 'number')
      .map(k => ({ t: k.t, pos: v3(k.pos), rot: [0, Number(k.yaw) || 0, 0], scale: [1, 1, 1], ease: bodyEase(k.ease, warnings) })).sort((a, b) => a.t - b.t);
    for (const t of p.tracks) if (!t.keys.length) t.keys.push({ t: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' });
    return { project: p, warnings };
  }
  const p = newRig(id); p.tracks = [];
  p.length = Number(obj.length) || 40; p.step = Number(obj.step) || 1; p.loop = !!obj.loop;
  for (const k of Object.keys(obj)) if (!['id', 'length', 'step', 'loop', 'parts'].includes(k)) p.extra[k] = obj[k];
  for (const [name, ps] of Object.entries(obj.parts || {})) {
    if (!ps || typeof ps !== 'object') continue;
    const type = String(ps.type || 'block').toLowerCase();
    const t = { name, type, material: '', props: {}, keys: [] };
    if (type === 'block' || type === 'item') t.material = String(ps[type] || 'stone').toLowerCase().replace('minecraft:', '');
    for (const [k, v] of Object.entries(ps)) if (k !== 'type' && k !== 'keys' && !((type === 'block' || type === 'item') && k === type)) t.props[k] = v;
    t.keys = readKeys(ps.keys, false, warnings);
    if (!t.keys.length) t.keys.push({ t: 0, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], ease: 'linear' });
    p.tracks.push(t);
  }
  return { project: p, warnings };
}

function bodyEase(e, warnings) {
  let s = String(e || 'linear').toLowerCase().replace('-', '_');
  if (s === 'in_out') s = 'inout';
  if (!BODY_EASES.includes(s)) { warnings.push('Ease ' + e + ' is not supported for body clips; using linear'); s = 'linear'; }
  return s;
}

function readKeys(list, body, warnings) {
  if (!Array.isArray(list)) return [];
  const raw = list.filter(k => k && typeof k.t === 'number').sort((a, b) => a.t - b.t);
  let lp = [0, 0, 0], lr = [0, 0, 0], ls = [1, 1, 1];
  const out = [];
  for (const k of raw) {
    const key = {
      t: Math.round(k.t),
      pos: Array.isArray(k.pos) ? v3(k.pos) : [...lp],
      rot: Array.isArray(k.rot) ? v3(k.rot) : [...lr],
      scale: Array.isArray(k.scale) ? v3(k.scale, 1) : typeof k.scale === 'number' ? [k.scale, k.scale, k.scale] : [...ls],
      ease: 'linear',
    };
    if (body) key.ease = bodyEase(k.ease, warnings);
    else {
      let e = String(k.ease || 'linear').toLowerCase().replace('-', '_');
      if (e === 'inout') e = 'in_out';
      if (!RIG_EASES.includes(e)) { warnings.push('Unknown ease ' + k.ease + '; using linear'); e = 'linear'; }
      key.ease = e;
      const extra = {};
      for (const [n, v] of Object.entries(k)) if (!['t', 'pos', 'rot', 'scale', 'ease'].includes(n)) extra[n] = v;
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
  for (const t of p.tracks) {
    if (!NAME_RE.test(t.name)) e.push(`Part name "${t.name}" must be a-z, 0-9 or _`);
    if (!t.keys.length) e.push(`${t.name}: no keyframes`);
    if (t.keys.length > L.keys) e.push(`${t.name}: at most ${L.keys} keyframes`);
    if (!body && (t.type === 'block' || t.type === 'item') && !/^[a-z0-9_./-]+$/.test(t.material || '')) e.push(`${t.name}: missing ${t.type} id`);
    let prev = -1;
    for (const k of t.keys) {
      const at = `${t.name} @${k.t}`;
      if (!Number.isInteger(k.t) || k.t < 0 || k.t > p.length) e.push(`${at}: tick outside 0..${p.length}`);
      if (k.t <= prev) e.push(`${at}: duplicate tick`);
      prev = k.t;
      if (body) {
        if (!fin(k.pos, L.pos)) e.push(`${at}: offsets must stay within ±${L.pos} block`);
        if (t.name === 'root' ? !fin([k.rot[1]], L.yaw) : !fin(k.rot, L.rot)) e.push(`${at}: ${t.name === 'root' ? 'yaw within ±360°' : 'rotation within ±720°'}`);
        if (!BODY_EASES.includes(k.ease)) e.push(`${at}: unknown ease ${k.ease}`);
      } else {
        if (!fin(k.pos, L.pos)) e.push(`${at}: position within ±128`);
        if (!fin(k.rot, L.rot)) e.push(`${at}: rotation within ±36000°`);
        if (!fin(k.scale, L.scale) || k.scale.some(s => s < 0)) e.push(`${at}: scale 0..32`);
        if (!RIG_EASES.includes(k.ease)) e.push(`${at}: unknown ease ${k.ease}`);
      }
    }
  }
  return e;
}

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
export function split(code) {
  if (code.length <= CHUNK) return [code];
  const data = code.slice(CODE_PREFIX.length), n = Math.ceil(data.length / CHUNK);
  let h = 0;
  for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) | 0;
  const tag = (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
  return Array.from({ length: n }, (_, i) => `${PART_PREFIX}${i + 1}:${n}:${tag}:${data.slice(i * CHUNK, (i + 1) * CHUNK)}`);
}

export { clone };
