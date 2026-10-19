/* ==========================================================================
   岁语 · 数字人「小孙子」
   --------------------------------------------------------------------------
   重新建模版：分层绘制的半写实扁平插画
     顺序：背景光 → 身体 → 脖子 → 后发 → 脸 → 耳 → 阴影 → 眉 → 眼 →
           鼻 → 嘴 → 腮红 → 刘海
   表情系统通过 CSS class + 自定义属性驱动，便于扩展和维护。

   对外接口（挂在 window.SeyoAvatar）：
     svg()                  → 返回 SVG 字符串
     faces                  → 表情定义表
     setFace(name, root)    → 切换到某个表情
     mount(el)              → 把数字人放进容器并启动待机动画
     lipStart() / lipStop() → 说话时的口型动画
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     造型参数（想调脸型、五官位置，改这里就行）
     ------------------------------------------------------------------ */
  const G = {
    cx: 160,            // 中轴
    faceTop: 40,        // 头顶
    chin: 232,          // 下巴
    faceHalf: 77,       // 脸最宽处的半宽
    eyeY: 130,          // 眼睛中线
    eyeDX: 37,          // 两眼到中轴的距离
    eyeRX: 18,          // 眼睛半宽
    eyeRY: 15.5,        // 眼睛半高
    browY: 103,         // 眉毛
    noseY: 154,         // 鼻子
    mouthY: 182,        // 嘴
    neckTop: 196,       // 脖子顶（被脸挡住）
    shoulderY: 250,     // 肩线
  };

  const FACE_PATH = `M160 40
    C 202 40 234 72 237 120
    C 239 150 235 176 223 197
    C 211 219 188 232 160 232
    C 132 232 109 219 97 197
    C 85 176 81 150 83 120
    C 86 72 118 40 160 40 Z`;

  /* ------------------------------------------------------------------
     SVG —— 数字人本体
     同一页面可能挂多份（开场页 + 主界面），所以每次生成都给 id 加独立前缀，
     否则浏览器只会认第一份的渐变，第二份的 url(#…) 全部失效（脸和头发会消失）
     ------------------------------------------------------------------ */
  let seq = 0;

  /** 把 svg 里所有 id 和 url(#id) 加上命名空间前缀 */
  function nsify(text, ns) {
    const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    let out = text;
    for (const k of ids) {
      out = out.split(`id="${k}"`).join(`id="${ns}-${k}"`);
      out = out.split(`url(#${k})`).join(`url(#${ns}-${k})`);
    }
    return out;
  }

  function svg(ns) {
    const n = ns || `sa${++seq}`;
    const { cx, eyeY, eyeDX, eyeRX, eyeRY, browY, noseY, mouthY } = G;
    const eL = cx - eyeDX;
    const eR = cx + eyeDX;

    /** 一只眼睛 */
    const eye = (x, side) => `
      <g class="eye" data-side="${side}">
        <ellipse cx="${x}" cy="${eyeY}" rx="${eyeRX}" ry="${eyeRY}" fill="#fdfaf6"/>
        <ellipse cx="${x}" cy="${eyeY - 2}" rx="${eyeRX - 1.5}" ry="${eyeRY - 1.5}" fill="url(#irisShade)" opacity=".4"/>
        <circle class="iris" cx="${x}" cy="${eyeY + 1}" r="9.5" fill="url(#iris)"/>
        <circle class="iris-ring" cx="${x}" cy="${eyeY + 1}" r="9.5" fill="none" stroke="#46301f" stroke-width="1.4" opacity=".45"/>
        <circle class="pupil" cx="${x}" cy="${eyeY + 1}" r="4.3" fill="#1d1511"/>
        <circle cx="${x + 3}" cy="${eyeY - 3.2}" r="2.7" fill="#fff" opacity=".92"/>
        <circle cx="${x - 3.2}" cy="${eyeY + 3.6}" r="1.4" fill="#fff" opacity=".38"/>
        <path d="M${x - eyeRX + 1} ${eyeY - 4.5} Q${x} ${eyeY - eyeRY - 1.5} ${x + eyeRX - 1} ${eyeY - 4.5}"
              stroke="#cf9469" stroke-width="1.9" fill="none" opacity=".35" stroke-linecap="round"/>
        <path d="M${x - eyeRX} ${eyeY - 2} Q${x} ${eyeY - eyeRY - 1} ${x + eyeRX} ${eyeY - 2}"
              stroke="#3d2b20" stroke-width="3" fill="none" stroke-linecap="round"/>
      </g>`;

    /** 上眼睑（眨眼） */
    const lid = (x) => `
      <ellipse class="lid" cx="${x}" cy="${eyeY + 1}" rx="${eyeRX + 1.5}" ry="${eyeRY + 2}"
               fill="#f2c69f" opacity="0"/>`;

    /** 眉毛 */
    const brow = (x, side) => `
      <path class="brow brow-${side}"
            d="M${x - 18} ${browY + 3} Q${x - 2} ${browY - 3.5} ${x + 17} ${browY + 1.5}"
            stroke="#54402f" stroke-width="5.6" fill="none" stroke-linecap="round"/>`;

    const out = `
<svg class="seyo-avatar-svg" viewBox="0 0 320 400" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="岁语数字人">
  <defs>
    <radialGradient id="glow" cx="50%" cy="40%" r="58%">
      <stop offset="0%"   stop-color="#fff8ec"/>
      <stop offset="60%"  stop-color="#fdeedd"/>
      <stop offset="100%" stop-color="#f6e2cb" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="skin" x1="0.1" y1="0" x2="0.4" y2="1">
      <stop offset="0%"   stop-color="#fddcba"/>
      <stop offset="55%"  stop-color="#f8cfa6"/>
      <stop offset="100%" stop-color="#efbb90"/>
    </linearGradient>
    <linearGradient id="skinSide" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#e0a072" stop-opacity=".5"/>
      <stop offset="100%" stop-color="#e0a072" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="skinSideR" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0%"   stop-color="#e0a072" stop-opacity=".5"/>
      <stop offset="100%" stop-color="#e0a072" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="hairTop" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%"   stop-color="#5f4536"/>
      <stop offset="42%"  stop-color="#3f2c21"/>
      <stop offset="100%" stop-color="#2b1d16"/>
    </linearGradient>
    <linearGradient id="hairBack" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#3d2a21"/>
      <stop offset="100%" stop-color="#241811"/>
    </linearGradient>
    <linearGradient id="shirt" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0%"   stop-color="#7dab8a"/>
      <stop offset="52%"  stop-color="#5d8b69"/>
      <stop offset="100%" stop-color="#436a4e"/>
    </linearGradient>
    <linearGradient id="shirtShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#2c4a36" stop-opacity=".34"/>
      <stop offset="50%"  stop-color="#2c4a36" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="iris" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#8d6547"/>
      <stop offset="55%"  stop-color="#654631"/>
      <stop offset="100%" stop-color="#3e2a1c"/>
    </linearGradient>
    <radialGradient id="irisShade" cx="50%" cy="30%" r="70%">
      <stop offset="0%"   stop-color="#fff" stop-opacity="0"/>
      <stop offset="100%" stop-color="#3a2418" stop-opacity=".5"/>
    </radialGradient>
    <radialGradient id="blush" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#ef8f77" stop-opacity=".42"/>
      <stop offset="65%"  stop-color="#ef8f77" stop-opacity=".14"/>
      <stop offset="100%" stop-color="#ef8f77" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="floor" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#b99b78" stop-opacity=".32"/>
      <stop offset="100%" stop-color="#b99b78" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="faceClip"><path d="${FACE_PATH}"/></clipPath>
    <clipPath id="mouthClip">
      <ellipse cx="${cx}" cy="${mouthY + 4}" rx="26" ry="20"/>
    </clipPath>
  </defs>

  <circle cx="160" cy="180" r="152" fill="url(#glow)"/>
  <ellipse cx="160" cy="388" rx="120" ry="13" fill="url(#floor)"/>

  <!-- 身体 -->
  <g class="body" data-sway="calm">
    <path d="M160 ${G.shoulderY}
             C 118 ${G.shoulderY} 80 276 68 314
             C 60 340 56 368 56 400
             L 264 400
             C 264 368 260 340 252 314
             C 240 276 202 ${G.shoulderY} 160 ${G.shoulderY} Z"
          fill="url(#shirt)"/>
    <path d="M160 ${G.shoulderY}
             C 118 ${G.shoulderY} 80 276 68 314
             C 60 340 56 368 56 400
             L 264 400
             C 264 368 260 340 252 314
             C 240 276 202 ${G.shoulderY} 160 ${G.shoulderY} Z"
          fill="url(#shirtShade)"/>
    <!-- 圆领 -->
    <path d="M129 253 C 140 271 180 271 191 253
             C 185 248 173 245 160 245
             C 147 245 135 248 129 253 Z" fill="#f7f1e6"/>
    <path d="M129 253 C 140 271 180 271 191 253"
          stroke="#ded1bd" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M134 306 q26 14 52 0" stroke="#3f6249" stroke-width="2" fill="none" opacity=".35"/>
  </g>

  <!-- 脖子 -->
  <g class="neck">
    <path d="M139 ${G.neckTop} L 181 ${G.neckTop} L 181 250 Q 160 262 139 250 Z" fill="#eeb98d"/>
    <path d="M139 ${G.neckTop} L 160 ${G.neckTop} L 160 256 Q 147 254 139 248 Z" fill="#dda678" opacity=".75"/>
  </g>

  <!-- 后发：实心块，只做头顶和两鬓的一点体积（短发，别盖到脸颊） -->
  <path class="hair-back"
        d="M160 22
           C 94 22 66 78 72 138
           C 74 150 78 158 84 164
           C 94 170 112 172 130 172
           L 190 172
           C 208 172 226 170 236 164
           C 242 158 246 150 248 138
           C 254 78 226 22 160 22 Z"
        fill="url(#hairBack)"/>

  <!-- 脸 -->
  <g class="head">
    <!-- 耳 -->
    <ellipse cx="85"  cy="148" rx="12.5" ry="19" fill="#f0bd93"/>
    <ellipse cx="235" cy="148" rx="12.5" ry="19" fill="#f0bd93"/>
    <path d="M85 141 q-4.5 8 0 14"  stroke="#dda57b" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M235 141 q4.5 8 0 14"  stroke="#dda57b" stroke-width="2.4" fill="none" stroke-linecap="round"/>

    <path d="${FACE_PATH}" fill="url(#skin)"/>

    <!-- 面部阴影（限制在脸内，做柔和的立体感） -->
    <g clip-path="url(#faceClip)">
      <ellipse cx="86"  cy="150" rx="24" ry="70" fill="url(#skinSide)"/>
      <ellipse cx="234" cy="150" rx="24" ry="70" fill="url(#skinSideR)"/>
      <ellipse cx="160" cy="84" rx="44" ry="22" fill="#fff4e4" opacity=".2"/>
      <ellipse cx="119" cy="178" rx="25" ry="17" fill="#e8a276" opacity=".09"/>
      <ellipse cx="201" cy="178" rx="25" ry="17" fill="#e8a276" opacity=".09"/>
      <ellipse cx="160" cy="242" rx="50" ry="16" fill="#e5a878" opacity=".11"/>
    </g>

    ${brow(eL, 'l')}
    ${brow(eR, 'r')}
    ${eye(eL, 'l')}
    ${eye(eR, 'r')}
    ${lid(eL)}
    ${lid(eR)}

    <!-- 鼻子 -->
    <path d="M160 ${noseY - 13} C 157 ${noseY - 1} 155 ${noseY + 3} 153 ${noseY + 6}"
          stroke="#dda57b" stroke-width="2.8" fill="none" stroke-linecap="round" opacity=".8"/>
    <path d="M153 ${noseY + 6} Q 160 ${noseY + 11} 167 ${noseY + 6}"
          stroke="#d79a6d" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".5"/>
    <ellipse cx="160" cy="${noseY + 1}" rx="7" ry="4" fill="#fff4e4" opacity=".18"/>

    <!-- 腮红 -->
    <ellipse class="blush" cx="112" cy="172" rx="21" ry="13" fill="url(#blush)"/>
    <ellipse class="blush" cx="208" cy="172" rx="21" ry="13" fill="url(#blush)"/>

    <!-- 嘴 -->
    <g class="mouth" style="--m:.22">
      <g class="mouth-inner" clip-path="url(#mouthClip)">
        <path class="mouth-gap"
              d="M${cx - 22} ${mouthY - 8} Q ${cx} ${mouthY} ${cx + 22} ${mouthY - 8}
                 Q ${cx + 16} ${mouthY + 21} ${cx} ${mouthY + 21}
                 Q ${cx - 16} ${mouthY + 21} ${cx - 22} ${mouthY - 8} Z"
              fill="#8d3f2c"/>
        <path class="mouth-teeth"
              d="M${cx - 17} ${mouthY - 6} Q ${cx} ${mouthY + 1} ${cx + 17} ${mouthY - 6}
                 L ${cx + 15} ${mouthY} Q ${cx} ${mouthY + 6} ${cx - 15} ${mouthY} Z"
              fill="#fdf8f2"/>
        <path class="mouth-tongue"
              d="M${cx - 10} ${mouthY + 11} Q ${cx} ${mouthY + 7} ${cx + 10} ${mouthY + 11}
                 Q ${cx + 7} ${mouthY + 20} ${cx} ${mouthY + 20}
                 Q ${cx - 7} ${mouthY + 20} ${cx - 10} ${mouthY + 11} Z"
              fill="#dc7b73"/>
      </g>
      <path class="mouth-line"
            d="M${cx - 22} ${mouthY - 8} Q ${cx} ${mouthY} ${cx + 22} ${mouthY - 8}"
            stroke="#b0573f" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    </g>
  </g>

  <!-- 刘海：实心一片，发际线是顺滑的弧 -->
  <path class="hair-front"
        d="M91 124
           C 84 78 113 28 160 28
           C 207 28 236 78 229 124
           C 225 106 219 93 209 86
           C 195 76 176 72 159 75
           C 141 78 129 86 121 96
           C 113 106 100 116 91 124 Z"
        fill="url(#hairTop)"/>
  <!-- 发丝与高光 -->
  <path d="M150 36 C 141 54 134 76 130 98" stroke="#1f1410" stroke-width="2.4" fill="none" opacity=".26" stroke-linecap="round"/>
  <path d="M174 38 C 184 54 192 74 196 96"  stroke="#1f1410" stroke-width="2"   fill="none" opacity=".17" stroke-linecap="round"/>
  <path d="M110 58 C 128 42 152 38 170 43 C 150 44 128 53 114 68 Z" fill="#8a6a54" opacity=".34"/>
  <path d="M186 46 C 206 54 224 70 231 92 C 222 70 204 56 186 46 Z" fill="#7a5a46" opacity=".26"/>
</svg>`;
    return nsify(out, n);
  }

  /* ------------------------------------------------------------------
     表情表
       brow: [左眉旋转, 左右眉平移, 右眉旋转]（角度按外端旋转，更像真眉毛）
       lid:  上眼睑遮盖 0~1（眨眼用 1）
       mouth: 张口幅度（--m）
       blush: 腮红强度
       sway:  身体摆动节奏
       pupil: 瞳孔偏移方向 [dx, dy]
     ------------------------------------------------------------------ */
  const FACE = {
    idle:      { brow: [0, 0, 0],    lid: 0,   mouth: 0.22, blush: 1,    sway: 'calm',  pupil: [0, 0] },
    listening: { brow: [-4, -2, -3], lid: 0,   mouth: 0.3,  blush: 1.05, sway: 'calm',  pupil: [0, -1] },
    thinking:  { brow: [-7, 2, -5],  lid: .22, mouth: 0.18, blush: .85,  sway: 'still', pupil: [-2, -2] },
    speaking:  { brow: [4, 1, 3],    lid: 0,   mouth: 0.55, blush: 1.05, sway: 'brisk', pupil: [0, 0] },
    happy:     { brow: [6, -2, 5],   lid: .1,  mouth: 0.72, blush: 1.25, sway: 'brisk', pupil: [0, 1] },
    soft:      { brow: [2, 1, 1],    lid: .16, mouth: 0.32, blush: .95,  sway: 'calm',  pupil: [0, 0] },
    concern:   { brow: [-3, -8, 8],  lid: 0,   mouth: 0.2,  blush: .6,   sway: 'still', pupil: [0, 1] },
    quiet:     { brow: [1, -3, 3],   lid: .3,  mouth: 0.16, blush: .65,  sway: 'slow',  pupil: [0, 2] },
  };

  /* ------------------------------------------------------------------
     表情控制
     ------------------------------------------------------------------ */
  let cur = 'idle';
  let lipTimer = null;
  let blinkTimer = null;

  const roots = () => document.querySelectorAll('.seyo-avatar');

  function setFace(name, only) {
    const f = FACE[name] || FACE.idle;
    cur = name;
    const scope = only ? [only] : Array.from(roots());
    for (const el of scope) {
      const bl = el.querySelector('.brow-l');
      const br = el.querySelector('.brow-r');
      // 眉毛：绕各自的中心旋转 + 上下平移
      if (bl) bl.setAttribute('transform',
        `rotate(${f.brow[0]} 124 ${G.browY}) translate(0 ${f.brow[1]})`);
      if (br) br.setAttribute('transform',
        `rotate(${f.brow[2]} 196 ${G.browY}) translate(0 ${f.brow[1]})`);
      el.querySelectorAll('.lid').forEach((l) => l.setAttribute('opacity', String(f.lid)));
      el.querySelectorAll('.blush').forEach((b) => b.setAttribute('opacity', String(f.blush)));
      const body = el.querySelector('.body');
      if (body) body.dataset.sway = f.sway;
      // 瞳孔微移（思考时看旁边，专注时看前方）
      el.querySelectorAll('.iris, .pupil').forEach((p) => {
        p.setAttribute('transform', `translate(${f.pupil[0]} ${f.pupil[1]})`);
      });
      // 张口幅度交给 CSS 变量
      const m = el.querySelector('.mouth');
      if (m) m.style.setProperty('--m', String(f.mouth));
    }
  }

  function lipStart() {
    lipStop();
    const step = () => {
      const v = (0.34 + Math.random() * 0.6).toFixed(2);
      document.querySelectorAll('.seyo-avatar .mouth').forEach((m) => m.style.setProperty('--m', v));
      lipTimer = setTimeout(step, 85 + Math.random() * 95);
    };
    step();
  }

  function lipStop() {
    if (lipTimer) clearTimeout(lipTimer);
    lipTimer = null;
    const v = String((FACE[cur] || FACE.idle).mouth);
    document.querySelectorAll('.seyo-avatar .mouth').forEach((m) => m.style.setProperty('--m', v));
  }

  /** 挂载：放进容器 + 启动待机动画 */
  function mount(el) {
    if (!el) return;
    el.classList.add('seyo-avatar');
    el.innerHTML = svg();
    setFace(cur, el);
    startBlink();
  }

  /** 眨眼 + 呼吸，只在页面可见、非说话时进行 */
  function startBlink() {
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = setInterval(() => {
      if (document.hidden) return;
      if (cur === 'quiet' || lipTimer) return;       // 安静/说话时不打断
      document.querySelectorAll('.seyo-avatar .lid').forEach((l) => {
        l.setAttribute('opacity', '1');
        setTimeout(() => {
          l.setAttribute('opacity', String((FACE[cur] || FACE.idle).lid));
        }, 130);
      });
    }, 4600);
  }

  window.SeyoAvatar = { svg, faces: FACE, setFace, mount, lipStart, lipStop, geom: G, current: () => cur };
})();
