/* 重置账号数据后，通知同源打开的其他页面刷新，避免老人端还留着旧对话。 */
window.addEventListener('storage', (e) => {
  if (e.key === 'seyo.reset') location.reload();
});
