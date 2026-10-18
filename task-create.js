import { getDB, saveDB } from './db.js';
import { logAction } from './app.js';

export function initTaskCreatePage() {
  const form = document.getElementById('task-form');
  if (!form) return;

  const typeSelect = document.getElementById('tc-type');

  // Show/hide type-specific fields
  typeSelect.addEventListener('change', () => {
    const type = typeSelect.value;
    document.getElementById('tc-recurrence-group').style.display = (type === 'calendar' || type === 'sequence') ? '' : 'none';
    document.getElementById('tc-threshold-group').style.display = type === 'stock' ? '' : 'none';
    document.getElementById('tc-deadline-group').style.display = type === 'standalone' ? '' : 'none';
    document.getElementById('tc-initial-stock-group').style.display = type === 'stock' ? '' : 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = document.getElementById('tc-name').value.trim();
    const type = typeSelect.value;
    const assigned = document.getElementById('tc-assigned').value.trim();
    const exempt = document.getElementById('tc-exempt').value.trim();
    const grace = parseInt(document.getElementById('tc-grace').value) || 0;
    const showAll = document.getElementById('tc-show-all').checked ? 1 : 0;
    const trackTime = document.getElementById('tc-track-time').checked ? 1 : 0;

    let recurrence = '';
    let threshold = null;
    let deadline = null;
    let initialStock = null;

    if (type === 'calendar') {
      recurrence = document.getElementById('tc-recurrence').value;
    } else if (type === 'sequence') {
      recurrence = document.getElementById('tc-recurrence').value; // e.g. "2d"
    } else if (type === 'stock') {
      threshold = parseInt(document.getElementById('tc-threshold').value) || 0;
      recurrence = `threshold:${threshold}`;
      initialStock = parseInt(document.getElementById('tc-initial-stock').value) || 0;
    } else if (type === 'standalone') {
      deadline = document.getElementById('tc-deadline').value || 'none';
      recurrence = deadline;
    }

    // Generate task_id from name (slug)
    const taskId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Insert task
    const db = getDB();
    db.run(
      `INSERT OR REPLACE INTO tasks (task_id, name, type, recurrence, assigned_user, exempt_days, grace_min, show_all_instances, track_time, retired, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      [taskId, name, type, recurrence, assigned, exempt, grace, showAll, trackTime, 0]
    );

    // For stock: log initial restock
    if (type === 'stock' && initialStock > 0) {
      const ts = new Date().toISOString();
      const user = localStorage.getItem('fe_user');
      db.run(`INSERT INTO stock (task_id, event, qty, ts, user) VALUES (?,?,?,?,?)`, [taskId, 'restock', initialStock, ts, user]);
    }

    // For standalone: create the single instance
    if (type === 'standalone') {
      const dueDate = deadline === 'none' ? null : deadline;
      db.run(
        `INSERT INTO instances (instance_id, task_id, due_date, status) VALUES (?,?,?, 'pending')`,
        [`${taskId}-0001`, taskId, dueDate || new Date().toISOString().slice(0, 10)]
      );
    }

    // For calendar/sequence: generate first instance
    if (type === 'calendar' || type === 'sequence') {
      const { generateNextInstance } = await import('./instances.js');
      const taskObj = { task_id: taskId, name, type, recurrence, exempt_days: exempt, grace_min: grace };
      const inst = generateNextInstance(taskObj, null);
      if (inst) {
        db.run(
          `INSERT INTO instances (instance_id, task_id, due_date, status) VALUES (?,?,?, 'pending')`,
          [inst.instance_id, taskId, inst.due_date]
        );
      }
    }

    await saveDB();

    // Log creation as event
    await logAction(taskId, taskId, 'created', name);

    // Reset form
    form.reset();
    alert(`Task "${name}" created.`);

    // Navigate back to dashboard
    const { showPage } = await import('./app.js');
    showPage('dashboard');
  });
}   




//RETIRE FUNCTION
export async function retireTask(taskId) {
  const db = getDB();
  db.run(`UPDATE tasks SET retired = 1 WHERE task_id = ?`, [taskId]);
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(taskId, taskId, 'retired', '');
}

export async function unretireTask(taskId) {
  const db = getDB();
  db.run(`UPDATE tasks SET retired = 0 WHERE task_id = ?`, [taskId]);
  await saveDB();

  const { logAction } = await import('./app.js');
  await logAction(taskId, taskId, 'resumed', '');
}   
