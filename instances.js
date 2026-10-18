import { getDB, saveDB } from './db.js';

// --- Day exemption ---
function isExempted(date, exemptDays) {
  if (!exemptDays) return false;
  const days = exemptDays.split(',').map(d => d.trim().toLowerCase());
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  if (days.includes(dayName)) return true;
  if (days.includes('sunday') && dayName === 'sunday') return true;
  // Holiday check (you'll add Indian holiday data later)
  if (days.includes('holidays') && isHoliday(date)) return true;
  return false;
}

function isHoliday(date) {
  // Placeholder — replace with your Indian holiday list
  // e.g., a Set of "YYYY-MM-DD" strings
  const holidays = new Set([
    '2026-10-02', // Gandhi Jayanti
    '2026-11-08', // Diwali (approx)
    '2026-12-25', // Christmas
  ]);
  return holidays.has(date.toISOString().slice(0, 10));
}

// --- Calendar-anchored ---
function nextCalendarDue(task, fromDate) {
  const d = new Date(fromDate);
  const rule = task.recurrence; // e.g. "monthly", "quarterly", "annual", "weekly:mon,wed,fri", "nth:2,tue"

  if (rule === 'monthly') {
    // Next 1st of the month (or same day-of-month as task creation)
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
  } else if (rule === 'quarterly') {
    const q = Math.floor(d.getMonth() / 3) + 1;
    d.setMonth(q * 3, 1);
  } else if (rule === 'annual') {
    d.setMonth(0, 1);
    d.setFullYear(d.getFullYear() + 1);
  } else if (rule.startsWith('weekly:')) {
    const days = rule.split(':')[1].split(',').map(s => s.trim().toLowerCase());
    for (let i = 0; i < 7; i++) {
      d.setDate(d.getDate() + 1);
      const name = d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      if (days.includes(name) && !isExempted(d, task.exempt_days)) return d;
    }
  } else if (rule.startsWith('nth:')) {
    // e.g. "nth:2,tue" = 2nd Tuesday of the month
    const [nth, dayName] = rule.split(':').map(s => s.trim());
    const n = parseInt(nth);
    const targetDay = dayName.toLowerCase();
    d.setDate(1);
    // Find first occurrence of targetDay
    while (d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() !== targetDay) {
      d.setDate(d.getDate() + 1);
    }
    // Jump to nth occurrence
    d.setDate(d.getDate() + (n - 1) * 7);
  }

  // Apply exemption — if due date falls on exempted day, skip forward
  while (isExempted(d, task.exempt_days)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// --- Sequence-based ---
function nextSequenceDue(task, lastDoneDate) {
  const intervalDays = parseInt(task.recurrence); // e.g. "2d" → 2
  const d = new Date(lastDoneDate || new Date());
  d.setDate(d.getDate() + intervalDays);

  // Apply exemption
  while (isExempted(d, task.exempt_days)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// --- Stock-threshold ---
function isStockDue(task) {
  const db = getDB();
  const threshold = parseInt(task.recurrence.replace('threshold:', ''));
  const result = db.exec(`
    SELECT COALESCE(SUM(CASE WHEN event='restock' THEN qty ELSE -qty END), 0) as stock
    FROM stock WHERE task_id = '${task.task_id}'
  `);
  const stock = result.length > 0 ? result[0].values[0][0] : 0;
  return stock <= threshold;
}

// --- Standalone ---
function standaloneDue(task) {
  // Due date is set at creation (task.recurrence holds the date, or "none")
  if (task.recurrence === 'none' || !task.recurrence) return null; // no deadline
  return new Date(task.recurrence);
}

// --- Main: generate next instance for a task ---
export function generateNextInstance(task, lastInstance) {
  let dueDate = null;

  switch (task.type) {
    case 'calendar':
      const from = lastInstance ? new Date(lastInstance.due_date) : new Date();
      dueDate = nextCalendarDue(task, from);
      break;

    case 'sequence':
      const lastDone = lastInstance && lastInstance.status === 'done'
        ? new Date(lastInstance.done_at)
        : null;
      dueDate = nextSequenceDue(task, lastDone);
      break;

    case 'stock':
      if (isStockDue(task)) {
        dueDate = new Date(); // due now
      }
      break;

    case 'standalone':
      dueDate = standaloneDue(task);
      break;
  }

  if (!dueDate) return null;

  // Generate instance_id
  const seq = (lastInstance ? parseInt(lastInstance.instance_id.split('-').pop()) : 0) + 1;
  const instanceId = `${task.task_id}-${String(seq).padStart(4, '0')}`;

  return {
    instance_id: instanceId,
    task_id: task.task_id,
    due_date: dueDate.toISOString().slice(0, 10),
    status: 'pending',
    done_by: null,
    done_at: null,
    note: null
  };
}

// --- Missed detection ---
export function isMissed(instance, task) {
  if (instance.status === 'done') return false;
  const due = new Date(instance.due_date + 'T23:59:59');
  const graceMs = (task.grace_min || 0) * 60 * 1000;
  return new Date() > new Date(due.getTime() + graceMs);
}

// --- Generate all pending instances for a task (for dashboard) ---
export function getUpcomingInstances(task, daysAhead = 7) {
  const db = getDB();
  const results = [];
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + daysAhead);
  const today = new Date().toISOString().slice(0, 10);

  // 1. Pull existing pending instances within horizon
  const existing = db.exec(
    `SELECT * FROM instances WHERE task_id = ? AND status != 'done' AND due_date <= ? AND due_date >= ? ORDER BY due_date ASC`,
    [task.task_id, horizon.toISOString().slice(0, 10), today]
  );
  if (existing.length > 0) {
    const cols = existing[0].columns;
    results.push(...existing[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]]))));
  }

  // 2. Standalone & stock: no forward generation
  if (task.type === 'standalone' || task.type === 'stock') return results;

  // 3. If show_all_instances is OFF → only return the first (next) instance
  if (task.show_all_instances === 0) {
    return results.length > 0 ? [results[0]] : [];
  }

  // 4. Generate forward (only when show_all_instances is ON)
  let lastInstance = null;
  const last = db.exec(
    `SELECT instance_id, due_date, status, done_at FROM instances WHERE task_id = ? ORDER BY due_date DESC LIMIT 1`,
    [task.task_id]
  );
  if (last.length > 0 && last[0].values.length > 0) {
    const cols = last[0].columns;
    lastInstance = Object.fromEntries(cols.map((c, i) => [c, last[0].values[0][i]]));
  }

  let current = lastInstance;
  for (let i = 0; i < 30; i++) {
    const inst = generateNextInstance(task, current);
    if (!inst) break;
    if (new Date(inst.due_date) > horizon) break;
    if (new Date(inst.due_date) < new Date()) continue;

    const exists = db.exec(`SELECT 1 FROM instances WHERE instance_id = ?`, [inst.instance_id]);
    if (exists.length === 0) {
      db.run(`INSERT INTO instances (instance_id, task_id, due_date, status) VALUES (?,?,?, 'pending')`,
        [inst.instance_id, task.task_id, inst.due_date]);
    }

    if (!results.find(r => r.instance_id === inst.instance_id)) {
      const row = db.exec(`SELECT * FROM instances WHERE instance_id = ?`, [inst.instance_id]);
      if (row.length > 0) {
        const cols = row[0].columns;
        results.push(Object.fromEntries(cols.map((c, i) => [c, row[0].values[0][i]])));
      }
    }

    current = inst;
  }

  return results;
}   
