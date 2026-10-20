/* 全屏：默认打开（老人端、查看端共用同一个 localStorage 设置；远程端不需要）。
   想切换页面还保持全屏，靠 start.bat 用 Edge/Chrome 的 --start-fullscreen 打开——
   那是浏览器窗口级全屏，换页不会丢；页面里的全屏按钮只是手动兜底。 */
(function () {
  // iframe 里的页面不要再请求自己的全屏：全屏由父页面持有，子页面请求会把父页面顶掉。
  // 但设置里的全屏按钮要能用 —— 点击时把请求转给父页面。
  if (window.parent && window.parent !== window) {
    const btn = document.getElementById('fullscreenBtn');
    if (!btn) return;
    const pref = () => {
      try { return localStorage.getItem('seyo.fullscreen') !== '0'; } catch { return true; }
    };
    const label = document.getElementById('fsLabel');
    const setText = (t) => { if (label) label.textContent = t; else btn.textContent = t; };
    const paint = () => {
      const on = pref();
      setText(on ? '全屏：开' : '全屏：关');
      btn.classList.toggle('on', on);
    };
    btn.onclick = async () => {
      const next = !pref();
      try { localStorage.setItem('seyo.fullscreen', next ? '1' : '0'); } catch { /* ignore */ }
      try {
        const pdoc = window.parent.document;
        if (next) await pdoc.documentElement.requestFullscreen({ navigationUI: 'hide' });
        else if (pdoc.fullscreenElement) await pdoc.exitFullscreen();
      } catch { /* 父页面可能已不在全屏 */ }
      paint();
    };
    try { window.parent.document.addEventListener('fullscreenchange', paint); } catch { /* ignore */ }
    paint();
    return;
  }
  const btn = document.getElementById('fullscreenBtn');
  if (!btn) return;
  const supported = () => !!(document.documentElement.requestFullscreen);
  const pref = () => {
    try { return localStorage.getItem('seyo.fullscreen') !== '0'; } catch { return true; }
  };
  // 浏览器窗口已经是全屏（F11 / --start-fullscreen）时，不再调用页面级全屏，
  // 免得切到另一个页面时把窗口全屏一起退掉。
  // 注意：--start-fullscreen 下 outer 等于 screen，但 inner 会少一截（任务栏/边框），
  // 所以必须看 outer，不能用 inner 判断。
  const browserFullscreen = () => {
    try {
      return window.outerWidth >= screen.width - 2 && window.outerHeight >= screen.height - 2;
    } catch { return false; }
  };
  const enter = async (force = false) => {
    if (!supported() || document.fullscreenElement) return;
    if (!force && browserFullscreen()) return;
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* 等下一次点击 */ }
  };
  const exit = async () => {
    if (!document.fullscreenElement) return;
    try { await document.exitFullscreen(); } catch { /* ignore */ }
  };
  const label = document.getElementById('fsLabel');
  const setText = (t) => { if (label) label.textContent = t; else btn.textContent = t; };
  const paint = () => {
    if (!supported()) {
      btn.disabled = true;
      setText('全屏：浏览器不支持');
      btn.classList.remove('on');
      return;
    }
    const on = pref();
    setText(on ? '全屏：开' : '全屏：关');
    btn.classList.toggle('on', on);
  };
  btn.onclick = async () => {
    const next = !pref();
    try { localStorage.setItem('seyo.fullscreen', next ? '1' : '0'); } catch { /* ignore */ }
    if (next) await enter(); else await exit();
    paint();
  };
  document.addEventListener('fullscreenchange', paint);
  // 老人端/查看端同源，设置改了另一个窗口也跟着显示同一个偏好
  window.addEventListener('storage', (e) => {
    if (e.key !== 'seyo.fullscreen') return;
    if (pref()) enter(); else exit();
    paint();
  });
  if (pref()) {
    // 即使浏览器窗口看起来已经最大化/全屏，第一次点击也补一次网页全屏：
    // Windows 最大化窗口有时 outer 也等于 screen，不能只靠尺寸判断。
    if (!browserFullscreen()) enter();
    if (!document.fullscreenElement) {
      const once = () => {
        document.removeEventListener('pointerdown', once);
        document.removeEventListener('keydown', once);
        if (pref() && !document.fullscreenElement) enter(true);
      };
      document.addEventListener('pointerdown', once, { once: true });
      document.addEventListener('keydown', once, { once: true });
    }
  } else {
    // 可能被 start.bat 用全屏参数打开；设置关了就退出页面级全屏
    exit();
  }
  paint();
})();
