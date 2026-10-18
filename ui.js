export function setSyncStatus(text, cls = '') {
  const el = document.getElementById('sync-status');
  el.textContent = text;
  el.className = cls;
}

export function setPendingCount(n) {
  const el = document.getElementById('sync-status');
  if (n > 0) {
    el.textContent = `⚠️ ${n} pending`;
    el.className = 'warn';
  }
}   
