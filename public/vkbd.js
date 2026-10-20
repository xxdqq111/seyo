/* 屏幕虚拟键盘：树莓派没有实体键盘时也能输入。
   点右下角 ⌨ 打开；点输入框会自动打开；输入写回当前聚焦的 input/textarea。
   支持字母、数字、常用符号、Shift、退格、空格、回车。 */
(function () {
  const style = document.createElement('style');
  style.textContent = `
    #vkbdToggle{position:fixed;right:14px;bottom:88px;z-index:9998;width:54px;height:54px;border-radius:50%;
      border:1px solid #e0c9a8;background:#fff8ec;color:#8a5a2b;font-size:24px;box-shadow:0 6px 20px rgba(60,40,20,.18);cursor:pointer}
    #vkbd{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fffdf8;border-top:2px solid #e0c9a8;
      box-shadow:0 -12px 40px rgba(60,40,20,.22);padding:8px 8px 12px;display:none;user-select:none}
    #vkbd.show{display:block}
    #vkbd .vk-row{display:flex;gap:4px;justify-content:center;margin:4px 0}
    #vkbd button{flex:1;min-width:0;min-height:42px;border:1px solid #e6d8c4;border-radius:8px;background:#fff;
      color:#3f3a32;font:inherit;font-size:18px;cursor:pointer;padding:0 4px}
    #vkbd button.special{background:#f5ede1;color:#8a5a2b;font-size:15px}
    #vkbd button.wide{flex:2.4}
    #vkbd .vk-head{display:flex;justify-content:space-between;align-items:center;padding:0 4px 2px;color:#8a7b68;font-size:13px}
    #vkbd .vk-x{border:none;background:transparent;font-size:20px;min-height:28px;flex:0 0 36px;color:#8a7b68}
    @media (max-width:520px){#vkbd button{min-height:38px;font-size:16px}}
  `;
  document.head.appendChild(style);

  const toggle = document.createElement('button');
  toggle.id = 'vkbdToggle';
  toggle.type = 'button';
  toggle.title = '虚拟键盘';
  toggle.setAttribute('aria-label', '虚拟键盘');
  toggle.textContent = '⌨';
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'vkbd';
  panel.innerHTML = `
    <div class="vk-head"><span>屏幕键盘</span><button class="vk-x" data-k="close" aria-label="收起">×</button></div>
    <div class="vk-row">${'1234567890'.split('').map((k) => `<button data-k="${k}">${k}</button>`).join('')}</div>
    <div class="vk-row">${'qwertyuiop'.split('').map((k) => `<button data-k="${k}">${k}</button>`).join('')}</div>
    <div class="vk-row">${'asdfghjkl'.split('').map((k) => `<button data-k="${k}">${k}</button>`).join('')}</div>
    <div class="vk-row"><button class="special" data-k="shift">⇧</button>${'zxcvbnm'.split('').map((k) => `<button data-k="${k}">${k}</button>`).join('')}<button class="special" data-k="backspace">⌫</button></div>
    <div class="vk-row"><button class="special" data-k="shift">⇧</button><button data-k="@">@</button><button data-k=".">.</button><button data-k="-">-</button><button data-k="_">_</button><button data-k=",">，</button><button data-k="?">？</button><button data-k="!">！</button><button class="special" data-k="space">空格</button><button class="special wide" data-k="enter">回车</button></div>
  `;
  document.body.appendChild(panel);

  let target = null;
  let shift = false;

  const activeTarget = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.type !== 'checkbox' && a.type !== 'radio') return a;
    return target;
  };
  const show = () => { panel.classList.add('show'); };
  const hide = () => { panel.classList.remove('show'); };
  const focusTarget = () => {
    const t = activeTarget();
    if (!t) return null;
    target = t;
    try { t.focus({ preventScroll: true }); } catch { /* ignore */ }
    return t;
  };
  const fireInput = (t) => {
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const insert = (text) => {
    const t = focusTarget();
    if (!t) { show(); return; }
    const start = typeof t.selectionStart === 'number' ? t.selectionStart : t.value.length;
    const end = typeof t.selectionEnd === 'number' ? t.selectionEnd : t.value.length;
    t.value = t.value.slice(0, start) + text + t.value.slice(end);
    const pos = start + text.length;
    try { t.setSelectionRange(pos, pos); } catch { /* ignore */ }
    fireInput(t);
  };
  const backspace = () => {
    const t = focusTarget();
    if (!t) return;
    const start = typeof t.selectionStart === 'number' ? t.selectionStart : t.value.length;
    const end = typeof t.selectionEnd === 'number' ? t.selectionEnd : t.value.length;
    if (start !== end) t.value = t.value.slice(0, start) + t.value.slice(end);
    else if (start > 0) t.value = t.value.slice(0, start - 1) + t.value.slice(start);
    try { t.setSelectionRange(Math.max(0, start - (start === end ? 1 : 0)), Math.max(0, start - (start === end ? 1 : 0))); } catch { /* ignore */ }
    fireInput(t);
  };
  const enter = () => {
    const t = focusTarget();
    if (!t) return;
    const form = t.closest && t.closest('form');
    if (form && form.requestSubmit) { form.requestSubmit(); return; }
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    const btn = t.parentElement && t.parentElement.querySelector('button');
    if (btn) btn.click();
  };

  panel.addEventListener('mousedown', (e) => {
    // 防止点键盘时输入框失焦
    if (e.target.closest('button')) e.preventDefault();
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (k === 'close') { hide(); return; }
    if (k === 'shift') { shift = !shift; panel.querySelectorAll('button[data-k="shift"]').forEach((x) => x.classList.toggle('on', shift)); return; }
    if (k === 'space') { insert(' '); return; }
    if (k === 'backspace') { backspace(); return; }
    if (k === 'enter') { enter(); return; }
    if (k === ',') { insert('，'); return; }
    if (k === '?') { insert('？'); return; }
    if (k === '!') { insert('！'); return; }
    let ch = k;
    if (/^[a-z]$/.test(k)) ch = shift ? k.toUpperCase() : k;
    if (k === '@' || k === '.' || k === '-' || k === '_') ch = k;
    insert(ch);
    if (shift) { shift = false; panel.querySelectorAll('button[data-k="shift"]').forEach((x) => x.classList.remove('on')); }
  });

  toggle.addEventListener('click', () => {
    if (panel.classList.contains('show')) hide();
    else { show(); const t = activeTarget(); if (t) target = t; }
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'checkbox' && t.type !== 'radio') {
      target = t;
      // 触摸屏设备：聚焦输入框自动弹出
      if (matchMedia && matchMedia('(pointer: coarse)').matches) show();
    }
  });
  // 点页面空白处不自动收起，避免老人刚输入就消失；只有 × 收起。
})();
