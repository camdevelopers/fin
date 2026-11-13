// ============================================================
// common.js — Shared DAL, Sync Manager, Merge Manager, SQLite
// ============================================================

// --- SQLite initialization ---
let _SQL = null;
let _db = null;

async function initSQLite() {
  if (_db) return _db;
  _SQL = await initSqlJs({
    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${file}`
  });
  // Try to load existing DB from IndexedDB
  const saved = await idbGetBlob('sqlite-db');
  if (saved) {
    _db = new _SQL.Database(new Uint8Array(saved));
  } else {
    _db = new _SQL.Database();
  }
  _createSchema();
  return _db;
}

function _createSchema() {
  _db.run(`
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock (taskId TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS changes (
      changeId TEXT PRIMARY KEY,
      tableName TEXT NOT NULL,
      opType TEXT NOT NULL,
      payloadJSON TEXT NOT NULL,
      synced INTEGER DEFAULT 0,
      pulled INTEGER DEFAULT 0,
      applied INTEGER DEFAULT 0,
      ts TEXT NOT NULL
    );
  `);
  _persist();
}

function _persist() {
  const data = _db.export();
  idbSetBlob('sqlite-db', data.buffer);
}

// --- IndexedDB blob storage (for SQLite file persistence) ---
function idbGetBlob(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('office-app', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readonly');
      const r = tx.objectStore('blobs').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbSetBlob(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('office-app', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// --- Meta helpers ---
function metaGet(key) {
  const res = _db.exec(`SELECT value FROM meta WHERE key='${key}'`);
  return (res.length && res[0].values.length) ? res[0].values[0][0] : null;
}

function metaSet(key, value) {
  _db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, String(value)]);
  _persist();
}

// --- Device ID ---
function getDeviceId() {
  return window.innerWidth < 768 ? 2 : 1;
}

function getNextSeq() {
  const key = `nextSeq_${getDeviceId()}`;
  const val = parseInt(metaGet(key) || '0', 10);
  return val;
}

function incrementSeq() {
  const key = `nextSeq_${getDeviceId()}`;
  const next = getNextSeq() + 1;
  metaSet(key, next);
  return next;
}

// ============================================================
// DATA ACCESS LAYER
// Every read/write goes through here. To add logging, sync
// side-effects, etc., modify these functions.
// ============================================================
const DAL = {
  // --- Generic helpers ---
  _query(sql, params = []) {
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  _run(sql, params = []) {
    _db.run(sql, params);
    _persist();
  },

  // --- Tasks ---
  async getTasks() {
    const rows = this._query('SELECT data FROM tasks');
    return rows.map(r => JSON.parse(r.data));
  },
  async saveTask(task) {
    this._run('INSERT OR REPLACE INTO tasks (id, data) VALUES (?, ?)', [task.id, JSON.stringify(task)]);
    this._logChange('tasks', 'upsert', task);
  },
  async deleteTask(id) {
    this._run('DELETE FROM tasks WHERE id=?', [id]);
    this._logChange('tasks', 'delete', { id });
  },

  // --- Instances ---
  async getInstances() {
    const rows = this._query('SELECT data FROM instances');
    return rows.map(r => JSON.parse(r.data));
  },
  async getInstance(id) {
    const rows = this._query('SELECT data FROM instances WHERE id=?', [id]);
    return rows.length ? JSON.parse(rows[0].data) : null;
  },
  async saveInstance(inst) {
    this._run('INSERT OR REPLACE INTO instances (id, taskId, data) VALUES (?, ?, ?)', [inst.id, inst.taskId, JSON.stringify(inst)]);
    this._logChange('instances', 'upsert', inst);
  },
  async deleteInstance(id) {
    this._run('DELETE FROM instances WHERE id=?', [id]);
    this._logChange('instances', 'delete', { id });
  },

  // --- Events ---
  async getEvents() {
    const rows = this._query('SELECT data FROM events ORDER BY id ASC');
    return rows.map(r => JSON.parse(r.data));
  },
  async addEvent(ev) {
    this._run('INSERT INTO events (data) VALUES (?)', [JSON.stringify(ev)]);
    this._logChange('events', 'insert', ev);
  },

  // --- Notes ---
  async getNotes() {
    const rows = this._query('SELECT data FROM notes');
    return rows.map(r => JSON.parse(r.data));
  },
  async saveNote(note) {
    this._run('INSERT OR REPLACE INTO notes (id, data) VALUES (?, ?)', [note.id, JSON.stringify(note)]);
    this._logChange('notes', 'upsert', note);
  },
  async deleteNote(id) {
    this._run('DELETE FROM notes WHERE id=?', [id]);
    this._logChange('notes', 'delete', { id });
  },

  // --- Stock ---
  async getStock(taskId) {
    const rows = this._query('SELECT data FROM stock WHERE taskId=?', [taskId]);
    return rows.length ? JSON.parse(rows[0].data) : { qty: 0, events: [] };
  },
  async saveStock(taskId, stock) {
    this._run('INSERT OR REPLACE INTO stock (taskId, data) VALUES (?, ?)', [taskId, JSON.stringify(stock)]);
    this._logChange('stock', 'upsert', { taskId, ...stock });
  },

  // --- Leave state ---
  async isLeaveActive() { return metaGet('leave_active') === 'true'; },
  async setLeaveActive(v) { metaSet('leave_active', v); },

  // --- Change logging (feeds Sync Manager) ---
  _logChange(tableName, opType, payload) {
    const deviceId = getDeviceId();
    const seq = incrementSeq();
    const changeId = `${deviceId}${String(seq).padStart(4, '0')}`;
    this._run(
      'INSERT OR REPLACE INTO changes (changeId, tableName, opType, payloadJSON, synced, pulled, applied, ts) VALUES (?, ?, ?, ?, 0, 0, 1, ?)',
      [changeId, tableName, opType, JSON.stringify(payload), new Date().toISOString()]
    );
    // Notify Sync Manager
    if (window.SyncManager) SyncManager.onLocalChange(changeId);
  },
};

// ============================================================
// INSTANCE ID GENERATOR
// ============================================================
function genInstanceId(task, context = {}) {
  switch (task.type) {
    case 'sequence': {
      const n = task.seqCounter || 0;
      return `${task.id}-s${n}`;
    }
    case 'calendar': {
      const d = context.dueAt ? new Date(context.dueAt) : new Date();
      return `${task.id}-c${d.toISOString().slice(0, 10)}`;
    }
    case 'quantity': {
      const n = task.qtyCounter || 0;
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
// SYNC MANAGER
// Push: auto (debounced) on local changes.
// Pull: manual, user-initiated.
// ============================================================
const SyncManager = {
  _queue: [],
  _timer: null,
  _DEBOUNCE_MS: 2500,

  // Called by DAL on every local change
  onLocalChange(changeId) {
    this._queue.push(changeId);
    this._schedulePush();
  },

  _schedulePush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), this._DEBOUNCE_MS);
  },

  async _flush() {
    if (this._queue.length === 0) return;
    const settings = getSettings();
    if (!settings.pat || !settings.repo || !settings.owner) {
      console.warn('[Sync] No GitHub settings configured. Changes queued locally.');
      return;
    }

    const toPush = this._queue.splice(0);
    for (const changeId of toPush) {
      try {
        await this._pushOne(changeId, settings);
      } catch (err) {
        console.error(`[Sync] Push failed for ${changeId}:`, err.message);
        // Leave synced=0; will retry on next flush
        this._queue.push(changeId);
      }
    }
  },

  async _pushOne(changeId, settings) {
    const rows = DAL._query('SELECT * FROM changes WHERE changeId=?', [changeId]);
    if (!rows.length) return;
    const row = rows[0];

    // Build CSV content: header + one data row
    const csv = `tableName,opType,payload\n${row.tableName},${row.opType},"${row.payloadJSON.replace(/"/g, '""')}"`;
    const filePath = `sync/${changeId}.csv`;
    const base64 = btoa(unescape(encodeURIComponent(csv)));

    const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${encodeURIComponent(filePath)}`;
    const body = {
      message: `sync ${changeId}`,
      content: base64,
      branch: settings.branch || 'main'
    };

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${settings.pat}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    // Mark as synced
    DAL._run('UPDATE changes SET synced=1 WHERE changeId=?', [changeId]);
    console.log(`[Sync] Pushed ${changeId}`);
  },

  // Retry all unsynced changes (call on 'online' event or manually)
  async retryUnsynced() {
    const settings = getSettings();
    if (!settings.pat || !settings.repo || !settings.owner) return;
    const rows = DAL._query('SELECT changeId FROM changes WHERE synced=0 AND applied=1');
    for (const row of rows) {
      this._queue.push(row.changeId);
    }
    this._schedulePush();
  },

  // --- Manual Pull ---
  async pull(settings) {
    if (!settings.pat || !settings.repo || !settings.owner) throw new Error('No GitHub settings');

    const lastSyncedAt = metaGet('lastSyncedAt') || new Date(0).toISOString();
    const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/commits?path=sync&since=${encodeURIComponent(lastSyncedAt)}&per_page=50`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${settings.pat}`,
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!res.ok) throw new Error(`Commits API: HTTP ${res.status}`);

    const commits = await res.json();
    const deviceId = String(getDeviceId());
    let pulledCount = 0;

    for (const commit of commits) {
      const files = commit.files || [];
      for (const file of files) {
        const fname = file.filename.replace('sync/', '');
        // Only process files from OTHER devices
        if (fname.startsWith(deviceId)) continue;
        if (!fname.endsWith('.csv')) continue;

        // Fetch file content
        const fileUrl = `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/sync/${fname}?ref=${commit.sha}`;
        const fRes = await fetch(fileUrl, {
          headers: {
            'Authorization': `Bearer ${settings.pat}`,
            'Accept': 'application/vnd.github+json'
          }
        });
        if (!fRes.ok) continue;
        const fData = await fRes.json();
        const content = atob(fData.content);
        const changeId = fname.replace('.csv', '');

        // Check if we already have this change
        const existing = DAL._query('SELECT changeId FROM changes WHERE changeId=?', [changeId]);
        if (existing.length) continue;

        // Parse CSV: skip header, take first data row
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;
        const dataLine = lines[1];
        // Parse: tableName,opType,"payload"
        const commaIdx1 = dataLine.indexOf(',');
        const commaIdx2 = dataLine.indexOf(',', commaIdx1 + 1);
        const tableName = dataLine.slice(0, commaIdx1);
        const opType = dataLine.slice(commaIdx1 + 1, commaIdx2);
        let payload = dataLine.slice(commaIdx2 + 1);
        // Remove surrounding quotes and unescape
        if (payload.startsWith('"') && payload.endsWith('"')) {
          payload = payload.slice(1, -1).replace(/""/g, '"');
        }

        // Log in changes table
        DAL._run(
          'INSERT OR REPLACE INTO changes (changeId, tableName, opType, payloadJSON, synced, pulled, applied, ts) VALUES (?, ?, ?, ?, 1, 1, 0, ?)',
          [changeId, tableName, opType, payload, new Date().toISOString()]
        );
        pulledCount++;
      }
    }

    // Update lastSyncedAt
    metaSet('lastSyncedAt', new Date().toISOString());

    // Trigger Merge Manager
    if (pulledCount > 0) {
      await MergeManager.process();
    }

    return pulledCount;
  },
};

// ============================================================
// MERGE MANAGER
// Processes pulled changes (pulled=1, applied=0) and applies
// them to local SQLite using conflict resolution rules.
// ============================================================
const MergeManager = {
  async process() {
    const rows = DAL._query('SELECT * FROM changes WHERE pulled=1 AND applied=0 ORDER BY ts ASC');
    for (const row of rows) {
      try {
        this._applyOne(row);
        DAL._run('UPDATE changes SET applied=1 WHERE changeId=?', [row.changeId]);
      } catch (err) {
        console.error(`[Merge] Failed to apply ${row.changeId}:`, err.message);
      }
    }
  },

  _applyOne(row) {
    const payload = JSON.parse(row.payloadJSON);
    const { tableName, opType } = row;

    if (opType === 'delete') {
      this._applyDelete(tableName, payload);
      return;
    }

    // upsert / insert — apply merge rules
    switch (tableName) {
      case 'tasks': this._mergeTask(payload); break;
      case 'instances': this._mergeInstance(payload); break;
      case 'events': this._mergeEvent(payload); break;
      case 'notes': this._mergeNote(payload); break;
      case 'stock': this._mergeStock(payload); break;
      default: console.warn(`[Merge] Unknown table: ${tableName}`);
    }
  },

  _applyDelete(tableName, payload) {
    switch (tableName) {
      case 'tasks': DAL.deleteTask(payload.id); break;
      case 'instances': DAL.deleteInstance(payload.id); break;
      case 'notes': DAL.deleteNote(payload.id); break;
      case 'stock': DAL._run('DELETE FROM stock WHERE taskId=?', [payload.taskId]); break;
    }
  },

  _mergeTask(remote) {
    const localRows = DAL._query('SELECT data FROM tasks WHERE id=?', [remote.id]);
    if (localRows.length === 0) {
      DAL.saveTask(remote);
      return;
    }
    const local = JSON.parse(localRows[0].data);
    // LWW by createdAt (tasks don't change status, just config)
    if (new Date(remote.createdAt || 0) >= new Date(local.createdAt || 0)) {
      DAL.saveTask(remote);
    }
  },

  _mergeInstance(remote) {
    const localRows = DAL._query('SELECT data FROM instances WHERE id=?', [remote.id]);
    if (localRows.length === 0) {
      DAL.saveInstance(remote);
      return;
    }
    const local = JSON.parse(localRows[0].data);

    // Rule 1: done is terminal — if either is done, done wins
    if (remote.status === 'done' || local.status === 'done') {
      const winner = remote.status === 'done' ? remote : local;
      // Keep the done version
      if (winner !== remote) return; // local already done, no change
      DAL.saveInstance(remote);
      return;
    }

    // Rule 2: LWW by updatedAt
    const localTs = new Date(local.updatedAt || 0);
    const remoteTs = new Date(remote.updatedAt || 0);
    if (remoteTs > localTs) {
      DAL.saveInstance(remote);
    } else if (remoteTs === localTs) {
      // Rule 3: more fields populated wins
      if (this._fieldCount(remote) > this._fieldCount(local)) {
        DAL.saveInstance(remote);
      }
    }
  },

  _mergeEvent(remote) {
    // Events are append-only; just insert if not present (check by ts+taskId+action)
    const existing = DAL._query('SELECT data FROM events');
    const exists = existing.some(r => {
      const e = JSON.parse(r.data);
      return e.ts === remote.ts && e.taskId === remote.taskId && e.action === remote.action;
    });
    if (!exists) DAL.addEvent(remote);
  },

  _mergeNote(remote) {
    const localRows = DAL._query('SELECT data FROM notes WHERE id=?', [remote.id]);
    if (localRows.length === 0) {
      DAL.saveNote(remote);
      return;
    }
    const local = JSON.parse(localRows[0].data);
    if (new Date(remote.editedAt || remote.createdAt || 0) >= new Date(local.editedAt || local.createdAt || 0)) {
      DAL.saveNote(remote);
    }
  },

  _mergeStock(remote) {
    const taskId = remote.taskId;
    const localRows = DAL._query('SELECT data FROM stock WHERE taskId=?', [taskId]);
    if (localRows.length === 0) {
      DAL.saveStock(taskId, { qty: remote.qty, events: remote.events || [] });
      return;
    }
    const local = JSON.parse(localRows[0].data);
    // Merge events (union by ts+action+qty)
    const allEvents = [...(local.events || [])];
    for (const ev of (remote.events || [])) {
      if (!allEvents.some(e => e.ts === ev.ts && e.action === ev.action && e.qty === ev.qty)) {
        allEvents.push(ev);
      }
    }
    allEvents.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    // Recalculate qty from events
    let qty = 0;
    for (const ev of allEvents) {
      qty += ev.action === 'restock' ? ev.qty : -ev.qty;
    }
    DAL.saveStock(taskId, { qty, events: allEvents });
  },

  _fieldCount(obj) {
    return Object.values(obj).filter(v => v !== null && v !== undefined && v !== '').length;
  },
};

// ============================================================
// SETTINGS (localStorage)
// ============================================================
function getSettings() {
  try {
    return JSON.parse(localStorage.getItem('office-settings') || '{}');
  } catch { return {}; }
}

function saveSettings(s) {
  localStorage.setItem('office-settings', JSON.stringify(s));
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

// ============================================================
// BOOT — call from each page
// ============================================================
async function bootApp() {
  await initSQLite();
  // Retry unsynced on online
  if (navigator.onLine) {
    setTimeout(() => SyncManager.retryUnsynced(), 3000);
  }
  window.addEventListener('online', () => SyncManager.retryUnsynced());
}   
