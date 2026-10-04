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
// three.js applies aoMap to the environment light only; with a strong key light the AO was nearly invisible.
// Let it darken the direct light too (AO_DIRECT of the way), like most asset viewers do.
const AO_DIRECT = 0.65;
THREE.ShaderChunk.aomap_fragment = THREE.ShaderChunk.aomap_fragment.replace('reflectedLight.indirectDiffuse *= ambientOcclusion;',
  `reflectedLight.indirectDiffuse *= ambientOcclusion;
  reflectedLight.directDiffuse *= mix( 1.0, ambientOcclusion, ${AO_DIRECT.toFixed(2)} );
  reflectedLight.directSpecular *= mix( 1.0, ambientOcclusion, ${AO_DIRECT.toFixed(2)} );`);

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
  { key: 'displacementMap', id: 'pm-disp', label: 'Displacement', hint: 'из Height, плотная сетка + свет' },
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
  for (const d of PBR_MAPS) p[d.key] = d.key !== 'displacementMap' && mapOn(d.key) ? mapSource(orig, d.key) : null; // displacement is baked into the geometry
  p.roughness = p.roughnessMap || !orig.roughnessMap ? orig.roughness : 0.6;
  p.metalness = p.metalnessMap || !orig.metalnessMap ? orig.metalness : 0;
  if (p.emissive) p.emissive.copy(p.emissiveMap || !orig.emissiveMap ? orig.emissive : new THREE.Color(0));
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
    color: 0xb8b2aa, roughness: 0.65, metalness: 0,
    normalMap: useNormalMap() ? m.userData.normalMap : null, normalScale: m.normalScale ? m.normalScale.clone() : new THREE.Vector2(1, 1) }) },
];
// Height map (entry.heightMap: { src, mm } — zero level 0.5, 1.0 = +mm), kept per material (userData.heightTex /
// heightMm) so an assembly can mix parts with and without one. Displacement runs on the CPU: the mesh is midpoint-subdivided
// until its edges are ~DISP_EDGE (within a triangle budget), moved along the normal by the height, and its normals are
// recomputed (welded across UV seams) — so the relief shows in the lighting, not only in the silhouette as GPU displacementMap would.
const hasHeight = () => meshes.some((o) => [].concat(o.userData.orig).some((m) => m.userData.heightTex));
const dispExag = () => +$('#disp-exag').value;
// The heavy part runs in a small worker pool (the model shows at once with its normal maps, the relief follows): each
// worker keeps the height pixels per texture and the subdivided + welded copy per mesh, so a new strength only re-displaces.
const DISP_WORKER = `
const pix = new Map(), subs = new Map();
function subdivide(g) {
  const idx = g.index, n = g.position.length / 3, cap = n + idx.length, names = Object.keys(g).filter((k) => !['index', 'id', 'ids'].includes(k));
  const size = Object.fromEntries(names.map((k) => [k, g[k].length / n])), dst = {};
  for (const k of names) { dst[k] = new Float32Array(cap * size[k]); dst[k].set(g[k]); }
  const pid = new Uint32Array(cap); pid.set(g.id);
  const edges = new Map(), welded = new Map(), out = new Uint32Array(idx.length * 4);
  let count = n, o = 0, ids = g.ids;
  const mid = (a, b) => {
    const key = a < b ? a * cap + b : b * cap + a;
    let v = edges.get(key);
    if (v !== undefined) return v;
    v = count++; edges.set(key, v);
    for (const k of names) {
      const s = size[k], d = dst[k];
      for (let c = 0; c < s; c++) d[v * s + c] = (d[a * s + c] + d[b * s + c]) / 2;
      if (k === 'normal') { const l = Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) || 1; for (let c = 0; c < 3; c++) d[v * 3 + c] /= l; }
    }
    const ia = pid[a], ib = pid[b], wk = ia < ib ? ia * 67108864 + ib : ib * 67108864 + ia;   // seam twins share a weld id
    let w = welded.get(wk); if (w === undefined) { w = ids++; welded.set(wk, w); }
    pid[v] = w;
    return v;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    out.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o); o += 12;
  }
  const r = { index: out, id: pid.slice(0, count), ids };
  for (const k of names) r[k] = dst[k].slice(0, count * size[k]);
  return r;
}
function weld(P) {   // split (UV-seam) vertices get one id
  const n = P.length / 3, id = new Uint32Array(n), keyOf = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.round(P[i * 3] * 1e5) + ',' + Math.round(P[i * 3 + 1] * 1e5) + ',' + Math.round(P[i * 3 + 2] * 1e5);
    let j = keyOf.get(k); if (j === undefined) { j = keyOf.size; keyOf.set(k, j); }
    id[i] = j;
  }
  return { id, ids: keyOf.size };
}
onmessage = ({ data: q }) => {
  if (q.clear) { pix.clear(); subs.clear(); return; }
  if (q.img) {   // height pixels of one texture, sent once per worker
    const c = new OffscreenCanvas(q.img.width, q.img.height), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(q.img, 0, 0); q.img.close();
    const rgba = x.getImageData(0, 0, c.width, c.height).data, d = new Uint8Array(c.width * c.height);
    for (let i = 0; i < d.length; i++) d[i] = rgba[i * 4];
    pix.set(q.tex, { w: c.width, h: c.height, d });
    return;
  }
  let g = subs.get(q.sub);
  if (!g) {
    g = q.geom; Object.assign(g, weld(g.position));
    for (let i = 0; i < q.lv; i++) g = subdivide(g);
    subs.set(q.sub, g);
  }
  const { w, h, d } = pix.get(q.tex), P = g.position.slice(), N = g.normal, U = g.uv, n = P.length / 3, idx = g.index;
  for (let i = 0; i < n; i++) {   // bilinear height, flipY = false: v = 0 is the top row; zero level 0.5
    const x = Math.min(Math.max(U[i * 2] * w - 0.5, 0), w - 1.001), y = Math.min(Math.max(U[i * 2 + 1] * h - 0.5, 0), h - 1.001);
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, k = y0 * w + x0;
    const hh = ((d[k] * (1 - fx) + d[k + 1] * fx) * (1 - fy) + (d[k + w] * (1 - fx) + d[k + w + 1] * fx) * fy) / 255;
    const dd = (hh * 2 - 1) * q.s;
    P[i * 3] += N[i * 3] * dd; P[i * 3 + 1] += N[i * 3 + 1] * dd; P[i * 3 + 2] += N[i * 3 + 2] * dd;
  }
  const acc = new Float32Array(g.ids * 3), id = g.id, NN = new Float32Array(n * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (let e = 0; e < 3; e++) { const j = id[idx[t + e]] * 3; acc[j] += nx; acc[j + 1] += ny; acc[j + 2] += nz; }
  }
  for (let i = 0; i < n; i++) {
    const j = id[i] * 3, l = Math.hypot(acc[j], acc[j + 1], acc[j + 2]) || 1;
    NN[i * 3] = acc[j] / l; NN[i * 3 + 1] = acc[j + 1] / l; NN[i * 3 + 2] = acc[j + 2] / l;
  }
  const r = { job: q.job, position: P, normal: NN }, tr = [P.buffer, NN.buffer];
  if (q.full) for (const k of ['uv', 'tangent', 'index']) if (g[k]) { r[k] = g[k].slice(); tr.push(r[k].buffer); }
  postMessage(r, tr);
};`;
const DISP_EDGE = 0.006, DISP_TRIS_MESH = 2.5e6, DISP_TRIS_ALL = 8e6;
function dispLevels(g, budget) {
  const P = g.attributes.position, idx = g.index.array, tris = idx.length / 3, step = Math.max(1, Math.floor(tris / 4000));
  let sum = 0, k = 0;
  for (let t = 0; t < tris; t += step, k++) {
    const a = idx[t * 3], b = idx[t * 3 + 1];
    sum += Math.hypot(P.getX(a) - P.getX(b), P.getY(a) - P.getY(b), P.getZ(a) - P.getZ(b));
  }
  let lv = Math.min(4, Math.max(2, Math.ceil(Math.log2((sum / k) / DISP_EDGE))));
  while (lv > 2 && tris * 4 ** lv > budget) lv--;
  return lv;
}
const flat = (a) => { const r = new Float32Array(a.count * a.itemSize); for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) r[i * a.itemSize + c] = a.getComponent(i, c); return r; };
const disp = { workers: [], jobs: new Map(), next: 0, url: null };
function dispWorker(key) {
  if (!disp.workers.length) {
    disp.url = URL.createObjectURL(new Blob([DISP_WORKER], { type: 'text/javascript' }));
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(disp.url); w.sent = new Map();   // texture uuid -> pixels posted
      w.onmessage = ({ data }) => dispDone(data);
      w.onerror = (e) => console.error('displacement worker', e);
      disp.workers.push(w);
    }
  }
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return disp.workers[Math.abs(h) % disp.workers.length];   // a mesh always goes to the same worker (its cached subdivision)
}
function dispClear() { for (const w of disp.workers) { w.postMessage({ clear: true }); w.sent.clear(); } disp.jobs.clear(); dispBadge(); }
function dispBadge() { setBadge('disp', disp.jobs.size ? `Рельеф (дисплейсмент): считается ${disp.jobs.size}…` : ''); }
async function dispRequest(base, d, m, key) {
  d.want = key;
  const job = ++disp.next, w = dispWorker(d.id), tex = m.userData.heightTex, q = { job, sub: d.id, lv: d.lv, tex: tex.uuid, s: m.userData.heightMm / 1000 * dispExag(), full: !d.attrs };
  disp.jobs.set(job, { base, d, key });
  dispBadge();
  const tr = [];
  if (!w.sent.has(tex.uuid)) w.sent.set(tex.uuid, createImageBitmap(tex.image).then((img) => w.postMessage({ img, tex: tex.uuid }, [img])));
  if (!d.posted) {   // the worker keeps the subdivided copy: the base arrays go once
    d.posted = true;
    const g = base, geom = { index: Uint32Array.from(g.index.array) };
    for (const k of ['position', 'normal', 'uv', 'tangent']) if (g.attributes[k]) geom[k] = flat(g.attributes[k]);
    q.geom = geom; tr.push(...Object.values(geom).map((a) => a.buffer));
  }
  await w.sent.get(tex.uuid);   // jobs and pixels keep their order per worker
  w.postMessage(q, tr);
}
function dispDone(r) {
  const j = disp.jobs.get(r.job);
  disp.jobs.delete(r.job); dispBadge();
  if (!j) return;
  const { base, d, key } = j;
  if (r.index) d.attrs = { uv: r.uv && new THREE.BufferAttribute(r.uv, 2), tangent: r.tangent && new THREE.BufferAttribute(r.tangent, 4), index: new THREE.BufferAttribute(r.index, 1) };
  if (!dispOn || d.want !== key || denseOf.get(base) !== d) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(r.position, 3)); g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3));
  if (d.attrs.uv) g.setAttribute('uv', d.attrs.uv);
  if (d.attrs.tangent) g.setAttribute('tangent', d.attrs.tangent);
  g.setIndex(d.attrs.index);
  const users = meshes.filter((o) => o.userData.baseGeom === base);
  const sh = users[0]?.userData.shift, s0 = d.shift0;   // a repivot after the base was sent moves the result the same way
  if (sh && s0 && !sh.equals(s0)) g.translate(sh.x - s0.x, sh.y - s0.y, sh.z - s0.z);
  g.computeBoundingBox(); g.computeBoundingSphere();
  const old = d.geom;
  d.geom = g; d.key = key;
  for (const o of users) o.geometry = g;
  old?.dispose();
  syncCuts();
}
const denseOf = new WeakMap();   // base geometry -> { id, lv, f: triangles per base triangle, geom: displaced copy, key, attrs }
let dispOn = false;
function setDisplaceGeometry(on) {
  dispOn = on;
  const list = meshes.filter((o) => !o.isSkinnedMesh && [].concat(o.userData.orig).some((m) => m.userData.heightTex));   // skinned: normal map only
  const total = list.reduce((t, o) => t + (o.userData.baseGeom || o.geometry).index.count / 3, 0);
  for (const mesh of list) {
    const u = mesh.userData;
    if (!u.baseGeom) u.baseGeom = mesh.geometry;
    if (!on) { mesh.geometry = u.baseGeom; continue; }
    const base = u.baseGeom, m = [].concat(u.orig).find((x) => x.userData.heightTex), tris = base.index.count / 3;
    const lv = dispLevels(base, Math.min(DISP_TRIS_MESH, DISP_TRIS_ALL * tris / total));
    let d = denseOf.get(base);
    if (!d || d.lv !== lv) {
      d?.geom?.dispose();
      d = { id: `${base.uuid}|${lv}`, lv, f: 4 ** lv, geom: null, key: '', want: '', shift0: (u.shift || new THREE.Vector3()).clone() };
      denseOf.set(base, d);
    }
    const key = `${m.userData.heightTex.uuid}|${m.userData.heightMm}|${dispExag()}`;
    if (d.key === key && d.geom) mesh.geometry = d.geom;
    else {
      if (d.geom) mesh.geometry = d.geom;   // the previous relief stays until the new one is ready
      if (d.want !== key) dispRequest(base, d, m, key).catch((err) => console.error(err));
    }
  }
  syncCuts();
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
  syncCuts();
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
const badges = {};   // hq / disp -> text; one line each
function setHqBadge(text) { setBadge('hq', text); }
function setBadge(k, text) {
  badges[k] = text;
  text = Object.values(badges).filter(Boolean).join(' · ');
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
  const parts = p ? p.parts : e.parts;
  const [heightTex, buffer] = await Promise.all([heightSrc ? loadHeight(heightSrc) : null, cached(bufCache, parts.join('|'), () => fetchParts(parts, onBytes))]);
  const gltf = await loader.parseAsync(buffer, '');
  if (gltf.animations.length) gltf.scene.userData.clips = gltf.animations;
  let idx = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh) o.frustumCulled = false;   // the bind-pose bounds don't follow the animation
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { m.userData.normalMap = m.normalMap; if (heightTex) { m.userData.heightTex = heightTex; m.userData.heightMm = e.heightMap.mm; } }
    o.userData.orig = o.material;
    o.userData.srcId = e.id;
    o.userData.srcIdx = idx++;
    if (e.quads && !o.isSkinnedMesh) {   // static line copies would stay in the bind pose
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
  syncFitUi();
  setHqBadge('');
  for (const t of liveTextures()) t.dispose();
  for (const m of modeCache.values()) m.dispose();
  root.clear(); meshes.length = 0; modeCache.clear(); setAnim(null); dispClear();
  bufCache = new Map(); texCache = new Map();
  const items = entry.assembly ? entry.assembly.map((a) => ({ a, e: byId(a.id) })).filter((x) => x.e) : [{ a: null, e: entry }];
  const uniq = [...new Map(items.map((x) => [x.e.id, x.e])).values()];
  const total = uniq.reduce((n, e) => n + srcBytes(e), 0);
  let got = 0;
  const onBytes = (n) => { got += n; setProgress(total ? got / total : 0, got < total ? `Загрузка ${mb(got)} / ${mb(total)} МБ` : 'Сборка сцены…'); };
  let gscene;
  if (entry.assembly) {
    gscene = new THREE.Group();
    const loaded = await Promise.all(items.map(({ e }) => loadSource(e, onBytes)));   // all parts download and parse at once
    if (token !== loadToken) return;
    for (const [i, { a, e }] of items.entries()) {
      const part = new THREE.Group();
      part.add(loaded[i]);
      part.name = a.name || e.id;
      part.userData.label = a.label || e.part;
      if (a.wrap) part.userData.wrap = a.wrap;
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
    meshes.length = 0; gscene.traverse((o) => { if (o.isMesh && o.userData.orig) meshes.push(o); });   // assembly order, not arrival order
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
  if (fitVariant !== 'manual') await Promise.all(gscene.children.filter((p) => p.userData.wrap).map(applyGeom));
  if (token !== loadToken) return;
  prepareCuts(gscene);
  model.updateMatrixWorld(true);
  model.traverse((o) => { if (o.isSkinnedMesh) { o.skeleton.update(); o.computeBoundingBox(); o.computeBoundingSphere(); } });   // bounds from the posed bones, not identity ones
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
  setAnim(gscene);
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
  // every full file downloads at once; they are swapped in one by one as they arrive
  let chain = Promise.resolve();
  await Promise.all(entries.map((e) => fetchParts(e.parts, (n) => { got += n; if (token === loadToken) badge(); })
    .then((buffer) => (chain = chain.then(() => swapFull(e, buffer, token))))));
  await chain;
  if (token === loadToken) setHqBadge('');
}
async function swapFull(e, buffer, token) {
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
// three r170 builds the bitangent as cross(normal, tangent) * tangent.w after the model transform, and a reflection turns
// that cross product around: a mirrored part with glTF tangents would get its normal map's green channel inverted.
// Meshes without tangents use screen-space derivatives, which handle the reflection themselves.
function flipMirroredNormalMaps(part) {
  part.traverse((o) => {
    if (o.isMesh && o.geometry.attributes.tangent) for (const m of [].concat(o.material)) m.normalScale.y *= -1;
  });
}
// An assembly item can hide the top of another part under it: cut = { part, above } drops the triangles of part `part`
// lying fully above y = above (that part's space), e.g. the body's own head under a separate HEAD part. The index is
// reordered once (kept triangles first, the quad wire likewise) and drawRange switches the cut on and off, so hiding
// the item brings the old head back. The subdivided displacement copy keeps the order (16 triangles per triangle: two subdivisions).
let cuts = [];
function prepareCuts(gscene) {
  cuts = [];
  for (const a of current.assembly || []) {
    const by = a.cut && gscene.children.find((p) => p.name === a.name);
    const target = by && gscene.children.find((p) => p.name === a.cut.part);
    if (!target) continue;
    root.updateMatrixWorld(true);
    const toPart = target.matrixWorld.clone().invert(), list = [];
    target.traverse((o) => {
      if (!o.isMesh || !o.geometry.index) return;
      const g = o.geometry, idx = g.index.array, P = g.attributes.position, m = toPart.clone().multiply(o.matrixWorld), v = new THREE.Vector3();
      const up = new Uint8Array(P.count);
      for (let i = 0; i < P.count; i++) up[i] = v.fromBufferAttribute(P, i).applyMatrix4(m).y > a.cut.above;
      const split = (arr, k) => {   // groups of k indices: those not fully above first
        const keep = [], drop = [];
        for (let t = 0; t < arr.length; t += k) {
          const grp = arr.subarray(t, t + k);
          (grp.every((i) => up[i]) ? drop : keep).push(...grp);
        }
        arr.set(keep.concat(drop));
        return keep.length;
      };
      const keep = split(idx, 3); g.index.needsUpdate = true;
      const q = o.userData.quadLines, qkeep = q ? split(q.geometry.index.array, 2) : 0;
      if (q) q.geometry.index.needsUpdate = true;
      list.push({ o, keep, qkeep });
    });
    cuts.push({ by, list });
  }
  syncCuts();
}
function syncCuts() {
  for (const { by, list } of cuts) for (const { o, keep, qkeep } of list) {
    const on = by.visible, base = o.userData.baseGeom || o.geometry;
    base.setDrawRange(0, on ? keep : Infinity);
    const d = denseOf.get(base); if (d) d.geom?.setDrawRange(0, on ? keep * d.f : Infinity);
    o.userData.quadLines?.geometry.setDrawRange(0, on ? qkeep : Infinity);
  }
}
// assembly: one checkbox per part to show / hide it
function fillAssembly(gscene) {
  const box = $('#asm-box');
  if (!box) return;
  box.hidden = !current.assembly;
  $('#asm-parts').innerHTML = '';
  const fit = $('#asm-fit');
  if (fit) fit.hidden = !(current.assembly || []).some((a) => a.wrap);
  if (!current.assembly) return;
  for (const p of gscene.children) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox'; c.checked = p.visible;
    c.onchange = () => { p.visible = c.checked; syncCuts(); if (!c.checked && edit.sel === p) select(null); };
    l.append(c, ` ${partLabel(p)}`);
    $('#asm-parts').append(l);
  }
}

// Center on X/Z, feet at 0, optional scale to 2.10 m.
function normalize() {
  const size = rawBox.getSize(new THREE.Vector3());
  const inPlace = current.assembly || current.bodySpace;   // bodySpace: rigged export, already in the body's metres
  const s = !inPlace && $('#scale21').checked && size.y > 0 ? (current.height || TARGET_HEIGHT) / size.y : 1;
  const model = root.children[0];
  if (!model) return;
  model.scale.setScalar(s);
  if (inPlace) { model.position.set(0, 0, 0); buildRuler(current.height || size.y, size.x / 2); return; }  // already in the body's space
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
let dispTimer = 0;
$('#disp-exag').oninput = () => {
  $('#disp-exag-v').textContent = `×${dispExag()}`;
  clearTimeout(dispTimer); dispTimer = setTimeout(() => { if (dispOn) setDisplaceGeometry(true); }, 200);
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
const PART_NAMES = { Orc_Base: 'Тело + голова', Skirt_T: 'Юбка', Body: 'Тело', Head: 'Голова', Hair: 'Волосы', Horns: 'Рога', Chest: 'Нагрудник',
  Belt: 'Пояс', Legs: 'Набедренная повязка', Tail: 'Хвост', Weapon: 'Булава' };
const GEAR_NAMES = { Pauldron: 'Наплечник', Bracer: 'Наруч', Boot: 'Ботинок', Shoulder: 'Наплечник', Glove: 'Наруч' };
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
  m = /^(Shoulder|Glove|Boot)_([RL])$/.exec(o.name);              // Baine rig
  if (m) return `${m[1] === 'Boot' ? 'Манжета копыта' : GEAR_NAMES[m[1]]} ${SIDE[m[2]]}`;
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
tc.addEventListener('objectChange', () => moved(edit.sel));

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
    const d = u.baseGeom && denseOf.get(u.baseGeom);
    for (const g of new Set([part.geometry, u.baseGeom, d?.geom, ...Object.values(u.geoms || {})].filter(Boolean))) g.translate(-c.x, -c.y, -c.z);
    u.shift = (u.shift || new THREE.Vector3()).sub(c);   // a later Tripo geometry swap gets the same shift
  }
  else for (const ch of part.children) ch.position.sub(c);
  part.position.add(c.clone().multiply(part.scale).applyQuaternion(part.quaternion));
  // quad-line / overlay geometries share the moved vertex buffer but keep their own (now stale) bounds
  part.traverse((o) => { if (o.geometry) { o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere(); } });
}

const hasMesh = (o) => { let m = false; o.traverse((x) => { if (x.isMesh) m = true; }); return m; };
const hasBone = (o) => { let b = false; o.traverse((x) => { if (x.isBone) b = true; }); return b; };
const hasSkin = (o) => { let b = false; o.traverse((x) => { if (x.isSkinnedMesh) b = true; }); return b; };
function editOnLoad(gscene) {
  // items: the parts of an assembly, or the meshes under the armature of a rigged model (as in orc-armory)
  const top = gscene.children.flatMap((o) => (hasBone(o) && !o.isMesh ? o.children.filter((c) => !c.isBone && hasMesh(c)) : [o])).filter(hasMesh);
  edit.parts = [];
  edit.rigged = top.some(hasSkin);
  if (edit.rigged) gscene.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });   // items are measured in the bind pose
  for (const o of top) {
    const p = hasSkin(o) ? skinItem(o, gscene) : o;
    if (p === o) repivot(p);
    p.updateMatrix();
    p.userData.base = { p: p.position.clone(), q: p.quaternion.clone(), s: p.scale.clone(), m: p.matrix.clone() };
    edit.parts.push(p);
  }
  linkPairs();
  edit.dirty = false;
  select(null);
  const saved = applySaved();
  for (const p of edit.parts) applySkin(p);
  buildPartList();
  $('#edit-toggle').textContent = saved ? `✎ Положение предметов · правок: ${saved}` : '✎ Положение предметов';
  setStatus(saved ? `Применено сохранённое положение: ${saved} дет.` : '');
  $('#edit-motion').hidden = !edit.rigged;
}
// A skinned item can't be moved as a node: its vertices follow the bones. The move is written into its vertices in the bind
// pose instead (v' = A^-1 * D * A * v, A: mesh bind space -> model space), so the item keeps its weights and moves with the
// animation. A helper node at the item's centre carries D for the gizmo, the fields, mirroring and saving.
function skinItem(o, gscene) {
  gscene.updateMatrixWorld(true);
  const toModel = gscene.matrixWorld.clone().invert(), list = [], box = new THREE.Box3(), v = new THREE.Vector3();
  o.traverse((m) => {
    if (!m.isSkinnedMesh) return;
    const sk = m.skeleton, B = sk.bones[0].matrixWorld.clone().multiply(sk.boneInverses[0]);   // the same for every bone in the bind pose
    const A = toModel.clone().multiply(m.matrixWorld).multiply(m.bindMatrixInverse).multiply(B).multiply(m.bindMatrix);
    const g = m.geometry, orig = {};
    for (const k of ['position', 'normal', 'tangent']) if (g.attributes[k]) {   // plain float copies (quantized / interleaved data too)
      orig[k] = flat(g.attributes[k]);
      g.setAttribute(k, new THREE.BufferAttribute(orig[k].slice(), g.attributes[k].itemSize));
    }
    for (let i = 0; i < orig.position.length; i += 3) box.expandByPoint(v.fromArray(orig.position, i).applyMatrix4(A));
    list.push({ m, A, Ai: A.clone().invert(), orig });
  });
  const p = new THREE.Object3D();
  p.name = o.name; p.userData.label = partLabel(o);
  p.userData.skin = { list, box0: box.clone(), box: box.clone(), node: o };
  p.position.copy(box.getCenter(v));
  for (const { m } of list) m.userData.item = p;
  gscene.add(p);
  return p;
}
function applySkin(p) {
  const sk = p && p.userData.skin;
  if (!sk) return;
  p.updateMatrix();
  const D = p.matrix.clone().multiply(p.userData.base.m.clone().invert()), N = new THREE.Matrix3(), v = new THREE.Vector3();
  sk.box.copy(sk.box0).applyMatrix4(D);
  for (const { m, A, Ai, orig } of sk.list) {
    const M = Ai.clone().multiply(D).multiply(A), g = m.geometry;
    N.getNormalMatrix(M);
    const P = g.attributes.position.array, o = orig.position;
    for (let i = 0; i < o.length; i += 3) v.fromArray(o, i).applyMatrix4(M).toArray(P, i);
    g.attributes.position.needsUpdate = true;
    if (orig.normal) {
      const a = g.attributes.normal.array, n = orig.normal;
      for (let i = 0; i < n.length; i += 3) v.fromArray(n, i).applyMatrix3(N).normalize().toArray(a, i);
      g.attributes.normal.needsUpdate = true;
    }
    if (orig.tangent) {
      const a = g.attributes.tangent.array, t = orig.tangent;
      for (let i = 0; i < t.length; i += 4) v.set(t[i], t[i + 1], t[i + 2]).transformDirection(M).toArray(a, i);
      g.attributes.tangent.needsUpdate = true;
    }
    g.computeBoundingBox(); g.computeBoundingSphere(); m.boundingBox = null; m.boundingSphere = null;
  }
}
// any change of an item: the mirrored partner follows, skinned vertices are rewritten, the fields refresh
function moved(p) {
  if (!p) return;
  syncMirror(p);
  applySkin(p);
  if ($('#edit-mirror').checked) applySkin(p.userData.partner);
  fillEditFields();
  markDirty();
}
// rigged models: bind pose while placing (the gizmo sits on the item); «Проверить в движении» plays the clip with the edits
function restPose(on) {
  anim.rest = on;
  if (on) {
    anim.mixer?.stopAllAction();
    curScene?.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  } else if (anim.mixer && anim.actions.length) {
    anim.cur = null;
    playClip(anim.last || anim.actions[0].getClip().name);
  }
  $('#edit-motion').classList.toggle('on', !on);
  $('#edit-motion').textContent = on ? '▶ Проверить в движении' : '■ Вернуть позу для настройки';
  if (edit.on) select(edit.sel);
}
function buildPartList() {
  const box = $('#edit-parts');
  box.innerHTML = '';
  for (const p of edit.parts) {
    const row = document.createElement('div'), c = document.createElement('input'), b = document.createElement('button');
    row.className = 'item';
    c.type = 'checkbox'; c.checked = itemVisible(p); c.title = 'Показать / скрыть';
    c.onchange = () => { setItemVisible(p, c.checked); if (!c.checked && edit.sel === p) select(null); };
    b.textContent = partLabel(p);
    b.onclick = () => select(p);
    p.userData.button = b;
    row.append(c, b);
    box.append(row);
  }
  markEdited();
}
const itemVisible = (p) => (p.userData.skin ? p.userData.skin.node.visible : p.visible);
function setItemVisible(p, on) {
  if (p.userData.skin) p.userData.skin.node.visible = on; else p.visible = on;
  syncCuts();
  const i = current.assembly && curScene ? curScene.children.indexOf(p) : -1;
  const asm = i >= 0 && document.querySelectorAll('#asm-parts input')[i];
  if (asm) asm.checked = on;
}
function markEdited() { for (const p of edit.parts) p.userData.button?.classList.toggle('edited', isEdited(p)); }
function fitEditPanel() {   // between the model tabs (one or more rows) and the bottom edge
  $('#edit-panel').style.maxHeight = `${Math.max(240, innerHeight - $('#parts').getBoundingClientRect().bottom - 24)}px`;
}
addEventListener('resize', fitEditPanel);
function setEdit(on) {
  edit.on = on;
  $('#edit-panel').hidden = !on;
  fitEditPanel();
  $('#edit-toggle').classList.toggle('on', on);
  tc.enabled = on;
  if (edit.rigged) restPose(on);
  if (!on) select(null);
  else if (edit.parts.length === 1) select(edit.parts[0]);
}
function select(part) {
  edit.sel = part;
  const gizmo = part && (!part.userData.skin || anim.rest);   // a skinned item's gizmo matches it only in the bind pose
  if (gizmo) { tc.attach(part); editBox.visible = true; } else { tc.detach(); editBox.visible = false; }
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
  const v = p ? readPlace(p) : null;
  for (const r of PLACE) {
    if (!r.k) continue;
    const rg = r.row.querySelector('input[type=range]'), num = r.row.querySelector('input[type=number]'), val = v ? v[r.k] : r.zero;
    if (val < +rg.min || val > +rg.max) {   // widen the slider for a big move
      const w = Math.max(Math.abs(val - r.zero) * 1.5, r.max - r.zero);
      rg.min = r.zero - w; rg.max = r.zero + w;
    }
    if (document.activeElement !== rg) rg.value = val;
    if (document.activeElement !== num) num.value = v ? +val.toFixed(r.k === 's' ? 1 : r.unit === '°' ? 1 : 2) : '';
    r.row.classList.toggle('moved', !!v && Math.abs(val - r.zero) > 0.005);
  }
  markEdited();
}
// The placement fields: offsets from the item's own place in the character's terms (he faces +Z, his right is -X),
// turns about the item's centre, size in % of the original.
const PLACE = [
  { sec: 'Сдвиг' },
  { k: 'x', label: 'Влево ↔ вправо', sub: 'для персонажа', unit: 'см', min: -30, max: 30, step: 0.1, nudge: 0.5, zero: 0 },
  { k: 'y', label: 'Вниз ↔ вверх', unit: 'см', min: -30, max: 30, step: 0.1, nudge: 0.5, zero: 0 },
  { k: 'z', label: 'Назад ↔ вперёд', unit: 'см', min: -30, max: 30, step: 0.1, nudge: 0.5, zero: 0 },
  { sec: 'Поворот вокруг центра предмета' },
  { k: 'rx', label: 'Наклон назад ↔ вперёд', unit: '°', min: -90, max: 90, step: 0.5, nudge: 1, zero: 0 },
  { k: 'ry', label: 'Поворот влево ↔ вправо', sub: 'вокруг вертикали', unit: '°', min: -180, max: 180, step: 0.5, nudge: 1, zero: 0 },
  { k: 'rz', label: 'Наклон влево ↔ вправо', unit: '°', min: -90, max: 90, step: 0.5, nudge: 1, zero: 0 },
  { sec: 'Размер' },
  { k: 's', label: 'Меньше ↔ больше', unit: '%', min: 50, max: 200, step: 0.5, nudge: 1, zero: 100 },
];
const yawQ = () => (curScene ? curScene.quaternion.clone() : new THREE.Quaternion());
const D2R = THREE.MathUtils.degToRad, R2D = THREE.MathUtils.radToDeg;
function readPlace(p) {
  const b = p.userData.base, yq = yawQ(), yi = yq.clone().invert();
  const d = p.position.clone().sub(b.p).applyQuaternion(yq).multiplyScalar(100);
  const qv = yq.clone().multiply(p.quaternion.clone().multiply(b.q.clone().invert())).multiply(yi);
  const e = new THREE.Euler().setFromQuaternion(qv, 'XYZ');
  return { x: -d.x, y: d.y, z: d.z, rx: R2D(e.x), ry: -R2D(e.y), rz: R2D(e.z), s: p.scale.x / b.s.x * 100 };
}
function writePlace(p, v) {
  const b = p.userData.base, yq = yawQ(), yi = yq.clone().invert();
  p.position.copy(b.p).add(new THREE.Vector3(-v.x, v.y, v.z).multiplyScalar(0.01).applyQuaternion(yi));
  const qv = new THREE.Quaternion().setFromEuler(new THREE.Euler(D2R(v.rx), D2R(-v.ry), D2R(v.rz), 'XYZ'));
  p.quaternion.copy(yi.clone().multiply(qv).multiply(yq)).multiply(b.q);
  p.scale.copy(b.s).multiplyScalar(Math.max(1, v.s) / 100);
}
function setPlace(k, val) {
  const p = edit.sel;
  if (!p || !Number.isFinite(val)) return;
  const v = readPlace(p);
  v[k] = val;
  writePlace(p, v);
  moved(p);
}
function buildPlace() {
  const box = $('#place');
  for (const r of PLACE) {
    if (r.sec) { const h = document.createElement('div'); h.className = 'psec'; h.textContent = r.sec; box.append(h); continue; }
    const row = document.createElement('div');
    row.className = 'prow';
    const tip = `шаг ${r.nudge} ${r.unit}, с Shift ×10`;
    row.innerHTML = `<span class="pl" title="Двойной клик — вернуть как было">${r.label}${r.sub ? `<small>${r.sub}</small>` : ''}</span>`
      + `<button title="${tip}">−</button><input type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${r.zero}">`
      + `<button title="${tip}">+</button><input type="number" step="${r.step}"><span class="pu">${r.unit}</span>`;
    const [minus, plus] = row.querySelectorAll('button'), rg = row.querySelector('input[type=range]'), num = row.querySelector('input[type=number]');
    const nudge = (sgn, e) => { if (edit.sel) setPlace(r.k, readPlace(edit.sel)[r.k] + sgn * r.nudge * (e.shiftKey ? 10 : 1)); };
    minus.onclick = (e) => nudge(-1, e); plus.onclick = (e) => nudge(1, e);
    rg.oninput = () => setPlace(r.k, +rg.value);
    num.onchange = () => setPlace(r.k, +num.value);
    row.querySelector('.pl').ondblclick = () => setPlace(r.k, r.zero);
    r.row = row;
    box.append(row);
  }
}
buildPlace();
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
      ...(p.userData.skin ? { skinned: 'delta_matrix is applied to the vertices in model space, bind pose' } : {}),
      place: Object.fromEntries(Object.entries(readPlace(p)).map(([k, v]) => [k, +v.toFixed(2)])),
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

// ---------- geometry variants: «Как из Tripo» and the Blender fit ----------
// entry.raw = { src, offset } is the part's geometry exactly as Tripo made it (same UVs, no textures). Parts deformed to fit
// the body (chest conformed, glove tubes refitted) switch back to it and forth; textures and placement stay as they are.
// An assembly item's wrap = src is a second fit of the same mesh made in Blender (Shrinkwrap + Surface Deform,
// baine/wrap/wrap_fit.py), one file per item since a mirrored copy is fitted in its own place. «Подгонка к телу» in the
// assembly box picks it for every item that has one; «Как из Tripo» on a part wins over both fits.
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
const FITS = { manual: 'ручная', wrap: 'Blender: Shrinkwrap + Surface Deform' };
let fitVariant = (() => { const v = new URLSearchParams(location.search).get('fit') || localStorage.getItem('orc-fit'); return v in FITS ? v : 'manual'; })();
const geomKind = (part) => (part.userData.raw ? 'raw' : fitVariant === 'wrap' && part.userData.wrap ? 'wrap' : 'fit');
async function applyGeom(part) {
  const kind = geomKind(part), list = partMeshes(part);
  for (const m of list) { const u = m.userData; if (!u.geoms) u.geoms = { fit: u.baseGeom || m.geometry }; }
  if (kind !== 'fit' && list.some((m) => !m.userData.geoms[kind])) {
    const e = partEntry(part);
    const src = kind === 'raw' ? e.raw.src : part.userData.wrap, offset = kind === 'raw' ? e.raw.offset : null;
    setStatus(kind === 'raw' ? 'Загружаю геометрию из Tripo…' : 'Загружаю подгонку из Blender…');
    const geos = await loadRaw(src);
    for (const m of list) {
      const u = m.userData, g = geos[u.srcIdx];
      if (!g || u.geoms[kind]) continue;
      const off = new THREE.Vector3(...(offset || [0, 0, 0])).add(u.shift || new THREE.Vector3());
      u.geoms[kind] = g.clone().translate(off.x, off.y, off.z);
    }
  }
  if (geomKind(part) !== kind) return;   // switched again while loading: the later call does the swap
  for (const m of list) {
    const u = m.userData;
    const g = u.geoms[kind] || u.geoms.fit, prev = u.baseGeom || m.geometry;
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
}
function refreshGeom() { fitNote();
  applyMode(mode);
  fillPolys({ scene: curScene });
  if (edit.sel) fillEditFields();
}
async function setRaw(part, on) {
  const e = partEntry(part);
  if (!e || !e.raw) return;
  part.userData.raw = on;
  try { await applyGeom(part); } catch (err) { part.userData.raw = !on; throw err; }
  refreshGeom();
  setStatus(on ? `${partLabel(part)}: геометрия как из Tripo (без подгонки к телу).` : `${partLabel(part)}: подгонка к телу возвращена.`);
}
async function setFit(v) {
  if (!(v in FITS)) return;
  fitVariant = v;
  localStorage.setItem('orc-fit', v);
  syncFitUi();
  if (!curScene) return;
  const parts = curScene.children.filter((p) => p.userData.wrap);
  setStatus(`Подгонка: ${FITS[v]}…`);
  await Promise.all(parts.map(applyGeom));
  refreshGeom(); markDirty();
  setStatus(`Подгонка к телу: ${FITS[v]}.`);
}
function fitNote() {   // items showing the original mesh ignore the fit switch: say so next to it
  const el = $('#asm-fit-raw');
  if (!el) return;
  const raw = curScene ? curScene.children.filter((p) => p.userData.wrap && p.userData.raw).map(partLabel) : [];
  el.hidden = !raw.length;
  el.textContent = raw.length ? `Без подгонки (включён «исходный меш» в «Положении предметов»): ${raw.join(', ')}.` : '';
}
function syncFitUi() {
  for (const r of document.querySelectorAll('#asm-fit input')) r.checked = r.value === fitVariant;
  fitNote();
  if (current) history.replaceState(null, '', `?m=${current.id}${current.assembly && fitVariant !== 'manual' ? `&fit=${fitVariant}` : ''}`);
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
  $('#edit-toggle').textContent = n ? `✎ Положение предметов · правок: ${n}` : '✎ Положение предметов';
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
  const rig = edit.rigged, wasRest = anim.rest;
  if (rig) {   // the whole rig in the bind pose with every clip; the helper nodes stay out
    restPose(true);
    for (const p of edit.parts) if (p.userData.skin && p.visible) { p.visible = false; hidden.push(p); }
  }
  const jpeg = new Map();   // the exporter re-encodes every texture: opaque ones as JPEG (PNG made a 16 MB rig 200 MB)
  for (const m of meshes) for (const mat of [].concat(m.material)) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
    const t = mat[k];
    if (!t || jpeg.has(t) || (k === 'map' && (mat.transparent || mat.alphaTest > 0))) continue;
    jpeg.set(t, t.userData.mimeType); t.userData.mimeType = 'image/jpeg';
  }
  try {
    const glb = await new GLTFExporter().parseAsync(rig ? curScene : edit.parts,
      { binary: true, maxTextureSize: 4096, ...(rig ? { animations: curScene.userData.clips || [] } : {}) });
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${current.id}-edited.glb`);
    setStatus(`GLB с правками скачан: ${current.id}-edited.glb (${(glb.byteLength / 1048576).toFixed(1)} МБ).`);
  } catch (err) {
    setStatus(`Не удалось собрать GLB: ${err.message}`);
  } finally {
    for (const o of hidden) o.visible = true;
    for (const [t, v] of jpeg) if (v === undefined) delete t.userData.mimeType; else t.userData.mimeType = v;
    applyMode(mode);
    if (rig && !wasRest) restPose(false);
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
  while (p && !edit.parts.includes(p)) p = p.userData.item || p.parent;
  select(p || null);
});
$('#edit-toggle').onclick = () => setEdit(!edit.on);
$('#edit-exit').onclick = () => setEdit(false);
for (const b of document.querySelectorAll('#edit-tools button')) b.onclick = () => setTool(b.dataset.tool);
$('#edit-reset').onclick = () => { if (edit.sel) { resetPart(edit.sel); moved(edit.sel); } };
$('#edit-reset-all').onclick = () => {
  for (const p of edit.parts) { resetPart(p); applySkin(p); if (p.userData.raw) setRaw(p, false).catch(showEditError); }
  fillEditFields(); markDirty();
};
$('#edit-motion').onclick = () => restPose(!anim.rest);
$('#edit-json').onclick = () => {
  const data = editsJSON();
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${current.id}-placement.json`);
  setStatus(`JSON скачан: ${current.id}-placement.json (${Object.keys(data.parts).length} дет.).`);
};
$('#edit-raw').onclick = () => toggleRaw().catch(showEditError);
for (const r of document.querySelectorAll('#asm-fit input')) r.onchange = () => setFit(r.value).catch(showEditError);
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

// ---------- animation (rigged entries: one GLB with several glTF clips) ----------
const clock = new THREE.Clock();
const anim = { mixer: null, actions: [], cur: null, paused: false, rest: false, last: null };
function setAnim(gscene) {
  anim.mixer?.stopAllAction(); anim.mixer = null; anim.actions = []; anim.cur = null; anim.last = null; anim.rest = false;
  const clips = gscene?.userData.clips;
  $('#anim-box').hidden = !clips;
  if (!clips) return;
  anim.mixer = new THREE.AnimationMixer(gscene);
  anim.mixer.timeScale = +$('#anim-speed').value;
  const box = $('#anim-clips'); box.innerHTML = '';
  for (const c of clips) {
    const b = document.createElement('button'); b.textContent = CLIP_NAMES[c.name] || c.name; b.dataset.clip = c.name;
    b.onclick = () => playClip(c.name); box.append(b);
    anim.actions.push(anim.mixer.clipAction(c));
  }
  const order = Object.keys(CLIP_NAMES), rank = (b) => (order.indexOf(b.dataset.clip) + 1) || 99;
  box.append(...[...box.children].sort((a, b) => rank(a) - rank(b)));
  playClip(clips.find((c) => /^idle$/i.test(c.name))?.name || clips[0].name);
  if (edit.on && edit.rigged) restPose(true);
}
const ORC_CLIPS = { idle: 'Стойка (орк)', walk: 'Ходьба', run: 'Бег', slash: 'Удар мечом', cheer: 'Ликование', rig_test: 'Тест рига' };
const CLIP_NAMES = { Idle: 'Стойка', Walk: 'Шаг', Attack: 'Удар', Roar: 'Рёв',
  ...Object.fromEntries(Object.entries(ORC_CLIPS).map(([k, v]) => [`Orc${k.replace(/(^|_)(\w)/g, (_, a, c) => c.toUpperCase())}`, v])), ...ORC_CLIPS };
function playClip(name) {
  const next = anim.actions.find((a) => a.getClip().name === name);
  if (!next) return;
  anim.last = name;
  if (anim.rest) { restPose(false); return; }   // a clip picked while placing items: show the motion
  next.reset().play();
  if (anim.cur && anim.cur !== next) anim.cur.crossFadeTo(next, 0.25, false);
  anim.cur = next;
  for (const b of document.querySelectorAll('#anim-clips button')) b.classList.toggle('on', b.dataset.clip === name);
}
$('#anim-speed').oninput = (e) => { $('#anim-speed-v').textContent = `×${(+e.target.value).toFixed(2)}`; if (anim.mixer) anim.mixer.timeScale = +e.target.value; };
function setPaused(on) {
  anim.paused = on;
  $('#anim-pause').classList.toggle('on', on);
  $('#anim-pause').textContent = on ? '▶' : '⏸';
  $('#anim-pause').title = on ? 'Продолжить (пробел)' : 'Пауза (пробел)';
}
$('#anim-pause').onclick = () => setPaused(!anim.paused);
$('#anim-scrub').oninput = (e) => {   // drag through the clip: pauses it
  if (!anim.cur || anim.rest) return;
  seekClip(+e.target.value * anim.cur.getClip().duration);
};
function seekClip(t) {   // a still frame of the current clip (no half-done crossfade from the previous one)
  setPaused(true);
  for (const a of anim.actions) if (a !== anim.cur) a.stop();
  anim.cur.stopFading().setEffectiveWeight(1);
  anim.cur.time = t;
  anim.mixer.update(0);
}
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !anim.mixer || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
  e.preventDefault();
  setPaused(!anim.paused);
});
function animUI() {
  const a = anim.cur, d = a ? a.getClip().duration : 0, t = a && !anim.rest ? a.time % (d || 1) : 0;
  const sc = $('#anim-scrub');
  if (document.activeElement !== sc) sc.value = d ? t / d : 0;
  sc.disabled = anim.rest;
  const txt = anim.rest ? 'поза настройки' : `${t.toFixed(2)} / ${d.toFixed(2)} с`;
  if ($('#anim-time').textContent !== txt) $('#anim-time').textContent = txt;
}

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
  const dt = Math.min(clock.getDelta(), 0.1);
  if (anim.mixer && !anim.paused && !anim.rest) anim.mixer.update(dt);
  if (anim.mixer) animUI();
  controls.update();
  if (tc.camera !== camera) tc.camera = camera;
  if (edit.sel?.userData.skin) editBox.box.copy(edit.sel.userData.skin.box).applyMatrix4(edit.sel.parent.matrixWorld);
  else if (edit.sel) editBox.box.setFromObject(edit.sel);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

// Console / automation hook: viewer.render() draws a frame even when the tab is in the background.
window.viewer = {
  render: frame,
  edit: {
    toggle: (on) => setEdit(on === undefined ? !edit.on : on),
    select: (name) => select(edit.parts.find((p) => p.name === name) || null),
    place: (v) => { if (!edit.sel) return null; if (v) { writePlace(edit.sel, { ...readPlace(edit.sel), ...v }); moved(edit.sel); } return readPlace(edit.sel); },
    motion: (on) => restPose(!on),
    save: () => saveEdits(),
    json: () => editsJSON(),
    glb: () => exportGLB(),
    add: (id) => addModel(id),
    raw: (on) => edit.sel && setRaw(edit.sel, on),
    fit: (v) => setFit(v),
    fits: () => (curScene ? curScene.children.filter((p) => p.userData.wrap) : []).map((p) => {   // per item: shown geometry, its largest offset from the manual fit
      const m = partMeshes(p)[0], u = m.userData, a = (u.baseGeom || m.geometry).attributes.position.array, f = u.geoms?.fit?.attributes.position.array || a;
      let d = 0; for (let i = 0; i < a.length; i += 3) d = Math.max(d, Math.hypot(a[i] - f[i], a[i + 1] - f[i + 1], a[i + 2] - f[i + 2]));
      return { name: p.name, kind: geomKind(p), verts: a.length / 3, maxOffset: +d.toFixed(4), scale: +p.scale.x.toFixed(3) };
    }),
    remove: () => removePart(edit.sel),
    state: () => ({ on: edit.on, sel: edit.sel && edit.sel.name, raw: !!(edit.sel && edit.sel.userData.raw), fit: fitVariant, parts: edit.parts.map((p) => p.name), tool: tc.mode, saved: localStorage.getItem(editKeyName()), status: $('#edit-status').textContent }),
  },
  mode: (id) => applyMode(id),
  anim: (name, t) => { if (name) playClip(name); if (t !== undefined && anim.cur) seekClip(t); return { clips: anim.actions.map((a) => a.getClip().name), cur: anim.cur && anim.cur.getClip().name }; },
  camera: (name) => setCamera(name),
  look: (pos, target) => { camera.position.set(...pos); controls.target.set(...target); controls.update(); },
  box: () => { const b = new THREE.Box3(); for (const o of meshes) b.expandByObject(o); return [b.min.toArray(), b.max.toArray()]; },
  state: () => ({ model: current && current.id, mode, meshes: meshes.length, loading: !$('#loading').hidden, text: $('#loading-text').textContent, hq: $('#hq-badge')?.hidden === false ? $('#hq-badge').textContent : '' }),
};

// ---------- start ----------
manifest = await (await fetch('models.json', { cache: 'no-cache' })).json();
buildNav();
fillAddList();
const wanted = new URLSearchParams(location.search).get('m');
loadModel(manifest.models.find((m) => m.id === wanted) || manifest.models[0]).catch(showError);
