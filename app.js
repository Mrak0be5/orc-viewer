import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
const MODES = [
  { id: 'pbr', key: '1', label: 'PBR', make: (m) => { m.normalMap = useNormalMap() ? m.userData.normalMap : null; m.needsUpdate = true; return m; } },
  { id: 'albedo', key: '2', label: 'Albedo (без света)', make: (m) => new THREE.MeshBasicMaterial({ map: m.map, color: m.color, toneMapped: false }) },
  { id: 'lit-color', key: '3', label: 'Не-PBR (Lambert)', make: (m) => new THREE.MeshLambertMaterial({ map: m.map, color: m.color }) },
  { id: 'clay', key: '4', label: 'Глина', make: (m) => new THREE.MeshStandardMaterial({ color: 0xb8b2aa, roughness: 0.65, metalness: 0, normalMap: useNormalMap() ? m.userData.normalMap : null }) },
  { id: 'matcap', key: '5', label: 'Matcap', make: (m) => new THREE.MeshMatcapMaterial({ matcap: MATCAP, normalMap: useNormalMap() ? m.userData.normalMap : null }) },
  { id: 'wire', key: '6', label: 'Сетка', make: () => new THREE.MeshBasicMaterial({ color: 0x9fb4ff, wireframe: true }) },
  { id: 'normals', key: '7', label: 'Нормали (геометрия)', make: () => new THREE.MeshNormalMaterial() },
  { id: 'normal-map', key: '8', label: 'Normal map', make: (m) => dataMaterial(m.userData.normalMap, new THREE.Vector4(0, 0, 0, -1), 0.5) },
  { id: 'rough', key: '9', label: 'Roughness', make: (m) => dataMaterial(m.roughnessMap, new THREE.Vector4(0, 1, 0, 0), m.roughness, m.roughness) },
  { id: 'metal', key: '0', label: 'Metalness', make: (m) => dataMaterial(m.metalnessMap, new THREE.Vector4(0, 0, 1, 0), m.metalness, m.metalness) },
  { id: 'uv', key: 'q', label: 'UV-чекер', make: () => new THREE.MeshBasicMaterial({ map: CHECKER, toneMapped: false }) },
  { id: 'facets', key: 'w', label: 'Грани (flat)', make: () => new THREE.MeshStandardMaterial({ color: 0xb8b2aa, roughness: 0.7, flatShading: true }) },
];
let mode = 'pbr';
const meshes = [];
const modeCache = new Map(); // mesh.uuid + mode -> material

function applyMode(id) {
  mode = id;
  for (const mesh of meshes) {
    const orig = mesh.userData.orig;
    if (id === 'pbr') { mesh.material = MODES[0].make(orig); continue; }
    const k = mesh.uuid + id + useNormalMap();
    if (!modeCache.has(k)) modeCache.set(k, MODES.find((m) => m.id === id).make(orig));
    mesh.material = modeCache.get(k);
  }
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === id);
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
    let o = mesh.userData.overlay;
    if (on && !o) {
      o = new THREE.Mesh(mesh.geometry, overlayMat);
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

async function fetchParts(parts, total) {
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
      setProgress(total ? got / total : 0, `Загрузка ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ`);
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

async function loadModel(entry) {
  current = entry;
  $('#model-note').textContent = entry.note || '';
  root.clear(); meshes.length = 0; modeCache.clear();
  const buffer = await fetchParts(entry.parts, entry.bytes);
  setProgress(1, 'Распаковка…');
  const gltf = await loader.parseAsync(buffer, '');
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m.userData.normalMap = m.normalMap;
    o.userData.orig = o.material;
    meshes.push(o);
  });
  // Tripo exports face +X; entry.yaw turns the model to face +Z (the viewer's "front").
  const model = new THREE.Group();
  gltf.scene.rotation.y = THREE.MathUtils.degToRad(entry.yaw || 0);
  model.add(gltf.scene);
  root.add(model);
  rawBox = new THREE.Box3().setFromObject(model);
  normalize();
  applyMode(mode);
  fillStats(gltf, entry);
  fillTextures();
  fillRefs(entry);
  setCamera('front');
  $('#loading').hidden = true;
}

// Center on X/Z, feet at 0, optional scale to 2.10 m.
function normalize() {
  const size = rawBox.getSize(new THREE.Vector3());
  const s = $('#scale21').checked && size.y > 0 ? TARGET_HEIGHT / size.y : 1;
  const model = root.children[0];
  if (!model) return;
  model.scale.setScalar(s);
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
    const g = o.geometry;
    verts += g.attributes.position.count;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const m of [].concat(o.material)) {
      mats.add(m);
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) texs.add(m[k]);
      if (m.userData.normalMap) texs.add(m.userData.normalMap);
    }
  });
  const size = rawBox.getSize(new THREE.Vector3());
  const rows = [
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

const TEX_NAMES = { map: 'BaseColor', normalMap: 'Normal', roughnessMap: 'Metal/Rough', metalnessMap: 'Metal/Rough', aoMap: 'AO', emissiveMap: 'Emissive' };
function drawTex(tex, canvas, max) {
  const img = tex.image;
  const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
  canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
  const g = canvas.getContext('2d');
  // glTF textures are stored with flipY = false; draw them the way they sit in the file.
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
}
function fillTextures() {
  const box = $('#textures');
  box.innerHTML = '';
  const seen = new Map();
  for (const mesh of meshes) for (const m of [].concat(mesh.userData.orig)) {
    for (const k of Object.keys(TEX_NAMES)) {
      const t = k === 'normalMap' ? m.userData.normalMap : m[k];
      if (t && !seen.has(t.uuid)) seen.set(t.uuid, { t, name: TEX_NAMES[k] });
    }
  }
  for (const { t, name } of seen.values()) {
    const fig = document.createElement('figure');
    const cv = document.createElement('canvas');
    drawTex(t, cv, 256);
    fig.append(cv);
    const cap = document.createElement('figcaption');
    cap.textContent = `${name} ${t.image.width}×${t.image.height}`;
    fig.append(cap);
    fig.onclick = () => openLightbox({ tex: t, caption: cap.textContent });
    box.append(fig);
  }
}
function fillRefs(entry) {
  const box = $('#refs');
  box.innerHTML = '';
  for (const r of entry.refs || []) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = r; img.loading = 'lazy';
    const cap = document.createElement('figcaption');
    cap.textContent = r.split('/').pop();
    fig.append(img, cap);
    fig.onclick = () => openLightbox({ src: r, caption: cap.textContent });
    box.append(fig);
  }
}
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
  const h = size.y;
  let target = c.clone(), dir, span = h * 1.16;
  switch (name) {
    case 'front': dir = new THREE.Vector3(0, 0, 1); break;
    case 'back': dir = new THREE.Vector3(0, 0, -1); break;
    case 'left': dir = new THREE.Vector3(1, 0, 0); break; // character's left side (model faces +Z)
    case 'right': dir = new THREE.Vector3(-1, 0, 0); break;
    case 'top': dir = new THREE.Vector3(0, 1, 0.001); span = Math.max(size.x, size.z) * 1.2; break;
    case 'three': dir = new THREE.Vector3(0.8, 0.25, 1).normalize(); break;
    case 'face': dir = new THREE.Vector3(0.35, 0.05, 1).normalize(); target = new THREE.Vector3(c.x, box.max.y - h * 0.075, c.z); span = h * 0.2; break;
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
renderer.domElement.addEventListener('dblclick', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(meshes, false)[0];
  if (!hit) return;
  const shift = hit.point.clone().sub(controls.target);
  controls.target.add(shift);
  camera.position.add(shift);
  controls.update();
});

// ---------- controls ----------
$('#wire-overlay').onchange = applyOverlay;
$('#normal-map-on').onchange = () => applyMode(mode);
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
$('#model').onchange = (e) => loadModel(manifest.models.find((m) => m.id === e.target.value));
lightRig.rotation.y = THREE.MathUtils.degToRad(35);
$('#shot').onclick = () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `${current ? current.id : 'model'}-${mode}.png`;
  a.click();
};
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  const m = MODES.find((x) => x.key === k);
  if (m) applyMode(m.id);
  if (k === 'e') { $('#wire-overlay').checked = !$('#wire-overlay').checked; applyOverlay(); }
  if (k === 'r') { const c = $('#autorotate'); c.checked = !c.checked; controls.autoRotate = c.checked; }
  if (e.key === 'Escape') $('#lightbox').hidden = true;
});

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
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// Console / automation hook: viewer.render() draws a frame even when the tab is in the background.
window.viewer = {
  render: () => { controls.update(); renderer.render(scene, camera); },
  mode: (id) => applyMode(id),
  camera: (name) => setCamera(name),
  state: () => ({ model: current && current.id, mode, meshes: meshes.length, loading: !$('#loading').hidden, text: $('#loading-text').textContent }),
};

// ---------- start ----------
manifest = await (await fetch('models.json', { cache: 'no-cache' })).json();
for (const m of manifest.models) $('#model').append(new Option(m.title, m.id));
const wanted = new URLSearchParams(location.search).get('m');
const first = manifest.models.find((m) => m.id === wanted) || manifest.models[0];
$('#model').value = first.id;
loadModel(first).catch((err) => setProgress(0, `Ошибка: ${err.message}`));
