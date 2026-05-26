const { Client } = require('pg');

let client;

async function getClient() {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL chưa được set!');
  console.log('Connecting to DB:', url.substring(0, 40) + '...');
  
  try {
    // Parse URL thủ công để tránh lỗi ký tự đặc biệt trong password
    const parsed = new URL(url);
    client = new Client({
      host: parsed.hostname,
      port: parseInt(parsed.port) || 5432,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace('/', ''),
      ssl: { rejectUnauthorized: false },
    });
  } catch(e) {
    // Fallback: dùng connectionString trực tiếp
    client = new Client({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
    });
  }

  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS events (
      id           SERIAL PRIMARY KEY,
      chat_id      BIGINT NOT NULL,
      user_id      BIGINT NOT NULL,
      created_by   TEXT,
      title        TEXT NOT NULL,
      datetime     TEXT,
      repeat       TEXT DEFAULT 'none',
      mention      TEXT,
      note         TEXT,
      remind_before TEXT DEFAULT '[]',
      target_chat_id BIGINT,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id    BIGINT PRIMARY KEY,
      name       TEXT,
      registered_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Add target_chat_id column if not exists
  await client.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS target_chat_id BIGINT`).catch(() => {});
  console.log('✅ Kết nối database thành công!');
  return client;
}

// ─── Templates ───────────────────────────────────────────────────────────────
async function saveTemplate(userId, name, data) {
  const db = await getClient();
  await db.query(`CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, name)
  )`);
  await db.query(
    `INSERT INTO templates (user_id, name, data) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET data=$3`,
    [userId, name.toLowerCase(), JSON.stringify(data)]
  );
}

async function getTemplate(userId, name) {
  const db = await getClient();
  await db.query(`CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, name)
  )`);
  const res = await db.query(
    'SELECT * FROM templates WHERE user_id=$1 AND name=$2',
    [userId, name.toLowerCase()]
  );
  return res.rows[0] || null;
}

async function listTemplates(userId) {
  const db = await getClient();
  await db.query(`CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, name)
  )`);
  const res = await db.query('SELECT * FROM templates WHERE user_id=$1 ORDER BY name ASC', [userId]);
  return res.rows;
}

async function deleteTemplate(userId, name) {
  const db = await getClient();
  const res = await db.query('DELETE FROM templates WHERE user_id=$1 AND name=$2', [userId, name.toLowerCase()]);
  return res.rowCount > 0;
}

async function registerGroup(chatId, name) {
  const db = await getClient();
  await db.query(
    `INSERT INTO groups (chat_id, name) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET name=$2`,
    [chatId, name]
  );
}

async function getGroups() {
  const db = await getClient();
  const res = await db.query('SELECT * FROM groups ORDER BY name ASC');
  return res.rows;
}

async function findGroupByName(name) {
  const db = await getClient();
  const res = await db.query(
    `SELECT * FROM groups WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
    [`%${name}%`]
  );
  return res.rows[0] || null;
}

async function addEvent(data) {
  const db = await getClient();
  const res = await db.query(
    `INSERT INTO events (chat_id, user_id, created_by, title, datetime, repeat, mention, note, remind_before, target_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [data.chat_id, data.user_id, data.created_by, data.title, data.datetime,
     data.repeat||'none', data.mention||null, data.note||null, data.remind_before||'[]', data.target_chat_id||null]
  );
  return res.rows[0];
}

async function getAllEvents() {
  const db = await getClient();
  const res = await db.query('SELECT * FROM events ORDER BY datetime ASC');
  return res.rows;
}

async function getUpcomingEvents(chatId) {
  const db = await getClient();
  const res = await db.query(
    `SELECT * FROM events WHERE chat_id=$1 AND (repeat!='none' OR datetime::timestamp > NOW()) ORDER BY datetime ASC`,
    [chatId]
  );
  return res.rows;
}

async function getTodayEvents(chatId) {
  const db = await getClient();
  const res = await db.query(
    `SELECT * FROM events WHERE chat_id=$1
     AND (datetime::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
     ORDER BY datetime ASC`,
    [chatId]
  );
  return res.rows;
}

async function getAllEventsForChat(chatId, userId) {
  const db = await getClient();
  // Lấy TẤT CẢ lịch trong database (dùng chung)
  const res = await db.query('SELECT * FROM events ORDER BY datetime ASC');
  return res.rows;
}

async function getAllEventsForGroup(groupChatId) {
  const db = await getClient();
  // Lấy tất cả lịch được tạo trong group này
  const res = await db.query(
    'SELECT * FROM events WHERE chat_id=$1 ORDER BY datetime ASC',
    [groupChatId]
  );
  return res.rows;
}

async function deleteEvent(id) {
  const db = await getClient();
  await db.query('DELETE FROM events WHERE id=$1', [id]);
}

async function deleteEventByChat(id, chatId) {
  const db = await getClient();
  // Xóa theo id thôi, không check chat_id để cho phép xóa từ mọi nơi
  const res = await db.query('DELETE FROM events WHERE id=$1', [id]);
  return res.rowCount > 0;
}

module.exports = { addEvent, getAllEvents, getAllEventsForChat, getAllEventsForGroup, getUpcomingEvents, getTodayEvents, deleteEvent, deleteEventByChat, registerGroup, getGroups, findGroupByName, saveTemplate, getTemplate, listTemplates, deleteTemplate };
