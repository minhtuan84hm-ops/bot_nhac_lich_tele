const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const db = require('./db');

// Xóa webhook cũ trước khi polling để tránh conflict
const token = process.env.TELEGRAM_BOT_TOKEN;
fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`)
  .then(() => console.log('✅ Đã xóa webhook cũ'))
  .catch(e => console.log('webhook delete:', e.message));

const bot = new TelegramBot(token, { polling: false });

// Delay 3s rồi mới bắt đầu polling để tránh conflict
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

// ─── Groq parser: extract event from natural language ────────────────────────
async function parseEventFromText(text) {
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const prompt = `Bạn là trợ lý phân tích lịch. Hôm nay là ${now} (múi giờ Việt Nam).

Từ đoạn text sau, hãy trích xuất thông tin lịch/sự kiện và trả về JSON thuần túy (không markdown, không backtick, không giải thích):
"${text}"

JSON format:
{
  "action": "create" | "list" | "delete" | "today" | "help" | "unknown",
  "title": "tên sự kiện",
  "datetime": "ISO 8601 string theo múi giờ +07:00, ví dụ: 2024-12-25T14:00:00+07:00",
  "repeat": "none" | "daily" | "weekly",
  "mention": "@username hoặc null nếu không nhắc ai cụ thể",
  "note": "ghi chú thêm hoặc null"
}

Quy tắc:
- "chiều mai 2h" hoặc "2h chiều mai" = ngày mai lúc 14:00
- "sáng mai 9h" = ngày mai lúc 09:00
- "tối nay 8h" = hôm nay lúc 20:00
- "chiều nay 5h" = hôm nay lúc 17:00
- "thứ 2 tuần sau" = thứ 2 tuần tới
- "lúc 5h" hoặc "5h" = 17:00 nếu không rõ sáng/chiều thì mặc định là chiều
- Nếu tin nhắn có chứa giờ (vd: 5h, 9h, 14h, 2h chiều...) thì action = "create"
- Nếu tin nhắn có "nhắc", "họp", "deadline", "meeting", "lịch" kèm giờ thì action = "create"
- mention: nếu có nhiều @username thì ghép lại thành 1 chuỗi, ví dụ: "@Nam @Hoa @Tuan"
- Tên người không có @ (vd: "Trung Salefarm", "Hương") thì bỏ qua, không thêm vào mention
- Nếu không có ngày/giờ cụ thể và là lệnh tạo lịch, đặt datetime = null
- Nếu là /today hoặc "lịch hôm nay" thì action = "today"
- Nếu là /list hoặc "xem lịch" hoặc "danh sách" thì action = "list"
- Nếu là /help thì action = "help"
- Nếu có "hàng ngày" hoặc "mỗi ngày" thì repeat = "daily"
- Nếu có "hàng tuần" hoặc "mỗi tuần" thì repeat = "weekly"`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
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

// ─── Schedule a notification job ─────────────────────────────────────────────
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

  schedule.scheduleJob(jobId, rule, async () => {
    const mention = event.mention ? event.mention + ' ' : '';
    const msg =
      `🔔 *Nhắc lịch!*\n\n` +
      `${mention}📌 *${event.title}*\n` +
      `🕐 ${formatDateTime(new Date(event.datetime))}` +
      `${event.note ? '\n📝 ' + event.note : ''}`;
    try {
      await bot.sendMessage(event.chat_id, msg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Lỗi gửi nhắc lịch:', e.message);
    }
    if (event.repeat === 'none') db.deleteEvent(event.id);
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

Chỉ cần nhắn tin tự nhiên, tôi sẽ hiểu:

📌 *Tạo lịch:*
• _họp team 2h chiều mai_
• _nhắc @Nam báo cáo thứ 2 tuần sau 9h_
• _uống thuốc 8h sáng hàng ngày_
• _deadline project 25/12 lúc 10h_

📋 *Xem lịch:*
• /today — lịch hôm nay
• /list — tất cả lịch sắp tới

🗑 *Xóa lịch:*
• /delete\\_[id] — ví dụ /delete\\_3

❓ /help — xem hướng dẫn này`;
}

// ─── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
  const text = (msg.text || '').trim();

  if (!text || text === '/start') {
    return bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' });
  }

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
    if (parsed.action === 'delete') {
      return bot.sendMessage(chatId, '🗑 Dùng /list để xem ID, rồi gõ `/delete_3`', { parse_mode: 'Markdown' });
    }

    if (parsed.action === 'create') {
      if (!parsed.datetime) {
        return bot.sendMessage(chatId,
          `⚠️ Tôi chưa rõ *thời gian*.\n\nVí dụ: _"họp team 2h chiều mai"_`,
          { parse_mode: 'Markdown' });
      }
      const ev = db.addEvent({
        chat_id: chatId, user_id: userId, created_by: username,
        title: parsed.title, datetime: parsed.datetime,
        repeat: parsed.repeat || 'none',
        mention: parsed.mention || null, note: parsed.note || null,
      });
      scheduleJob(ev);
      const dt = new Date(parsed.datetime);
      return bot.sendMessage(chatId,
        `✅ *Đã tạo lịch!*\n\n📌 *${ev.title}*\n🕐 ${formatDateTime(dt)}\n${repeatLabel(ev.repeat)}\n` +
        `${ev.mention ? '👤 ' + ev.mention + '\n' : ''}${ev.note ? '📝 ' + ev.note + '\n' : ''}` +
        `🆔 ID: \`${ev.id}\`\n\n_Bot sẽ nhắc đúng giờ_ 🔔`,
        { parse_mode: 'Markdown' });
    }

    return bot.sendMessage(chatId,
      `🤔 Tôi chưa hiểu. Thử: _"họp team 3h chiều mai"_ hoặc /help`,
      { parse_mode: 'Markdown' });

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
    return `${i + 1}. *${ev.title}*\n   🕐 ${formatDateTime(dt)}\n   ${repeatLabel(ev.repeat)} · \`/delete_${ev.id}\``;
  }).join('\n\n');
  bot.sendMessage(chatId,
    `📋 *Lịch sắp tới (${Math.min(events.length,10)}/${events.length}):*\n\n${lines}`,
    { parse_mode: 'Markdown' });
}

bot.onText(/\/today/, (msg) => handleToday(msg.chat.id));
bot.onText(/\/list/, (msg) => handleList(msg.chat.id));
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'Markdown' }));
bot.onText(/\/delete[_ ](\d+)/, (msg) => handleMessage(msg));
bot.on('message', (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const botUsername = '@dieuthyen_bot';

  // Trong group: chỉ phản hồi khi được tag hoặc dùng lệnh /
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const isMentioned = text.toLowerCase().includes(botUsername.toLowerCase());
    const isCommand = text.startsWith('/');
    if (!isMentioned && !isCommand) return;
    // Xóa @botname khỏi text trước khi xử lý
    msg.text = text.replace(new RegExp(botUsername, 'gi'), '').trim();
  }

  if (!text.startsWith('/')) handleMessage(msg);
  else if (text.startsWith('/start')) handleMessage(msg);
});

restoreJobs();
console.log('🤖 Bot nhắc lịch đang chạy (Groq AI)...');
