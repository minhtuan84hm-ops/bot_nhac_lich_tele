const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const db = require('./db');

const token = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = '@dieuthuyen_csbot';

// Xóa webhook cũ trước khi polling
fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`)
  .then(() => console.log('✅ Đã xóa webhook cũ'))
  .catch(e => console.log('webhook delete:', e.message));

const bot = new TelegramBot(token, { polling: false });

setTimeout(() => {
  bot.startPolling({ restart: false });
  console.log('✅ Bắt đầu polling...');
}, 3000);

bot.on('polling_error', (err) => {
  if (err.message && err.message.includes('409')) {
    console.log('⚠️ Conflict 409, dừng polling 10s...');
    bot.stopPolling();
    setTimeout(() => {
      fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`)
        .then(() => bot.startPolling({ restart: false }))
        .catch(e => console.log(e.message));
    }, 10000);
  } else {
    console.error('Polling error:', err.message);
  }
});

// ─── Groq parser ─────────────────────────────────────────────────────────────
async function parseEventFromText(text) {
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const prompt = `Bạn là trợ lý phân tích lịch. Hôm nay là ${now} (múi giờ Việt Nam).

Từ đoạn text sau, trả về JSON thuần túy (không markdown, không backtick, không giải thích):
"${text}"

JSON format:
{
  "action": "create" | "list" | "delete" | "today" | "help" | "unknown",
  "title": "tên sự kiện",
  "datetime": "ISO 8601 +07:00, ví dụ: 2024-12-25T14:00:00+07:00",
  "repeat": "none" | "daily" | "weekly",
  "remind_before": [20, 10],
  "mention": "@user1 @user2 hoặc null",
  "note": "ghi chú hoặc null"
}

Quy tắc:
- "chiều mai 2h" = ngày mai 14:00, "sáng mai 9h" = ngày mai 09:00
- "tối nay 8h" = hôm nay 20:00, "chiều nay 5h" = hôm nay 17:00
- Giờ không rõ sáng/chiều thì mặc định chiều (14:00+)
- mention: chỉ lấy @username có dấu @, bỏ qua tên không có @
- remind_before: mảng số phút nhắc trước, ví dụ "nhắc trước 20 phút và 10 phút" = [20, 10], "nhắc trước 30 phút" = [30], mặc định = []
- Nếu có giờ trong tin nhắn thì action = "create"
- "hàng ngày"/"mỗi ngày" → repeat = "daily", "hàng tuần"/"mỗi tuần" → repeat = "weekly"
- /today hoặc "lịch hôm nay" → action = "today"
- /list hoặc "xem lịch" → action = "list"
- /help → action = "help"`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 500,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  let raw = data.choices[0].message.content.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) raw = match[0];
  try { return JSON.parse(raw); } catch(e) { return { action: 'unknown' }; }
}

// ─── Schedule jobs (main + nhắc trước) ───────────────────────────────────────
function scheduleJob(event) {
  const dt = new Date(event.datetime);
  if (event.repeat === 'none' && dt <= new Date()) return;

  const jobId = `event_${event.id}`;
  if (schedule.scheduledJobs[jobId]) schedule.scheduledJobs[jobId].cancel();

  const rule = event.repeat === 'daily'
    ? { hour: dt.getHours(), minute: dt.getMinutes(), tz: 'Asia/Ho_Chi_Minh' }
    : event.repeat === 'weekly'
      ? { dayOfWeek: dt.getDay(), hour: dt.getHours(), minute: dt.getMinutes(), tz: 'Asia/Ho_Chi_Minh' }
      : dt;

  // Job chính
  schedule.scheduleJob(jobId, rule, async () => {
    const mention = event.mention ? event.mention + ' ' : '';
    const msg = `🔔 *Đến giờ rồi!*\n\n${mention}📌 *${event.title}*\n🕐 ${formatDateTime(new Date(event.datetime))}${event.note ? '\n📝 ' + event.note : ''}`;
    try { await bot.sendMessage(event.chat_id, msg, { parse_mode: 'Markdown' }); } catch(e) {}
    if (event.repeat === 'none') db.deleteEvent(event.id);
  });

  // Jobs nhắc trước
  const remindBefore = event.remind_before ? JSON.parse(event.remind_before) : [];
  remindBefore.forEach(minutes => {
    const remindTime = new Date(dt.getTime() - minutes * 60 * 1000);
    if (remindTime <= new Date()) return;
    const remindJobId = `event_${event.id}_before_${minutes}`;
    if (schedule.scheduledJobs[remindJobId]) schedule.scheduledJobs[remindJobId].cancel();
    schedule.scheduleJob(remindJobId, remindTime, async () => {
      const mention = event.mention ? event.mention + ' ' : '';
      const msg = `⏰ *Nhắc trước ${minutes} phút!*\n\n${mention}📌 *${event.title}*\n🕐 ${formatDateTime(new Date(event.datetime))}`;
      try { await bot.sendMessage(event.chat_id, msg, { parse_mode: 'Markdown' }); } catch(e) {}
    });
  });
}

// ─── Restore jobs on startup ──────────────────────────────────────────────────
function restoreJobs() {
  const events = db.getAllEvents();
  let count = 0;
  for (const ev of events) {
    if (!ev.datetime) continue;
    const dt = new Date(ev.datetime);
    if (ev.repeat === 'none' && dt <= new Date()) { db.deleteEvent(ev.id); continue; }
    scheduleJob(ev);
    count++;
  }
  console.log(`✅ Khôi phục ${count} lịch nhắc`);
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function formatDateTime(dt) {
  return dt.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function repeatLabel(r) {
  return r === 'daily' ? '🔁 Mỗi ngày' : r === 'weekly' ? '🔁 Mỗi tuần' : '1️⃣ Một lần';
}

function helpText() {
  return `👋 *Xin chào! Tôi là bot trợ lý lịch* 🗓

Chỉ cần tag tôi và nhắn tự nhiên:

📌 *Tạo lịch:*
• _họp team 2h chiều mai_
• _nhắc @Nam báo cáo thứ 2 tuần sau 9h_
• _deadline 25/12 lúc 10h, nhắc trước 30 phút_
• _uống thuốc 8h sáng hàng ngày_

⏰ *Nhắc trước:*
• _họp 3h chiều, nhắc trước 20 phút và 10 phút_
• _nhắc trước 1 tiếng_

📋 *Xem lịch:*
• /today — lịch hôm nay
• /list — tất cả lịch sắp tới

🗑 *Xóa lịch:*
• /delete\\_[id] — ví dụ /delete\\_3`;
}

// ─── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
  const text = (msg.text || '').trim();

  if (!text || text === '/start') return bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' });

  const deleteMatch = text.match(/^\/delete[_ ](\d+)$/i);
  if (deleteMatch) {
    const id = parseInt(deleteMatch[1]);
    const ok = db.deleteEventByChat(id, chatId);
    const jobId = `event_${id}`;
    if (schedule.scheduledJobs[jobId]) schedule.scheduledJobs[jobId].cancel();
    return bot.sendMessage(chatId, ok ? `✅ Đã xóa lịch #${id}` : `❌ Không tìm thấy lịch #${id}`);
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const parsed = await parseEventFromText(text);

    if (parsed.action === 'help') return bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' });
    if (parsed.action === 'today') return handleToday(chatId);
    if (parsed.action === 'list') return handleList(chatId);
    if (parsed.action === 'delete') return bot.sendMessage(chatId, '🗑 Dùng /list rồi gõ `/delete_3`', { parse_mode: 'Markdown' });

    if (parsed.action === 'create') {
      if (!parsed.datetime) {
        return bot.sendMessage(chatId, `⚠️ Tôi chưa rõ *thời gian*.\n\nVí dụ: _"họp team 2h chiều mai"_`, { parse_mode: 'Markdown' });
      }

      const remindBefore = Array.isArray(parsed.remind_before) ? parsed.remind_before : [];
      const ev = db.addEvent({
        chat_id: chatId, user_id: userId, created_by: username,
        title: parsed.title, datetime: parsed.datetime,
        repeat: parsed.repeat || 'none',
        mention: parsed.mention || null,
        note: parsed.note || null,
        remind_before: JSON.stringify(remindBefore),
      });
      scheduleJob(ev);

      const dt = new Date(parsed.datetime);
      const remindText = remindBefore.length > 0
        ? `⏰ Nhắc trước: ${remindBefore.map(m => m >= 60 ? m/60 + ' tiếng' : m + ' phút').join(', ')}\n`
        : '';

      return bot.sendMessage(chatId,
        `✅ *Đã tạo lịch!*\n\n📌 *${ev.title}*\n🕐 ${formatDateTime(dt)}\n${repeatLabel(ev.repeat)}\n` +
        `${ev.mention ? '👤 ' + ev.mention + '\n' : ''}${remindText}` +
        `${ev.note ? '📝 ' + ev.note + '\n' : ''}🆔 ID: \`${ev.id}\`\n\n_Bot sẽ nhắc đúng giờ_ 🔔`,
        { parse_mode: 'Markdown' });
    }

    return bot.sendMessage(chatId, `🤔 Tôi chưa hiểu. Thử: _"họp team 3h chiều mai"_ hoặc /help`, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('Lỗi xử lý tin nhắn:', err);
    bot.sendMessage(chatId, '❌ Có lỗi xảy ra, thử lại sau nhé!');
  }
}

function handleToday(chatId) {
  const events = db.getTodayEvents(chatId);
  if (!events.length) return bot.sendMessage(chatId, '📭 Hôm nay không có lịch nào!');
  const lines = events.map((ev, i) => {
    const dt = new Date(ev.datetime);
    const time = dt.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
    return `${i + 1}. *${ev.title}* — ${time}${ev.mention ? ' ' + ev.mention : ''} \`#${ev.id}\``;
  }).join('\n');
  bot.sendMessage(chatId, `📅 *Lịch hôm nay:*\n\n${lines}`, { parse_mode: 'Markdown' });
}

function handleList(chatId) {
  const events = db.getUpcomingEvents(chatId);
  if (!events.length) return bot.sendMessage(chatId, '📭 Không có lịch nào sắp tới!');
  const lines = events.slice(0, 10).map((ev, i) => {
    const dt = new Date(ev.datetime);
    const remindBefore = ev.remind_before ? JSON.parse(ev.remind_before) : [];
    const remindText = remindBefore.length > 0 ? ` · ⏰ ${remindBefore.join(', ')} phút` : '';
    return `${i + 1}. *${ev.title}*\n   🕐 ${formatDateTime(dt)}\n   ${repeatLabel(ev.repeat)}${remindText} · \`/delete_${ev.id}\``;
  }).join('\n\n');
  bot.sendMessage(chatId, `📋 *Lịch sắp tới (${Math.min(events.length,10)}/${events.length}):*\n\n${lines}`, { parse_mode: 'Markdown' });
}

// ─── Command handlers ─────────────────────────────────────────────────────────
bot.onText(/\/today/, (msg) => handleToday(msg.chat.id));
bot.onText(/\/list/, (msg) => handleList(msg.chat.id));
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'Markdown' }));
bot.onText(/\/delete[_ ](\d+)/, (msg) => handleMessage(msg));
bot.on('message', (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();

  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const isMentioned = text.toLowerCase().includes(BOT_USERNAME.toLowerCase());
    const isCommand = text.startsWith('/');
    if (!isMentioned && !isCommand) return;
    msg.text = text.replace(new RegExp(BOT_USERNAME, 'gi'), '').trim();
  }

  if (!msg.text.startsWith('/')) handleMessage(msg);
  else if (msg.text.startsWith('/start')) handleMessage(msg);
});

// ─── Update db schema for remind_before ──────────────────────────────────────
const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'events.json');
try {
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  data.events = data.events.map(e => ({ remind_before: '[]', ...e }));
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
} catch(e) {}

restoreJobs();
console.log('🤖 Bot nhắc lịch đang chạy (Groq AI)...');
