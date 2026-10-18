import { getDB, saveDB } from './db.js';

// --- Request leave ---
export async function requestLeave(user, startDate, endDate, type, reason) {
  const db = getDB();
  db.run(
    `INSERT INTO leave (user, start_date, end_date, type, reason) VALUES (?,?,?,?,?)`,
    [user, startDate, endDate || null, type || 'leave', reason || null]
  );
  await saveDB();

  // Log as event
  const { logAction } = await import('./app.js');
  const note = `type:${type||'leave'} ${startDate}→${endDate||'open'} ${reason||''}`.trim();
  await logAction(`leave-${user}-${startDate}`, 'leave', 'unavailable', note);
}

// --- Cancel leave ---
export async function cancelLeave(user, startDate) {
  const db = getDB();
  db.run(`DELETE FROM leave WHERE user = ? AND start_date = ?`, [user, startDate]);
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(`leave-${user}-${startDate}`, 'leave', 'available', 'cancelled');
}

// --- Check if a user is on leave on a given date ---
export function isOnLeave(user, dateStr) {
  const db = getDB();
  const res = db.exec(
    `SELECT type FROM leave WHERE user = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    [user, dateStr, dateStr]
  );
  return res.length > 0 && res[0].values.length > 0 ? res[0].values[0][0] : null;
}

// --- Get all active leaves (for presence section) ---
export function getActiveLeaves(dateStr) {
  const db = getDB();
  const res = db.exec(
    `SELECT user, start_date, end_date, type, reason FROM leave WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    [dateStr, dateStr]
  );
  if (res.length === 0) return [];
  const cols = res[0].columns;
  return res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

// --- Render leave request modal ---
export function showLeaveModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'leave-modal';
  modal.innerHTML = `
    <div class="modal">
      <h3>Request Leave</h3>
      <label>Start date</label>
      <input type="date" id="leave-start" />
      <label>End date (optional)</label>
      <input type="date" id="leave-end" />
      <label>Type</label>
      <select id="leave-type">
        <option value="leave">Leave</option>
        <option value="not_available">Not Available</option>
        <option value="redirected">Redirected</option>
      </select>
      <label>Reason</label>
      <input type="text" id="leave-reason" placeholder="Optional" />
      <div class="modal-btns">
        <button class="btn-cancel" onclick="document.getElementById('leave-modal').remove()">Cancel</button>
        <button class="btn-confirm" id="leave-submit">Request</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('leave-submit').addEventListener('click', async () => {
    const user = localStorage.getItem('fe_user');
    const start = document.getElementById('leave-start').value;
    const end = document.getElementById('leave-end').value;
    const type = document.getElementById('leave-type').value;
    const reason = document.getElementById('leave-reason').value;

    if (!start) return alert('Start date required');

    await requestLeave(user, start, end, type, reason);
    modal.remove();

    const { renderDashboard } = await import('./dashboard.js');
    renderDashboard();
  });
}
window.showLeaveModal = showLeaveModal;   
