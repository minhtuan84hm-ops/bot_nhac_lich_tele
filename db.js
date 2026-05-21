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
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Kết nối database thành công!');
  return client;
}

async function addEvent(data) {
  const db = await getClient();
  const res = await db.query(
    `INSERT INTO events (chat_id, user_id, created_by, title, datetime, repeat, mention, note, remind_before)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [data.chat_id, data.user_id, data.created_by, data.title, data.datetime,
     data.repeat||'none', data.mention||null, data.note||null, data.remind_before||'[]']
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
  // Lấy lịch của chat này HOẶC lịch do user này tạo (để xem từ mọi nơi)
  const res = await db.query(
    'SELECT * FROM events WHERE chat_id=$1 OR user_id=$2 ORDER BY datetime ASC',
    [chatId, userId]
  );
  // Dedup by id
  const seen = new Set();
  return res.rows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}

async function deleteEvent(id) {
  const db = await getClient();
  await db.query('DELETE FROM events WHERE id=$1', [id]);
}

async function deleteEventByChat(id, chatId) {
  const db = await getClient();
  const res = await db.query('DELETE FROM events WHERE id=$1 AND chat_id=$2', [id, chatId]);
  return res.rowCount > 0;
}

module.exports = { addEvent, getAllEvents, getAllEventsForChat, getUpcomingEvents, getTodayEvents, deleteEvent, deleteEventByChat };
