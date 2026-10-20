/* 在全屏状态下切换「对话页 ↔ 查看端」时，不离开当前文档：
   用同源 iframe 把目标页面装进来，父页面的全屏状态不会被浏览器退出。
   非全屏时保持原来的普通跳转，不影响网址/书签/刷新。 */
(function () {
  // 不只导航条：查看端的 logo（a.brand）也指向对话页，点它同样不能真跳转。
  const NAV_SEL = 'a[href="/"], a[href="/family.html"]';
  const EMBED = new URLSearchParams(location.search).has('embed');
  const isEmbedded = EMBED && window.parent && window.parent !== window;

  const browserFullscreen = () => {
    try { return window.outerWidth >= screen.width - 2 && window.outerHeight >= screen.height - 2; } catch { return false; }
  };
  const inFullscreen = () => !!document.fullscreenElement || browserFullscreen();

  const frameHref = (href) => href + (href.includes('?') ? '&' : '?') + 'embed=1';

  if (isEmbedded) {
    // 被父页面装进 iframe：导航链接交给父页面换 iframe，父文档保持不动
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest(NAV_SEL);
      if (!a) return;
      e.preventDefault();
      window.parent.postMessage({ type: 'seyo-nav', href: a.getAttribute('href') }, location.origin);
    }, true);
    return;
  }

  const ensureFrame = () => {
    let f = document.getElementById('seyoNavFrame');
    if (!f) {
      f = document.createElement('iframe');
      f.id = 'seyoNavFrame';
      f.title = '岁语页面';
      f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9996;background:#faf6ef;';
      document.body.appendChild(f);
    }
    return f;
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest(NAV_SEL);
    if (!a) return;
    // 这两个页面之间的切换一律在当前文档内完成：
    // 只要发生真正的页面跳转，浏览器就会退出全屏，不能靠尺寸判断赌。
    e.preventDefault();
    const href = a.getAttribute('href');
    const f = ensureFrame();
    f.dataset.href = href;
    f.dataset.full = inFullscreen() ? '1' : '0';
    f.src = frameHref(href);
  }, true);

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    if (!e.data || e.data.type !== 'seyo-nav') return;
    const href = String(e.data.href || '');
    if (href !== '/' && href !== '/family.html') return;
    const f = document.getElementById('seyoNavFrame');
    if (!f) return;
    f.dataset.href = href;
    f.src = frameHref(href);
  });

  // 用户在 iframe 模式下退出全屏：回到普通页面，恢复网址
  const restore = () => {
    const f = document.getElementById('seyoNavFrame');
    if (!f || f.dataset.full !== '1' || inFullscreen()) return;
    const href = f.dataset.href;
    if (href === '/' || href === '/family.html') location.href = href;
  };
  document.addEventListener('fullscreenchange', () => setTimeout(restore, 50));
  window.addEventListener('resize', () => setTimeout(restore, 120));
})();
