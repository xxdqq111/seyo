/* ==========================================================================
   岁语 · 前端
   - 数字人：二维卡通晚辈，表情随"聆听/思考/说话/情绪"变化（含眨眼、呼吸、口型）
   - 语音：按住说话（Web Speech API，Chrome/Edge 中文可用）；岁语用系统语音朗读
   - 内部过程：每一轮都把"听懂 → 查库 → 入库 → 库里现状"摊开显示
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = async (url, body) => {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
};

const S = {
  sessionId: 'web-' + Math.random().toString(36).slice(2, 8),
  persona: { agent_name: '岁语', self_ref: '小孙子', elder_call: '爷爷' },
  // 声音默认开着。上次明确关过才关 —— 在**声明的时候就恢复**，
  // 别等到后面再赋值：updateSoundNote() 在启动时就会根据它画按钮，
  // 恢复晚一步的话，刷新之后按钮会显示成"开"但其实静音着。
  muted: localStorage.getItem('seyo.muted') === '1',
  quiet: false,        // 老人自己按的「安静模式」= 不主动开口（持久选择）
  companion: false,    // 引擎那边的临时陪伴窗口（他情绪不高，这几轮不问事）—— 跟上面是两回事
  busy: false,
  listening: false,
  face: 'idle',
  turns: 0,
  bootAt: Date.now(), // 页面是什么时候打开的 —— 判断"这句是不是打开之前说的"
  audioBlocked: false, // 浏览器把声音挡住了（页面还没被点过），等第一次交互补上
  // 用什么念：'local' = 本机神经网络（默认）；'system' = 浏览器自带系统语音
  ttsEngine: localStorage.getItem('seyo.tts') === 'system' ? 'system' : 'local',
  ttsMs: 0,            // 最近一次合成耗时（给面板看）
  ttsAudioMs: 0,       // 最近一次合成出来的音频长度
  ttsError: '',        // 本机合成失败的原因（失败会自动退回系统语音）
  lastSpoken: '',      // 最近一次说的话，没出声时能重放
  gateTimer: 0,        // "怎么还没出声"的计时器
};

/* ======================================================================
   数字人
   ----------------------------------------------------------------------
   优先用 3D（avatar3d.js，加载 VRM 模型）；
   它要是没起来（模块挂了 / 浏览器不支持 WebGL），就用 2D（avatar.js）。
   两套接口一模一样：mount / setFace / lipStart / lipStop。
   ====================================================================== */
let A = window.SeyoAvatar;

/** 3D 是 ES module，比普通脚本晚执行，所以要等它一下 */
async function pickAvatar() {
  if (window.SeyoAvatar3D) { A = window.SeyoAvatar3D; return '3d'; }
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    window.addEventListener('seyo-avatar3d-ready', fin, { once: true });
    setTimeout(fin, 3000);          // 等不到就别等了，走 2D
  });
  if (window.SeyoAvatar3D) { A = window.SeyoAvatar3D; return '3d'; }
  return '2d';
}

/** 切表情，并同步"舞台"外圈的呼吸光 */
function setFace(name) {
  S.face = name;
  A.setFace(name);
  const st = document.getElementById('avatarStage');
  if (st) {
    st.dataset.mode = name === 'listening' ? 'listening'
      : (name === 'speaking' || name === 'happy') ? 'speaking' : '';
  }
}
const lipStart = () => A.lipStart();
const lipStop = () => A.lipStop();

/* ======================================================================
   状态与朗读
   ====================================================================== */
function status(kind, text) {
  $('status').className = `status ${kind}`;
  $('statusText').textContent = text;
}

let voice = null;

/* 浏览器**不给**性别，只能靠名字认。
   这台机器上 Chrome 能看到三个中文嗓音：
       Microsoft Huihui   （女）
       Microsoft Kangkang （男）  ← 岁语是"小孙子"，要这个
       Microsoft Yaoyao   （女）
   原来写的是 /Huihui|Yaoyao|Kangkang/ —— 正则会按数组顺序扫到第一个匹配的，
   而 Huihui 排在前面，所以永远选中女声，Kangkang 根本没机会。 */
const MALE_VOICE = /Kangkang|Yunxi|云希|Yunyang|云扬|Yunjian|云健|Yunfeng|Yunhao|Yunze|Male/i;
const FEMALE_VOICE = /Huihui|慧慧|Yaoyao|瑶瑶|Xiaoxiao|晓晓|Xiaoyi|晓伊|Xiaohan|小涵|Xiaomeng|晓梦|Xiaomo|晓墨|Xiaorui|晓睿|Xiaoshuang|晓双|Xiaoyan|晓艳|Xiaoyou|晓悠|Xiaozhen|晓臻|Yunxia|云霞|Yinping|银萍|Female/i;

/** 中文嗓音列表（设置里那个下拉框用） */
function zhVoices() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return vs.filter((v) => /zh|Chinese|中文/i.test(`${v.lang} ${v.name}`));
}

/** 挑一个适合"小孙子"的嗓音：男声优先，其次认不出性别的，最后才轮到女声 */
function pickVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  if (!vs.length) return;

  // 老人/家人自己在设置里选过 → 就用那个
  const saved = localStorage.getItem('seyo.voice') || '';
  if (saved) {
    const hit = vs.find((v) => v.name === saved);
    if (hit) { voice = hit; return; }
  }

  const zh = vs.filter((v) => /zh/i.test(v.lang));
  /* 优先挑**本机**的（localService）。
     Chrome 还会塞几个 Google 的嗓音 —— 那些要联网，说的话会发给 Google，
     跟这个项目"录音、画面、文字都不出这台机器"的底线冲突，默认不用。
     真想用也不是不行，在设置里照样能选，只是会标出来「要联网」。 */
  const local = zh.filter((v) => v.localService !== false);
  const pool = (local.length ? local : zh);
  const use = pool.length ? pool : vs;
  voice = use.find((v) => MALE_VOICE.test(v.name))          // 男声（Kangkang 这种）
    || use.find((v) => !FEMALE_VOICE.test(v.name))          // 认不出性别的
    || use[0];
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

/* ======================================================================
   说话：两条路
   ----------------------------------------------------------------------
   local （默认）  本机神经网络合成（sherpa-onnx + 中文男声）
                   先用 POST /api/say 拿到一段 WAV，再塞进 <audio> 播。
                   文字和声音都不出这台机器。

   system         浏览器自带的 speechSynthesis（就是 Windows 的 Kangkang 那些）。
                   音质硬、腔调老，但**不用等合成**、也不吃 CPU。
                   老机器跑不动神经网络 TTS 时能切回去。
   ====================================================================== */
let currentAudio = null;     // 正在播的那个 <audio>
let lastBlob = null;         // 最近合成好的 WAV，自动播放被拦时直接重播，不用再合一遍

/** 把正在说的停掉（重新说、关声音时都用） */
function stopSpeaking() {
  if (currentAudio) { try { currentAudio.pause(); } catch { /* ignore */ } currentAudio = null; }
  if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  clearTimeout(S.gateTimer);
}

/** 系统语音那条路（原来那套，留着当兜底） */
function speakSystem(clean) {
  if (!window.speechSynthesis) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    if (voice) u.voice = voice;
    u.lang = (voice && voice.lang) || 'zh-CN';
    /* 语速/音调。原来的 pitch = 1.1 是把音调**抬高**，听上去发尖、更不自然，
       而且会让本来低沉的男声也变娘。现在保持原调，只把语速放慢一点 ——
       对面坐的是老人，说慢些更听得清。 */
    u.rate = 0.95;
    u.pitch = 1.0;
    let started = false;
    u.onstart = () => {
      started = true;
      S.audioBlocked = false;
      updateSoundNote();
      status('speak', '岁语在说……'); setFace(S.quiet || S.companion ? 'quiet' : 'speaking'); lipStart();
    };
    u.onend = () => {
      const c = S.quiet || S.companion;
      lipStop(); setFace(c ? 'quiet' : 'idle');
      status(c ? 'quiet' : 'idle', c ? '陪着您' : '在听您说话');
    };
    u.onerror = () => { lipStop(); setFace('idle'); };
    speechSynthesis.speak(u);

    /* 浏览器有个限制：页面还没被点过的话，很多浏览器不让出声。
       1.2 秒还没 onstart 就记一笔，等页面里**第一次点击/按键**自动补上。 */
    S.gateTimer = setTimeout(() => {
      if (!started && !S.muted) {
        S.audioBlocked = true;
        updateSoundNote();
      }
    }, 1200);
    return true;
  } catch { return false; }
}

/** 播一段 WAV（本机合成出来的） */
function playBlob(blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  const done = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; };
  audio.onplay = () => {
    S.audioBlocked = false;
    updateSoundNote();
    status('speak', '岁语在说……');
    setFace(S.quiet || S.companion ? 'quiet' : 'speaking');
    lipStart();
  };
  audio.onended = () => {
    done(); lipStop();
    const c = S.quiet || S.companion;
    setFace(c ? 'quiet' : 'idle');
    status(c ? 'quiet' : 'idle', c ? '陪着您' : '在听您说话');
  };
  audio.onerror = () => { done(); lipStop(); setFace('idle'); };
  return audio.play();       // 被自动播放策略拦下会 reject，交给调用方处理
}

function speak(text) {
  S.lastSpoken = String(text || '');        // 留着：万一没出声，能重放
  if (S.muted) return;
  const clean = String(text || '').replace(/[（(][^）)]*[）)]/g, '').trim();
  if (!clean) return;
  stopSpeaking();

  // 选了系统语音就直接走那条
  if (S.ttsEngine === 'system') { speakSystem(clean); return; }

  /* 本机神经网络合成。合成要几百毫秒，所以这里必然是异步的 ——
     speak() 不返回 Promise，调用方本来也不用等。 */
  const t0 = performance.now();
  fetch('/api/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean, speed: 1.0 }),
  }).then(async (res) => {
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ('HTTP ' + res.status));
    }
    S.ttsMs = Number(res.headers.get('X-Seyo-Ms')) || Math.round(performance.now() - t0);
    S.ttsAudioMs = Number(res.headers.get('X-Seyo-Audio-Ms')) || 0;
    return res.blob();
  }).then((blob) => {
    lastBlob = blob;
    S.ttsError = '';
    return playBlob(blob);
  }).catch((e) => {
    /* 两种情况要分开：
       ① 自动播放被拦（NotAllowedError）→ 浏览器的策略，等第一次点击自动补
       ② 合成服务不可用（模型没装 / 进程没起来）→ 退回系统语音，别让老人干等 */
    const blocked = e && (e.name === 'NotAllowedError'
      || /play\(\)|user gesture|autoplay|not allowed/i.test(String(e.message || '')));
    if (blocked) {
      S.audioBlocked = true;
      updateSoundNote();
      return;
    }
    S.ttsError = String((e && e.message) || e);
    updateSoundNote();
    speakSystem(clean);       // 兜底：至少还有声音
  });
}

/**
 * 嗓音下拉框（设置 → 声音 → 用哪个嗓音）。
 *
 * 为什么让人自己选：浏览器只给名字不给性别，每台电脑装的中文嗓音又不一样
 * （这台机器上是 Huihui 女 / Kangkang 男 / Yaoyao 女）。
 * 哪个听着顺耳只有耳朵知道 —— 与其我猜，不如列出来让他挑，挑完记住。
 */
function fillVoiceList() {
  const sel = $('voiceSel');
  const note = $('voiceNote');
  if (!sel) return;

  const list = zhVoices();
  if (!list.length) {
    sel.innerHTML = '<option>（这个浏览器没有中文嗓音）</option>';
    sel.disabled = true;
    if (note) { note.textContent = '这台电脑没装中文朗读嗓音 —— 装一个中文本地语音包就能选了'; note.className = 'set-note warn'; }
    return;
  }

  sel.disabled = false;
  sel.innerHTML = list.map((v) => {
    const male = MALE_VOICE.test(v.name);
    const female = FEMALE_VOICE.test(v.name);
    const tag = male ? '（男）' : female ? '（女）' : '';
    // 非本机的嗓音要联网，说的话会发出去 —— 标清楚
    const net = v.localService === false ? '〔要联网〕' : '';
    const so = v.name === (voice && voice.name) ? ' selected' : '';
    return `<option value="${esc(v.name)}"${so}>${esc(v.name)}${tag}${net}</option>`;
  }).join('');

  if (note) {
    const cloud = voice && voice.localService === false;
    note.textContent = voice
      ? `现在用的是 ${voice.name}${MALE_VOICE.test(voice.name) ? '（男声）' : ''}${
        cloud ? ' —— 注意：这个要联网，说的话会发出去' : '（在本机念，不出门）'}`
      : '';
    note.className = cloud ? 'set-note warn' : 'set-note';
  }
}

/** 换嗓音：立刻记住、立刻念一句让人听 */
function applyVoice(name, say = true) {
  const hit = zhVoices().find((v) => v.name === name);
  if (!hit) return;
  voice = hit;
  localStorage.setItem('seyo.voice', hit.name);
  fillVoiceList();
  if (say) {
    // 用一句短的试听，别念长的
    const wasMuted = S.muted;
    S.muted = false;
    speak('爷爷，我是岁语。');
    S.muted = wasMuted;
  }
}

/**
 * 声音状态那一行（设置 → 声音）。
 * 分几种情况，说清楚现在是什么状况 —— 不然"没声音"只能靠猜。
 */
function updateSoundNote() {
  const el = $('soundNote');
  const btn = $('soundBtn');
  if (!el || !btn) return;
  updateTtsNote();
  if (S.muted) {
    el.textContent = '已关闭 —— 说的话只显示在屏幕上';
    el.className = 'set-note';
    btn.textContent = '🔇 声音已关';
    btn.classList.remove('on');
    return;
  }
  btn.textContent = '🔊 开启声音';
  btn.classList.add('on');
  if (S.audioBlocked) {
    el.textContent = '浏览器把声音挡住了（页面还没被点过）—— 随便点一下屏幕就出声了';
    el.className = 'set-note warn';
  } else {
    el.textContent = '声音开着';
    el.className = 'set-note';
  }
}

/**
 * 「用什么念」那一行。
 * 说清楚现在走的是哪条路、上回合成花了多久、失败了没有 ——
 * 不然"声音不对/没声音"只能靠猜。
 */
function updateTtsNote() {
  const el = $('ttsNote');
  const sel = $('ttsSel');
  if (!el || !sel) return;
  sel.value = S.ttsEngine;

  if (S.ttsEngine === 'system') {
    el.textContent = window.speechSynthesis
      ? '用浏览器自带的语音念 —— 立刻出声，音质一般（下面可以选嗓音）'
      : '这个浏览器不支持系统语音 —— 换回上面那个吧';
    el.className = window.speechSynthesis ? 'set-note' : 'set-note bad';
    return;
  }
  if (S.ttsError) {
    el.textContent = `本机合成用不了（${S.ttsError}）—— 已经自动退回系统语音`;
    el.className = 'set-note warn';
    return;
  }
  if (S.ttsMs) {
    el.textContent = `本机神经网络合成：上次 ${S.ttsMs} 毫秒生成了 ${(S.ttsAudioMs / 1000).toFixed(1)} 秒语音`
      + `（文字和声音都不出这台机器）`;
    el.className = 'set-note';
    return;
  }
  el.textContent = '本机神经网络（中文男声）—— 第一次说话要先加载模型，会慢几秒';
  el.className = 'set-note';
}

/**
 * 页面里第一次点击/按键时，把被挡住的声音解锁。
 *
 * 为什么这么干：浏览器要求"有过用户交互"才允许 speechSynthesis 出声。
 * 开场白在页面一加载就说，这时候通常还没交互过 —— 所以第一句往往没声音。
 * 与其浮个按钮让老人去点，不如**任何一次交互**都算数：
 * 他按话筒、点设置、甚至点一下空白处，声音就补上了。
 */
function armAudioUnlock() {
  const unlock = () => {
    if (!S.audioBlocked || S.muted) return;
    S.audioBlocked = false;
    /* 有刚合成好的 WAV 就直接重播 —— 不用再找一遍合成服务（那要再等几百毫秒）。
       没有的话才重新说一遍。 */
    if (lastBlob && S.ttsEngine !== 'system') {
      playBlob(lastBlob).catch(() => { updateSoundNote(); });
      return;
    }
    const last = S.lastSpoken || '';
    if (last) speak(last);          // 把刚才那句补念一遍
    else updateSoundNote();
  };
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, unlock, { capture: true });
  });
}

/* ======================================================================
   气泡
   ====================================================================== */
function bubble(role, text, tag) {
  const d = document.createElement('div');
  d.className = `bubble ${role}${role === 'me' && S.quiet ? ' quiet' : ''}`;
  d.appendChild(document.createTextNode(text));
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.innerHTML = tag;
    d.appendChild(t);
  }
  $('bubbles').appendChild(d);
  $('bubbles').scrollTop = $('bubbles').scrollHeight;
  while ($('bubbles').children.length > 60) $('bubbles').removeChild($('bubbles').firstChild);
  return d;
}

/* ======================================================================
   一轮对话
   ====================================================================== */
async function say(raw) {
  const text = String(raw || '').trim();
  if (!text || S.busy) return;
  S.busy = true;
  $('micBtn').disabled = true;
  $('sendBtn').disabled = true;
  $('input').value = '';
  $('typing').hidden = false;
  $('typing').textContent = `您说：${text}`;
  bubble('you', text);
  status('think', '岁语在想……');
  setFace('thinking');

  try {
    const r = await api('/api/chat', { text, sessionId: S.sessionId });
    S.turns += 1;
    /* ⚠️ 这里千万别写 S.quiet = ...
       S.quiet 是老人自己按的「安静模式」，是个持久选择；
       而 r.mode 是引擎那边"他情绪不高，这 10 分钟只陪着、不问事"的临时窗口，
       两回事。原来写成覆盖，结果他只要回一句话，安静模式就被悄悄关掉了。
       临时窗口单独记在 S.companion 里。 */
    S.companion = r.mode === 'companion';

    // 表情：陪伴 > 查到记忆 > 讲述 > 不知道
    setFace(S.quiet || S.companion ? 'quiet'
      : r.strategy === 'answer' ? 'happy'
        : r.strategy === 'probe' ? 'soft'
          : r.heard.mood.level === 'low' ? 'concern'
            : r.strategy === 'tell' ? 'happy' : 'idle');

    // 注意：这里不往气泡下面挂任何技术标注。
    // "相关度 0.85""整理入库 1 条""已合并"这些是给开发看的，老人看到只会觉得是废话；
    // 同样的信息在下面的「内部过程」面板里都有。
    bubble('me', r.reply);

    render(r);
    speak(r.reply);
  } catch (e) {
    bubble('me', '哎，我这边好像卡住了，您再说一遍行吗？');
    status('idle', '不太顺，稍后再试');
    console.error(e);
  } finally {
    S.busy = false;
    $('micBtn').disabled = false;
    // 这里是"请求结束、恢复可用"，不是"无条件亮起来" ——
    // 输入框这时已经清空了，所以还是得按内容决定亮不亮
    $('sendBtn').disabled = !$('input').value.trim();
    $('typing').hidden = true;
    $('input').focus();
  }
}
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

/* ======================================================================
   内部过程
   ====================================================================== */
function render(r) {
  // ① 听懂
  const h = r.heard;
  $('colHeard').innerHTML = `
    <h4>① 听懂这句</h4>
    <div class="row">意图：<b>${esc({
      tell: '讲述往事', ask: '在问一件事', recall: '考你还记不记得', ack: '只是应了一声', mood: '情绪信号', agent: '问你是谁',
    }[h.intent] || h.intent)}</b></div>
    <div class="row">整理成主句：<b>${esc(h.statement || '—')}</b></div>
    <div class="row">人物：${h.persons.map((x) => `<span class="pill">${esc(x)}</span>`).join('') || '—'}</div>
    <div class="row">地点：${h.places.map((x) => `<span class="pill">${esc(x)}</span>`).join('') || '—'}</div>
    <div class="row">时间：${h.times.map((x) => `<span class="pill">${esc(x.label)}</span>`).join('') || '—'}</div>
    <div class="row">事件：${h.events.map((x) => `<span class="pill">${esc(x)}</span>`).join('') || '—'}</div>
    <div class="row">情绪：${esc(h.mood.level)}（${h.mood.hits.map(esc).join('、') || '平稳'}）</div>
    <div class="score">关键词：${esc(h.keywords.join(' / ') || '—')}</div>`;

  // ② 查库
  $('colRecall').innerHTML = `<h4>② 查主句库</h4>${r.recall.length
    ? r.recall.map((x) => `<div class="hit">
        <b>#${x.seq} ${esc(x.statement)}</b>
        <div class="score">相关度 ${x.score}｜字面重合 ${x.why.overlap} · 关键词 ${x.why.keywords} · 人物 ${x.why.person} · 地点 ${x.why.place} · 事件 ${x.why.event} · 问法 ${x.why.ask} · 时间 ${x.why.time}${x.why.penalty ? ` · 扣分 ${x.why.penalty}` : ''}</div>
        <div class="score"><span class="pill green">已记下</span>${x.time ? ` · ${esc(x.time)}` : ''}</div>
      </div>`).join('')
    : '<p class="dim">没查到 —— 所以岁语会说"记不清"，并请老人讲。讲完就进库。</p>'}`;

  // ③ 入库
  const st = r.stored;
  $('colStore').innerHTML = `<h4>③ 整理入库</h4>${
    st.created.length
      ? st.created.map((c) => `<div class="hit">
          <b>${esc(c.statement)}</b>
          <div class="score">置信度 ${c.confidence}${c.time ? ` · 时间 ${esc(c.time)}` : ''}</div>
          <div class="score">${[...c.persons, ...c.places, ...c.events].map((x) => `<span class="pill">${esc(x)}</span>`).join('') || ''}</div>
        </div>`).join('')
      : st.merged.length
        ? st.merged.map((m) => `<div class="hit"><b>${esc(m.statement)}</b><div class="score">这件事以前记过，合并计数，没有重复存</div></div>`).join('')
        : '<p class="dim">这句不需要入库（应声、或者还没讲出可记的事）。</p>'
  }${st.skipped ? `<div class="score">丢弃半截话 ${st.skipped} 段</div>` : ''}`;

  // ④ 库里现状（顺带把"这轮是谁说的""大模型通不通"摊开）
  const s = r.stats;
  $('colDb').innerHTML = `
    <h4>④ 库里现在有什么</h4>
    <div class="row">主句库：<b>${s.sentences}</b> 条</div>
    <div class="row">人物 ${s.persons} · 地点 ${s.places} · 事件 ${s.events}</div>
    <div class="row">原话留档：${s.utterances} 句</div>
    <div class="row">索引词条：${s.indexed}</div>
    <div class="score">数据库文件：${esc(s.dbFile)}</div>
    <div class="row" style="margin-top:8px">这轮谁说的：<b>${r.by === "llm" ? "大模型" : "内置规则引擎"}</b>${r.llm?.error ? `（模型报错：${esc(r.llm.error)}）` : r.llm?.model ? `（${esc(r.llm.model)}，${r.llm.ms} 毫秒）` : ""}</div>
    <div id="llmBox" class="score">正在读大模型配置……</div>
    <div id="visionBox" class="score"></div>
    <button class="mini" id="btnList">看主句库</button>
    <button class="mini" id="btnSearch">试着自己搜一条</button>
    <div id="listOut"></div>`;
  loadLLMBox();
  loadVisionBox();
  $('btnList').onclick = async () => {
    const { items } = await api('/api/sentences');
    $('listOut').innerHTML = items.length
      ? items.map((x) => `<div class="hit"><b>#${x.seq} ${esc(x.statement)}</b>
          <div class="score">被问 ${x.asked_count} 次｜说过 ${x.told_count} 遍｜${esc(x.asks[0] || '')}</div></div>`).join('')
      : '<p class="dim">库是空的。</p>';
  };
  $('btnSearch').onclick = async () => {
    const q = prompt('输入一句老人的问法，看看能查到哪条：');
    if (!q) return;
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $('listOut').innerHTML = `<div class="score">查询：${esc(res.query)}</div>` + (res.hits.length
      ? res.hits.map((x) => `<div class="hit"><b>#${x.seq} ${esc(x.statement)}</b><div class="score">相关度 ${x.score}｜字面重合 ${x.why.overlap}</div></div>`).join('')
      : '<p class="dim">没查到。</p>');
  };
}

/* ======================================================================
   语音识别（按住说话）—— 本地 Vosk，录音不出门
   ======================================================================
   原来用的是浏览器自带的 SpeechRecognition。它会把**录音传到 Google / 微软
   的服务器**再返回文字，而且必须联网 —— 跟这个项目的底线冲突：
   老人家里说的话，不该为了转成文字就先寄出去转一圈。

   现在改成：浏览器只负责录音，转文字在本机做（Vosk，见 model/asr_service.py）。

   录音这条链路：
     getUserMedia → AudioContext（原生采样率，通常是 48k）
       → 攒 Float32 采样
       → OfflineAudioContext 重采样到 16k
       → 转成 16 位小端 PCM
       → base64 发给 /api/listen

   为什么不用 MediaRecorder：它给的是 webm/opus，还得在服务端解码。
   直接拿 PCM 最省事，服务端一个字节都不用解。
   ====================================================================== */
let micStream = null;
let audioCtx = null;
let micSource = null;
let micProc = null;
let chunks = [];               // Float32Array 数组
let recRate = 48000;

/** 能不能用（要有麦克风 API 和 OfflineAudioContext） */
function speechSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.OfflineAudioContext);
}

function initRecog() {
  if (!speechSupported()) {
    $('micText').textContent = '打字吧';
    console.warn('这个浏览器不支持录音 —— 只能打字');
    return;
  }
  // 没有原生 SpeechRecognition 也没关系，下面的录音链路跟它无关。
  // 但要在提示里说明是本地识别，老人/家人知道录音不出门。
  $('micText').textContent = '按住说话';
}

/** 把 Float32 单声道重采样到 16 kHz，返回 16 位小端 PCM 字节 */
async function toPcm16k(float32, fromRate) {
  if (!float32.length) return new Uint8Array(0);
  const frames = Math.max(1, Math.ceil(float32.length * 16000 / fromRate));
  const off = new OfflineAudioContext(1, frames, 16000);
  const buf = off.createBuffer(1, float32.length, fromRate);
  buf.copyToChannel(float32, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();

  const f = rendered.getChannelData(0);
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i += 1) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

/** 把所有 chunk 拼成一个 Float32Array */
function joinChunks() {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function listenStart() {
  if (S.listening || S.busy) return;
  if (!speechSupported()) { status('idle', '这个浏览器不能录音 —— 直接打字吧'); return; }
  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    }
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    recRate = audioCtx.sampleRate || 48000;
    chunks = [];
    micSource = audioCtx.createMediaStreamSource(micStream);
    // ScriptProcessor 虽然过时，但兼容性最好，而且不用额外加载 AudioWorklet 模块
    micProc = audioCtx.createScriptProcessor(4096, 1, 1);
    micProc.onaudioprocess = (e) => {
      if (!S.listening) return;
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    micSource.connect(micProc);
    micProc.connect(audioCtx.destination);   // 某些浏览器不接目的地就不触发回调

    S.listening = true;
    S.listenStartedAt = Date.now();
    $('micBtn').classList.add('listening');
    $('micText').textContent = '我在听……';
    status('idle', '正在聆听……');
    setFace('listening');
    $('typing').hidden = false;
    $('typing').textContent = '……';
  } catch (e) {
    status('idle', e?.name === 'NotAllowedError'
      ? '麦克风没开权限 —— 也可以直接打字'
      : '麦克风打不开 —— 也可以直接打字');
    console.warn('开麦克风失败：', e);
  }
}

function teardownMic() {
  try { if (micProc) micProc.disconnect(); } catch { /* ignore */ }
  try { if (micSource) micSource.disconnect(); } catch { /* ignore */ }
  micProc = null;
  micSource = null;
  $('micBtn').classList.remove('listening');
  $('micText').textContent = '按住说话';
}

async function listenStop() {
  if (!S.listening) return;
  S.listening = false;
  teardownMic();

  const heldMs = Date.now() - (S.listenStartedAt || 0);
  const audio = joinChunks();
  chunks = [];

  // 太短的多半是误触，不值得跑一次识别
  if (heldMs < 400 || audio.length < recRate * 0.3) {
    $('typing').hidden = true;
    status('idle', '在听您说话');
    setFace('idle');
    return;
  }

  status('idle', '听清了，我想想……');
  try {
    // 先看一眼有没有声音。整段几乎是 0 的话，多半是麦克风被静音了
    // （系统静音、设备选错、或者被别的程序独占），这时候说"没听清"
    // 会让老人一直重复，其实该检查的是麦克风。
    let peak = 0;
    for (let i = 0; i < audio.length; i += 8) {
      const v = audio[i] < 0 ? -audio[i] : audio[i];
      if (v > peak) peak = v;
    }
    console.debug('[语音] 录到', audio.length, '个采样，峰值', peak.toFixed(4));
    if (peak < 0.01) {
      $('typing').hidden = true;
      status('idle', '没听到声音 —— 看看麦克风是不是静音了');
      setFace('idle');
      S.lastMicPeak = peak;
      return;
    }
    S.lastMicPeak = peak;

    const pcm = await toPcm16k(audio, recRate);
    const r = await api('/api/listen', { pcm: bytesToB64(pcm), rate: 16000 });
    $('typing').hidden = true;
    if (!r.ok) {
      status('idle', `没听清（${r.error || '识别服务没起来'}）—— 也可以直接打字`);
      setFace('idle');
      return;
    }
    const t = String(r.text || '').trim();
    if (t) say(t);
    else { status('idle', '没听清，您再说一遍'); setFace('idle'); }
  } catch (e) {
    $('typing').hidden = true;
    status('idle', '没听清 —— 也可以直接打字');
    setFace('idle');
    console.warn('语音识别失败：', e);
  }
}

const listenStopSafe = () => { listenStop().catch(() => {}); };

/* ======================================================================
   装配
   ====================================================================== */
async function boot() {
  await pickAvatar();
  A.mount($('avatar'));
  setFace('idle');

  try {
    const { persona } = await api('/api/persona');
    S.persona = persona;
    // 导航上只写名字，关系放到副标题（"岁语 / 您的小孙子"），不写成"岁语（您的小孙子）"
    $('agentName').textContent = persona.agent_name;
    const sub = document.querySelector('.brand-text small');
    if (sub) sub.textContent = persona.self_ref ? `您的${persona.self_ref}` : '陪老人说话';
  } catch { /* 用默认 */ }

  const tick = () => {
    const d = new Date();
    $('clock').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    $('date').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  };
  tick();
  setInterval(tick, 15000);

  /** 打开就进主界面，岁语自己先开口（开场页已去掉） */
  async function begin() {
    $('input').focus();
    status('idle', '在听您说话');
    try {
      const o = await api('/api/opening', { sessionId: S.sessionId, reason: 'auto' });
      bubble('me', o.text);
      speak(o.text);
    } catch { /* ignore */ }
  }

  /* 浏览器有时候不让没交互过的页面出声。
     不弹整页的"开始"按钮了，只在**确实没说出声**时冒一条小提示。 */
  // 声音被浏览器挡住时的自动解锁：页面里第一次点击/按键就补上
  armAudioUnlock();
  updateSoundNote();

  begin();

  $('sendBtn').onclick = () => say($('input').value);
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') say($('input').value); });

  /* "告诉他"这个按钮别做成坏按钮。
     原来空着的时候它是亮的，按下去却什么都不发生（say() 看到空文本直接 return）——
     对老人来说这就是"按了没反应"，比没有按钮更糟。
     现在没字就灰着，写了字才亮起来，一眼看得出还差一步。 */
  const syncSend = () => {
    if (S.busy) return;                       // 请求中本来就禁用，别抢
    $('sendBtn').disabled = !$('input').value.trim();
  };
  $('input').addEventListener('input', syncSend);
  syncSend();

  initRecog();
  const mic = $('micBtn');
  mic.addEventListener('mousedown', () => { listenStart(); });
  mic.addEventListener('touchstart', (e) => { e.preventDefault(); listenStart(); }, { passive: false });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach((ev) => mic.addEventListener(ev, listenStopSafe));

  /* 声音开关（在「设置 → 声音」里）。
     默认是**开**的 —— 老人打开就该听见岁语说话。
     关掉之后完全不出声，文字照样显示（不想被打扰，或者家里人睡觉了）。 */
  $('soundBtn').onclick = () => {
    S.muted = !S.muted;
    localStorage.setItem('seyo.muted', S.muted ? '1' : '0');
    if (S.muted) stopSpeaking();
    if (!S.muted) {
      // 刚打开、而且之前被浏览器挡住过 → 这次点击就是那个"用户交互"，直接补一句
      S.audioBlocked = false;
      const last = S.lastSpoken || '';
      if (last) speak(last);
    }
    updateSoundNote();
  };

  /* 嗓音选择。浏览器只给名字不给性别，每台电脑装的中文嗓音也不一样 ——
     所以列出来让人自己挑，挑完记住（下次开页面还用这个）。 */
  /* 「用什么念」：本机神经网络 / 系统语音。
     换引擎时清掉上一次的错误和缓存 —— 不然会拿旧状态误导人。 */
  $('ttsSel').onchange = () => {
    S.ttsEngine = $('ttsSel').value === 'system' ? 'system' : 'local';
    localStorage.setItem('seyo.tts', S.ttsEngine);
    S.ttsError = '';
    S.ttsMs = 0;
    lastBlob = null;
    updateSoundNote();
    // 立刻用新引擎说一句，让人马上听出区别
    const wasMuted = S.muted;
    S.muted = false;
    speak(`爷爷，我是${S.persona?.agent_name || '岁语'}。`);
    S.muted = wasMuted;
  };

  fillVoiceList();
  $('voiceSel').onchange = () => applyVoice($('voiceSel').value, true);
  $('voiceTry').onclick = () => {
    const wasMuted = S.muted;
    S.muted = false;
    speak(`爷爷，我是${S.persona?.agent_name || '岁语'}，您的小孙子。`);
    S.muted = wasMuted;
  };
  // 语音列表是异步加载的，装载完再填一次
  if (window.speechSynthesis) {
    speechSynthesis.addEventListener('voiceschanged', () => { pickVoice(); fillVoiceList(); });
  }

  /* 「🤝 安静模式」= 一句主动的话都不说。
     老人什么时候想说话，自己按话筒或打字，那时候照常回。
     这个状态要同时做三件事，少一件就不成立：
       ① 改前端的样子（表情、气泡、按钮文案）
       ② 告诉服务端（不然守望照样会主动开口 —— 原来是漏的）
       ③ 记在本地（刷新之后还得是这个模式） */
  const syncQuiet = async () => {
    $('quietBtn').classList.toggle('on', S.quiet);
    $('quietBtn').textContent = S.quiet ? '🤝 安静模式：开着' : '🤝 安静模式';
    setFace(S.quiet ? 'quiet' : 'idle');
    localStorage.setItem('seyo.quiet', S.quiet ? '1' : '0');
    try { await api('/api/watch/config', { companion: S.quiet }); } catch { /* 服务没起来就算了 */ }
  };

  $('quietBtn').onclick = async () => {
    S.quiet = !S.quiet;
    await syncQuiet();
    // 刚进这个模式时说一句，让他知道"我不问了"，之后就一直安静着
    if (S.quiet) {
      try {
        const o = await api('/api/opening', { sessionId: S.sessionId, reason: 'companion' });
        bubble('me', o.text);
        speak(o.text);
      } catch { /* ignore */ }
    }
  };

  // 刷新后恢复（默认不开）
  if (localStorage.getItem('seyo.quiet') === '1') {
    S.quiet = true;
    setTimeout(syncQuiet, 300);
  }

  $('insideBtn').onclick = () => {
    const open = $('insideBody').hidden;
    $('insideBody').hidden = !open;
    $('caret').textContent = open ? '▾' : '▸';
    if (open) renderWatch();
  };

  /* ==================================================================
     陪伴守望：摄像头情绪识别 + 闲置主动关心
     ================================================================== */

  let camStream = null;
  let camTimer = null;
  let watchTimer = null;
  let lastWatchSpeak = 0;
  let lastPollAt = 0;          // 上次问"该不该开口"是什么时候（看门狗用它判断）
  let polling = false;         // 正有一个询问在飞（防止堆积）
  S.shownIds = S.shownIds || new Set();   // 已经显示过的开口 id（服务端会重复给）

  async function camOn() {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      const v = $('cam');
      v.srcObject = camStream;
      // 等真的出画面再往下走 —— 不然第一帧可能是黑的，送出去识别也没用
      await new Promise((res) => {
        if (v.readyState >= 2) return res();
        v.onloadeddata = res;
        setTimeout(res, 5000);
      });
      try { await v.play(); } catch { /* 自动播放被拦也没关系，静音流一般能播 */ }

      $('camBtn').textContent = '📷 摄像头：开（看着您的表情）';
      $('camBtn').classList.add('on');
      S.cameraOn = true;
      localStorage.setItem('seyo.camera', '1');
      $('camNote').textContent = '正在看表情。画面只在本机识别，不上传。';
      $('camNote').className = 'set-note';
      // 让服务端也打开视觉通道
      await api('/api/watch/config', { cameraEnabled: true });

      // 多久看一次**由服务端说了算**，而且是自适应的：
      // 平常 15 秒，一发现情绪不对就 5 秒 —— 得尽快分清他是真难受，
      // 还是只是刚好那个表情；恢复也一样要尽快看到。
      // 所以不用 setInterval（间隔固定），改成拍完自己排下一次。
      clearTimeout(camTimer);
      camTimer = null;
      lookOnce();                    // 开的时候先立刻看一次
      renderWatch();
    } catch (e) {
      // 摄像头黑屏最常见的原因是"被别的程序占着"，把话说清楚
      const tip = {
        NotAllowedError: '没给权限',
        NotReadableError: '被别的程序占着',
        NotFoundError: '没找到摄像头',
        SecurityError: '要用 127.0.0.1 或 https 打开',
      }[e.name] || e.name;
      $('camBtn').textContent = `📷 打不开（${tip}）`;
      $('camNote').textContent = `打不开：${tip}。修好之后刷新页面会自动再试。`;
      $('camNote').className = 'set-note bad';
      console.warn('摄像头打不开：', e.name, e.message);
      status('idle', `摄像头打不开：${tip} —— 设置里有详细说明`);
    }
  }

  async function camOff() {
    clearTimeout(camTimer);
    camTimer = null;
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    $('cam').srcObject = null;
    $('camBtn').textContent = '📷 摄像头：关（让岁语看表情）';
    $('camBtn').classList.remove('on');
    S.cameraOn = false;
    localStorage.setItem('seyo.camera', '0');
    $('camNote').textContent = '已关闭。点上面的按钮可以再打开。';
    $('camNote').className = 'set-note';
    await api('/api/watch/config', { cameraEnabled: false });
    renderWatch();
  }

  /**
   * 抓一帧，交给服务端看一眼。图片只在内存里过一下，不存。
   *
   * 会先算平均亮度：房间暗的时候（比如傍晚只开一盏灯），画面平均亮度
   * 可能只有二三十（满值 255），人眼觉得"全黑"，但拿去做表情识别基本白搭。
   * 所以暗就先拉亮再送，不然模型看不清。
   */
  async function lookOnce() {
    // 相机被切到后台就不用拍了（人不在，别拍），但计时得接上，
    // 否则回到前台就再也不拍了。
    if (!camStream || document.hidden) { scheduleNextLook(); return; }
    const v = $('cam');
    const c = $('camCanvas');
    if (!v.videoWidth) { scheduleNextLook(); return; }
    c.width = 320; c.height = 240;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, 320, 240);

    // 采样 + 按需提亮
    const img = ctx.getImageData(0, 0, 320, 240);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const avg = sum / (320 * 240);
    if (avg < 60) {
      const gain = Math.min(5, 110 / Math.max(avg, 1));
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.min(255, d[i] * gain);
        d[i + 1] = Math.min(255, d[i + 1] * gain);
        d[i + 2] = Math.min(255, d[i + 2] * gain);
      }
      ctx.putImageData(img, 0, 0);
      S.lastBrightness = { raw: Math.round(avg), gain: Number(gain.toFixed(1)) };
    } else {
      S.lastBrightness = { raw: Math.round(avg), gain: 1 };
    }

    // 相机被切到后台就不用拍了（人不在，别拍），但计时得接上，
    // 否则回到前台就再也不拍了。
    if (!camStream || document.hidden || !$('cam').videoWidth) {
      scheduleNextLook();
      return;
    }

    try {
      const r = await api('/api/vision', {
        image: c.toDataURL('image/jpeg', 0.6),
        sessionId: S.sessionId,
      });
      // 服务端会告诉我们下次隔多久 —— 情绪不对时它会调快
      if (r?.watch) S.watch = r.watch;
      // ★ 它可能已经顺手判过"该不该开口"了，有就直接显示，不用等轮询
      if (r?.proactive) showProactive(r.proactive);
    } catch (e) {
      console.warn('看一眼失败：', e.message);
    }
    renderWatch();
    scheduleNextLook();
  }

  /** 把服务端给的主动开口显示出来（摄像头链路和轮询链路共用） */
  function showProactive(p) {
    if (!p) { S.seen = '服务端没回 proactive 字段'; return false; }
    if (!p.speak || !p.text) {
      S.seen = `服务端说先不说（${p.reason || '没给原因'}）`;
      if (p.reason) S.lastWatchReason = p.reason;
      return false;
    }

    /* ★ 页面打开之前说过的那句，不要重放。
       服务端会保留最近 60 秒的开口，好让"别的标签页"也能拿到（多标签页场景）。
       但对一个**刚打开**的页面来说，那句是上一个页面的事 ——
       重放出来就会和开场问候一起冒出来，老人一次看到两条。 */
    if (p.replay && p.at && p.at < S.bootAt) {
      S.seen = '这句是页面打开之前说的，不重复显示';
      return false;
    }

    /* ★ 后台标签页不许领。
       这是踩过的坑：老人可能开着好几个页面（或者后台还挂着一个），
       主动开口的消息原来"谁先问归谁" —— 先问到的那个后台标签页把它领走了，
       老人正在看的那页就永远什么都不出现，可服务端日志里明明写了"主动开口"。
       所以：页面不在前台就一声不吭，也不标记已读 —— 等切回来再补显示。 */
    if (document.hidden) { S.seen = '页面在后台，先不显示（切回来会补）'; return false; }

    // 同一个 id 只显示一次（服务端会在 60 秒内反复给，好让每个页面都能拿到）
    if (p.id) {
      if (S.shownIds.has(p.id)) { S.seen = '这句已经显示过了'; return false; }
      S.shownIds.add(p.id);
      if (S.shownIds.size > 40) S.shownIds.delete(S.shownIds.values().next().value);
    } else if (Date.now() - lastWatchSpeak < 5000) {
      S.seen = '5 秒内刚说过，跳过';
      return false;
    }
    lastWatchSpeak = Date.now();

    // 不挂任何标注 —— 尤其不能写"看到您不太开心"，
    // 那等于告诉老人"我在看着你"，跟提示词里"绝不提是看出来的"直接冲突。
    // 但给个淡淡的高亮，好让家人一眼看出这句是它自己开口的。
    const el = bubble('me', p.text);
    if (el) el.classList.add('proactive');
    setFace(p.reason === 'low_mood' ? 'soft' : 'idle');
    speak(p.text);
    S.lastProactiveAt = Date.now();
    S.seen = `已经显示：${p.text.slice(0, 20)}…`;
    console.log('[陪伴守望] 主动开口：', p.reason, p.text);
    if (p.id) fetch(`/api/watch/ack?id=${encodeURIComponent(p.id)}`, { method: 'POST' }).catch(() => {});
    return true;
  }

  /** 拍完自己排下一次（间隔由服务端给，自适应） */
  function scheduleNextLook() {
    clearTimeout(camTimer);
    if (!camStream) return;
    const ms = Number(S.watch?.cameraNextMs) || 15000;
    camTimer = setTimeout(lookOnce, ms);
  }

  $('camBtn').onclick = () => (camStream ? camOff() : camOn());

  /* 设置面板（右上角小角落）。
     摄像头、内部过程都收在这里 —— 老人的主界面上就只剩"说话"这一件事。 */
  const settings = $('settings');
  const openSettings = (on) => {
    settings.hidden = !on;
    $('gearBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  $('gearBtn').onclick = () => openSettings(settings.hidden);
  $('settingsClose').onclick = () => openSettings(false);
  // 点面板外面、或者按 Esc 也收起来
  document.addEventListener('mousedown', (e) => {
    if (settings.hidden) return;
    if (settings.contains(e.target) || $('gearBtn').contains(e.target)) return;
    openSettings(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settings.hidden) openSettings(false);
  });

  /**
   * 轮询：现在该主动开口吗？（情绪低落 / 太久没说话）
   *
   * 注意这里**故意不判 document.hidden**。
   * 之前加了这句，结果页面一切到后台（老人去看别的窗口、家人来配东西）
   * 它就不问了 —— 而那恰恰是最需要它主动的时候。
   * 摄像头抓帧那边会判（人不在就别拍），守望这边不判。
   */
  async function pollWatch() {
    // 一次只发一个。看门狗每 5 秒醒一次，但这一趟要调大模型（1~3 秒），
    // 不管住的话会好几个请求同时在飞，服务端那边也乱。
    if (polling) return;
    polling = true;
    lastPollAt = Date.now();
    try {
      const r = await api(`/api/watch?sessionId=${encodeURIComponent(S.sessionId)}`);
      showProactive(r);
      if (r.watch) S.watch = r.watch;
    } catch (e) {
      S.lastWatchError = e.message;
      S.seen = `询问失败：${e.message}`;
    } finally {
      polling = false;
      // ★ 这里必须刷面板。以前 pollWatch 结束不 renderWatch，
      // 面板上显示的一直是**上次**的状态 —— 于是会出现
      // "面板写着'该开口'，实际早就说过了"或者反过来，怎么都对不上。
      renderWatch();
    }
  }

  /* 页面切回前台立刻问一次。
     浏览器对后台标签页的计时器是限流的（藏久了能降到一分钟一次，甚至冻结），
     所以「一直开着但不说话」很可能只是定时器被冻住了。
     用户一回到这个页面就补一次，别让他盯着等。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { pollWatch(); renderWatch(); }
  });
  window.addEventListener('focus', () => { pollWatch(); });

  /* 定时器也可能被浏览器冻住不恢复，所以再加一条：
     只要页面每 5 秒有一次机会跑（哪怕是绘制），就检查一下距上次轮询多久了。 */
  setInterval(() => {
    if (document.hidden) return;               // 后台就别折腾了，切回来会补
    if (Date.now() - lastPollAt < 12000) return;
    lastPollAt = Date.now();
    pollWatch();
  }, 5000);

  /** 内部过程里那栏"陪伴守望" */
  async function renderWatch() {
    const box = $('colWatch');
    if (!box) return;
    let w = S.watch;
    if (!w) { try { w = await api('/api/watch/state'); } catch { return; } }
    const m = w.lastMood;
    // 四档：难过 / 看着不太对劲 / 正常 / 心情不错。
    // "不太对劲"是模型很有把握他情绪消极、但说不准是哪一种（生气、烦躁、害怕）。
    const MOOD_CN = { low: '难过', uneasy: '看着不太对劲', normal: '正常', happy: '心情不错' };
    const src = { camera: '摄像头', text: '聊天文字', manual: '手动' }[m?.source] || '';

    // 判定依据：说明"为什么判成这个心情" ——
    // 不然会出现"angry 97% 却显示正常"这种看着很矛盾的情况
    let basis = '';
    if (m?.why) {
      const w2 = m.why;
      const parts = [];
      if (w2.pSad != null) parts.push(`P(难过) ${(w2.pSad * 100).toFixed(0)}%`);
      if (w2.pNeg != null) parts.push(`消极 ${(w2.pNeg * 100).toFixed(0)}%`);
      if (w2.pPos != null) parts.push(`积极 ${(w2.pPos * 100).toFixed(0)}%`);
      if (parts.length) basis = `　${parts.join(' · ')}`;
    }

    const moodText = m
      ? `<b>${MOOD_CN[m.level] || m.level}</b>${m.note ? `（表情 ${esc(m.note)}）` : ''} · ${src}`
      : '还没有读数';

    // 最近确认过的消极状态。
    // 判据不是"当前这一帧"，而是"最近确认过消极、且还没连续 negClearStreak 帧正常" ——
    // 因为模型逐帧会抖（同一张脸 angry 42% ↔ 34%），单帧不作数。
    // 不把这条显示出来的话，会出现"刚才明明是难过的，怎么说不该开口"这种困惑。
    const neg = w.neg || {};
    const negLine = neg.since
      ? `<div class="row">消极确认：<b style="color:#a8381c">${{ low: '难过', uneasy: '看着不太对劲' }[neg.level] || neg.level}</b>
           <span class="score">${neg.streak
             ? `之后有 ${neg.streak}/${neg.clearStreak} 帧正常，还不算缓过来`
             : '最近一帧仍是消极'}</span></div>`
      : '<div class="score">消极确认：没有（当前不在消极状态）</div>';

    // 逐条闸门 —— "为什么没触发"一眼看清，不用猜
    const trace = (w.due?.trace || []).map((g) => `
      <div class="gate ${g.pass ? 'p' : 'f'}">
        <span class="gk">${g.pass ? '通过' : '拦下'}</span>
        <span class="gn">${esc(g.gate)}</span>
        <span class="gd">${esc(g.detail)}</span>
      </div>`).join('');

    // 它到底自己开过口没有 —— 加这一行之前只能靠猜（"该开口"却听不到声音，
    // 分不清是没触发、还是触发了没显示、还是浏览器把页面冻住了）
    const sp = (w.spokeLog || [])[(w.spokeLog || []).length - 1];
    const ago = sp ? Math.round((Date.now() - sp.at) / 1000) : null;
    const whyCN = { low_mood: '情绪不对', idle: '太久没说话' };
    const spokeLine = sp
      ? `<div class="row">上次主动开口：<b>${ago < 90 ? `${ago} 秒前` : `${Math.round(ago / 60)} 分钟前`}</b>
           <span class="score">${whyCN[sp.reason] || sp.reason}${sp.text ? ` — “${esc(sp.text)}”` : ''}</span></div>
         <div class="score">累计主动开口 ${w.spokeCount || 0} 次</div>`
      : '<div class="row">上次主动开口：<b>还没有过</b></div>';

    // 页面到底有没有在问"该不该开口"。
    // 这一行是用来分辨那三种情况的：没触发 / 触发了没显示 / 页面根本没在问。
    const pa = w.lastPollAgoSec;
    const pollLine = `<div class="score">页面询问：${
      w.polls ? `共 ${w.polls} 次，最近一次 ${pa}s 前${pa > 40 ? ' <b style="color:#a97c22">（有点久，可能被浏览器限流了）</b>' : ''}`
        : '还没问过'}</div>
      <div class="score">页面看到：${esc(S.seen || '还没收到过结果')}${
        S.lastWatchError ? ` <b style="color:#a8381c">（出错：${esc(S.lastWatchError)}）</b>` : ''}</div>`;

    box.innerHTML = `
      <h4>⑤ 陪伴守望</h4>
      <div class="row">闭嘴时长：<b>${w.silentMinutes}</b> 分钟${w.enabled ? `（再过 ${w.nextIdleInMinutes} 分钟会主动搭话）` : ''}</div>
      <div class="row">最近情绪：${moodText}</div>
      ${negLine}
      ${basis ? `<div class="score">判定依据：${basis.trim()}
        <br>规则：P(难过) ≥ 45% 且 消极 ≥ 50% 才算难过；消极 ≥ 65% 且积极 ≤ 22% 算"看着不太对劲"</div>` : ''}
      <div class="row">摄像头：${w.cameraOn ? '开着' : '关着'}${w.cameraOn ? `（每 ${Math.round((w.cameraNextMs || 15000) / 1000)} 秒看一眼${(w.lastMood && (w.lastMood.level === 'low' || w.lastMood.level === 'uneasy')) ? '，情绪不对已提速' : ''}）` : ''}</div>
      ${/* ⚠️ 这两个节奏必须分开写清楚。
            看脸看多勤 ≠ 说话说多勤 —— 看脸只管"看"，说话还要过一道道闸门。
            以前两个都是 15 秒，摆在一起会让人以为"每 15 秒就可能说一句"。 */''}
      <div class="score">　看脸只管「看」，不打扰人；「说」是另一档，慢得多 ——</div>
      <div class="score">　主动开口：最快每 <b>${Math.round((w.config?.debounceMs || 300000) / 60000)} 分钟</b>一次
        （第一次发现情绪不对时不等；闲置搭话 ${Math.round((w.config?.minGapMs || 600000) / 60000)} 分钟一次）</div>
      ${spokeLine}
      ${pollLine}
      <div class="row">这会儿该开口吗：${w.due?.speak ? `<b class="say-yes">该（${w.due.reason === 'low_mood' ? '情绪不对，去关心' : '太久没说话，去看看'}）</b>` : esc(w.due?.reason || '—')}</div>
      <details class="gates"><summary>逐条闸门（为什么开口 / 为什么不开口）</summary>${trace}</details>
      <button class="mini" id="btnWatchTest">假装情绪低落，试一次</button>
      <button class="mini" id="btnWatchClear">清空情绪记录</button>`;
    const t = $('btnWatchTest');
    if (t) t.onclick = async () => {
      // 先喂一条"正常"把这一波结束掉，再喂难过。
      // 不这样的话第二次按就没反应了 —— sadEpisode 还挂着上一波的 true，
      // 它会认为"刚安慰过"，要等 sadRepeatMs（10 分钟）才再说。
      await api('/api/mood', { level: 'normal', score: 0, note: '重置', source: 'manual' });
      await api('/api/mood', { level: 'low', score: 0.8, note: '手动测试', source: 'manual' });
      S.watch = null;                 // 丢掉缓存的快照，强制重新读一遍
      await pollWatch();
      await renderWatch();
    };
    const c = $('btnWatchClear');
    if (c) c.onclick = async () => {
      await fetch('/api/watch/log', { method: 'DELETE' });
      S.watch = null;
      renderWatch();
    };
  }

  // 轮询由上面那个 5 秒看门狗负责 —— 它只在"距上次问超过 12 秒"时才真去问，
  // 所以实际还是大约每 12 秒一次，但页面被浏览器限流冻住之后能自己补回来。
  // （原来这里还有个 setInterval(pollWatch, 15000)，两套会重复请求，去掉了。）
  setTimeout(() => { pollWatch(); renderWatch(); }, 1500);

  // 摄像头**默认就开** —— 老人不该为了这个去点一次设置。
  // 只有明确关过（localStorage 记成 '0'）才不开。
  // 浏览器第一次会弹权限框问一次，允许过之后就是静默生效的。
  if (localStorage.getItem('seyo.camera') !== '0') {
    setTimeout(async () => {
      await camOn();
      if (!camStream) {
        // 打不开（没权限/没设备）—— 别把 '0' 写进去，
        // 免得下次插上摄像头也还是不试。留着下次再自动试一次。
        $('camNote').textContent = '这次没打开 —— 看看浏览器有没有问权限，或者摄像头被别的程序占着';
        $('camNote').className = 'set-note warn';
      }
    }, 1200);
  }
}

boot();

/* 大模型状态与配置：填一次 key，说话就交给模型 */
async function loadLLMBox() {
  const box = $('llmBox');
  if (!box) return;
  let st;
  try { st = await api('/api/llm'); } catch { box.textContent = '读不到大模型配置'; return; }
  if (st.available) {
    box.innerHTML = `🟢 <b>已接大模型</b>：${esc(st.model)}（${esc(st.provider)}）<br>
      <span class="score">说话由模型负责，记忆仍由本地引擎抽取、归档、核实</span>
      <button class="mini" id="llmTest">试一句</button>
      <button class="mini" id="llmClear">断开</button>
      <div id="llmMsg" class="score"></div>`;
    $('llmTest').onclick = async () => {
      $('llmMsg').textContent = '正在试……';
      const r = await api('/api/llm', { test: true });
      $('llmMsg').textContent = r.ok ? `通了（${r.ms} 毫秒）：${r.sample}` : `不通：${r.error}`;
    };
    $('llmClear').onclick = async () => {
      await api('/api/llm', { enabled: false });
      loadLLMBox();
    };
    return;
  }
  box.innerHTML = `⚪ <b>没接大模型</b>，现在用内置规则引擎说话（不够灵活）。<br>
    <span class="score">填一次下面任意一家的 API Key 就行，记忆仍留在本机数据库里：</span><br>
    <select id="llmPreset" class="mini" style="min-height:32px">
      <option value="deepseek">DeepSeek</option>
      <option value="qwen">通义千问</option>
      <option value="kimi">Kimi</option>
      <option value="zhipu">智谱 GLM</option>
      <option value="openai">OpenAI</option>
      <option value="ollama">本机 Ollama</option>
    </select>
    <input id="llmKey" placeholder="粘贴 API Key（Ollama 可留空）" style="min-height:34px;font:inherit;font-size:14px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;width:min(100%,320px)">
    <button class="mini" id="llmSave">接上</button>
    <div id="llmMsg" class="score"></div>`;
  $('llmSave').onclick = async () => {
    $('llmMsg').textContent = '正在保存并试连通……';
    const preset = $('llmPreset').value;
    const apiKey = $('llmKey').value.trim();
    await api('/api/llm', { preset, apiKey });
    const r = await api('/api/llm', { test: true });
    $('llmMsg').textContent = r.ok ? `接上了（${r.ms} 毫秒）：${r.sample}` : `保存了，但试不通：${r.error}`;
    setTimeout(loadLLMBox, r.ok ? 1200 : 0);
  };
}

/* ======================================================================
   表情识别（本地模型）
   ----------------------------------------------------------------------
   用的是自己训练的那个 FER 模型（ResNet18+CBAM），跑在本机 Python 里。
   照片一个字节都不出这台机器。
   ====================================================================== */
async function loadVisionBox() {
  const box = $('visionBox');
  if (!box) return;
  let st;
  try { st = await api('/api/vision'); } catch { box.textContent = '读不到配置'; return; }

  const live = st.live || {};
  const h = live.health || {};
  const on = st.enabled && st.available;
  const ready = Boolean(h.ready);

  box.innerHTML = `
    <div class="row" style="margin-top:10px"><b>📷 表情识别</b>
      <span class="pill ${ready ? 'green' : on ? 'gold' : 'gray'}">${
        ready ? '模型已就绪' : on ? '已开启，模型没起来' : '关闭中'}</span></div>
    <div class="score">看老人的表情，情绪不对就主动过去陪。<br>
      模型跑在<b>本机</b>（Python + ONNX），照片不上传任何地方。</div>
    <div class="row">模型位置</div>
    <div class="score" style="word-break:break-all">${esc(st.modelDir || '—')}</div>
    ${ready ? `<div class="score">${h.provider === 'hsemotion'
      ? 'HSEmotion（EfficientNet-B0，AffectNet 训练，8 类）'
      : `${esc(h.backbone || '')}${h.use_cbam ? '+CBAM' : ''}（自训，FER2013${
        h.test_acc ? `，准确率 ${Math.round(h.test_acc * 100)}%` : ''}）`}
      · ${esc(h.device || '')} · 加载 ${h.load_ms || '—'} 毫秒</div>` : ''}
    ${h.hse_error ? `<div class="score" style="color:#a97c22">hsemotion 没起来，已退回自训模型：${esc(h.hse_error)}</div>` : ''}
    ${h.error ? `<div class="score" style="color:#a8381c">加载失败：${esc(h.error)}<br>详情看 data/fer.log</div>` : ''}
    <button class="mini" id="visSave">${on ? '重新加载模型' : '开启'}</button>
    <button class="mini" id="visOff">关闭</button>
    <button class="mini" id="visPick">换模型目录</button>
    <div id="visMsg" class="score"></div>`;

  $('visSave').onclick = async () => {
    $('visMsg').textContent = '正在启动模型（第一次要十几秒）……';
    const r = await api('/api/vision/config', { enabled: true, provider: 'local', modelDir: st.modelDir });
    $('visMsg').textContent = r.available ? '已开启' : '配置不全';
    setTimeout(loadVisionBox, 800);
  };
  $('visOff').onclick = async () => {
    await api('/api/vision/config', { enabled: false });
    setTimeout(loadVisionBox, 400);
  };
  $('visPick').onclick = async () => {
    const dir = prompt('FRE_Classroom 目录在哪？（里面有 src/ 和 weights/）', st.modelDir || '');
    if (!dir) return;
    await api('/api/vision/config', { modelDir: dir.trim(), enabled: true, provider: 'local' });
    $('visMsg').textContent = '已更新，正在重新加载……';
    setTimeout(loadVisionBox, 1200);
  };
}
