// ============================================================
// store.js — Data Access Layer + Sync + Merge (FIXED)
// ============================================================

function getSettings() {
  try { return JSON.parse(localStorage.getItem('office-settings') || '{}'); }
  catch { return {}; }
}

function getDeviceId() {
  const s = getSettings();
  if (s.deviceId) return parseInt(s.deviceId, 10);
  return window.innerWidth < 768 ? 2 : 1;
}
const DEVICE_ID = getDeviceId();
const BASELINE = '2000-01-01';

function _localKey() { return `app_data_${DEVICE_ID}`; }
function _loadLocal() {
  try { return JSON.parse(localStorage.getItem(_localKey()) || '{}'); }
  catch { return {}; }
}
function _saveLocal(data) { localStorage.setItem(_localKey(), JSON.stringify(data)); }

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

  // --- PUBLIC WRITES (log change + push) ---
  writeTask(task) {
    this._writeTaskLocal(task);
    this._logChange('tasks', 'upsert', task);
  },
  writeInstance(inst) {
    this._writeInstanceLocal(inst);
    this._logChange('instances', 'upsert', inst);
  },
  writeEvent(ev) {
    this._writeEventLocal(ev);
    this._logChange('events', 'insert', ev);
  },
  writeNote(note) {
    this._writeNoteLocal(note);
    this._logChange('notes', 'upsert', note);
  },
  writeStock(taskId, stock) {
    this._writeStockLocal(taskId, stock);
    this._logChange('stock', 'upsert', { taskId, ...stock });
  },
  writeMeta(key, value) {
    const d = _loadLocal();
    d.meta = d.meta || {};
    d.meta[key] = value;
    _saveLocal(d);
  },

  // --- PUBLIC DELETES (log change + push) ---
  deleteTask(id) {
    this._deleteTaskLocal(id);
    this._logChange('tasks', 'delete', { id });
  },
  deleteInstance(id) {
    this._deleteInstanceLocal(id);
    this._logChange('instances', 'delete', { id });
  },
  deleteNote(id) {
    this._deleteNoteLocal(id);
    this._logChange('notes', 'delete', { id });
  },

  // --- SILENT WRITES (local only, NO change log, NO push) ---
  // Used exclusively by Merge Manager.
  _writeTaskLocal(task) {
    const d = _loadLocal();
    d.tasks = d.tasks || [];
    const idx = d.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) d.tasks[idx] = task; else d.tasks.push(task);
    _saveLocal(d);
  },
  _writeInstanceLocal(inst) {
    const d = _loadLocal();
    d.instances = d.instances || [];
    const idx = d.instances.findIndex(i => i.id === inst.id);
    if (idx >= 0) d.instances[idx] = inst; else d.instances.push(inst);
    _saveLocal(d);
  },
  _writeEventLocal(ev) {
    const d = _loadLocal();
    d.events = d.events || [];
    d.events.push(ev);
    _saveLocal(d);
  },
  _writeNoteLocal(note) {
    const d = _loadLocal();
    d.notes = d.notes || [];
    const idx = d.notes.findIndex(n => n.id === note.id);
    if (idx >= 0) d.notes[idx] = note; else d.notes.push(note);
    _saveLocal(d);
  },
  _writeStockLocal(taskId, stock) {
    const d = _loadLocal();
    d.stock = d.stock || {};
    d.stock[taskId] = stock;
    _saveLocal(d);
  },
  _deleteTaskLocal(id) {
    const d = _loadLocal();
    d.tasks = (d.tasks || []).filter(t => t.id !== id);
    _saveLocal(d);
  },
  _deleteInstanceLocal(id) {
    const d = _loadLocal();
    d.instances = (d.instances || []).filter(i => i.id !== id);
    _saveLocal(d);
  },
  _deleteNoteLocal(id) {
    const d = _loadLocal();
    d.notes = (d.notes || []).filter(n => n.id !== id);
    _saveLocal(d);
  },

  // --- CHANGE LOGGING ---
  _logChange(tableName, opType, payload) {
    const d = _loadLocal();
    d.meta = d.meta || {};
    const next = (d.meta.nextSeq || 0) + 1;
    d.meta.nextSeq = next;
    const changeId = `${DEVICE_ID}${String(next).padStart(4, '0')}`;
    d.changes = d.changes || [];
    d.changes.push({
      changeId, tableName, opType,
      payloadJSON: JSON.stringify(payload),
      synced: 0, pulled: 0, applied: 1,
      ts: new Date().toISOString()
    });
    _saveLocal(d);
    // Immediate push (no debounce)
    this._pushOne(changeId).catch(err => {
      console.error(`[Sync] Push failed ${changeId}:`, err.message);
    });
  },

  // --- PUSH (immediate) ---
  async _pushOne(changeId) {
    const settings = getSettings();
    if (!settings.pat || !settings.repo || !settings.owner) return;

    const d = _loadLocal();
    const change = (d.changes || []).find(c => c.changeId === changeId);
    if (!change) return;

    const csv = `tableName,opType,payload\n${change.tableName},${change.opType},"${change.payloadJSON.replace(/"/g, '""')}"`;
    const filePath = `sync/${changeId}.csv`;
    const base64 = btoa(unescape(encodeURIComponent(csv)));

    const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${filePath}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${settings.pat}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `sync ${changeId}`,
        content: base64,
        branch: settings.branch || 'main'
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const d2 = _loadLocal();
    const c = (d2.changes || []).find(x => x.changeId === changeId);
    if (c) { c.synced = 1; _saveLocal(d2); }
  },

  // --- RETRY UNSYNCED ---
  async retryUnsynced() {
    const settings = getSettings();
    if (!settings.pat || !settings.repo || !settings.owner) return;
    const unsynced = this.readChanges({ synced: 0, applied: 1 });
    for (const c of unsynced) {
      this._pushOne(c.changeId).catch(err => {
        console.error(`[Sync] Retry failed ${c.changeId}:`, err.message);
      });
    }
  },

  // --- MANUAL PULL ---
async syncPull() {
  const settings = getSettings();
  if (!settings.pat || !settings.repo || !settings.owner) throw new Error('No GitHub settings');

  // List all files in sync/ directory
  const listUrl = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/sync?ref=${settings.branch || 'main'}`;
  const res = await fetch(listUrl, {
    headers: {
      'Authorization': `Bearer ${settings.pat}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  if (!res.ok) throw new Error(`List sync/: HTTP ${res.status}`);
  const files = await res.json();

  const myPrefix = String(DEVICE_ID);
  const existingIds = new Set(this.readChanges().map(c => c.changeId));
  const d = _loadLocal();
  d.changes = d.changes || [];
  let pulledCount = 0;

  for (const file of files) {
    if (file.type !== 'file') continue;
    const fname = file.name.replace('.csv', '');
    if (fname.startsWith(myPrefix)) continue;
    if (existingIds.has(fname)) continue;

    // Fetch file content
    const fRes = await fetch(file.download_url, {
      headers: { 'Authorization': `Bearer ${settings.pat}` }
    });
    if (!fRes.ok) continue;
    const content = await fRes.text();

    // Parse CSV
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

    d.changes.push({
      changeId: fname, tableName, opType,
      payloadJSON: payload,
      synced: 1, pulled: 1, applied: 0,
      ts: new Date().toISOString()
    });
    existingIds.add(fname);
    pulledCount++;
  }

  _saveLocal(d);
  if (pulledCount > 0) this.mergeProcess();
  return pulledCount;
},   
  // --- MERGE MANAGER (uses SILENT writes — no re-push) ---
  mergeProcess() {
    const pending = this.readChanges({ pulled: 1, applied: 0 });
    pending.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    for (const change of pending) {
      try {
        this._mergeOne(change);
      } catch (err) {
        console.error(`[Merge] ${change.changeId}:`, err);
        continue;
      }
      const d = _loadLocal();
      const c = (d.changes || []).find(x => x.changeId === change.changeId);
      if (c) { c.applied = 1; _saveLocal(d); }
    }
  },

  _mergeOne(change) {
    const payload = JSON.parse(change.payloadJSON);
    const { tableName, opType } = change;

    if (opType === 'delete') {
      if (tableName === 'tasks') this._deleteTaskLocal(payload.id);
      else if (tableName === 'instances') this._deleteInstanceLocal(payload.id);
      else if (tableName === 'notes') this._deleteNoteLocal(payload.id);
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
    if (!local) { this._writeTaskLocal(remote); return; }
    if (new Date(remote.createdAt || 0) >= new Date(local.createdAt || 0)) {
      this._writeTaskLocal(remote);
    }
  },

  _mergeInstance(remote) {
    const local = this.readInstances().find(i => i.id === remote.id);
    if (!local) { this._writeInstanceLocal(remote); return; }

    if (remote.status === 'done') { this._writeInstanceLocal(remote); return; }
    if (local.status === 'done') return;

    if (remote.seqNumber !== undefined && local.seqNumber !== undefined) {
      if (remote.seqNumber > local.seqNumber) { this._writeInstanceLocal(remote); return; }
      if (local.seqNumber > remote.seqNumber) return;
      if (remote.linkNumber === 0 && local.linkNumber > 0) return;
      if (local.linkNumber === 0 && remote.linkNumber > 0) { this._writeInstanceLocal(remote); return; }
    }

    const lt = new Date(local.updatedAt || 0);
    const rt = new Date(remote.updatedAt || 0);
    if (rt > lt) { this._writeInstanceLocal(remote); return; }
    if (rt === lt) {
      if (this._fieldCount(remote) > this._fieldCount(local)) this._writeInstanceLocal(remote);
    }
  },

  _mergeEvent(remote) {
    const events = this.readEvents();
    const exists = events.some(e => e.ts === remote.ts && e.taskId === remote.taskId && e.action === remote.action);
    if (!exists) this._writeEventLocal(remote);
  },

  _mergeNote(remote) {
    const local = this.readNotes().find(n => n.id === remote.id);
    if (!local) { this._writeNoteLocal(remote); return; }
    if (new Date(remote.editedAt || remote.createdAt || 0) >= new Date(local.editedAt || local.createdAt || 0)) {
      this._writeNoteLocal(remote);
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
    this._writeStockLocal(taskId, { qty, events: allEvents });
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

function getLatestDoneSeq(instances, taskId) {
  const done = instances
    .filter(i => i.taskId === taskId && i.status === 'done')
    .sort((a, b) => (b.seqNumber || 0) - (a.seqNumber || 0));
  return done.length ? (done[0].seqNumber || 0) : 0;
}

function nextSeqNumber(instances, taskId) {
  return getLatestDoneSeq(instances, taskId) + 1;
}

// --- Auto-retry on reconnect ---
window.addEventListener('online', () => Store.retryUnsynced());
setInterval(() => Store.retryUnsynced(), 60000);   
