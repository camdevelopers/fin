import { getDB, saveDB } from './db.js';
import { logAction } from './app.js';

// --- Render action buttons for an instance ---
export function renderActionButtons(instance, task) {
  const container = document.createElement('div');
  container.className = 'task-actions';

  const actions = [
    { label: 'Will do', action: 'will_do' },
    { label: 'Doing', action: 'doing' },
    { label: 'Done', action: 'done' }
  ];

  for (const { label, action } of actions) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.disabled = instance.status === 'done'; // can't re-act on done

    // Highlight if this is the current status
    if (instance.status === action) {
      btn.classList.add('active');
    }

    btn.addEventListener('click', () => {
      const note = prompt('Note (optional):') || '';
      logAction(instance.instance_id, task.task_id, action, note);
      renderDashboard(); // re-render after action
    });

    container.appendChild(btn);
  }

  // Transfer button (only if not done)
  if (instance.status !== 'done') {
    const tBtn = document.createElement('button');
    tBtn.textContent = 'Transfer';
    tBtn.className = 'transfer-btn';
    tBtn.addEventListener('click', () => {
      const target = prompt('Transfer to (username):');
      if (!target) return;
      const note = prompt('Note (optional):') || '';
      const fullNote = `to:${target} ${note}`.trim();
      logAction(instance.instance_id, task.task_id, 'transferred', fullNote);
      renderDashboard();
    });
    container.appendChild(tBtn);
  }

  return container;
}

// --- Get the actual doer for an instance (from events) ---
export function getDoer(instanceId) {
  const db = getDB();
  const res = db.exec(
    `SELECT user, action FROM events WHERE instance_id = ? AND action = 'done' ORDER BY ts DESC LIMIT 1`,
    [instanceId]
  );
  if (res.length > 0 && res[0].values.length > 0) {
    return res[0].values[0][0];
  }
  return null;
}

// --- Get latest status for an instance (derived from events) ---
export function getLatestStatus(instanceId) {
  const db = getDB();
  const res = db.exec(
    `SELECT action, user, ts, note FROM events WHERE instance_id = ? ORDER BY ts DESC LIMIT 1`,
    [instanceId]
  );
  if (res.length > 0 && res[0].values.length > 0) {
    const [action, user, ts, note] = res[0].values[0];
    return { action, user, ts, note };
  }
  return { action: 'pending', user: null, ts: null, note: null };
}

// --- Per-task timeline (all events for all instances of a task) ---
export function getTaskTimeline(taskId) {
  const db = getDB();
  const res = db.exec(
    `SELECT ts, instance_id, action, user, note FROM events WHERE task_id = ? ORDER BY ts ASC`,
    [taskId]
  );
  if (res.length === 0) return [];

  const cols = res[0].columns;
  return res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

// --- Render timeline as a simple list ---
export function renderTimeline(taskId) {
  const events = getTaskTimeline(taskId);
  const container = document.createElement('div');
  container.className = 'timeline';

  if (events.length === 0) {
    container.innerHTML = '<p class="muted">No events yet.</p>';
    return container;
  }

  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'timeline-row';
    const time = new Date(ev.ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
    const doer = ev.user;
    const actionLabel = ev.action.replace('_', ' ');
    const note = ev.note ? ` — ${ev.note}` : '';
    row.innerHTML = `<span class="tl-time">${time}</span> <span class="tl-action">${actionLabel}</span> <span class="tl-user">by ${doer}</span><span class="tl-note">${note}</span>`;
    container.appendChild(row);
  }

  return container;
}

// --- Render a single task card (for dashboard sections) ---
export function renderTaskCard(instance, task) {
  const card = document.createElement('div');
  card.className = 'task-card';

  // Header: name + assigned + doer
  const doer = getDoer(instance.instance_id);
  const assigned = task.assigned_user;
  const doerLabel = doer && doer !== assigned
    ? `<span class="doer">→ ${doer}</span>`
    : '';

  const header = document.createElement('div');
  header.className = 'task-card-header';
  header.innerHTML = `<strong>${task.name}</strong> <span class="muted">(${assigned})</span> ${doerLabel}`;
  card.appendChild(header);

  // Due date
  const due = document.createElement('div');
  due.className = 'task-card-due';
  due.textContent = `Due: ${instance.due_date}`;
  card.appendChild(due);

  // Status badge
  const status = getLatestStatus(instance.instance_id);
  const badge = document.createElement('span');
  badge.className = `badge badge-${status.action}`;
  badge.textContent = status.action.replace('_', ' ');
  card.appendChild(badge);

  // Action buttons
  card.appendChild(renderActionButtons(instance, task));

  return card;
}   
