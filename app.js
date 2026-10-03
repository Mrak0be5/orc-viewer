import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const $ = (s) => document.querySelector(s);
const TARGET_HEIGHT = 2.1;

// ---------- renderer / scene ----------
const view = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#26282c');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const persp = new THREE.PerspectiveCamera(30, 1, 0.01, 200);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
let camera = persp;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 1.5;

const lightRig = new THREE.Group();
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(2.5, 4, 3);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
rimLight.position.set(-3, 2.5, -3);
lightRig.add(keyLight, rimLight);
scene.add(lightRig);

const grid = new THREE.GridHelper(6, 60, 0x55595f, 0x33363b);
scene.add(grid);
const ruler = new THREE.Group();
scene.add(ruler);

const root = new THREE.Group(); // normalized model container
scene.add(root);

// ---------- helper textures ----------
function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const n = 16, s = c.width / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const hue = ((x + y * 3) * 23) % 360;
    g.fillStyle = (x + y) % 2 ? `hsl(${hue} 55% 62%)` : `hsl(${hue} 30% 28%)`;
    g.fillRect(x * s, y * s, s, s);
  }
  g.fillStyle = '#fff'; g.font = `bold ${s * 0.32}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let y = 0; y < n; y += 2) for (let x = 0; x < n; x += 2) g.fillText(String.fromCharCode(65 + x / 2) + (y / 2 + 1), x * s + s / 2, y * s + s / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.flipY = false; t.anisotropy = 8;
  return t;
}
function matcapTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(190, 170, 20, 256, 256, 256);
  grad.addColorStop(0, '#f4efe8'); grad.addColorStop(0.45, '#b9a99a'); grad.addColorStop(0.85, '#5d4f45'); grad.addColorStop(1, '#2a221e');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const CHECKER = checkerTexture();
const MATCAP = matcapTexture();

// Raw texture / single channel display (data values shown as-is, no lighting, no tone mapping).
function dataMaterial(tex, mask, fallback = 1, factor = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tex: { value: tex || null }, hasTex: { value: !!tex }, mask: { value: mask },
      fallback: { value: fallback }, factor: { value: factor },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tex; uniform bool hasTex; uniform vec4 mask; uniform float fallback; uniform float factor; varying vec2 vUv;
      void main() {
        if (!hasTex) { gl_FragColor = vec4(vec3(fallback), 1.0); return; }
        vec4 t = texture2D(tex, vUv);
        if (mask.w < 0.0) { gl_FragColor = vec4(t.rgb, 1.0); return; }
        gl_FragColor = vec4(vec3(dot(t, mask) * factor), 1.0);
      }`,
  });
}

// ---------- shading modes ----------
const useNormalMap = () => $('#normal-map-on').checked;
// PBR mode = a copy of the glTF material with every map the model has; each map has its own checkbox in #pbr-maps.
// Without its map, roughness falls back to 0.6 and metalness to 0 (the glTF factors are 1 when a map drives them).
const PBR_MAPS = [
  { key: 'map', id: 'pm-map', label: 'BaseColor' },
  { key: 'normalMap', id: 'normal-map-on', label: 'Normal', hint: 'и в глине/matcap' },
  { key: 'roughnessMap', id: 'pm-rough', label: 'Roughness' },
  { key: 'metalnessMap', id: 'pm-metal', label: 'Metalness' },
  { key: 'aoMap', id: 'pm-ao', label: 'AO' },
  { key: 'displacementMap', id: 'pm-disp', label: 'Displacement', hint: 'из Height, геометрия ×16' },
  { key: 'emissiveMap', id: 'pm-emissive', label: 'Emissive' },
];
const mapSource = (m, key) => (key === 'normalMap' ? m.userData.normalMap : key === 'displacementMap' ? m.userData.heightTex : m[key]) || null;
const mapOn = (key) => { const el = $('#' + PBR_MAPS.find((d) => d.key === key).id); return !!el && el.checked && !el.disabled; };
function pbrMaterial(orig) {
  let p = orig.userData.pbr;
  if (!p) {
    const ud = orig.userData; orig.userData = {}; // Material.clone JSON-copies userData, which holds textures
    p = orig.clone(); orig.userData = ud; ud.pbr = p; p.userData.src = orig;
  }
  for (const d of PBR_MAPS) p[d.key] = mapOn(d.key) ? mapSource(orig, d.key) : null;
  p.roughness = p.roughnessMap || !orig.roughnessMap ? orig.roughness : 0.6;
  p.metalness = p.metalnessMap || !orig.metalnessMap ? orig.metalness : 0;
  if (p.emissive) p.emissive.copy(p.emissiveMap || !orig.emissiveMap ? orig.emissive : new THREE.Color(0));
  Object.assign(p, p.displacementMap ? dispParams(orig) : { displacementScale: 1, displacementBias: 0 });
  p.needsUpdate = true;
  return p;
}
function fillPbrMaps() {
  const mats = meshes.flatMap((o) => [].concat(o.userData.orig));
  for (const d of PBR_MAPS) {
    const has = mats.filter((m) => mapSource(m, d.key)).length, el = $('#' + d.id);
    el.disabled = !has;
    el.parentElement.classList.toggle('off', !has);
    el.parentElement.querySelector('small').textContent = !has ? 'нет в модели' : has < mats.length ? `${has} из ${mats.length} материалов` : (d.hint || '');
  }
}
{
  const box = $('#pbr-maps');
  for (const d of PBR_MAPS) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" id="${d.id}" checked> ${d.label} <small></small>`;
    l.querySelector('input').onchange = () => applyMode(mode);
    box.appendChild(l);
  }
  $('#pbr-all').onclick = () => { for (const d of PBR_MAPS) $('#' + d.id).checked = true; applyMode(mode); };
  $('#pbr-none').onclick = () => { for (const d of PBR_MAPS) $('#' + d.id).checked = false; applyMode(mode); };
}
const MODES = [
  { id: 'pbr', key: '1', label: 'PBR', make: (m) => (Array.isArray(m) ? m.map(pbrMaterial) : pbrMaterial(m)) },
  { id: 'albedo', key: '2', label: 'Albedo (без света)', make: (m) => new THREE.MeshBasicMaterial({ map: m.map, color: m.color, toneMapped: false }) },
  { id: 'lit-color', key: '3', label: 'Не-PBR (Lambert)', make: (m) => new THREE.MeshLambertMaterial({ map: m.map, color: m.color }) },
  { id: 'clay', key: '4', label: 'Глина', make: (m) => new THREE.MeshStandardMaterial({ color: 0xb8b2aa, roughness: 0.65, metalness: 0, normalMap: useNormalMap() ? m.userData.normalMap : null, normalScale: m.normalScale ? m.normalScale.clone() : new THREE.Vector2(1, 1) }) },
  { id: 'matcap', key: '5', label: 'Matcap', make: (m) => new THREE.MeshMatcapMaterial({ matcap: MATCAP, normalMap: useNormalMap() ? m.userData.normalMap : null, normalScale: m.normalScale ? m.normalScale.clone() : new THREE.Vector2(1, 1) }) },
  { id: 'wire', key: '6', label: 'Сетка', make: () => new THREE.MeshBasicMaterial({ color: 0x9fb4ff, wireframe: true }) },
  { id: 'normals', key: '7', label: 'Нормали (геометрия)', make: () => new THREE.MeshNormalMaterial() },
  { id: 'normal-map', key: '8', label: 'Normal map', make: (m) => dataMaterial(m.userData.normalMap, new THREE.Vector4(0, 0, 0, -1), 0.5) },
  { id: 'rough', key: '9', label: 'Roughness', make: (m) => dataMaterial(m.roughnessMap, new THREE.Vector4(0, 1, 0, 0), m.roughness, m.roughness) },
  { id: 'metal', key: '0', label: 'Metalness', make: (m) => dataMaterial(m.metalnessMap, new THREE.Vector4(0, 0, 1, 0), m.metalness, m.metalness) },
  { id: 'uv', key: 'q', label: 'UV-чекер', make: () => new THREE.MeshBasicMaterial({ map: CHECKER, toneMapped: false }) },
  { id: 'facets', key: 'w', label: 'Грани (flat)', make: () => new THREE.MeshStandardMaterial({ color: 0xb8b2aa, roughness: 0.7, flatShading: true }) },
  { id: 'ao', key: 'a', label: 'AO', make: (m) => dataMaterial(m.aoMap, new THREE.Vector4(1, 0, 0, 0), 1) },
  { id: 'height', key: 'h', label: 'Height', make: (m) => dataMaterial(m.userData.heightTex, new THREE.Vector4(1, 0, 0, 0), 0.5) },
  { id: 'displace', key: 'd', label: 'Дисплейсмент', make: (m) => new THREE.MeshStandardMaterial({
    color: 0xb8b2aa, roughness: 0.65, metalness: 0, displacementMap: m.userData.heightTex || null, ...dispParams(m),
    normalMap: useNormalMap() ? m.userData.normalMap : null, normalScale: m.normalScale ? m.normalScale.clone() : new THREE.Vector2(1, 1) }) },
];
// Height map (entry.heightMap: { src, mm } — zero level 0.5, 1.0 = +mm), kept per material (userData.heightTex /
// heightMm) so an assembly can mix parts with and without one. Displacement preview runs on a 4× midpoint-subdivided
// copy of the mesh; the relief is a few millimetres, so it can be exaggerated.
const hasHeight = () => meshes.some((o) => [].concat(o.userData.orig).some((m) => m.userData.heightTex));
const dispExag = () => +$('#disp-exag').value;
function dispParams(m) {
  const mm = (m && m.userData.heightMm) || 0, h = mm / 1000 * dispExag();
  return { displacementScale: 2 * h, displacementBias: -h };
}
function subdivide(g) {
  const idx = g.index.array, n = g.attributes.position.count;
  const names = ['position', 'normal', 'uv', 'tangent'].filter((k) => g.attributes[k]);
  const src = names.map((k) => g.attributes[k]), cap = n + idx.length;
  const dst = src.map((a) => new Float32Array(cap * a.itemSize));
  src.forEach((a, i) => { for (let v = 0; v < n; v++) for (let c = 0; c < a.itemSize; c++) dst[i][v * a.itemSize + c] = a.getComponent(v, c); });
  const edges = new Map(), out = new Uint32Array(idx.length * 4);
  let count = n, o = 0;
  const mid = (a, b) => {
    const key = a < b ? a * cap + b : b * cap + a;
    let v = edges.get(key);
    if (v !== undefined) return v;
    v = count++; edges.set(key, v);
    src.forEach((attr, i) => {
      const s = attr.itemSize, d = dst[i];
      for (let c = 0; c < s; c++) d[v * s + c] = (d[a * s + c] + d[b * s + c]) / 2;
      if (names[i] === 'normal') { const l = Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) || 1; for (let c = 0; c < 3; c++) d[v * 3 + c] /= l; }
    });
    return v;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o); o += 12;
  }
  const r = new THREE.BufferGeometry();
  names.forEach((k, i) => r.setAttribute(k, new THREE.BufferAttribute(dst[i].slice(0, count * src[i].itemSize), src[i].itemSize)));
  r.setIndex(new THREE.BufferAttribute(out, 1));
  return r;
}
const denseOf = new WeakMap();   // base geometry -> its subdivided displacement copy
function setDisplaceGeometry(on) {
  for (const mesh of meshes) {
    const u = mesh.userData;
    if (![].concat(u.orig).some((m) => m.userData.heightTex)) continue;
    if (!u.baseGeom) u.baseGeom = mesh.geometry;
    if (on && !denseOf.has(u.baseGeom)) denseOf.set(u.baseGeom, subdivide(subdivide(u.baseGeom)));
    mesh.geometry = on ? denseOf.get(u.baseGeom) : u.baseGeom;
  }
}
let mode = 'pbr';
const meshes = [];
const modeCache = new Map(); // mesh.uuid + mode -> material
const wireBaseMat = new THREE.MeshBasicMaterial({ color: 0x1f2125, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const quadWireMat = new THREE.LineBasicMaterial({ color: 0x9fb4ff });
const quadOverlayMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false });

// Quad meshes arrive triangulated; each quad is written as two consecutive triangles sharing an edge
// (mixed meshes interleave lone triangles, so walk the list instead of assuming even pairs).
// Rebuild the quad edges (dropping the diagonals) so the wireframe shows the real topology.
function quadLines(mesh) {
  const g = mesh.geometry, idx = g.index && g.index.array;
  if (!idx) return null;
  const tris = idx.length / 3, seen = new Set(), out = [];
  let quads = 0, lone = 0;
  const add = (a, b) => { const k = a < b ? a * 4294967296 + b : b * 4294967296 + a; if (!seen.has(k)) { seen.add(k); out.push(a, b); } };
  for (let t = 0; t < tris;) {
    const A = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const B = t + 1 < tris ? [idx[t * 3 + 3], idx[t * 3 + 4], idx[t * 3 + 5]] : [];
    const shared = A.filter((v) => B.includes(v));
    const isQuad = shared.length === 2;
    for (const T of isQuad ? [A, B] : [A]) for (let i = 0; i < 3; i++) {
      const a = T[i], b = T[(i + 1) % 3];
      if (isQuad && shared.includes(a) && shared.includes(b)) continue;
      add(a, b);
    }
    if (isQuad) { quads++; t += 2; } else { lone++; t += 1; }
  }
  if (quads < (quads + lone) * 0.6) return null; // not a quad mesh
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', g.attributes.position);
  lg.setIndex(out);
  const lines = new THREE.LineSegments(lg, quadOverlayMat);
  lines.renderOrder = 1;
  lines.userData.quads = quads;
  return lines;
}

function applyMode(id) {
  const height = hasHeight();
  if ((id === 'height' || id === 'displace') && !height) id = 'pbr';
  mode = id;
  setDisplaceGeometry(id === 'displace' || (id === 'pbr' && mapOn('displacementMap')));
  for (const mesh of meshes) {
    const orig = mesh.userData.orig;
    if (id === 'pbr') { mesh.material = MODES[0].make(orig); continue; }
    if (id === 'wire' && mesh.userData.quadLines) { mesh.material = wireBaseMat; continue; }
    const k = mesh.uuid + id + useNormalMap();
    if (!modeCache.has(k)) { const made = MODES.find((m) => m.id === id).make(orig); made.userData.src = orig; modeCache.set(k, made); }
    mesh.material = modeCache.get(k);
  }
  for (const b of document.querySelectorAll('#modes button')) {
    b.classList.toggle('on', b.dataset.mode === id);
    if (b.dataset.mode === 'height' || b.dataset.mode === 'displace') b.disabled = !height;
  }
  $('#disp-box').hidden = !height;
  applyOverlay();
}

const modesBox = $('#modes');
for (const m of MODES) {
  const b = document.createElement('button');
  b.dataset.mode = m.id;
  b.innerHTML = `${m.label}<kbd>${m.key.toUpperCase()}</kbd>`;
  b.onclick = () => applyMode(m.id);
  modesBox.appendChild(b);
}

// wireframe overlay: a second draw of the same geometry
const overlayMat = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.12, depthWrite: false });
function applyOverlay() {
  const on = $('#wire-overlay').checked && mode !== 'wire';
  for (const mesh of meshes) {
    const q = mesh.userData.quadLines;
    if (q) {
      q.visible = on || mode === 'wire';
      q.material = mode === 'wire' ? quadWireMat : quadOverlayMat;
      for (const mat of [].concat(mesh.material)) { mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1; }
      continue;
    }
    let o = mesh.userData.overlay;
    if (on && !o) {
      o = new THREE.Mesh(mesh.userData.baseGeom || mesh.geometry, overlayMat);
      o.renderOrder = 1;
      mesh.add(o);
      mesh.userData.overlay = o;
    }
    if (o) o.visible = on;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) { mat.polygonOffset = on; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1; }
  }
}

// ---------- model loading ----------
const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
let manifest = { models: [] };
let current = null;
let rawBox = new THREE.Box3();

async function fetchParts(parts, onBytes) {
  const bufs = [];
  let got = 0;
  for (const url of parts) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bufs.push(value);
      got += value.length;
      onBytes(value.length);
    }
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const b of bufs) { out.set(b, o); o += b.length; }
  return out.buffer;
}

function setProgress(f, text) {
  $('#loading').hidden = false;
  $('#bar i').style.width = `${Math.round(f * 100)}%`;
  $('#loading-text').textContent = text;
}
const mb = (n) => (n / 1048576).toFixed(1);
// small non-blocking badge while the full-resolution textures stream in behind the preview
function setHqBadge(text) {
  let b = $('#hq-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'hq-badge';
    b.style.cssText = 'position:absolute;left:50%;bottom:14px;transform:translateX(-50%);padding:5px 12px;border-radius:12px;background:rgba(0,0,0,.6);color:#ddd;font:12px system-ui,sans-serif;pointer-events:none;z-index:5';
    $('#view').append(b);
  }
  b.hidden = !text;
  b.textContent = text || '';
}

// An entry is one GLB (entry.parts) or an assembly: entry.assembly = [{ id, name, label, pos, rot, scale, mirror }], every item
// another entry of models.json placed in the body's space (metres, Y up, facing +Z; rot in degrees, XYZ; mirror reflects across x = 0).
// entry.preview = { parts, bytes, heightSrc } is a light copy (2K textures) shown first; the full textures replace it in the background.
const byId = (id) => manifest.models.find((m) => m.id === id);
const PREVIEW_MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
let loadToken = 0;
let curScene = null;
let bufCache = new Map(), texCache = new Map();   // per loadModel: mirrored pairs download one file once
const cached = (cache, key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
const loadHeight = (src) => cached(texCache, src, async () => {
  const t = await new THREE.TextureLoader().loadAsync(src);
  t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
});
const srcBytes = (e) => (e.preview ? e.preview.bytes : e.bytes);
async function loadSource(e, onBytes) {
  const p = e.preview;
  const heightSrc = e.heightMap && ((p && p.heightSrc) || e.heightMap.src);
  const heightTex = heightSrc ? await loadHeight(heightSrc) : null;
  const parts = p ? p.parts : e.parts;
  const buffer = await cached(bufCache, parts.join('|'), () => fetchParts(parts, onBytes));
  setProgress(1, 'Распаковка…');
  const gltf = await loader.parseAsync(buffer, '');
  let idx = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { m.userData.normalMap = m.normalMap; if (heightTex) { m.userData.heightTex = heightTex; m.userData.heightMm = e.heightMap.mm; } }
    o.userData.orig = o.material;
    o.userData.srcId = e.id;
    o.userData.srcIdx = idx++;
    if (e.quads) {
      const q = quadLines(o);
      if (q) { q.visible = false; o.add(q); o.userData.quadLines = q; }
    }
    meshes.push(o);
  });
  return gltf.scene;
}
function liveTextures() {
  const s = new Set();
  for (const o of meshes) for (const m of [].concat(o.userData.orig)) {
    for (const k of PREVIEW_MAPS) if (m[k]) s.add(m[k]);
    if (m.userData.normalMap) s.add(m.userData.normalMap);
    if (m.userData.heightTex) s.add(m.userData.heightTex);
  }
  return s;
}
async function loadModel(entry) {
  const token = ++loadToken;
  current = entry;
  $('#model-title').textContent = `${entry.part || ''} · ${entry.label || entry.title}`;
  $('#model-note').textContent = entry.note || '';
  markNav();
  history.replaceState(null, '', `?m=${entry.id}`);
  setHqBadge('');
  for (const t of liveTextures()) t.dispose();
  for (const m of modeCache.values()) m.dispose();
  root.clear(); meshes.length = 0; modeCache.clear();
  bufCache = new Map(); texCache = new Map();
  const items = entry.assembly ? entry.assembly.map((a) => ({ a, e: byId(a.id) })).filter((x) => x.e) : [{ a: null, e: entry }];
  const uniq = [...new Map(items.map((x) => [x.e.id, x.e])).values()];
  const total = uniq.reduce((n, e) => n + srcBytes(e), 0);
  let got = 0;
  const onBytes = (n) => { got += n; setProgress(total ? got / total : 0, `Загрузка ${mb(got)} / ${mb(total)} МБ`); };
  let gscene;
  if (entry.assembly) {
    gscene = new THREE.Group();
    for (const { a, e } of items) {
      const part = new THREE.Group();
      part.add(await loadSource(e, onBytes));
      if (token !== loadToken) return;
      part.name = a.name || e.id;
      part.userData.label = a.label || e.part;
      part.position.fromArray(a.pos || [0, 0, 0]);
      part.rotation.set(...(a.rot || [0, 0, 0]).map(THREE.MathUtils.degToRad), 'ZYX');   // = Blender Euler 'XYZ' (asm/assemble.py)
      part.scale.setScalar(a.scale || 1);
      if (a.mirror) {   // left-hand copy of a right-hand part: reflect the placed part across x = 0
        part.updateMatrix();
        MIRROR_X.clone().multiply(part.matrix).decompose(part.position, part.quaternion, part.scale);
        flipMirroredNormalMaps(part);
      }
      part.traverse((o) => { if (o.isMesh) Object.assign(o.userData, { partName: part.name, texPart: a.group || part.userData.label }); });
      part.visible = !a.hidden;
      gscene.add(part);
    }
  } else {
    gscene = await loadSource(entry, onBytes);
    if (token !== loadToken) return;
  }
  bufCache = new Map();
  curScene = gscene;
  const gltf = { scene: gscene };
  // Tripo exports face +X; entry.yaw turns the model to face +Z (the viewer's "front").
  const model = new THREE.Group();
  gscene.rotation.y = THREE.MathUtils.degToRad(entry.yaw || 0);
  model.add(gscene);
  root.add(model);
  rawBox = new THREE.Box3().setFromObject(model);
  normalize();
  fillPbrMaps();
  applyMode(mode);
  fillStats(gltf, entry);
  fillPolys(gltf);
  fillTextures();
  fillRefs(entry);
  editOnLoad(gscene);
  fillAssembly(gscene);
  setCamera('front');
  $('#loading').hidden = true;
  const full = uniq.filter((e) => e.preview);
  if (full.length) upgradeTextures(full, token).catch((err) => { console.error(err); setHqBadge(''); });
}
// Swap the preview textures for the full ones. The full GLB has the same meshes in the same order, only the images differ,
// so mesh n of a source gets the maps of mesh n of its full file; mirrored copies share them.
async function upgradeTextures(entries, token) {
  const total = entries.reduce((n, e) => n + e.bytes, 0);
  let got = 0;
  const badge = () => setHqBadge(`Полные текстуры 8K: ${mb(got)} / ${mb(total)} МБ`);
  badge();
  for (const e of entries) {
    const buffer = await fetchParts(e.parts, (n) => { got += n; if (token === loadToken) badge(); });
    if (token !== loadToken) return;
    const gltf = await loader.parseAsync(buffer, '');
    const heightTex = e.heightMap ? await new THREE.TextureLoader().loadAsync(e.heightMap.src) : null;
    const full = [];
    gltf.scene.traverse((o) => { if (o.isMesh) { full.push([].concat(o.material)); o.geometry.dispose(); } });
    if (token !== loadToken) {
      for (const ms of full) for (const m of ms) { for (const k of PREVIEW_MAPS) m[k]?.dispose(); m.dispose(); }
      heightTex?.dispose();
      return;
    }
    if (heightTex) { heightTex.flipY = false; heightTex.colorSpace = THREE.NoColorSpace; heightTex.needsUpdate = true; }
    const old = new Set();
    for (const o of meshes) {
      if (o.userData.srcId !== e.id) continue;
      const src = full[o.userData.srcIdx];
      if (!src) continue;
      [].concat(o.userData.orig).forEach((m, i) => {
        const f = src[i];
        if (!f) return;
        for (const k of PREVIEW_MAPS) if (m[k] && f[k]) { old.add(m[k]); m[k] = f[k]; }
        if (m.userData.normalMap && f.normalMap) { old.add(m.userData.normalMap); m.userData.normalMap = f.normalMap; }
        if (heightTex && m.userData.heightTex) { old.add(m.userData.heightTex); m.userData.heightTex = heightTex; }
      });
    }
    for (const ms of full) for (const m of ms) m.dispose();
    for (const m of modeCache.values()) m.dispose();
    modeCache.clear();
    applyMode(mode);
    for (const t of old) t.dispose();
    fillTextures();
  }
  if (token === loadToken) setHqBadge('');
}
// three r170 builds the bitangent as cross(normal, tangent) * tangent.w after the model transform, and a reflection turns
// that cross product around: a mirrored part with glTF tangents would get its normal map's green channel inverted.
// Meshes without tangents use screen-space derivatives, which handle the reflection themselves.
function flipMirroredNormalMaps(part) {
  part.traverse((o) => {
    if (o.isMesh && o.geometry.attributes.tangent) for (const m of [].concat(o.material)) m.normalScale.y *= -1;
  });
}
// assembly: one checkbox per part to show / hide it
function fillAssembly(gscene) {
  const box = $('#asm-box');
  if (!box) return;
  box.hidden = !current.assembly;
  $('#asm-parts').innerHTML = '';
  if (!current.assembly) return;
  for (const p of gscene.children) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox'; c.checked = p.visible;
    c.onchange = () => { p.visible = c.checked; if (!c.checked && edit.sel === p) select(null); };
    l.append(c, ` ${partLabel(p)}`);
    $('#asm-parts').append(l);
  }
}

// Center on X/Z, feet at 0, optional scale to 2.10 m.
function normalize() {
  const size = rawBox.getSize(new THREE.Vector3());
  const s = !current.assembly && $('#scale21').checked && size.y > 0 ? (current.height || TARGET_HEIGHT) / size.y : 1;
  const model = root.children[0];
  if (!model) return;
  model.scale.setScalar(s);
  if (current.assembly) { model.position.set(0, 0, 0); buildRuler(current.height || size.y, size.x / 2); return; }  // already in the body's space
  const c = rawBox.getCenter(new THREE.Vector3());
  model.position.set(-c.x * s, -rawBox.min.y * s, -c.z * s);
  buildRuler(size.y * s, size.x * s / 2);
}

function label(text, size = 0.06) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#e6e6e6'; g.font = 'bold 40px sans-serif'; g.textBaseline = 'middle';
  g.fillText(text, 4, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, toneMapped: false }));
  sp.scale.set(size * 4, size, 1);
  sp.center.set(0, 0.5);
  return sp;
}

function buildRuler(h, halfW) {
  ruler.clear();
  const x = halfW + 0.25;
  const pts = [new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, h, 0)];
  const step = h > 1.2 ? 0.1 : h > 0.3 ? 0.05 : 0.01;
  for (let y = 0; y <= h + 1e-6; y += step) {
    const major = Math.abs(y / (step * 5) - Math.round(y / (step * 5))) < 1e-6;
    pts.push(new THREE.Vector3(x, y, 0), new THREE.Vector3(x - (major ? 0.08 : 0.04), y, 0));
    if (major && y > 0) { const l = label(`${y.toFixed(y < 1 ? 2 : 1)} м`, h * 0.025); l.position.set(x + 0.03, y, 0); ruler.add(l); }
  }
  pts.push(new THREE.Vector3(x - 0.15, h, 0), new THREE.Vector3(x + 0.02, h, 0));
  const top = label(`${h.toFixed(3)} м`, h * 0.03);
  top.position.set(x + 0.03, h + h * 0.02, 0);
  ruler.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd0d4da })), top);
  ruler.visible = $('#ruler').checked;
}

// ---------- panels ----------
function fillStats(gltf, entry) {
  let tris = 0, verts = 0, meshesN = 0;
  const mats = new Set(), texs = new Set();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    meshesN++;
    const g = o.userData.baseGeom || o.geometry; // not the subdivided displacement copy
    verts += g.attributes.position.count;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const m of [].concat(o.material)) {
      mats.add(m);
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) texs.add(m[k]);
      if (m.userData.normalMap) texs.add(m.userData.normalMap);
    }
  });
  const size = rawBox.getSize(new THREE.Vector3());
  const quads = meshes.reduce((n, m) => n + (m.userData.quadLines ? m.userData.quadLines.userData.quads : 0), 0);
  const rows = [
    ...(quads ? [['Квады', quads.toLocaleString('ru-RU')]] : []),
    ['Треугольники', Math.round(tris).toLocaleString('ru-RU')],
    ['Вершины', verts.toLocaleString('ru-RU')],
    ['Меши / материалы', `${meshesN} / ${mats.size}`],
    ['Текстуры', [...texs].map((t) => `${t.image?.width ?? '?'}²`).join(', ') || '—'],
    ['Размер файла', `${(entry.bytes / 1048576).toFixed(1)} МБ`],
    ['Габариты (исходные)', `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}`],
    ['Источник', entry.source || '—'],
  ];
  $('#stats').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
}

// Polycount of the whole model and of every part (the GLB's top-level nodes, as in the edit mode), a quad = 1 polygon:
// exact counts from Blender when the export wrote them into the node extras (poly_faces / poly_quads / poly_tris),
// else the quads are paired back from the triangles (Blender writes a quad as two consecutive triangles).
function pairQuads(g) {
  const idx = g.index && g.index.array;
  const n = idx ? idx.length / 3 : g.attributes.position.count / 3;
  if (!idx) return { quads: 0, lone: n };
  let quads = 0, lone = 0;
  for (let t = 0; t < n;) {
    const A = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const shared = t + 1 < n ? [idx[t * 3 + 3], idx[t * 3 + 4], idx[t * 3 + 5]].filter((v) => A.includes(v)).length : 0;
    if (shared === 2) { quads++; t += 2; } else { lone++; t += 1; }
  }
  return { quads, lone };
}
function meshCounts(obj) {
  let tris = 0, verts = 0, quads = 0, lone = 0, faces = 0, xq = 0, xt = 0;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.userData.baseGeom || o.geometry; // not the subdivided displacement copy
    verts += g.attributes.position.count;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const q = pairQuads(g);
    quads += q.quads; lone += q.lone;
  });
  const nodes = [];
  obj.traverse((o) => { if (Number.isFinite(o.userData?.poly_faces)) nodes.push(o); });
  if (nodes.length) {
    for (const o of nodes) { faces += o.userData.poly_faces; xq += o.userData.poly_quads; xt += o.userData.poly_tris; }
    return { tris: Math.round(tris), verts, polys: faces, quads: xq, lone: xt, exact: true };
  }
  return { tris: Math.round(tris), verts, polys: quads + lone, quads, lone, exact: false };
}
function fillPolys(gltf) {
  const fmt = (n) => n.toLocaleString('ru-RU');
  const total = meshCounts(gltf.scene);
  // head to toe (by the top of each part), a right / left pair next to each other
  const parts = gltf.scene.children.map((o) => ({ o, top: new THREE.Box3().setFromObject(o).max.y, ...meshCounts(o) }))
    .filter((p) => p.tris > 0)
    .sort((a, b) => (Math.abs(a.top - b.top) > 0.02 ? b.top - a.top : a.o.name.localeCompare(b.o.name)));
  const row = (name, c, cls = '') => {
    const pct = total.polys ? (c.polys / total.polys) * 100 : 0;
    return `<tr class="${cls}"><td>${name}${cls ? '' : `<i style="width:${pct.toFixed(1)}%"></i>`}</td><td>${fmt(c.polys)}</td>` +
           `<td>${fmt(c.quads)}</td><td>${cls ? '100' : pct < 1 ? pct.toFixed(1) : Math.round(pct)}%</td></tr>`;
  };
  $('#polys').innerHTML = '<tr class="head"><td>Часть</td><td>Полиг.</td><td>Квады</td><td>Доля</td></tr>' +
    row('Вся модель', total, 'total') + (parts.length > 1 ? parts.map((p) => row(partLabel(p.o), p)).join('') : '');
  const how = total.exact ? 'точные числа граней из Blender' : 'квады собраны из пар треугольников, ±несколько %';
  $('#polys-hint').textContent = `${parts.length > 1 ? `Частей: ${parts.length}. ` : 'Модель из одной части. '}Полигоны: квад = 1 (${how}); ` +
    `остальное — треугольники: ${fmt(total.lone)}. В движке ${fmt(total.tris)} треуг. — в «Статистике».`;
}

const TEX_NAMES = { map: 'BaseColor', normalMap: 'Normal', aoMap: 'AO', roughnessMap: 'Metal/Rough', metalnessMap: 'Metal/Rough', emissiveMap: 'Emissive' };
function drawTex(tex, canvas, max) {
  const img = tex.image;
  const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
  canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
  const g = canvas.getContext('2d');
  // glTF textures are stored with flipY = false; draw them the way they sit in the file.
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
}
// One figure per texture. glTF packs AO, roughness and metalness into one texture, so the names of every slot it fills
// are joined ("AO + Metal/Rough"). In an assembly captions start with the part, and a part loaded twice (a mirrored
// pair) is listed once.
function fillTextures() {
  const box = $('#textures');
  box.innerHTML = '';
  const seen = new Map(), firstPart = new Map();
  for (const mesh of meshes) {
    const u = mesh.userData;
    if (!firstPart.has(u.srcId)) firstPart.set(u.srcId, u.partName);
    if (firstPart.get(u.srcId) !== u.partName) continue;
    const add = (t, name) => {
      if (!t) return;
      if (!seen.has(t.uuid)) seen.set(t.uuid, { t, part: u.texPart, names: new Set() });
      seen.get(t.uuid).names.add(name);
    };
    for (const m of [].concat(u.orig)) {
      for (const k of Object.keys(TEX_NAMES)) add(k === 'normalMap' ? m.userData.normalMap : m[k], TEX_NAMES[k]);
      if (m.userData.heightTex) add(m.userData.heightTex, `Height (±${Math.round(m.userData.heightMm * 1000) / 1000} мм)`);
    }
  }
  for (const { t, part, names } of seen.values()) {
    const fig = document.createElement('figure');
    const cv = document.createElement('canvas');
    drawTex(t, cv, 256);
    fig.append(cv);
    const cap = document.createElement('figcaption');
    cap.textContent = `${part ? `${part} · ` : ''}${[...names].join(' + ')} ${t.image.width}×${t.image.height}`;
    fig.append(cap);
    fig.onclick = () => openLightbox({ tex: t, caption: cap.textContent });
    box.append(fig);
  }
}
function fillRefs(entry) {
  const box = $('#refs');
  box.innerHTML = '';
  const t = entry.tripo || {};
  $('#tripo-info').textContent = [t.settings, t.task && `Задача: ${t.task}`, t.credits && `Стоимость: ${t.credits} кр.`].filter(Boolean).join(' · ');
  const inputs = t.inputs || (entry.refs || []).map((src) => ({ src }));
  for (const r of inputs) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = r.src; img.loading = 'lazy';
    const cap = document.createElement('figcaption');
    const name = r.src.split('/').pop();
    cap.innerHTML = r.slot ? `<b>${r.slot}</b> ${name}` : name;
    fig.append(img, cap);
    fig.onclick = () => openLightbox({ src: r.src, caption: `${r.slot ? r.slot + ' — ' : ''}${name}` });
    box.append(fig);
  }
}

// ---------- part / version navigation ----------
function buildNav() {
  const parts = [...new Set(manifest.models.map((m) => m.part || 'Модель'))];
  $('#part-tabs').innerHTML = '';
  for (const p of parts) {
    const b = document.createElement('button');
    b.textContent = p;
    b.dataset.part = p;
    b.onclick = () => loadModel(manifest.models.find((m) => (m.part || 'Модель') === p)).catch(showError);
    $('#part-tabs').append(b);
  }
}
function markNav() {
  const part = current.part || 'Модель';
  for (const b of document.querySelectorAll('#part-tabs button')) b.classList.toggle('on', b.dataset.part === part);
  const box = $('#versions');
  box.innerHTML = '';
  for (const m of manifest.models.filter((x) => (x.part || 'Модель') === part)) {
    const b = document.createElement('button');
    b.innerHTML = `${m.label || m.title}${m.polys ? `<small>${m.polys}</small>` : ''}`;
    b.classList.toggle('on', m.id === current.id);
    b.onclick = () => loadModel(m).catch(showError);
    box.append(b);
  }
}
function showError(err) { setProgress(0, `Ошибка: ${err.message}`); }
function openLightbox({ src, tex, caption }) {
  const lb = $('#lightbox');
  const img = lb.querySelector('img'), cv = lb.querySelector('canvas');
  img.hidden = !src; cv.hidden = !tex;
  if (src) img.src = src;
  if (tex) drawTex(tex, cv, 4096);
  lb.querySelector('span').textContent = caption;
  lb.hidden = false;
}
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };

// ---------- camera ----------
function modelBox() { return new THREE.Box3().setFromObject(root); }
function setCamera(name) {
  const box = modelBox();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const h = size.y, aspect = view.clientWidth / view.clientHeight || 1;
  const fit = (w) => Math.max(h, w / aspect) * 1.16;   // the height and the width across the view (wide parts: horns)
  let target = c.clone(), dir, span = fit(size.x);
  switch (name) {
    case 'front': dir = new THREE.Vector3(0, 0, 1); break;
    case 'back': dir = new THREE.Vector3(0, 0, -1); break;
    case 'left': dir = new THREE.Vector3(1, 0, 0); span = fit(size.z); break; // character's left side (model faces +Z)
    case 'right': dir = new THREE.Vector3(-1, 0, 0); span = fit(size.z); break;
    case 'top': dir = new THREE.Vector3(0, 1, 0.001); span = Math.max(size.x, size.z) * 1.2; break;
    case 'three': dir = new THREE.Vector3(0.8, 0.25, 1).normalize(); span = fit(size.x * 0.781 + size.z * 0.625); break;
    case 'face': {
      const f = (current && current.face) || { top: 0.075, span: 0.2 };
      dir = new THREE.Vector3(0.35, 0.05, 1).normalize(); target = new THREE.Vector3(c.x, box.max.y - h * f.top, c.z); span = h * f.span; break;
    }
  }
  const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
  persp.position.copy(target).addScaledVector(dir, dist);
  ortho.position.copy(target).addScaledVector(dir, Math.max(dist, h * 3));
  ortho.userData.span = span;
  ortho.zoom = 1;
  controls.target.copy(target);
  resize();
  camera.lookAt(target);
  controls.update();
}
for (const b of document.querySelectorAll('[data-cam]')) b.onclick = () => setCamera(b.dataset.cam);
$('#ortho').onclick = () => {
  const toOrtho = camera === persp;
  const from = camera;
  camera = toOrtho ? ortho : persp;
  const dir = from.position.clone().sub(controls.target).normalize();
  const dist = toOrtho ? Math.max(from.position.distanceTo(controls.target), 5) : (ortho.userData.span || 2) / 2 / Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) / ortho.zoom;
  if (toOrtho) ortho.userData.span = 2 * from.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  if (toOrtho) ortho.zoom = 1;
  controls.object = camera;
  $('#ortho').textContent = `Орто: ${toOrtho ? 'вкл' : 'выкл'}`;
  $('#ortho').classList.toggle('on', toOrtho);
  resize();
  controls.update();
};

// double click: orbit around the clicked point
const ray = new THREE.Raycaster();
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };  // hidden assembly parts can't be hit
renderer.domElement.addEventListener('dblclick', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(meshes, false).find((h) => shown(h.object));
  if (!hit) return;
  const shift = hit.point.clone().sub(controls.target);
  controls.target.add(shift);
  camera.position.add(shift);
  controls.update();
});

// ---------- controls ----------
$('#wire-overlay').onchange = applyOverlay;
$('#disp-exag').oninput = () => {
  $('#disp-exag-v').textContent = `×${dispExag()}`;
  for (const [k, m] of modeCache) if (m.displacementMap) Object.assign(m, dispParams(m.userData.src));
  for (const o of meshes) for (const m of [].concat(o.userData.orig)) if (m.userData.pbr?.displacementMap) Object.assign(m.userData.pbr, dispParams(m));
};
$('#scale21').onchange = () => { normalize(); setCamera('front'); };
$('#ruler').onchange = (e) => { ruler.visible = e.target.checked; };
$('#grid-on').onchange = (e) => { grid.visible = e.target.checked; };
$('#autorotate').onchange = (e) => { controls.autoRotate = e.target.checked; };
$('#env').oninput = (e) => { scene.environmentIntensity = +e.target.value; };
$('#key').oninput = (e) => { keyLight.intensity = +e.target.value; };
$('#rot').oninput = (e) => { lightRig.rotation.y = THREE.MathUtils.degToRad(+e.target.value); };
$('#exposure').oninput = (e) => { renderer.toneMappingExposure = +e.target.value; };
$('#tonemap').onchange = (e) => {
  renderer.toneMapping = { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, none: THREE.NoToneMapping }[e.target.value];
  for (const mesh of meshes) [].concat(mesh.material).forEach((m) => { m.needsUpdate = true; });
};
$('#bg').onchange = (e) => { scene.background = new THREE.Color(e.target.value); };
lightRig.rotation.y = THREE.MathUtils.degToRad(35);
$('#shot').onclick = () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `${current ? current.id : 'model'}-${mode}.png`;
  a.click();
};
addEventListener('keydown', (e) => {
  if (edit.on && editKey(e)) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  const m = MODES.find((x) => x.key === k);
  if (m) applyMode(m.id);
  if (k === 'e') { $('#wire-overlay').checked = !$('#wire-overlay').checked; applyOverlay(); }
  if (k === 'r') { const c = $('#autorotate'); c.checked = !c.checked; controls.autoRotate = c.checked; }
  if (e.key === 'Escape') $('#lightbox').hidden = true;
});

// ---------- edit mode: pick a part, move / rotate / scale it, save ----------
// Parts are the top-level nodes of the loaded GLB (e.g. Orc_Base, Hair_01). Transforms are kept in GLB space
// (metres, Y up, model facing +Z); saved edits live in localStorage per model and are re-applied on load,
// «Сохранить» also downloads them as JSON so they can be applied to the source assets.
const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.9);
tc.enabled = false;
scene.add(tc.getHelper());
const editBox = new THREE.Box3Helper(new THREE.Box3(), 0xffc24d);
editBox.visible = false;
scene.add(editBox);
const edit = { on: false, parts: [], sel: null, dirty: false };
const PART_NAMES = { Orc_Base: 'Тело + голова', Skirt_T: 'Юбка' };
const GEAR_NAMES = { Pauldron: 'Наплечник', Bracer: 'Наруч', Boot: 'Ботинок' };
const SIDE = { R: 'правый', L: 'левый' };
function partLabel(o) {
  if (o.userData.label) return o.userData.label;
  if (PART_NAMES[o.name]) return PART_NAMES[o.name];
  let m = /^Hair_(\d+)/.exec(o.name);
  if (m) return `Волосы ${m[1]}`;
  m = /^Boot_(\d+)_([RL])$/.exec(o.name);
  if (m) return `Ботинок ${m[1]} ${SIDE[m[2]]}`;
  m = /^Bracer_(\d+)_([RL])$/.exec(o.name);
  if (m) return `Наруч ${m[1]} ${SIDE[m[2]]}`;
  m = /^(Pauldron|Bracer|Boot)_T_([RL])$/.exec(o.name);        // gear cut out of the Tripo models
  if (m) return `${GEAR_NAMES[m[1]]} ${SIDE[m[2]]}`;
  return o.name || 'Деталь';
}
// left/right pairs (<name>_R / <name>_L, mirror images across x = 0): editing one moves the other mirrored
const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
function linkPairs() {
  for (const p of edit.parts) {
    const m = /^(.*)_([RL])$/.exec(p.name);
    const q = m && edit.parts.find((x) => x.name === `${m[1]}_${m[2] === 'R' ? 'L' : 'R'}`);
    p.userData.partner = q || null;
    // fixed local reflection K with  partner = MIRROR_X * part * K  (from the loaded placement)
    if (q) p.userData.mirrorK = MIRROR_X.clone().multiply(p.userData.base.m).invert().multiply(q.userData.base.m);
  }
}
function syncMirror(p) {
  const q = p && p.userData.partner;
  if (!q || !$('#edit-mirror').checked) return;
  p.updateMatrix();
  MIRROR_X.clone().multiply(p.matrix).multiply(p.userData.mirrorK).decompose(q.position, q.quaternion, q.scale);
}
const editKeyName = () => `orc-edit:${current ? current.id : ''}`;

tc.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
tc.addEventListener('objectChange', () => { syncMirror(edit.sel); fillEditFields(); markDirty(); });

// Parts come with their origin at the model's feet; move each part's pivot to the centre of its bounds so the gizmo
// sits on the part and scaling / rotating happens around it (world positions stay exactly the same).
function repivot(part) {
  part.updateMatrixWorld(true);
  const inv = part.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  part.traverse((o) => {
    if (!o.isMesh || o.userData.isHelper) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(inv.clone().multiply(o.matrixWorld)));
  });
  const c = box.getCenter(new THREE.Vector3());
  if (part.isMesh) {   // overlays / quad lines share this geometry; the displacement copy moves with it
    const u = part.userData;
    for (const g of new Set([part.geometry, u.baseGeom, u.baseGeom && denseOf.get(u.baseGeom)].filter(Boolean))) g.translate(-c.x, -c.y, -c.z);
    u.shift = (u.shift || new THREE.Vector3()).sub(c);   // a later Tripo geometry swap gets the same shift
  }
  else for (const ch of part.children) ch.position.sub(c);
  part.position.add(c.clone().multiply(part.scale).applyQuaternion(part.quaternion));
  // quad-line / overlay geometries share the moved vertex buffer but keep their own (now stale) bounds
  part.traverse((o) => { if (o.geometry) { o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); } });
}

function editOnLoad(gscene) {
  edit.parts = gscene.children.filter((o) => { let m = false; o.traverse((x) => { if (x.isMesh) m = true; }); return m; });
  for (const p of edit.parts) {
    repivot(p);
    p.updateMatrix();
    p.userData.base = { p: p.position.clone(), q: p.quaternion.clone(), s: p.scale.clone(), m: p.matrix.clone() };
  }
  linkPairs();
  edit.dirty = false;
  select(null);
  const saved = applySaved();
  buildPartList();
  $('#edit-toggle').textContent = saved ? `✎ Редактировать · правок: ${saved}` : '✎ Редактировать';
  setStatus(saved ? `Применено сохранённое положение: ${saved} дет.` : '');
}
function buildPartList() {
  const box = $('#edit-parts');
  box.innerHTML = '';
  for (const p of edit.parts) {
    const b = document.createElement('button');
    b.textContent = partLabel(p);
    b.onclick = () => select(p);
    p.userData.button = b;
    box.append(b);
  }
}
function setEdit(on) {
  edit.on = on;
  $('#edit-panel').hidden = !on;
  $('#edit-toggle').classList.toggle('on', on);
  tc.enabled = on;
  if (!on) select(null);
  else if (edit.parts.length === 1) select(edit.parts[0]);
}
function select(part) {
  edit.sel = part;
  if (part) { tc.attach(part); editBox.visible = true; } else { tc.detach(); editBox.visible = false; }
  for (const p of edit.parts) p.userData.button && p.userData.button.classList.toggle('on', p === part);
  $('#edit-sel').textContent = part ? `Выбрано: ${partLabel(part)}` : 'Кликните по детали модели или выберите её здесь:';
  $('#edit-fields').classList.toggle('off', !part);
  fillEditFields();
}
function setTool(mode) {
  tc.setMode(mode);
  for (const b of document.querySelectorAll('#edit-tools button')) b.classList.toggle('on', b.dataset.tool === mode);
}
function fillEditFields() {
  const p = edit.sel;
  const raw = p && partEntry(p)?.raw;
  $('#edit-raw').disabled = !raw;
  $('#edit-raw').textContent = p && p.userData.raw ? 'Вернуть подгонку к телу' : 'Как из Tripo (без деформации)';
  $('#edit-raw').title = !p ? 'Выберите деталь' : raw ? 'Показать геометрию детали ровно такой, какой её сделал Tripo, без подгонки к телу'
    : 'Эта деталь не деформировалась: её геометрия и так как из Tripo';
  $('#edit-remove').disabled = !(p && p.userData.added);
  if (!p) { for (const id of ['#edit-scale', '#edit-x', '#edit-y', '#edit-z']) $(id).value = ''; return; }
  const b = p.userData.base;
  $('#edit-scale').value = (p.scale.x / b.s.x * 100).toFixed(1);
  const d = p.position.clone().sub(b.p).multiplyScalar(100);
  $('#edit-x').value = d.x.toFixed(1); $('#edit-y').value = d.y.toFixed(1); $('#edit-z').value = d.z.toFixed(1);
}
function setScalePct(pct) {
  const p = edit.sel;
  if (!p || !(pct > 0)) return;
  p.scale.copy(p.userData.base.s).multiplyScalar(pct / 100);
  syncMirror(p); fillEditFields(); markDirty();
}
function setOffsetCm(xyz) {
  const p = edit.sel;
  if (!p) return;
  p.position.copy(p.userData.base.p).add(new THREE.Vector3(...xyz.map((v) => (+v || 0) / 100)));
  syncMirror(p); fillEditFields(); markDirty();
}
function resetPart(p) {
  const b = p.userData.base;
  p.position.copy(b.p); p.quaternion.copy(b.q); p.scale.copy(b.s);
}
function markDirty() { edit.dirty = true; setStatus('Есть несохранённые правки.'); }
function setStatus(t) { $('#edit-status').textContent = t; }
function isEdited(p) {
  const b = p.userData.base;
  return p.position.distanceTo(b.p) > 1e-5 || p.scale.distanceTo(b.s) > 1e-5 || p.quaternion.angleTo(b.q) > 1e-5;
}
function editsJSON() {
  const parts = {};
  for (const p of edit.parts) {
    if (!isEdited(p) && !p.userData.added && !p.userData.raw) continue;
    const b = p.userData.base;
    const e = new THREE.Euler().setFromQuaternion(b.q.clone().invert().multiply(p.quaternion));
    p.updateMatrix();
    parts[p.name] = {
      label: partLabel(p),
      ...(p.userData.added ? { added: p.userData.added } : {}),
      ...(p.userData.raw ? { raw: true } : {}),
      // apply to the part as it is in the GLB: new = delta_matrix x old (column-major 4x4, glTF space)
      delta_matrix: p.matrix.clone().multiply(b.m.clone().invert()).toArray().map((v) => +v.toFixed(6)),
      pivot: b.p.toArray().map((v) => +v.toFixed(5)),
      position: p.position.toArray(), quaternion: p.quaternion.toArray(), scale: p.scale.toArray(),
      delta: {
        move_cm: p.position.clone().sub(b.p).multiplyScalar(100).toArray().map((v) => +v.toFixed(2)),
        rotate_deg: [e.x, e.y, e.z].map((v) => +THREE.MathUtils.radToDeg(v).toFixed(2)),
        scale_pct: p.scale.toArray().map((v, i) => +(v / b.s.toArray()[i] * 100).toFixed(2)),
      },
    };
  }
  return { model: current.id, saved: new Date().toISOString(),
    space: 'glTF: metres, Y up, model faces +Z. delta_matrix: new = delta_matrix x old for the part node; move/rotate/scale are about the part centre (pivot)', parts };
}
function applySaved() {
  const raw = localStorage.getItem(editKeyName());
  if (!raw) return 0;
  let n = 0;
  const added = [];
  try {
    for (const [name, t] of Object.entries(JSON.parse(raw).parts || {})) {
      if (t.added) { added.push([name, t]); n++; continue; }
      const p = edit.parts.find((x) => x.name === name);
      if (!p) continue;
      p.position.fromArray(t.position); p.quaternion.fromArray(t.quaternion); p.scale.fromArray(t.scale);
      if (t.raw) setRaw(p, true).catch(showEditError);
      if (isEdited(p) || t.raw) n++;          // a placement already written into the files counts as nothing
    }
  } catch (err) { console.warn('bad saved edits', err); }
  if (added.length) restoreAdded(added, loadToken).catch(showEditError);
  return n;
}
async function restoreAdded(list, token) {
  for (const [name, t] of list) {
    const p = await addModel(t.added, name);
    if (!p || token !== loadToken) return;
    p.position.fromArray(t.position); p.quaternion.fromArray(t.quaternion); p.scale.fromArray(t.scale);
    if (t.raw) await setRaw(p, true);
  }
  edit.dirty = false;
  fillEditFields();
}
const showEditError = (err) => { console.error(err); setStatus(`Ошибка: ${err.message || err}`); };

// ---------- edit mode: add any model of the list as one more part ----------
const partMeshes = (part) => { const a = []; part.traverse((o) => { if (o.isMesh && o.userData.orig) a.push(o); }); return a; };
const partEntry = (part) => { const m = partMeshes(part)[0]; return m ? byId(m.userData.srcId) : null; };
function fillAddList() {
  const sel = $('#edit-add-model');
  sel.innerHTML = '';
  for (const m of manifest.models) {
    if (m.assembly) continue;
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.part || 'Модель'} · ${m.label || m.id}`;
    sel.append(o);
  }
}
// The new part stands on the floor to the right of the model; it is saved with the placement («Сохранить»).
async function addModel(id, name) {
  const e = byId(id);
  if (!e || e.assembly || !curScene) return null;
  const token = loadToken;
  const total = srcBytes(e);
  let got = 0;
  setStatus(`Загружаю «${e.part || e.id}»…`);
  const inner = await loadSource(e, (n) => { got += n; setStatus(`Загружаю «${e.part || e.id}»: ${mb(got)} / ${mb(total)} МБ`); });
  $('#loading').hidden = true;
  if (token !== loadToken) return null;
  const part = new THREE.Group();
  part.add(inner);
  let k = 1;
  while (!name && edit.parts.some((p) => p.name === `${e.id}+${k}`)) k++;
  part.name = name || `${e.id}+${k}`;
  part.userData.label = `${e.part || e.id} (добавлена${k > 1 ? ` ${k}` : ''})`;
  part.userData.added = e.id;
  part.traverse((o) => { if (o.isMesh) Object.assign(o.userData, { partName: part.name, texPart: part.userData.label }); });
  const toLocal = curScene.matrixWorld.clone().invert();
  const model = new THREE.Box3();
  for (const p of edit.parts) if (p.visible) model.union(new THREE.Box3().setFromObject(p).applyMatrix4(toLocal));
  curScene.add(part);
  curScene.updateMatrixWorld(true);
  const pb = new THREE.Box3().setFromObject(part).applyMatrix4(toLocal);
  if (!model.isEmpty()) part.position.set(model.max.x - pb.min.x + 0.1 * (model.max.x - model.min.x), model.min.y - pb.min.y, 0);
  repivot(part);
  part.updateMatrix();
  part.userData.base = { p: part.position.clone(), q: part.quaternion.clone(), s: part.scale.clone(), m: part.matrix.clone() };
  edit.parts.push(part);
  linkPairs();
  buildPartList();
  fillAssembly(curScene);
  fillPbrMaps();
  applyMode(mode);
  fillPolys({ scene: curScene });
  fillTextures();
  part.updateMatrixWorld(true);
  const wb = new THREE.Box3().setFromObject(part), v = new THREE.Vector3();
  camera.updateMatrixWorld();
  const out = [0, 1, 2, 3, 4, 5, 6, 7].some((i) => {   // reframe only when the new part is (partly) off screen
    v.set(i & 1 ? wb.max.x : wb.min.x, i & 2 ? wb.max.y : wb.min.y, i & 4 ? wb.max.z : wb.min.z).project(camera);
    return Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
  });
  if (out) setCamera('front');
  if (e.preview) upgradeTextures([e], token).catch((err) => { console.error(err); setHqBadge(''); });
  setStatus(`Добавлено: ${part.userData.label}. Подгоните и нажмите «Сохранить».`);
  return part;
}
function removePart(p) {
  if (!p || !p.userData.added) return;
  select(null);
  const gone = new Set(partMeshes(p));
  for (let i = meshes.length - 1; i >= 0; i--) if (gone.has(meshes[i])) meshes.splice(i, 1);
  for (const [k, m] of modeCache) if ([...gone].some((o) => k.startsWith(o.uuid))) { m.dispose(); modeCache.delete(k); }
  p.removeFromParent();
  edit.parts = edit.parts.filter((x) => x !== p);
  linkPairs();
  buildPartList();
  fillAssembly(curScene);
  fillPolys({ scene: curScene });
  fillTextures();
  markDirty();
}

// ---------- edit mode: «Как из Tripo» ----------
// entry.raw = { src, offset } is the part's geometry exactly as Tripo made it (same UVs, no textures). Parts deformed to fit
// the body (chest conformed, glove tubes refitted) switch back to it and forth; textures and placement stay as they are.
const rawCache = new Map();   // src -> Promise<[geometry per mesh]>
function loadRaw(src) {
  return cached(rawCache, src, async () => {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${src}: ${res.status}`);
    const g = await loader.parseAsync(await res.arrayBuffer(), '');
    const out = [];
    g.scene.traverse((o) => { if (o.isMesh) out.push(o.geometry); });
    return out;
  });
}
async function setRaw(part, on) {
  const e = partEntry(part);
  if (!e || !e.raw) return;
  const list = partMeshes(part);
  if (on && list.some((m) => !m.userData.rawGeom)) {
    setStatus('Загружаю геометрию из Tripo…');
    const geos = await loadRaw(e.raw.src);
    for (const m of list) {
      const u = m.userData, src = geos[u.srcIdx];
      if (!src || u.rawGeom) continue;
      const off = new THREE.Vector3(...(e.raw.offset || [0, 0, 0])).add(u.shift || new THREE.Vector3());
      u.rawGeom = src.clone().translate(off.x, off.y, off.z);
    }
  }
  for (const m of list) {
    const u = m.userData;
    if (!u.rawGeom) continue;
    if (!u.fitGeom) u.fitGeom = u.baseGeom || m.geometry;
    const g = on ? u.rawGeom : u.fitGeom, prev = u.baseGeom || m.geometry;
    if (g === prev) continue;
    u.baseGeom = g; m.geometry = g;
    if (u.overlay) u.overlay.geometry = g;
    if (u.quadLines) {
      if (!u.quadOf) u.quadOf = new Map([[prev, u.quadLines]]);
      if (!u.quadOf.has(g)) u.quadOf.set(g, quadLines(m));
      const old = u.quadLines, q = u.quadOf.get(g);
      if (q) { q.visible = old.visible; q.material = old.material; m.remove(old); m.add(q); u.quadLines = q; }
    }
  }
  part.userData.raw = on;
  applyMode(mode);
  fillPolys({ scene: curScene });
  if (edit.sel === part || edit.sel === part.userData.partner) fillEditFields();
  setStatus(on ? `${partLabel(part)}: геометрия как из Tripo (без подгонки к телу).` : `${partLabel(part)}: подгонка к телу возвращена.`);
}
async function toggleRaw() {
  const p = edit.sel;
  if (!p) return;
  const on = !p.userData.raw;
  await setRaw(p, on);
  const q = p.userData.partner;
  if (q && $('#edit-mirror').checked) await setRaw(q, on);
  fillEditFields();
  markDirty();
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function describe(t) {
  const d = t.delta;
  const move = d.move_cm.map((v) => (v >= 0 ? '+' : '') + v.toFixed(1));
  const bits = [`сдвиг X ${move[0]}, Y ${move[1]}, Z ${move[2]} см`];
  if (d.rotate_deg.some((v) => Math.abs(v) > 0.05)) bits.push(`поворот ${d.rotate_deg.map((v) => v.toFixed(1)).join(' / ')}°`);
  if (d.scale_pct.some((v) => Math.abs(v - 100) > 0.05)) bits.push(`масштаб ${d.scale_pct[0].toFixed(1)}%`);
  return `${t.label}: ${bits.join(', ')}`;
}
// «Сохранить» keeps only the placement (coordinates) of the parts — nothing is downloaded. It is stored per model
// and re-applied whenever the model is opened; the values are absolute, so once a placement is written into the
// model files it simply matches them.
function saveEdits() {
  const data = editsJSON();
  const n = Object.keys(data.parts).length;
  if (n) localStorage.setItem(editKeyName(), JSON.stringify(data)); else localStorage.removeItem(editKeyName());
  edit.dirty = false;
  $('#edit-toggle').textContent = n ? `✎ Редактировать · правок: ${n}` : '✎ Редактировать';
  setStatus(n ? `Положение сохранено (${new Date().toLocaleTimeString()}). ${Object.values(data.parts).map(describe).join('; ')}.`
              : 'Всё на исходных местах — сохранённое положение для этой модели удалено.');
  return data;
}
async function exportGLB() {
  setStatus('Готовлю GLB…');
  const hidden = [];
  scene.traverse((o) => { if ((o.isLineSegments || o.userData.isOverlay || o === o.parent?.userData.overlay) && o.visible) { o.visible = false; hidden.push(o); } });
  for (const m of meshes) m.material = m.userData.orig;
  setDisplaceGeometry(false);
  try {
    const glb = await new GLTFExporter().parseAsync(edit.parts, { binary: true, maxTextureSize: 4096 });
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${current.id}-edited.glb`);
    setStatus(`GLB с правками скачан: ${current.id}-edited.glb (${(glb.byteLength / 1048576).toFixed(1)} МБ).`);
  } catch (err) {
    setStatus(`Не удалось собрать GLB: ${err.message}`);
  } finally {
    for (const o of hidden) o.visible = true;
    applyMode(mode);
  }
}
function editKey(e) {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveEdits(); return true; }
  if (e.target.tagName === 'INPUT') return false;
  if (k === 'g') { setTool('translate'); return true; }
  if (k === 'r') { setTool('rotate'); return true; }
  if (k === 's') { setTool('scale'); return true; }
  if (e.key === 'Escape') { select(null); return true; }
  return false;
}
// click (not drag) on the model selects the part under the cursor
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, gizmo: tc.axis !== null }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!edit.on || !down || down.gizmo || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(meshes, false).find((h) => shown(h.object));
  let p = hit && hit.object;
  while (p && !edit.parts.includes(p)) p = p.parent;
  select(p || null);
});
$('#edit-toggle').onclick = () => setEdit(!edit.on);
$('#edit-exit').onclick = () => setEdit(false);
for (const b of document.querySelectorAll('#edit-tools button')) b.onclick = () => setTool(b.dataset.tool);
$('#edit-scale').onchange = (e) => setScalePct(+e.target.value);
for (const id of ['#edit-x', '#edit-y', '#edit-z']) $(id).onchange = () => setOffsetCm([$('#edit-x').value, $('#edit-y').value, $('#edit-z').value]);
$('#edit-reset').onclick = () => { if (edit.sel) { resetPart(edit.sel); syncMirror(edit.sel); fillEditFields(); markDirty(); } };
$('#edit-reset-all').onclick = () => { for (const p of edit.parts) { resetPart(p); if (p.userData.raw) setRaw(p, false).catch(showEditError); } fillEditFields(); markDirty(); };
$('#edit-raw').onclick = () => toggleRaw().catch(showEditError);
$('#edit-remove').onclick = () => removePart(edit.sel);
$('#edit-add-btn').onclick = async () => {
  const b = $('#edit-add-btn');
  b.disabled = true;
  try { const p = await addModel($('#edit-add-model').value); if (p) { setEdit(true); select(p); markDirty(); } }
  catch (err) { showEditError(err); }
  finally { b.disabled = false; }
};
$('#edit-save').onclick = () => saveEdits();
$('#edit-glb').onclick = () => exportGLB();
setTool('translate');

// ---------- loop ----------
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  const span = ortho.userData.span || 2;
  ortho.top = span / 2; ortho.bottom = -span / 2;
  ortho.left = -span / 2 * (w / h); ortho.right = span / 2 * (w / h);
  ortho.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
function frame() {
  controls.update();
  if (tc.camera !== camera) tc.camera = camera;
  if (edit.sel) editBox.box.setFromObject(edit.sel);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

// Console / automation hook: viewer.render() draws a frame even when the tab is in the background.
window.viewer = {
  render: frame,
  edit: {
    toggle: (on) => setEdit(on === undefined ? !edit.on : on),
    select: (name) => select(edit.parts.find((p) => p.name === name) || null),
    offset: (x, y, z) => setOffsetCm([x, y, z]),
    scale: (pct) => setScalePct(pct),
    save: () => saveEdits(),
    json: () => editsJSON(),
    glb: () => exportGLB(),
    add: (id) => addModel(id),
    raw: (on) => edit.sel && setRaw(edit.sel, on),
    remove: () => removePart(edit.sel),
    state: () => ({ on: edit.on, sel: edit.sel && edit.sel.name, raw: !!(edit.sel && edit.sel.userData.raw), parts: edit.parts.map((p) => p.name), tool: tc.mode, saved: localStorage.getItem(editKeyName()), status: $('#edit-status').textContent }),
  },
  mode: (id) => applyMode(id),
  camera: (name) => setCamera(name),
  state: () => ({ model: current && current.id, mode, meshes: meshes.length, loading: !$('#loading').hidden, text: $('#loading-text').textContent, hq: $('#hq-badge')?.hidden === false ? $('#hq-badge').textContent : '' }),
};

// ---------- start ----------
manifest = await (await fetch('models.json', { cache: 'no-cache' })).json();
buildNav();
fillAddList();
const wanted = new URLSearchParams(location.search).get('m');
loadModel(manifest.models.find((m) => m.id === wanted) || manifest.models[0]).catch(showError);
