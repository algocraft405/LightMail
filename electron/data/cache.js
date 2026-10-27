'use strict';

const fs = require('fs');
const path = require('path');

let SQL = null;
let db = null;
let saveTimer = null;
let dirty = false;

function userFile(name) {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), name);
}

async function open() {
  const initSqlJs = require('sql.js/dist/sql-wasm-inline.js');
  SQL = await initSqlJs();
  const file = userFile('mail.db');
  if (fs.existsSync(file)) db = new SQL.Database(fs.readFileSync(file));
  else db = new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS records (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  migrateJson();
}

function migrateJson() {
  const file = userFile('cache.json');
  if (!fs.existsSync(file)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = Date.now();
    const insert = db.prepare('INSERT OR IGNORE INTO records (key, value, updated_at) VALUES (?, ?, ?)');
    for (const [key, entry] of Object.entries(parsed || {})) {
      if (!entry || entry.value == null || (entry.exp && entry.exp <= now)) continue;
      insert.run([key, JSON.stringify(entry.value), now]);
      dirty = true;
    }
    insert.free();
    fs.renameSync(file, `${file}.migrated`);
    if (dirty) flush();
  } catch {
    // A bad cache file is left in place. The database still starts empty of those rows.
  }
}

function ensure() {
  if (!db) throw new Error('The mail database is not open.');
}

function likePrefix(prefix) {
  return `${String(prefix || '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function get(key) {
  ensure();
  const stmt = db.prepare('SELECT value FROM records WHERE key = ?');
  stmt.bind([key]);
  let value;
  if (stmt.step()) {
    try {
      value = JSON.parse(stmt.getAsObject().value);
    } catch {
      value = undefined;
    }
  }
  stmt.free();
  return value;
}

function set(key, value) {
  ensure();
  db.run(
    'INSERT OR REPLACE INTO records (key, value, updated_at) VALUES (?, ?, ?)',
    [key, JSON.stringify(value), Date.now()]
  );
  scheduleSave();
  return value;
}

function collect(prefix) {
  ensure();
  const stmt = db.prepare("SELECT key, value FROM records WHERE key LIKE ? ESCAPE '\\'");
  stmt.bind([likePrefix(prefix)]);
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    try {
      rows.push({ key: row.key, value: JSON.parse(row.value) });
    } catch {
      // Skip a row that is not JSON.
    }
  }
  stmt.free();
  return rows;
}

function drop(prefix) {
  ensure();
  db.run("DELETE FROM records WHERE key LIKE ? ESCAPE '\\'", [likePrefix(prefix)]);
  scheduleSave();
}

function edit(prefix, fn) {
  ensure();
  const stmt = db.prepare("SELECT key, value FROM records WHERE key LIKE ? ESCAPE '\\'");
  stmt.bind([likePrefix(prefix)]);
  const updates = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    updates.push([JSON.stringify(fn(JSON.parse(row.value), row.key)), Date.now(), row.key]);
  }
  stmt.free();
  if (!updates.length) return;
  const update = db.prepare('UPDATE records SET value = ?, updated_at = ? WHERE key = ?');
  for (const row of updates) update.run(row);
  update.free();
  scheduleSave();
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      flush();
    } catch {
      // The next change tries again. A crash before that can lose the latest write.
    }
  }, 250);
}

function countRows(sql) {
  const result = db.exec(sql);
  if (!result.length || !result[0].values.length) return 0;
  return Number(result[0].values[0][0] || 0);
}

function stats() {
  ensure();
  if (dirty) flush();
  const file = userFile('mail.db');
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    bytes = 0;
  }
  return {
    path: file,
    bytes,
    records: countRows('SELECT COUNT(*) FROM records'),
    mail: countRows("SELECT COUNT(*) FROM records WHERE key LIKE 'mail:%'"),
    calendar: countRows("SELECT COUNT(*) FROM records WHERE key LIKE 'cal:%'"),
  };
}

function clear(scope) {
  ensure();
  if (scope === 'mail') drop('mail:');
  else if (scope === 'calendar') drop('cal:');
  else if (scope === 'all') {
    db.run('DELETE FROM records');
    scheduleSave();
  } else {
    throw new Error('Choose mail, calendar, or all cached data.');
  }
  return stats();
}

function snapshotPath() {
  ensure();
  const file = userFile('mail.db');
  if (dirty || !fs.existsSync(file)) {
    dirty = true;
    flush();
  }
  return file;
}

function replace(bytes) {
  if (!SQL) throw new Error('The mail database is not open.');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = Buffer.from(data.subarray(0, 15)).toString('utf8');
  if (header !== 'SQLite format 3') throw new Error('That file is not a Light Mail database.');
  let next = null;
  try {
    next = new SQL.Database(data);
    const tables = next.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'");
    if (!tables.length) throw new Error('missing records');
  } catch (error) {
    if (next) next.close();
    if (error && error.message === 'That file is not a Light Mail database.') throw error;
    throw new Error('That file is not a Light Mail database.');
  }
  if (db) db.close();
  db = next;
  dirty = true;
  flush();
  return stats();
}

function flush() {
  if (!db || !dirty) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const file = userFile('mail.db');
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
  dirty = false;
}

module.exports = { open, flush, get, set, drop, edit, collect, stats, clear, snapshotPath, replace };
