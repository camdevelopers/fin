import { getDB, saveDB } from './db.js';
import { getUpcomingInstances, isMissed } from './instances.js';
import { renderTaskCard, getDoer, getLatestStatus } from './actions.js';

// --- Toggle collapse ---
window.toggleSec = function(headerEl) {
  const sec = headerEl.parentElement;
  const body = sec.querySelector('.sec-body');
  const chevron = headerEl.querySelector('.chevron');
  const isOpen = sec.classList.contains('open');

  if (isOpen) {
    sec.classList.remove('open');
    body.style.display = 'none';
    chevron.textContent = '▸';
  } else {
    sec.classList.add('open');
    body.style.display = '';
    chevron.textContent = '▾';
  }
  // Persist preference
  const prefs = JSON.parse(localStorage.getItem('sec_prefs') || '{}');
  prefs[sec.id] = !isOpen;
  localStorage.setItem('sec_prefs', JSON.stringify(prefs));
};

// --- Restore collapse prefs on load ---
function restorePrefs() {
  const prefs = JSON.parse(localStorage.getItem('sec_prefs') || '{}');
  for (const [id, shouldOpen] of Object.entries(prefs)) {
    const sec = document.getElementById(id);
    if (!sec) continue;
    const body = sec.querySelector('.sec-body');
    const chevron = sec.querySelector('.chevron');
    if (shouldOpen && !sec.classList.contains('open')) {
      sec.classList.add('open');
      body.style.display = '';
      chevron.textContent = '▾';
    } else if (!shouldOpen && sec.classList.contains('open')) {
      sec.classList.remove('open');
      body.style.display = 'none';
      chevron.textContent = '▸';
    }
  }
}

// --- Section 1: Attendance (current user) ---
function renderAttendance(currentUser) {
  const container = document.getElementById('attendance-content');
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);

  const res = db.exec(
    `SELECT checkin, checkout FROM attendance WHERE date = ? AND user = ?`,
    [today, currentUser]
  );

  let checkin = null, checkout = null;
  if (res.length > 0 && res[0].values.length > 0) {
    checkin = res[0].values[0][0];
    checkout = res[0].values[0][1];
  }

  const fmt = (t) => t ? new Date(`2000-01-01T${t}`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

  container.innerHTML = `
    <div class="attendance-row">
      <span>Check-in: <strong>${fmt(checkin)}</strong></span>
      <span>Check-out: <strong>${fmt(checkout)}</strong></span>
    </div>
    <div class="attendance-btns">
      ${!checkin ? `<button class="btn-checkin" onclick="doAttendance('checkin')">Check In</button>` : ''}
      ${checkin && !checkout ? `<button class="btn-checkout" onclick="doAttendance('checkout')">Check Out</button>` : ''}
      ${checkin && checkout ? '<span class="muted">Done for today</span>' : ''}
    </div>
  `;
}

window.doAttendance = async function(type) {
  const db = getDB();
  const user = localStorage.getItem('fe_user');
  const now = new Date().toTimeString().slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'checkin') {
    db.run(`INSERT OR REPLACE INTO attendance (date, user, checkin, checkout) VALUES (?, ?, ?, NULL)`, [today, user, now]);
  } else {
    db.run(`UPDATE attendance SET checkout = ? WHERE date = ? AND user = ?`, [now, today, user]);
  }
  await saveDB();

  // Log as event
  const { logAction } = await import('./app.js');
  await logAction(`att-${today}`, 'attendance', type, '');

  renderAttendance(user);
  renderPresence();
};

// --- Section 2: Office Presence ---
function renderPresence() {
  const container = document.getElementById('presence-content');
  const db = getDB();
  const today = new Date().toISOString().slice(0, 10);

  // Get all users from attendance + leave
  const attRes = db.exec(`SELECT user, checkin, checkout FROM attendance WHERE date = ?`, [today]);
  const leaveRes = db.exec(`SELECT user, type FROM leave WHERE start_date <= ? AND (end_date IS NULL OR end_date >= ?)`, [today, today]);

  const fmt = (t) => t ? new Date(`2000-01-01T${t}`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

  let rows = '';

  // Build user list (union of attendance + leave + known users)
  const users = new Set();
  if (attRes.length > 0) attRes[0].values.forEach(v => users.add(v[0]));
  if (leaveRes.length > 0) leaveRes[0].values.forEach(v => users.add(v[0]));

  const attMap = {};
  if (attRes.length > 0) attRes[0].values.forEach(v => { attMap[v[0]] = { checkin: v[1], checkout: v[2] }; });
  const leaveMap = {};
  if (leaveRes.length > 0) leaveRes[0].values.forEach(v => { leaveMap[v[0]] = v[1]; });

  const sorted = [...users].sort();
  for (const user of sorted) {
    if (leaveMap[user]) {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-leave">On Leave (${leaveMap[user]})</span></div>`;
    } else if (attMap[user] && attMap[user].checkin && attMap[user].checkout) {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-out">Out</span> <span class="muted">${fmt(attMap[user].checkin)} – ${fmt(attMap[user].checkout)}</span></div>`;
    } else if (attMap[user] && attMap[user].checkin) {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-in">In</span> <span class="muted">since ${fmt(attMap[user].checkin)}</span></div>`;
    } else {
      rows += `<div class="presence-row"><span class="p-name">${user}</span> <span class="badge badge-absent">Absent</span></div>`;
    }
  }

  container.innerHTML = rows || '<p class="muted">No one logged yet today.</p>';
}

// --- Section 3: Missed Tasks ---
function renderMissed(tasks) {
  const container = document.getElementById('missed-content');
  let count = 0;

  for (const task of tasks) {
    const instances = getUpcomingInstances(task, 0); // just today
    const missed = instances.filter(i => isMissed(i, task));
    for (const inst of missed) {
      container.appendChild(renderTaskCard(inst, task));
      count++;
    }
  }

  if (count === 0) container.innerHTML = '<p class="muted">Nothing missed. 🎉</p>';
}

// --- Section 4: Upcoming (today + 7d) ---
function renderUpcoming(tasks) {
  const container = document.getElementById('upcoming-content');
  let count = 0;

  for (const task of tasks) {
    if (task.show_all_instances === 0) {
      // Collapsed: show one line
      const instances = getUpcomingInstances(task, 7);
      if (instances.length > 0) {
        const next = instances[0];
        const card = renderTaskCard(next, task);
        const extra = document.createElement('div');
        extra.className = 'muted small';
        extra.textContent = `+${instances.length - 1} more this week`;
        card.appendChild(extra);
        container.appendChild(card);
        count++;
      }
    } else {
      const instances = getUpcomingInstances(task, 7);
      for (const inst of instances) {
        container.appendChild(renderTaskCard(inst, task));
        count++;
      }
    }
  }

  if (count === 0) container.innerHTML = '<p class="muted">Nothing upcoming.</p>';
}

// --- Section 5: Recurring (beyond 7d) ---
function renderRecurring(tasks) {
  const container = document.getElementById('recurring-content');
  let count = 0;

  for (const task of tasks) {
    if (task.type !== 'calendar') continue;
    const instances = getUpcomingInstances(task, 90); // look 90 days ahead
    const beyond7 = instances.filter(i => {
      const d = new Date(i.due_date);
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 7);
      return d > horizon;
    });
    for (const inst of beyond7) {
      container.appendChild(renderTaskCard(inst, task));
      count++;
    }
  }

  if (count === 0) container.innerHTML = '<p class="muted">No recurring tasks beyond this week.</p>';
}

// --- Section 6: Notes ---
function renderNotes() {
  const container = document.getElementById('notes-content');
  const db = getDB();
  const res = db.exec(`SELECT note_id, author, ts, content FROM notes ORDER BY ts DESC LIMIT 10`);

  if (res.length === 0 || res[0].values.length === 0) {
    container.innerHTML = '<p class="muted">No notes yet.</p>';
    return;
  }

  const rows = res[0].values.map(v => {
    const [, author, ts, content] = v;
    const time = new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="note-row"><span class="note-author">${author}</span> <span class="note-time">${time}</span><p>${content}</p></div>`;
  });
  container.innerHTML = rows.join('');
}

window.publishNote = async function() {
  const input = document.getElementById('note-input');
  const content = input.value.trim();
  if (!content) return;

  const db = getDB();
  const user = localStorage.getItem('fe_user');
  const ts = new Date().toISOString();
  const noteId = `n-${Date.now()}`;

  db.run(`INSERT INTO notes (note_id, author, ts, content) VALUES (?,?,?,?)`, [noteId, user, ts, content]);
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(noteId, 'notes', 'note', content);

  input.value = '';
  renderNotes();
};

// --- Section 7: Paused / Retired ---
function renderPaused() {
  const container = document.getElementById('paused-content');
  const db = getDB();
  const res = db.exec(`SELECT task_id, name, retired FROM tasks WHERE retired = 1`);

  if (res.length === 0 || res[0].values.length === 0) {
    container.innerHTML = '<p class="muted">Nothing paused or retired.</p>';
    return;
  }

  const rows = res[0].values.map(v => {
    const [, name, retired] = v;
    return `<div class="paused-row"><span>${name}</span> <span class="badge badge-retired">${retired ? 'Retired' : 'Paused'}</span></div>`;
  });
  container.innerHTML = rows.join('');
}

// --- Master render ---
export function renderDashboard() {
  const db = getDB();
  const currentUser = localStorage.getItem('fe_user');

  // Get all active tasks
  const tasksRes = db.exec(`SELECT * FROM tasks WHERE retired = 0`);
  let tasks = [];
  if (tasksRes.length > 0) {
    const cols = tasksRes[0].columns;
    tasks = tasksRes[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
  }

  // Clear all sections
  ['attendance-content', 'presence-content', 'missed-content', 'upcoming-content', 'recurring-content', 'notes-content', 'paused-content']
    .forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });

  // Render each
  renderAttendance(currentUser);
  renderPresence();
  renderMissed(tasks);
  renderUpcoming(tasks);
  renderRecurring(tasks);
  renderNotes();
  renderPaused();
}   
