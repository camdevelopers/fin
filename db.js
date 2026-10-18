//import initSqlJs from 'https://sql.js.org/dist/sql-wasm.js';

const IDB_NAME = 'office-pwa';
const IDB_STORE = 'state';
const DB_KEY = 'sqlite_blob';
const INDEX_KEY = 'user_index';
const SHA_KEY = 'last_sha';
const PENDING_KEY = 'pending';

let db = null;
let SQL = null;

// --- IndexedDB helpers ---
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const idb = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const idb = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- DB init ---
export async function initDB() {
  SQL = await initSqlJs({
  locateFile: () => 'https://sql.js.org/dist/sql-wasm.wasm'
});

  const savedBlob = await idbGet(DB_KEY);
  if (savedBlob) {
    db = new SQL.Database(new Uint8Array(savedBlob));
  } else {
    // First run — create schema
    db = new SQL.Database();
    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        recurrence TEXT,
        assigned_user TEXT,
        exempt_days TEXT,
        grace_min INTEGER DEFAULT 0,
        show_all_instances INTEGER DEFAULT 1,
        track_time INTEGER DEFAULT 0,
        retired INTEGER DEFAULT 0,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS instances (
        instance_id TEXT PRIMARY KEY,
        task_id TEXT,
        due_date TEXT,
        status TEXT DEFAULT 'pending',
        done_by TEXT,
        done_at TEXT,
        note TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        ts TEXT,
        instance_id TEXT,
        task_id TEXT,
        action TEXT,
        user TEXT,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS attendance (
        date TEXT,
        user TEXT,
        checkin TEXT,
        checkout TEXT,
        PRIMARY KEY(date, user)
      );
      CREATE TABLE IF NOT EXISTS leave (
        user TEXT,
        start_date TEXT,
        end_date TEXT,
        type TEXT,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS notes (
        note_id TEXT PRIMARY KEY,
        author TEXT,
        ts TEXT,
        content TEXT
      );
      CREATE TABLE IF NOT EXISTS stock (
        task_id TEXT,
        event TEXT,
        qty INTEGER,
        ts TEXT,
        user TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    await saveDB();
  }
}

export function getDB() {
  return db;
}

export async function saveDB() {
  const data = db.export();
  await idbSet(DB_KEY, data.buffer);
}

// --- Index tracking ---
export async function getUserIndex() {
  return (await idbGet(INDEX_KEY)) || {};
}

export async function setUserIndex(map) {
  await idbSet(INDEX_KEY, map);
}

export async function getLastSHA() {
  return (await idbGet(SHA_KEY)) || null;
}

export async function setLastSHA(sha) {
  await idbSet(SHA_KEY, sha);
}

// --- Pending changes ---
export async function getPending() {
  return (await idbGet(PENDING_KEY)) || [];
}

export async function setPending(items) {
  await idbSet(PENDING_KEY, items);
}

// --- Apply a CSV event row into DB ---
export function applyEventRow(fields) {
  const [ts, instance_id, task_id, action, user, note] = fields;

  db.run(
    `INSERT INTO events (ts, instance_id, task_id, action, user, note) VALUES (?,?,?,?,?,?)`,
    [ts, instance_id, task_id, action, user, note || null]
  );

  // done → update instance
  if (action === 'done') {
    db.run(
      `INSERT INTO instances (instance_id, task_id, due_date, status, done_by, done_at, note)
       VALUES (?,?,?, 'done', ?, ?, ?)
       ON CONFLICT(instance_id) DO UPDATE SET status='done', done_by=excluded.done_by, done_at=excluded.done_at, note=excluded.note`,
      [instance_id, task_id, ts.slice(0, 10), user, ts, note || null]
    );
  }

  // note → insert into notes table
  if (action === 'note') {
    db.run(
      `INSERT OR IGNORE INTO notes (note_id, author, ts, content) VALUES (?,?,?,?)`,
      [instance_id, user, ts, note || '']
    );
  }

  // checkin → insert into attendance
  if (action === 'checkin') {
    db.run(
      `INSERT OR IGNORE INTO attendance (date, user, checkin, checkout) VALUES (?,?,?,NULL)`,
      [ts.slice(0, 10), user, ts.slice(11, 19)]
    );
  }

  // checkout → update attendance
  if (action === 'checkout') {
    db.run(
      `UPDATE attendance SET checkout = ? WHERE date = ? AND user = ?`,
      [ts.slice(11, 19), ts.slice(0, 10), user]
    );
  }

  // unavailable → insert into leave
  if (action === 'unavailable') {
    // note format: "type:leave 2026-10-20→2026-10-24 reason"
    const parts = (note || '').split(' ');
    const type = (parts[0] || 'leave').replace('type:', '');
    const dates = (parts[1] || '').split('→');
    const start = dates[0] || ts.slice(0, 10);
    const end = dates[1] && dates[1] !== 'open' ? dates[1] : null;
    const reason = parts.slice(2).join(' ') || null;

    db.run(
      `INSERT OR IGNORE INTO leave (user, start_date, end_date, type, reason) VALUES (?,?,?,?,?)`,
      [user, start, end, type, reason]
    );
  }

  // available → remove from leave
  if (action === 'available') {
    db.run(
      `DELETE FROM leave WHERE user = ? AND start_date = ?`,
      [user, ts.slice(0, 10)]
    );
  }
}   
