/* kiosk 模式下提供退出方式：右下角按钮 / Esc。
   只对 start.bat 用 ?kiosk=1 打开的窗口生效，普通浏览器窗口不会出现。 */
(function () {
  const q = new URLSearchParams(location.search);
  if (q.get('kiosk') === '1') {
    try { sessionStorage.setItem('seyo.kiosk', '1'); } catch { /* ignore */ }
  }
  let kiosk = false;
  try { kiosk = sessionStorage.getItem('seyo.kiosk') === '1'; } catch { /* ignore */ }
  if (!kiosk) return;

  const close = () => {
    // 命令行走 --kiosk 打开的窗口允许脚本关闭；普通标签页会静默失败
    try { window.close(); } catch { /* ignore */ }
  };

  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '退出全屏';
  b.setAttribute('aria-label', '退出全屏');
  b.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:10000;min-height:40px;padding:0 16px;' +
    'border:1px solid #e0c9a8;border-radius:10px;background:#fff8ec;color:#8a5a2b;' +
    'font:inherit;font-size:15px;cursor:pointer;box-shadow:0 4px 16px rgba(60,40,20,.15)';
  b.addEventListener('click', (e) => { e.preventDefault(); close(); });
  document.body.appendChild(b);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }, true);
})();
