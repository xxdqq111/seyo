/* ==========================================================================
   岁语 · 3D 数字人（VRM）
   --------------------------------------------------------------------------
   跟 avatar.js 那套 2D 的**接口完全一样**：
     mount(el) · setFace(name) · lipStart() / lipStop() · current()
   所以 app.js 一行都不用改，换的只是这里。

   技术栈（全部 vendor 在 public/vendor/，不走 npm、不连外网）：
     three.js r160        → 渲染
     @pixiv/three-vrm 3.x → 解析 VRM 的人形骨骼 + 表情系统
     GLTFLoader           → 读 glb/vrm

   画布策略：**只有一块 WebGL 画布**，哪块容器看得见就把它搬进去。
   一开始想过"渲一次再 blit 到多块 2D 画布"，但 drawImage 对 WebGL 画布
   会抛 InvalidStateError，而且多一份拷贝在树莓派上是白费力气。

   口型：VRM 自带 5 个元音 aa/ih/ou/ee/oh，我们拿不到 TTS 的音素时间轴，
   所以说话时按节奏轮换这几个 —— 是"假口型"，不是逐音素对齐。
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '/vendor/three-vrm.module.min.js';

const MODEL_URL = '/models/seyo.vrm';

/* ------------------------------------------------------------------ *
 * 表情映射
 * ------------------------------------------------------------------ */
const FACES = {
  idle: { preset: 'neutral', weight: 0.0, sway: 1.0 },
  listening: { preset: 'relaxed', weight: 0.55, sway: 0.7 },
  thinking: { preset: 'relaxed', weight: 0.30, sway: 0.5, lookUp: true },
  speaking: { preset: 'happy', weight: 0.40, sway: 1.3 },
  happy: { preset: 'happy', weight: 0.95, sway: 1.5 },
  soft: { preset: 'relaxed', weight: 0.75, sway: 0.6 },
  quiet: { preset: 'relaxed', weight: 0.45, sway: 0.4 },
};
const PRESETS = ['neutral', 'relaxed', 'happy', 'sad', 'angry', 'surprised'];
const VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'];
const BLINKS = ['blink', 'blinkLeft', 'blinkRight'];

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
let renderer = null;
let scene = null;
let camera = null;
let vrm = null;
let clock = null;
let raf = null;

const hosts = [];
let currentHost = null;

let faceName = 'idle';
const faceMix = {};

let lipOn = false;
let lipNextAt = 0;
let lipVowel = 'aa';

let blinkNextAt = 0;
let blinkUntil = 0;
let blinkKind = 'blink';

const pointer = { x: 0, y: 0 };
let ready = false;
let failed = null;
let starting = false;
let restHipsY = 0;      // 胯的静止高度，呼吸动画在它上面叠加

/* ------------------------------------------------------------------ *
 * 尺寸 / 画布摆放
 * ------------------------------------------------------------------ */
function sizeOf(host) {
  const r = host.getBoundingClientRect();
  const w = Math.max(160, Math.round(r.width || 300));
  const h = Math.max(200, Math.round(r.height || 380));
  return { w: w, h: h };
}

function fitTo(host) {
  if (!renderer || !host) return;
  const s = sizeOf(host);
  renderer.setSize(s.w, s.h, false);    // false：尺寸交给 CSS(100%)，别写死内联样式
  camera.aspect = s.w / s.h;
  camera.updateProjectionMatrix();
  const cv = renderer.domElement;
  cv.style.width = '100%';
  cv.style.height = '100%';
  cv.style.display = 'block';
}

function placeCanvas() {
  if (!renderer || !hosts.length) return;
  let host = null;
  for (let i = hosts.length - 1; i >= 0; i--) {
    if (hosts[i].offsetWidth > 0 && hosts[i].offsetHeight > 0) { host = hosts[i]; break; }
  }
  if (!host) host = hosts[hosts.length - 1];
  if (!host) return;
  if (renderer.domElement.parentElement !== host) {
    // 先把"正在唤醒岁语…"这个占位删掉 —— 留着它会跟画布上下排开，
    // 把容器撑高一倍，画布被 overflow:hidden 裁掉，就什么都看不见了。
    const ph = host.querySelector('.seyo-3d-loading');
    if (ph) ph.remove();
    host.appendChild(renderer.domElement);
    currentHost = host;
    fitTo(host);
  }
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
async function init() {
  const s0 = sizeOf(hosts[0] || document.body);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(s0.w, s0.h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ⚠️ 不要开色调映射。
  // 之前用了 ACESFilmic，结果肤色和衣服全被去饱和，看着**发灰**。
  // VRM 用的是 MToon 材质，本身就有卡通明暗分层，再压一道只会变脏。
  renderer.toneMapping = THREE.NoToneMapping;

  scene = new THREE.Scene();

  // 半身取景。头心约 y=1.55，头顶约 1.73。
  camera = new THREE.PerspectiveCamera(28, s0.w / s0.h, 0.05, 20);
  camera.position.set(0, 1.52, 0.94);
  camera.lookAt(0, 1.52, 0);

  // 亮度也一并调过 —— 关掉 ACES 之后原来那套强度会过曝。
  // 三盏灯都往暖里偏：MToon 的暗部容易发灰发蓝，环境光用暖白能压住。
  const key = new THREE.DirectionalLight(0xfff4e6, 1.75); key.position.set(0.9, 1.9, 1.9);
  const fill = new THREE.DirectionalLight(0xf6f7ff, 0.38); fill.position.set(-1.5, 1.1, 1.3);
  const rim = new THREE.DirectionalLight(0xffffff, 0.32); rim.position.set(-0.4, 1.6, -1.8);
  scene.add(key, fill, rim, new THREE.AmbientLight(0xfff8f0, 0.90));

  clock = new THREE.Clock();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(MODEL_URL);
  vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('这个文件不是 VRM（没有 VRM 扩展），做不了表情');

  try {
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
  } catch { /* 优化失败不影响显示 */ }

  gltf.scene.traverse((o) => { o.frustumCulled = false; });
  scene.add(vrm.scene);

  // 把 T-pose 的胳膊放下来。VRM 归一化骨骼里左臂朝 +X，
  // 绕 Z 转负角才是往下（正角是往上举，第一版就写反了）。
  //
  // 另外：胯的**静止位置**要记下来。呼吸动画是"在静止位置上叠加"，
  // 直接写 hips.position.y = 0.005 会把它从胯高（约 1.0）拽到脚底下，
  // 整个人沉到画面外 —— 这个坑踩过一次。
  if (vrm.humanoid) {
    const hipsBone = vrm.humanoid.getNormalizedBoneNode('hips');
    if (hipsBone) restHipsY = hipsBone.position.y;

    const arms = [['leftUpperArm', -1], ['rightUpperArm', 1]];
    for (const pair of arms) {
      const name = pair[0];
      const sign = pair[1];
      const b = vrm.humanoid.getNormalizedBoneNode(name);
      if (b) {
        b.rotation.z = sign * 1.18;
        b.rotation.x = 0.1;
        b.rotation.y = sign * -0.12;
        const l = vrm.humanoid.getNormalizedBoneNode(name.replace('UpperArm', 'LowerArm'));
        if (l) { l.rotation.z = sign * 0.2; l.rotation.y = sign * -0.25; }
      }
    }
  }

  const exCount = vrm.expressionManager ? vrm.expressionManager.expressions.length : 0;
  if (vrm.expressionManager) {
    const all = VOWELS.concat(PRESETS, BLINKS);
    for (const n of all) {
      try { vrm.expressionManager.setValue(n, 0); } catch { /* 模型没这个表情 */ }
    }
  }

  ready = true;
  blinkNextAt = performance.now() + 1500 + Math.random() * 2200;
  placeCanvas();
  raf = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ *
 * 每帧
 * ------------------------------------------------------------------ */
function frame() {
  raf = requestAnimationFrame(frame);
  if (!ready || !vrm) return;

  placeCanvas();

  const now = performance.now();
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const f = FACES[faceName] || FACES.idle;
  const em = vrm.expressionManager;

  if (em) {
    const want = {};
    for (const p of PRESETS) want[p] = 0;
    want[f.preset] = f.weight;
    for (const name of Object.keys(want)) {
      const goal = want[name];
      const cur = faceMix[name] === undefined ? 0 : faceMix[name];
      faceMix[name] = cur + (goal - cur) * Math.min(1, dt * 6);
      try { em.setValue(name, faceMix[name]); } catch { /* ignore */ }
    }
  }

  if (vrm.humanoid) {
    const sw = f.sway;
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    const chest = vrm.humanoid.getNormalizedBoneNode('chest');
    const neck = vrm.humanoid.getNormalizedBoneNode('neck');
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (hips) hips.position.y = restHipsY + Math.sin(t * 1.35) * 0.005 * sw;
    if (chest) {
      chest.rotation.z = Math.sin(t * 0.85) * 0.012 * sw;
      chest.rotation.x = Math.sin(t * 1.35) * 0.008 * sw;
    }
    if (neck) neck.rotation.x = Math.sin(t * 0.7) * 0.012 * sw;
    if (head) {
      const ty = pointer.x * 0.14 + Math.sin(t * 0.52) * 0.035 * sw;
      const tx = pointer.y * -0.09 + Math.sin(t * 0.78) * 0.02 * sw + (f.lookUp ? -0.06 : 0);
      head.rotation.y += (ty - head.rotation.y) * Math.min(1, dt * 3);
      head.rotation.x += (tx - head.rotation.x) * Math.min(1, dt * 3);
      head.rotation.z = Math.sin(t * 0.62) * 0.018 * sw;
    }
  }

  let blinkW = 0;
  if (now < blinkUntil) {
    const p = 1 - (blinkUntil - now) / 160;
    blinkW = Math.sin(Math.max(0, Math.min(1, p)) * Math.PI);
  } else if (now >= blinkNextAt) {
    blinkUntil = now + 160;
    blinkNextAt = now + 2400 + Math.random() * 3600;
    const r = Math.random();
    blinkKind = r < 0.08 ? 'blinkLeft' : r < 0.16 ? 'blinkRight' : 'blink';
  }

  let vowelW = 0;
  if (lipOn) {
    if (now >= lipNextAt) {
      lipNextAt = now + 95 + Math.random() * 70;
      const pool = VOWELS.filter((v) => v !== lipVowel);
      lipVowel = pool[Math.floor(Math.random() * pool.length)];
    }
    vowelW = 0.42 + Math.random() * 0.25;
  }

  if (em) {
    try {
      em.setValue(blinkKind, blinkW);
      for (const b of BLINKS) if (b !== blinkKind) em.setValue(b, 0);
      for (const v of VOWELS) em.setValue(v, v === lipVowel ? vowelW : 0);
    } catch { /* ignore */ }
  }

  vrm.update(dt);
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ *
 * 对外接口（和 avatar.js 一模一样）
 * ------------------------------------------------------------------ */
export function mount(host) {
  if (!host || hosts.indexOf(host) >= 0) return;
  hosts.push(host);
  host.classList.add('seyo-3d-host');

  if (renderer) { placeCanvas(); return; }

  if (!host.firstChild) {
    const ph = document.createElement('div');
    ph.className = 'seyo-3d-loading';
    ph.textContent = '正在唤醒岁语…';
    host.appendChild(ph);
  }

  if (starting) return;
  starting = true;
  init().then(placeCanvas).catch((e) => {
    failed = e;
    console.error('[3D 数字人] 起不来：', e);
    for (const h of hosts) {
      h.innerHTML = '<div class="seyo-3d-err">3D 数字人没起来<br><span>'
        + String((e && e.message) || e) + '</span></div>';
    }
  });
}

export function setFace(name) {
  if (FACES[name]) faceName = name;
}

export function lipStart() {
  lipOn = true;
  lipNextAt = 0;
}

export function lipStop() {
  lipOn = false;
  if (vrm && vrm.expressionManager) {
    for (const v of VOWELS) { try { vrm.expressionManager.setValue(v, 0); } catch { /* ignore */ } }
  }
}

export function current() { return faceName; }
export function isReady() { return ready; }
export function error() { return failed; }
export function hasVRM() { return Boolean(vrm && vrm.expressionManager); }

/** 这个模型实际有哪些表情（排查用） */
export function expressions() {
  if (!vrm || !vrm.expressionManager) return [];
  return vrm.expressionManager.expressions.map((e) => e.expressionName);
}

window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
}, { passive: true });
window.addEventListener('pointerleave', () => { pointer.x = 0; pointer.y = 0; });

let resizeTimer = null;
function scheduleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentHost) fitTo(currentHost); }, 180);
}
window.addEventListener('resize', scheduleResize);
if (window.ResizeObserver) {
  const ro = new ResizeObserver(scheduleResize);
  const attach = () => { for (const h of hosts) { try { ro.observe(h); } catch { /* ignore */ } } };
  window.addEventListener('seyo-avatar3d-ready', attach);
}

window.SeyoAvatar3D = {
  mount: mount, setFace: setFace, lipStart: lipStart, lipStop: lipStop,
  current: current, isReady: isReady, error: error,
  expressions: expressions, hasVRM: hasVRM,
};
window.dispatchEvent(new Event('seyo-avatar3d-ready'));
