'use strict';
// SQLite access via Node's built-in node:sqlite (no native build step).
// Usage:
//   const { getDb, tx } = require('../lib/db');
//   const db = getDb();
//   db.prepare('SELECT * FROM plants WHERE plant_code = ?').get(code);
//   tx(() => { ...several statements... });      // atomic
// Rows are null-prototype objects; JSON columns are plain text — use parseJson().
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let db = null;
let txDepth = 0;

function open(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new DatabaseSync(dbPath);
  conn.exec('PRAGMA journal_mode = WAL;');
  conn.exec('PRAGMA foreign_keys = ON;');
  conn.exec('PRAGMA busy_timeout = 5000;');
  conn.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  migrate(conn);
  return conn;
}

// Columns added after the first release. schema.sql creates them for new databases;
// this adds them to databases created before (CREATE TABLE IF NOT EXISTS won't).
const ADDED_COLUMNS = [
  ['areas', 'kind', "TEXT NOT NULL DEFAULT 'area' CHECK (kind IN ('area', 'town', 'landmark'))"],
  ['reports', 'proximity_basis', "TEXT CHECK (proximity_basis IN ('plant', 'area_centre'))"],
];

function migrate(conn) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const exists = conn.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function getDb() {
  if (!db) db = open();
  return db;
}

/** Replace the shared connection (tests use a temp file). */
function setDb(conn) {
  db = conn;
  txDepth = 0;
}

function closeDb() {
  if (db) db.close();
  db = null;
  txDepth = 0;
}

/** Run fn inside a transaction (nested calls use savepoints). Returns fn's result. */
function tx(fn) {
  const conn = getDb();
  const sp = `sp_${txDepth}`;
  if (txDepth === 0) conn.exec('BEGIN IMMEDIATE');
  else conn.exec(`SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const result = fn(conn);
    txDepth--;
    if (txDepth === 0) conn.exec('COMMIT');
    else conn.exec(`RELEASE ${sp}`);
    return result;
  } catch (err) {
    txDepth--;
    if (txDepth === 0) conn.exec('ROLLBACK');
    else conn.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Convert a null-prototype row to a plain object (handy before res.json / spreading). */
const plain = (row) => (row ? { ...row } : row);

module.exports = { open, getDb, setDb, closeDb, tx, parseJson, plain };
