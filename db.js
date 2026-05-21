const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'events.db');

// ensure data dir exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    created_by TEXT,
    title      TEXT    NOT NULL,
    datetime   TEXT,
    repeat     TEXT    DEFAULT 'none',
    mention    TEXT,
    note       TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
  );
`);

// ─── Queries ──────────────────────────────────────────────────────────────────
const stmtAdd = db.prepare(`
  INSERT INTO events (chat_id, user_id, created_by, title, datetime, repeat, mention, note)
  VALUES (@chat_id, @user_id, @created_by, @title, @datetime, @repeat, @mention, @note)
`);

const stmtGetAll = db.prepare(`SELECT * FROM events ORDER BY datetime ASC`);

const stmtGetChat = db.prepare(`
  SELECT * FROM events
  WHERE chat_id = ?
    AND (repeat != 'none' OR datetime(datetime) >= datetime('now'))
  ORDER BY datetime ASC
`);

const stmtGetToday = db.prepare(`
  SELECT * FROM events
  WHERE chat_id = ?
    AND date(datetime, '+7 hours') = date('now', '+7 hours')
  ORDER BY datetime ASC
`);

const stmtDelete = db.prepare(`DELETE FROM events WHERE id = ?`);
const stmtDeleteChat = db.prepare(`DELETE FROM events WHERE id = ? AND chat_id = ?`);

// ─── Exports ──────────────────────────────────────────────────────────────────
function addEvent(data) {
  const info = stmtAdd.run(data);
  return { id: info.lastInsertRowid, ...data };
}

function getAllEvents() {
  return stmtGetAll.all();
}

function getUpcomingEvents(chatId) {
  return stmtGetChat.all(chatId);
}

function getTodayEvents(chatId) {
  return stmtGetToday.all(chatId);
}

function deleteEvent(id) {
  stmtDelete.run(id);
}

function deleteEventByChat(id, chatId) {
  return stmtDeleteChat.run(id, chatId).changes > 0;
}

module.exports = { addEvent, getAllEvents, getUpcomingEvents, getTodayEvents, deleteEvent, deleteEventByChat };
