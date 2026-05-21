const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const db = require('./db');

const token = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = '@dieuthuyen_csbot';

// Xóa webhook cũ
fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`)
  .then(() => console.log('✅ Đã xóa webhook cũ'))
  .catch(e => console.log('webhook delete:', e.message));

const bot = new TelegramBot(token, { polling: false });
setTimeout(() => { bot.startPolling({ restart: false }); console.log('✅ Bắt đầu polling...'); }, 3000);

bot.on('polling_error', (err) => {
  if (err.message && err.message.includes('409')) {
    console.log('⚠️ Conflict 409, dừng 10s...');
    bot.stopPolling();
    setTimeout(() => {
      fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`)
        .then(() => bot.startPolling({ restart: false }))
        .catch(e => console.log(e.message));
    }, 10000);
  } else console.error('Polling error:', err.message);
});

// ─── Groq AI parser ───────────────────────────────────────────────────────────
async function parseEventFromText(text) {
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const prompt = `Bạn là trợ lý phân tích lịch. Hôm nay là ${now} (múi giờ Việt Nam).
Từ đoạn text sau, trả về JSON thuần túy (không markdown, không backtick):
"${text}"
JSON:
{
  "action": "create"|"today"|"tomorrow"|"this_week"|"next_week"|"list"|"delete"|"help"|"unknown",
  "title": "tên sự kiện",
  "datetime": "ISO 8601 +07:00",
  "repeat": "none"|"daily"|"weekly",
  "remind_before": [số phút],
  "mention": "@user1 @user2 hoặc null",
  "note": "ghi chú hoặc null"
}
Quy tắc:
- "chiều mai 2h"=ngày mai 14:00, "sáng mai 9h"=ngày mai 09:00, "tối nay 8h"=hôm nay 20:00, "chiều nay 5h"=hôm nay 17:00
- Giờ không rõ sáng/chiều → mặc định chiều
- mention: chỉ @username có dấu @
- remind_before: "nhắc trước 20 phút và 10 phút"=[20,10], mặc định=[]
- Có giờ trong tin → action="create"
- "hàng ngày"/"mỗi ngày" → repeat="daily", "hàng tuần" → repeat="weekly"
- "lịch hôm nay" hoặc /today → action="today"
- "lịch ngày mai" hoặc "ngày mai có lịch" → action="tomorrow"
- "lịch tuần này" hoặc "tuần này có gì" → action="this_week"
- "lịch tuần sau" hoặc "tuần sau có gì" → action="next_week"
- /list hoặc "xem lịch" hoặc "tất cả lịch" → action="list"`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 500, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  let raw = data.choices[0].message.content.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) raw = match[0];
  try { return JSON.parse(raw); } catch(e) { return { action: 'unknown' }; }
}

// ─── Schedule jobs ────────────────────────────────────────────────────────────
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
    const msg = `🔔 *Đến giờ rồi!*\n\n${mention}📌 *${event.title}*\n🕐 ${formatDateTime(new Date(event.datetime))}${event.note ? '\n📝 ' + event.note : ''}`;
    try { await bot.sendMessage(event.chat_id, msg, { parse_mode: 'Markdown' }); } catch(e) {}
    if (event.repeat === 'none') db.deleteEvent(event.id);
  });
  const remindBefore = event.remind_before ? JSON.parse(event.remind_before) : [];
  remindBefore.forEach(minutes => {
    const remindTime = new Date(dt.getTime() - minutes * 60 * 1000);
    if (remindTime <= new Date()) return;
    const rJobId = `event_${event.id}_before_${minutes}`;
    if (schedule.scheduledJobs[rJobId]) schedule.scheduledJobs[rJobId].cancel();
    schedule.scheduleJob(rJobId, remindTime, async () => {
      const mention = event.mention ? event.mention + ' ' : '';
      try { await bot.sendMessage(event.chat_id, `⏰ *Nhắc trước ${minutes} phút!*\n\n${mention}📌 *${event.title}*\n🕐 ${formatDateTime(new Date(event.datetime))}`, { parse_mode: 'Markdown' }); } catch(e) {}
    });
  });
}

async function restoreJobs() {
  try {
    await new Promise(r => setTimeout(r, 2000));
    const events = await db.getAllEvents();
    let count = 0;
    for (const ev of events) {
      if (!ev.datetime) continue;
      const dt = new Date(ev.datetime);
      if (ev.repeat === 'none' && dt <= new Date()) { await db.deleteEvent(ev.id); continue; }
      scheduleJob(ev);
      count++;
    }
    console.log(`✅ Khôi phục ${count} lịch nhắc`);
  } catch(e) { console.error('Lỗi khôi phục lịch:', e.message); }
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function formatDateTime(dt) {
  return dt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function repeatLabel(r) {
  return r === 'daily' ? '🔁 Mỗi ngày' : r === 'weekly' ? '🔁 Mỗi tuần' : '1️⃣ Một lần';
}

// ─── Main menu ────────────────────────────────────────────────────────────────
function sendMainMenu(chatId) {
  bot.sendMessage(chatId, '📅 *Xin chào! Chọn chức năng:*', {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['📅 Hôm nay', '📅 Ngày mai'],
        ['📆 Tuần này', '📆 Tuần sau'],
        ['📋 Tất cả lịch', '❓ Hướng dẫn']
      ],
      resize_keyboard: true,
      persistent: true
    }
  });
}

// ─── Show events with delete buttons ─────────────────────────────────────────
async function showEvents(chatId, events, title) {
  if (!events.length) {
    return bot.sendMessage(chatId, `📭 ${title}: Không có lịch nào!`);
  }
  for (const ev of events) {
    const dt = new Date(ev.datetime);
    const remindBefore = ev.remind_before ? JSON.parse(ev.remind_before) : [];
    const remindText = remindBefore.length > 0 ? `\n⏰ Nhắc trước: ${remindBefore.join(', ')} phút` : '';
    const msg =
      `📌 *${ev.title}*\n` +
      `🕐 ${formatDateTime(dt)}\n` +
      `${repeatLabel(ev.repeat)}` +
      `${ev.mention ? '\n👤 ' + ev.mention : ''}` +
      `${remindText}` +
      `${ev.note ? '\n📝 ' + ev.note : ''}`;
    await bot.sendMessage(chatId, msg, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🗑 Xóa lịch này', callback_data: `del_${ev.id}` }]]
      }
    });
  }
}

// ─── Date range helpers ───────────────────────────────────────────────────────
function getDateRange(type) {
  const now = new Date();
  const vn = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

  if (type === 'today') {
    return { start: startOfDay(vn), end: endOfDay(vn) };
  }
  if (type === 'tomorrow') {
    const tom = new Date(vn); tom.setDate(tom.getDate() + 1);
    return { start: startOfDay(tom), end: endOfDay(tom) };
  }
  if (type === 'this_week') {
    const day = vn.getDay();
    const mon = new Date(vn); mon.setDate(vn.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: startOfDay(mon), end: endOfDay(sun) };
  }
  if (type === 'next_week') {
    const day = vn.getDay();
    const mon = new Date(vn); mon.setDate(vn.getDate() - (day === 0 ? 6 : day - 1) + 7);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: startOfDay(mon), end: endOfDay(sun) };
  }
}

async function showByRange(chatId, userId, type, label, isGroup) {
  try {
    const { start, end } = getDateRange(type);
    // Trong group: lấy tất cả lịch của group. Chat riêng: lấy lịch của user
    const all = isGroup
      ? await db.getAllEventsForGroup(chatId)
      : await db.getAllEventsForChat(chatId, userId || 0);
    const filtered = all.filter(ev => {
      const dt = new Date(ev.datetime);
      return dt >= start && dt <= end;
    }).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    await showEvents(chatId, filtered, label);
  } catch(e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Lỗi tải lịch!');
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
  const text = (msg.text || '').trim();

  if (!text || text === '/start') return sendMainMenu(chatId);

  // Menu buttons
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (text === '📅 Hôm nay') return showByRange(chatId, userId, 'today', 'Hôm nay', isGroup);
  if (text === '📅 Ngày mai') return showByRange(chatId, userId, 'tomorrow', 'Ngày mai', isGroup);
  if (text === '📆 Tuần này') return showByRange(chatId, userId, 'this_week', 'Tuần này', isGroup);
  if (text === '📆 Tuần sau') return showByRange(chatId, userId, 'next_week', 'Tuần sau', isGroup);
  if (text === '📋 Tất cả lịch') {
    const events = await db.getAllEventsForChat(chatId, msg.from.id);
    const upcoming = events.filter(ev => ev.repeat !== 'none' || new Date(ev.datetime) > new Date())
      .sort((a,b) => new Date(a.datetime) - new Date(b.datetime));
    return showEvents(chatId, upcoming, 'Tất cả lịch');
  }
  if (text === '❓ Hướng dẫn') return bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' });

  const deleteMatch = text.match(/^\/delete[_ ](\d+)$/i);
  if (deleteMatch) {
    const id = parseInt(deleteMatch[1]);
    const ok = await db.deleteEventByChat(id, chatId);
    const jobId = `event_${id}`;
    if (schedule.scheduledJobs[jobId]) schedule.scheduledJobs[jobId].cancel();
    return bot.sendMessage(chatId, ok ? `✅ Đã xóa lịch #${id}` : `❌ Không tìm thấy lịch #${id}`);
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const parsed = await parseEventFromText(text);
    if (parsed.action === 'help') return bot.sendMessage(chatId, helpText(), { parse_mode: 'Markdown' });
    if (parsed.action === 'today') return showByRange(chatId, userId, 'today', 'Hôm nay', isGroup);
    if (parsed.action === 'tomorrow') return showByRange(chatId, userId, 'tomorrow', 'Ngày mai', isGroup);
    if (parsed.action === 'this_week') return showByRange(chatId, userId, 'this_week', 'Tuần này', isGroup);
    if (parsed.action === 'next_week') return showByRange(chatId, userId, 'next_week', 'Tuần sau', isGroup);
    if (parsed.action === 'list') {
      const events = isGroup
        ? await db.getAllEventsForGroup(chatId)
        : await db.getAllEventsForChat(chatId, msg.from.id);
      const upcoming = events.filter(ev => ev.repeat !== 'none' || new Date(ev.datetime) > new Date())
        .sort((a,b) => new Date(a.datetime) - new Date(b.datetime));
      return showEvents(chatId, upcoming, 'Tất cả lịch');
    }
    if (parsed.action === 'create') {
      if (!parsed.datetime) return bot.sendMessage(chatId, `⚠️ Tôi chưa rõ *thời gian*.\n\nVí dụ: _"họp team 2h chiều mai"_`, { parse_mode: 'Markdown' });
      const remindBefore = Array.isArray(parsed.remind_before) ? parsed.remind_before : [];
      const ev = await db.addEvent({
        chat_id: chatId, user_id: userId, created_by: username,
        title: parsed.title, datetime: parsed.datetime,
        repeat: parsed.repeat || 'none',
        mention: parsed.mention || null, note: parsed.note || null,
        remind_before: JSON.stringify(remindBefore),
      });
      scheduleJob(ev);
      const dt = new Date(parsed.datetime);
      const remindText = remindBefore.length > 0 ? `\n⏰ Nhắc trước: ${remindBefore.map(m => m >= 60 ? m/60 + ' tiếng' : m + ' phút').join(', ')}` : '';
      return bot.sendMessage(chatId,
        `✅ *Đã tạo lịch!*\n\n📌 *${ev.title}*\n🕐 ${formatDateTime(dt)}\n${repeatLabel(ev.repeat)}\n` +
        `${ev.mention ? '👤 ' + ev.mention + '\n' : ''}${remindText}${ev.note ? '\n📝 ' + ev.note : ''}\n\n_Bot sẽ nhắc đúng giờ_ 🔔`,
        { parse_mode: 'Markdown' });
    }
    return bot.sendMessage(chatId, `🤔 Tôi chưa hiểu. Thử: _"họp team 3h chiều mai"_ hoặc nhấn *❓ Hướng dẫn*`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Lỗi:', err);
    bot.sendMessage(chatId, '❌ Có lỗi xảy ra, thử lại sau nhé!');
  }
}

function helpText() {
  return `👋 *Bot trợ lý lịch* 🗓

Nhắn tin tự nhiên để tạo lịch:
• _họp team 2h chiều mai_
• _nhắc @Nam báo cáo thứ 2 tuần sau 9h_
• _deadline 25/12 lúc 10h nhắc trước 30 phút_
• _uống thuốc 8h sáng hàng ngày_

Hoặc dùng menu phía dưới để xem lịch! 👇`;
}

// ─── Callback query (nút xóa) ─────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  if (data.startsWith('del_')) {
    const id = parseInt(data.replace('del_', ''));
    const ok = await db.deleteEventByChat(id, chatId);
    ['', `_before_10`, `_before_20`, `_before_30`, `_before_60`].forEach(suffix => {
      const jid = `event_${id}${suffix}`;
      if (schedule.scheduledJobs[jid]) schedule.scheduledJobs[jid].cancel();
    });
    await bot.answerCallbackQuery(query.id, { text: ok ? '✅ Đã xóa!' : '❌ Không tìm thấy!' });
    if (ok) {
      try {
        await bot.editMessageText('~~Đã xóa lịch này~~', {
          chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
        });
      } catch(e) {}
    }
  }
});

// ─── Command + message handlers ──────────────────────────────────────────────
bot.onText(/\/start/, (msg) => sendMainMenu(msg.chat.id));
bot.onText(/\/today/, (msg) => showByRange(msg.chat.id, msg.from.id, 'today', 'Hôm nay', msg.chat.type === 'group' || msg.chat.type === 'supergroup'));
bot.onText(/\/list/, async (msg) => {
  const isGrp = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const events = isGrp
    ? await db.getAllEventsForGroup(msg.chat.id)
    : await db.getAllEventsForChat(msg.chat.id, msg.from.id);
  const upcoming = events.filter(ev => ev.repeat !== 'none' || new Date(ev.datetime) > new Date());
  showEvents(msg.chat.id, upcoming, 'Tất cả lịch');
});
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'Markdown' }));

bot.on('message', (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const isMentioned = text.toLowerCase().includes(BOT_USERNAME.toLowerCase());
    const isCommand = text.startsWith('/');
    const isMenuBtn = ['📅 Hôm nay','📅 Ngày mai','📆 Tuần này','📆 Tuần sau','📋 Tất cả lịch','❓ Hướng dẫn'].includes(text);
    if (!isMentioned && !isCommand && !isMenuBtn) return;
    msg.text = text.replace(new RegExp(BOT_USERNAME, 'gi'), '').trim();
  }
  if (!msg.text.startsWith('/')) handleMessage(msg);
  else if (msg.text.startsWith('/start')) handleMessage(msg);
});

restoreJobs();
console.log('🤖 Bot nhắc lịch đang chạy (Groq AI)...');

// HTTP server để Render không timeout
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot đang chạy!')).listen(PORT, () => {
  console.log(`✅ HTTP server chạy trên port ${PORT}`);
});
