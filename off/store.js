// ============================================================
// store.js — Dummy Store (localStorage-backed)
// Later: replace function bodies with SQLite / GitHub API.
// ============================================================

const DEVICE_ID = window.DEVICE_ID || 1; // Overridden in each HTML file
const BASELINE = '2000-01-01';

// --- Local data (per-instance) ---
function _localKey() { return `app_data_${DEVICE_ID}`; }
function _loadLocal() {
  try { return JSON.parse(localStorage.getItem(_localKey()) || '{}'); }
  catch { return {}; }
}
function _saveLocal(data) { localStorage.setItem(_localKey(), JSON.stringify(data)); }

// --- Fake git (shared) ---
const GIT_KEY = 'fake_git_repo';
function _gitLoad() {
  try { return JSON.parse(localStorage.getItem(GIT_KEY) || '{}'); }
  catch { return {}; }
}
function _gitSave(repo) { localStorage.setItem(GIT_KEY, JSON.stringify(repo)); }

// ============================================================
// STORE
// ============================================================
const Store = {
  // --- READS ---
  readTasks() { return _loadLocal().tasks || []; },
  readInstances() { return _loadLocal().instances || []; },
  readEvents() { return _loadLocal().events || []; },
  readNotes() { return _loadLocal().notes || []; },
  readStock(taskId) {
    const stock = (_loadLocal().stock || {})[taskId];
    return stock || { qty: 0, events: [] };
  },
  readMeta(key) {
    const meta = _loadLocal().meta || {};
    return meta[key] !== undefined ? meta[key] : null;
  },
  readChanges(filter) {
    const changes = _loadLocal().changes || [];
    if (!filter) return changes;
    return changes.filter(c => {
      for (const k in filter) { if (c[k] !== filter[k]) return false; }
      return true;
    });
  },

  // --- WRITES ---
  writeTask(task) {
    const d = _loadLocal();
    d.tasks = d.tasks || [];
    const idx = d.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) d.tasks[idx] = task; else d.tasks.push(task);
    _saveLocal(d);
    this._logChange('tasks', 'upsert', task);
  },
  writeInstance(inst) {
    const d = _loadLocal();
    d.instances = d.instances || [];
    const idx = d.instances.findIndex(i => i.id === inst.id);
    if (idx >= 0) d.instances[idx] = inst; else d.instances.push(inst);
    _saveLocal(d);
    this._logChange('instances', 'upsert', inst);
  },
  writeEvent(ev) {
    const d = _loadLocal();
    d.events = d.events || [];
    d.events.push(ev);
    _saveLocal(d);
    this._logChange('events', 'insert', ev);
  },
  writeNote(note) {
    const d = _loadLocal();
    d.notes = d.notes || [];
    const idx = d.notes.findIndex(n => n.id === note.id);
    if (idx >= 0) d.notes[idx] = note; else d.notes.push(note);
    _saveLocal(d);
    this._logChange('notes', 'upsert', note);
  },
  writeStock(taskId, stock) {
    const d = _loadLocal();
    d.stock = d.stock || {};
    d.stock[taskId] = stock;
    _saveLocal(d);
    this._logChange('stock', 'upsert', { taskId, ...stock });
  },
  writeMeta(key, value) {
    const d = _loadLocal();
    d.meta = d.meta || {};
    d.meta[key] = value;
    _saveLocal(d);
  },

  // --- DELETES ---
  deleteTask(id) {
    const d = _loadLocal();
    d.tasks = (d.tasks || []).filter(t => t.id !== id);
    _saveLocal(d);
    this._logChange('tasks', 'delete', { id });
  },
  deleteInstance(id) {
    const d = _loadLocal();
    d.instances = (d.instances || []).filter(i => i.id !== id);
    _saveLocal(d);
    this._logChange('instances', 'delete', { id });
  },
  deleteNote(id) {
    const d = _loadLocal();
    d.notes = (d.notes || []).filter(n => n.id !== id);
    _saveLocal(d);
    this._logChange('notes', 'delete', { id });
  },

  // --- CHANGE LOGGING ---
  _logChange(tableName, opType, payload) {
    const d = _loadLocal();
    d.meta = d.meta || {};
    const seqKey = `nextSeq`;
    const next = (d.meta[seqKey] || 0) + 1;
    d.meta[seqKey] = next;
    const changeId = `${DEVICE_ID}${String(next).padStart(4, '0')}`;
    d.changes = d.changes || [];
    d.changes.push({
      changeId, tableName, opType,
      payloadJSON: JSON.stringify(payload),
      synced: 0, pulled: 0, applied: 1,
      ts: new Date().toISOString()
    });
    _saveLocal(d);
    this.syncPush(changeId);
  },

  // --- SYNC PUSH (immediate, to fake git) ---
  syncPush(changeId) {
    const d = _loadLocal();
    const change = (d.changes || []).find(c => c.changeId === changeId);
    if (!change) return;
    const csv = `tableName,opType,payload\n${change.tableName},${change.opType},"${change.payloadJSON.replace(/"/g, '""')}"`;
    const repo = _gitLoad();
    repo[`sync/${changeId}.csv`] = csv;
    _gitSave(repo);
    // Mark synced
    change.synced = 1;
    _saveLocal(d);
  },

  // --- SYNC PULL (manual) ---
  syncPull() {
    const repo = _gitLoad();
    const d = _loadLocal();
    const myPrefix = String(DEVICE_ID);
    const otherPrefix = String(DEVICE_ID === 1 ? 2 : 1);
    const existingIds = new Set((d.changes || []).map(c => c.changeId));
    let pulledCount = 0;

    for (const filePath of Object.keys(repo)) {
      if (!filePath.startsWith('sync/')) continue;
      const fname = filePath.replace('sync/', '').replace('.csv', '');
      if (!fname.startsWith(otherPrefix)) continue;
      if (existingIds.has(fname)) continue;

      // Parse CSV
      const content = repo[filePath];
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length < 2) continue;
      const dataLine = lines[1];
      const c1 = dataLine.indexOf(',');
      const c2 = dataLine.indexOf(',', c1 + 1);
      const tableName = dataLine.slice(0, c1);
      const opType = dataLine.slice(c1 + 1, c2);
      let payload = dataLine.slice(c2 + 1);
      if (payload.startsWith('"') && payload.endsWith('"')) {
        payload = payload.slice(1, -1).replace(/""/g, '"');
      }

      d.changes = d.changes || [];
      d.changes.push({
        changeId: fname, tableName, opType,
        payloadJSON: payload,
        synced: 1, pulled: 1, applied: 0,
        ts: new Date().toISOString()
      });
      pulledCount++;
    }

    _saveLocal(d);
    if (pulledCount > 0) this.mergeProcess();
    return pulledCount;
  },

  // --- MERGE MANAGER ---
  mergeProcess() {
    const d = _loadLocal();
    const pending = (d.changes || []).filter(c => c.pulled === 1 && c.applied === 0);
    pending.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    for (const change of pending) {
      try {
        this._mergeOne(change);
        change.applied = 1;
      } catch (err) {
        console.error(`[Merge] ${change.changeId}:`, err);
      }
    }
    _saveLocal(d);
  },

  _mergeOne(change) {
    const payload = JSON.parse(change.payloadJSON);
    const { tableName, opType } = change;

    if (opType === 'delete') {
      if (tableName === 'tasks') this.deleteTask(payload.id);
      else if (tableName === 'instances') this.deleteInstance(payload.id);
      else if (tableName === 'notes') this.deleteNote(payload.id);
      return;
    }

    switch (tableName) {
      case 'tasks': this._mergeTask(payload); break;
      case 'instances': this._mergeInstance(payload); break;
      case 'events': this._mergeEvent(payload); break;
      case 'notes': this._mergeNote(payload); break;
      case 'stock': this._mergeStock(payload); break;
    }
  },

  _mergeTask(remote) {
    const local = this.readTasks().find(t => t.id === remote.id);
    if (!local) { this.writeTask(remote); return; }
    if (new Date(remote.createdAt || 0) >= new Date(local.createdAt || 0)) {
      this.writeTask(remote);
    }
  },

  _mergeInstance(remote) {
    const local = this.readInstances().find(i => i.id === remote.id);
    if (!local) { this.writeInstance(remote); return; }

    // Rule 1: done is terminal
    if (remote.status === 'done') { this.writeInstance(remote); return; }
    if (local.status === 'done') return;

    // Rule 2: chain — higher seqNumber wins (for sequence/quantity)
    if (remote.seqNumber !== undefined && local.seqNumber !== undefined) {
      if (remote.seqNumber > local.seqNumber) { this.writeInstance(remote); return; }
      if (local.seqNumber > remote.seqNumber) return;
      // Same seqNumber: passive (link=0) loses to linked
      if (remote.linkNumber === 0 && local.linkNumber > 0) return;
      if (local.linkNumber === 0 && remote.linkNumber > 0) { this.writeInstance(remote); return; }
    }

    // Rule 3: LWW by updatedAt
    const lt = new Date(local.updatedAt || 0);
    const rt = new Date(remote.updatedAt || 0);
    if (rt > lt) { this.writeInstance(remote); return; }
    if (rt === lt) {
      if (this._fieldCount(remote) > this._fieldCount(local)) this.writeInstance(remote);
    }
  },

  _mergeEvent(remote) {
    const events = this.readEvents();
    const exists = events.some(e => e.ts === remote.ts && e.taskId === remote.taskId && e.action === remote.action);
    if (!exists) this.writeEvent(remote);
  },

  _mergeNote(remote) {
    const local = this.readNotes().find(n => n.id === remote.id);
    if (!local) { this.writeNote(remote); return; }
    if (new Date(remote.editedAt || remote.createdAt || 0) >= new Date(local.editedAt || local.createdAt || 0)) {
      this.writeNote(remote);
    }
  },

  _mergeStock(remote) {
    const taskId = remote.taskId;
    const local = this.readStock(taskId);
    const allEvents = [...(local.events || [])];
    for (const ev of (remote.events || [])) {
      if (!allEvents.some(e => e.ts === ev.ts && e.action === ev.action && e.qty === ev.qty)) {
        allEvents.push(ev);
      }
    }
    allEvents.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    let qty = 0;
    for (const ev of allEvents) qty += ev.action === 'restock' ? ev.qty : -ev.qty;
    this.writeStock(taskId, { qty, events: allEvents });
  },

  _fieldCount(obj) {
    return Object.values(obj).filter(v => v !== null && v !== undefined && v !== '').length;
  },
};

// ============================================================
// INSTANCE ID GENERATOR
// ============================================================
function genInstanceId(task, context = {}) {
  switch (task.type) {
    case 'sequence': {
      const n = context.seqNumber || (task.seqCounter || 0) + 1;
      return `${task.id}-s${n}`;
    }
    case 'calendar': {
      const d = context.dueAt ? new Date(context.dueAt) : new Date();
      return `${task.id}-c${d.toISOString().slice(0, 10)}`;
    }
    case 'quantity': {
      const n = context.seqNumber || (task.qtyCounter || 0) + 1;
      return `${task.id}-q${n}`;
    }
    case 'standalone': {
      const rand = Math.random().toString(36).slice(2, 8);
      return `${task.id}-r${rand}`;
    }
    case 'dependency': {
      const triggerId = context.triggerInstanceId || 'unknown';
      const d = context.dueAt ? new Date(context.dueAt) : new Date();
      return `${triggerId}-D${d.toISOString().slice(0, 10)}`;
    }
    default:
      return `${task.id}-x${Date.now().toString(36)}`;
  }
}

// ============================================================
// HELPERS
// ============================================================
const now = () => new Date();
const todayStr = () => now().toISOString().slice(0, 10);
const hrsFromNow = (h) => { const d = new Date(); d.setHours(d.getHours() + h); return d; };
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
const fmtTime = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDuration = (ms) => {
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
};

// --- Chain helpers ---
function getLatestDoneSeq(instances, taskId) {
  const done = instances
    .filter(i => i.taskId === taskId && i.status === 'done')
    .sort((a, b) => (b.seqNumber || 0) - (a.seqNumber || 0));
  return done.length ? (done[0].seqNumber || 0) : 0;
}

function nextSeqNumber(instances, taskId) {
  return getLatestDoneSeq(instances, taskId) + 1;
}   