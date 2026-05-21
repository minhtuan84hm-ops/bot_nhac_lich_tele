const { Client } = require('pg');

let client;

async function getClient() {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  console.log('DATABASE_URL prefix:', url ? url.substring(0, 30) + '...' : 'KHÔNG CÓ!');
  if (!url) throw new Error('DATABASE_URL chưa được set!');
  client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  // Tạo bảng nếu chưa có
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
    `SELECT * FROM events WHERE chat_id=$1 AND (repeat!='none' OR datetime > NOW() AT TIME ZONE 'UTC') ORDER BY datetime ASC`,
    [chatId]
  );
  return res.rows;
}

async function getTodayEvents(chatId) {
  const db = await getClient();
  const res = await db.query(
    `SELECT * FROM events WHERE chat_id=$1
     AND (datetime AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
     ORDER BY datetime ASC`,
    [chatId]
  );
  return res.rows;
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

module.exports = { addEvent, getAllEvents, getUpcomingEvents, getTodayEvents, deleteEvent, deleteEventByChat };
