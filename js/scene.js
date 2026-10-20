// three.js stage: Minecraft player model (exact StealzersAnim body-rig geometry) and block rigs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';
import { BONES, PIVOTS, sample, channelAt } from './model.js';

// Body bones = the player-head cube remapped by StealzersCore/pack-src/body_rig.py: vanilla player proportions x 0.9375,
// pivot at the joint, limb hanging down. Offsets are the thirdperson_righthand translations (item frame x is mirrored).
export const PX = 0.9375 / 16;
const BONE_DEF = {
  head: { size: [8, 8, 8], uv: [0, 0], outer: [32, 0], cx: 0, up: true },
  torso: { size: [8, 12, 4], uv: [16, 16], outer: [16, 32], cx: 0 },
  arm_r: { size: [4, 12, 4], uv: [40, 16], outer: [40, 32], cx: 1.625 / 16, slimCx: 1.1575 / 16 },
  arm_l: { size: [4, 12, 4], uv: [32, 48], outer: [48, 48], cx: -1.625 / 16, slimCx: -1.1575 / 16 },
  leg_r: { size: [4, 12, 4], uv: [0, 16], outer: [0, 32], cx: -0.125 / 16 },
  leg_l: { size: [4, 12, 4], uv: [16, 48], outer: [0, 48], cx: 0.125 / 16 },
};
const OUTER = 1.0625; // skull hat layer: 8 -> 8.5

/** Box with Minecraft skin UVs. Faces: +X = the model's right side, -Z = front. */
function skinBox(w, h, d, u, v, center, f) {
  const sx = w * PX * f / 2, sy = h * PX * f / 2, sz = d * PX * f / 2;
  const [cx, cy, cz] = center, x0 = cx - sx, x1 = cx + sx, y0 = cy - sy, y1 = cy + sy, z0 = cz - sz, z1 = cz + sz;
  // corners in image order TL, TR, BR, BL and the texture rect (x, y, w, h) in pixels
  const faces = [
    [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [u, v + d, d, h]],
    [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0], [u + d, v + d, w, h]],
    [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0], [u + d + w, v + d, d, h]],
    [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], [u + 2 * d + w, v + d, w, h]],
    [[x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0], [u + d, v, w, d]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [u + d + w, v, w, d]],
  ];
  const pos = [], uv = [], nor = [];
  for (const [tl, tr, br, bl, [rx, ry, rw, rh]] of faces) {
    const U0 = rx / 64, U1 = (rx + rw) / 64, V0 = 1 - ry / 64, V1 = 1 - (ry + rh) / 64;
    const n = new THREE.Vector3().crossVectors(new THREE.Vector3(...bl).sub(new THREE.Vector3(...tl)), new THREE.Vector3(...br).sub(new THREE.Vector3(...tl))).normalize();
    for (const [p, t] of [[tl, [U0, V0]], [bl, [U0, V1]], [br, [U1, V1]], [tl, [U0, V0]], [br, [U1, V1]], [tr, [U1, V0]]]) {
      pos.push(...p); uv.push(...t); nor.push(n.x, n.y, n.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// ------------------------------------------------------------------ vanilla textures (assets mirror) with colour fallback

const ASSETS = 'https://assets.mcasset.cloud/1.21.4/assets/minecraft/textures/';
const DYES = { white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9, yellow: 0xf8c527, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447,
  light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x792aac, blue: 0x35399d, brown: 0x724728, green: 0x546d1b, red: 0xa12722, black: 0x141519 };
export function fallbackColor(id) {
  for (const [dye, c] of Object.entries(DYES).sort((a, b) => b[0].length - a[0].length)) if (id.startsWith(dye + '_')) return c;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.55).getHex();
}
const texCache = new Map();
function loadImg(url) {
  return new Promise(res => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
}
function toTex(img) {
  const t = new THREE.Texture(img);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
  if (img.height > img.width) { t.repeat.set(1, img.width / img.height); t.offset.set(0, 1 - img.width / img.height); } // animated strip: first frame
  t.needsUpdate = true;
  return t;
}
async function firstImg(paths) { for (const p of paths) { const i = await loadImg(ASSETS + p + '.png'); if (i) return i; } return null; }
/** {kind:'block'|'item'|null, side, top} */
export function textures(type, id) {
  const key = type + ':' + id;
  if (!texCache.has(key)) texCache.set(key, (async () => {
    const block = async () => {
      const side = await firstImg([`block/${id}`, `block/${id}_side`, `block/${id}_front`, `block/${id.replace(/_block$/, '')}`]);
      if (!side) return null;
      const top = await firstImg([`block/${id}_top`]);
      return { kind: 'block', side: toTex(side), top: toTex(top || side) };
    };
    if (type === 'item') {
      const it = await firstImg([`item/${id}`]);
      if (it) return { kind: 'item', side: toTex(it), top: null };
    }
    return (await block()) || { kind: null };
  })());
  return texCache.get(key);
}

// ------------------------------------------------------------------ models

function ghostMat(color) { return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }); }

/** Player model: root (yaw) -> offset (root pos) -> bone groups at pivots. */
export function buildBody(skin, slim, ghost) {
  const root = new THREE.Group(), offset = new THREE.Group(), bones = {};
  root.add(offset);
  const inner = ghost ? ghostMat(ghost) : new THREE.MeshLambertMaterial({ map: skin });
  const outer = ghost ? null : new THREE.MeshLambertMaterial({ map: skin, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide, depthWrite: true });
  for (const b of BONES) {
    const def = BONE_DEF[b], g = new THREE.Group();
    g.rotation.order = 'XYZ';
    const w = slim && def.slimCx !== undefined ? 3 : def.size[0], [, h, d] = def.size;
    const cx = slim && def.slimCx !== undefined ? def.slimCx : def.cx;
    const center = [cx, def.up ? h * PX / 2 : -h * PX / 2, 0];
    const m = new THREE.Mesh(skinBox(w, h, d, def.uv[0], def.uv[1], center, 1), inner);
    m.userData.track = b; g.add(m);
    if (outer) { const o = new THREE.Mesh(skinBox(w, h, d, def.outer[0], def.outer[1], center, OUTER), outer); o.userData.track = b; o.renderOrder = 1; g.add(o); }
    g.userData.box = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...center), new THREE.Vector3(w * PX, h * PX, d * PX));
    offset.add(g); bones[b] = g;
  }
  return { kind: 'body', root, offset, bones };
}

/** Block rig: each part is an object whose position is the part centre (Engine.transform), rotation Y->X->Z, scale. */
export function buildRig(project, ghost) {
  const root = new THREE.Group(), parts = {};
  for (const t of project.tracks) {
    const obj = new THREE.Group();
    obj.rotation.order = 'YXZ';
    obj.userData.track = t.name; obj.userData.type = t.type;
    const mesh = ghost ? new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMat(ghost)) : partMesh(t);
    mesh.userData.track = t.name;
    obj.add(mesh);
    root.add(obj); parts[t.name] = obj;
  }
  return { kind: 'rig', root, parts, ghost: !!ghost };
}

function partMesh(t) {
  if (t.type === 'text' || t.type === 'sprite') {
    const label = t.type === 'text' ? String(t.props.text || '').replace(/<[^>]*>/g, '') || 'text' : '✦ ' + (t.props.sprite || 'sprite');
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    ctx.font = '600 40px Geist, system-ui, sans-serif';
    const w = Math.min(1024, Math.ceil(ctx.measureText(label).width) + 24);
    c.width = w; c.height = 56;
    ctx.font = '600 40px Geist, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(0, 0, w, 56);
    ctx.fillStyle = typeof t.props.color === 'string' ? '#' + t.props.color.replace('#', '') : '#fff';
    ctx.textBaseline = 'middle'; ctx.fillText(label, 12, 30);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w / 56 * 0.25, 0.25), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
    m.userData.billboard = (t.props.billboard || 'center') !== 'fixed';
    return m;
  }
  const color = fallbackColor(t.material || 'stone');
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [mat, mat, mat, mat, mat, mat]);
  mesh.userData.loading = true;
  textures(t.type, t.material).then(tx => {
    mesh.userData.loading = false; mesh.userData.missing = !tx.kind;
    if (tx.kind === 'block') {
      const side = new THREE.MeshLambertMaterial({ map: tx.side, transparent: true, alphaTest: 0.1 }), top = new THREE.MeshLambertMaterial({ map: tx.top, transparent: true, alphaTest: 0.1 });
      mesh.material = [side, side, top, top, side, side];
    } else if (tx.kind === 'item') {
      mesh.geometry = new THREE.BoxGeometry(1, 1, 1 / 16);
      const face = new THREE.MeshLambertMaterial({ map: tx.side, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
      const edge = new THREE.MeshBasicMaterial({ visible: false });
      mesh.material = [edge, edge, edge, edge, face, face];
      mesh.rotation.y = Math.PI; // ItemDisplay renders items turned 180 degrees
    }
  });
  return mesh;
}

const rad = d => d * Math.PI / 180;

export function poseModel(model, project, tick) {
  if (model.kind === 'body') {
    const tr = n => project.tracks.find(t => t.name === n);
    const r = sample(tr('root'), tick, 'body');
    model.root.rotation.y = -rad(r.rot[1]);
    model.offset.position.set(...r.pos);
    // v2: root pitch (X) / roll (Z) and uniform scale about the feet, like ActorEngine.pose
    model.offset.rotation.set(rad(r.rot[0]), 0, rad(r.rot[2]), 'XYZ');
    const rs = Math.max(1e-4, r.scale[0]); model.offset.scale.set(rs, rs, rs);
    for (const b of BONES) {
      const k = sample(tr(b), tick, 'body'), g = model.bones[b], p = PIVOTS[b];
      g.position.set(p[0] + k.pos[0], p[1] + k.pos[1], p[2] + k.pos[2]);
      g.rotation.set(rad(k.rot[0]), rad(k.rot[1]), rad(k.rot[2]), 'XYZ');
      g.scale.set(Math.max(1e-4, k.scale[0]), Math.max(1e-4, k.scale[1]), Math.max(1e-4, k.scale[2]));
      g.visible = channelAt(tr(b), 'visible', Math.floor(tick)) !== false;
    }
  } else {
    for (const t of project.tracks) {
      const o = model.parts[t.name];
      if (!o) continue;
      const k = sample(t, tick, 'rig');
      o.visible = channelAt(t, 'visible', tick) !== false;
      if (!model.ghost && (t.type === 'block' || t.type === 'item' || t.type === 'text')) {
        // block/item/text swap keys: rebuild the part's mesh when the shown id or text changes
        const ch = t.type === 'text' ? 'text' : t.type, v = channelAt(t, ch, tick);
        const want = v !== undefined ? String(v) : t.type === 'text' ? String(t.props.text || '') : t.material;
        if (o.userData.shown === undefined) o.userData.shown = t.type === 'text' ? String(t.props.text || '') : t.material;
        if (o.userData.shown !== want) {
          const m = partMesh(t.type === 'text' ? { ...t, props: { ...t.props, text: want } } : { ...t, material: want });
          m.userData.track = t.name;
          o.remove(o.children[0]); o.add(m); o.userData.shown = want;
        }
      }
      o.position.set(...k.pos);
      o.rotation.set(rad(k.rot[0]), rad(k.rot[1]), rad(k.rot[2]), 'YXZ');
      o.scale.set(Math.max(1e-4, k.scale[0]), Math.max(1e-4, k.scale[1]), Math.max(1e-4, k.scale[2]));
    }
  }
}

// ------------------------------------------------------------------ stage

export class Stage {
  constructor(el, events) {
    this.el = el; this.events = events;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio)); r.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(r.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15171c);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5a5f6e, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-3, 6, -4); this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(4, 2, 5); this.scene.add(fill);
    this.floor();
    this.orbit = new OrbitControls(this.camera, r.domElement);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.12; this.orbit.target.set(0, 0.95, 0);
    this.orbit.minDistance = 0.6; this.orbit.maxDistance = 40;
    this.gizmo = new TransformControls(this.camera, r.domElement);
    this.gizmo.setSize(0.75); this.gizmo.setSpace('local');
    this.gizmo.addEventListener('dragging-changed', e => { this.orbit.enabled = !e.value; events.drag(e.value); });
    this.gizmo.addEventListener('objectChange', () => events.change(this.gizmo.object));
    this.scene.add(this.gizmo);
    this.ghosts = [];
    this.outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x8fb4ff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.outline.renderOrder = 10; this.outline.visible = false;
    this.hover = new THREE.LineSegments(this.outline.geometry, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.35 }));
    this.hover.renderOrder = 9; this.hover.visible = false;
    this.ray = new THREE.Raycaster();
    let down = null;
    r.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    r.domElement.addEventListener('pointerup', e => {
      if (!down || this.gizmo.dragging || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
      events.pick(this.pick(e));
    });
    r.domElement.addEventListener('pointermove', e => { if (!e.buttons) this.hoverAt(e); });
    r.domElement.addEventListener('pointerleave', () => { this.hover.visible = false; });
    new ResizeObserver(() => this.resize()).observe(el);
    this.view('front', 'body');
    const loop = () => { requestAnimationFrame(loop); events.frame && events.frame(); this.orbit.update(); this.billboards(); this.render(); };
    loop();
  }

  floor() {
    const g = new THREE.Group();
    const grid = new THREE.GridHelper(16, 16, 0x3a404d, 0x262a33); g.add(grid);
    const fine = new THREE.GridHelper(2, 32, 0x2b303a, 0x2b303a); fine.position.y = 0.0005; fine.material.transparent = true; fine.material.opacity = 0.55; g.add(fine);
    const axis = (a, b, c) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: c })); l.position.y = 0.002; g.add(l); };
    axis([0, 0, 0], [1, 0, 0], 0xe5534b); axis([0, 0, 0], [0, 0, 1], 0x4a8cff);
    const shadow = document.createElement('canvas'); shadow.width = shadow.height = 128;
    const sc = shadow.getContext('2d'), grad = sc.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,.45)'); grad.addColorStop(1, 'rgba(0,0,0,0)'); sc.fillStyle = grad; sc.fillRect(0, 0, 128, 128);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadow), transparent: true, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.001; g.add(blob);
    this.arrow = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-0.12, 0), new THREE.Vector2(0.12, 0), new THREE.Vector2(0, 0.2)])), new THREE.MeshBasicMaterial({ color: 0x7c8cff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    this.arrow.rotation.x = -Math.PI / 2; this.arrow.position.y = 0.003; g.add(this.arrow);
    this.scene.add(g);
  }

  /** Arrow on the floor shows the front: body clips face -Z, rigs +Z (towards you in /animator preview). */
  setFront(kind) {
    const z = kind === 'body' ? -1 : 1;
    this.arrow.position.z = z * 0.62;
    this.arrow.rotation.set(-Math.PI / 2, 0, z < 0 ? Math.PI : 0);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  view(name, kind) {
    // f = the side the model faces (body -Z, rig +Z); the model's own right side is +X for bodies, -X for rigs
    const f = kind === 'body' ? -1 : 1, t = this.orbit.target, d = 4.4;
    const at = { front: [0, 0.3, f * d], right: [-f * d, 0.3, 0], top: [0, d, f * 0.001], persp: [-f * 2.6, 1.2, f * 3.4] }[name] || [0, 0.3, f * d];
    this.camera.position.set(t.x + at[0], t.y + at[1], t.z + at[2]);
    this.camera.lookAt(t);
  }

  /** Fits the selection (or the whole model) in view, keeping the viewing direction. */
  frame(name) {
    const target = name && this.objectFor(name, 'translate');
    const box = new THREE.Box3().setFromObject(target && this.model.kind === 'rig' ? target : this.model.root);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(0.6, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, Math.min(60, r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1));
  }

  setModel(model) {
    if (this.model) this.scene.remove(this.model.root);
    this.model = model; this.scene.add(model.root);
    this.gizmo.detach(); this.outline.visible = false;
  }

  setGhosts(models) {
    for (const g of this.ghosts) this.scene.remove(g.root);
    this.ghosts = models; for (const g of models) this.scene.add(g.root);
  }

  meshes() { const out = []; this.model && this.model.root.traverse(o => { if (o.isMesh && o.userData.track) out.push(o); }); return out; }

  cast(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects(this.meshes(), false)[0];
    return hit ? hit.object.userData.track : null;
  }
  pick(e) { return this.cast(e); }
  hoverAt(e) {
    const t = this.cast(e);
    this.renderer.domElement.style.cursor = t ? 'pointer' : '';
    this.hoverTrack = t;
  }

  objectFor(name, mode) {
    const m = this.model;
    if (!m) return null;
    if (m.kind === 'body') return name === 'root' ? (mode === 'rotate' ? m.root : m.offset) : m.bones[name];
    return m.parts[name];
  }

  attach(name, mode) {
    const o = name && this.objectFor(name, mode);
    this.gizmo.setMode(mode);
    if (!o) { this.gizmo.detach(); return; }
    const rootYaw = this.model.kind === 'body' && name === 'root' && mode === 'rotate';
    this.gizmo.showX = !rootYaw; this.gizmo.showZ = !rootYaw; this.gizmo.showY = true;
    this.gizmo.attach(o);
  }

  boxOf(name) {
    const m = this.model;
    if (!m || !name) return null;
    if (m.kind === 'body') {
      if (name === 'root') return { obj: m.offset, box: new THREE.Box3(new THREE.Vector3(-0.32, 0, -0.16), new THREE.Vector3(0.32, 1.9, 0.16)) };
      return { obj: m.bones[name], box: m.bones[name].userData.box };
    }
    const o = m.parts[name];
    return o ? { obj: o.children[0], box: new THREE.Box3().setFromBufferAttribute(o.children[0].geometry.attributes.position) } : null;
  }

  frameOutline(line, name) {
    const b = this.boxOf(name);
    if (!b) { line.visible = false; return; }
    b.obj.updateWorldMatrix(true, false);
    const size = b.box.getSize(new THREE.Vector3()).addScalar(0.02), c = b.box.getCenter(new THREE.Vector3());
    line.matrixAutoUpdate = false;
    line.matrix.copy(b.obj.matrixWorld).multiply(new THREE.Matrix4().compose(c, new THREE.Quaternion(), size));
    line.visible = true;
    if (!line.parent) this.scene.add(line);
  }

  billboards() {
    const q = new THREE.Quaternion();
    this.scene.traverse(o => {
      if (o.isMesh && o.userData.billboard && o.parent) { o.parent.getWorldQuaternion(q); o.quaternion.copy(q.invert().multiply(this.camera.quaternion)); }
    });
  }

  render() {
    this.frameOutline(this.outline, this.selected);
    if (this.hoverTrack && this.hoverTrack !== this.selected) this.frameOutline(this.hover, this.hoverTrack); else this.hover.visible = false;
    this.renderer.render(this.scene, this.camera);
  }

  screenshot() { return this.renderer.domElement.toDataURL('image/png'); }
}

// ------------------------------------------------------------------ skins

export function skinTexture(img) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  if (img.height === 32) { // legacy 64x32: left limbs reuse the right ones
    x.drawImage(img, 0, 16, 16, 16, 16, 48, 16, 16);
    x.drawImage(img, 40, 16, 16, 16, 32, 48, 16, 16);
  }
  const alpha = (px, py) => x.getImageData(px, py, 1, 1).data[3];
  const slim = img.height === 64 && alpha(54, 20) === 0 && alpha(55, 31) === 0 && alpha(50, 16) === 0;
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
  return { texture: t, slim, canvas: c };
}

export async function loadSkin(name) {
  const sources = name ? [`https://mc-heads.net/skin/${encodeURIComponent(name)}`, `https://minotar.net/skin/${encodeURIComponent(name)}`] : [];
  for (const url of sources) {
    const img = await loadImg(url);
    if (img && img.width === 64 && (img.height === 64 || img.height === 32)) return { ...skinTexture(img), source: url };
  }
  const steve = await loadImg('vendor/steve.png');
  return { ...skinTexture(steve), source: 'default', failed: !!name };
}

export { THREE };
