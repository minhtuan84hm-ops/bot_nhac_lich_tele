const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'events.json');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function read() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { events: [], nextId: 1 };
  }
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function addEvent(data) {
  const db = read();
  const event = { id: db.nextId++, ...data };
  db.events.push(event);
  write(db);
  return event;
}

function getAllEvents() {
  return read().events;
}

function getUpcomingEvents(chatId) {
  const now = new Date();
  return read().events.filter(e =>
    e.chat_id === chatId &&
    (e.repeat !== 'none' || new Date(e.datetime) >= now)
  ).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

function getTodayEvents(chatId) {
  const now = new Date();
  const todayVN = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  return read().events.filter(e => {
    if (e.chat_id !== chatId) return false;
    const dt = new Date(new Date(e.datetime).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    return dt.getFullYear() === todayVN.getFullYear() &&
           dt.getMonth() === todayVN.getMonth() &&
           dt.getDate() === todayVN.getDate();
  }).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

function deleteEvent(id) {
  const db = read();
  db.events = db.events.filter(e => e.id !== id);
  write(db);
}

function deleteEventByChat(id, chatId) {
  const db = read();
  const before = db.events.length;
  db.events = db.events.filter(e => !(e.id === id && e.chat_id === chatId));
  write(db);
  return db.events.length < before;
}

module.exports = { addEvent, getAllEvents, getUpcomingEvents, getTodayEvents, deleteEvent, deleteEventByChat };
