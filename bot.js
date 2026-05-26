const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const db = require('./db');
const http = require('http');

const token = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = '@dieuthuyen_csbot';
const PORT = process.env.PORT || 3000;
const pendingTag = new Map();

const bot = new TelegramBot(token, { polling: false });

const server = http.createServer((req, res) => {
  const webhookPath = '/webhook/' + token;
  if (req.url === webhookPath && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { bot.processUpdate(JSON.parse(body)); res.writeHead(200); res.end('OK'); }
      catch(e) { res.writeHead(400); res.end('Bad Request'); }
    });
  } else { res.writeHead(200); res.end('Bot dang chay!'); }
});

server.listen(PORT, async () => {
  console.log('HTTP server chay tren port ' + PORT);
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
  if (RENDER_URL) {
    try {
      await fetch('https://api.telegram.org/bot' + token + '/setWebhook?url=' + RENDER_URL + '/webhook/' + token + '&drop_pending_updates=true');
      console.log('Webhook da set');
    } catch(e) { console.error('Loi set webhook:', e.message); }
  } else {
    await fetch('https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=true');
    bot.startPolling({ restart: false });
    console.log('Polling (local)...');
  }
});

function escHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDateTime(dt) {
  return dt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function repeatLabel(r) {
  if (r === 'daily') return '\uD83D\uDD01 M\u1ed7i ng\u00e0y';
  if (r === 'weekly') return '\uD83D\uDD01 M\u1ed7i tu\u1ea7n';
  return '1\uFE0F\u20E3 M\u1ed9t l\u1ea7n';
}

async function parseEventFromText(text) {
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const prompt = 'Ban la tro ly phan tich lich. Hom nay la ' + now + ' (mui gio Viet Nam).\n'
    + 'Tu doan text sau, tra ve JSON thuan tuy (khong markdown, khong backtick):\n'
    + '"' + text + '"\n'
    + 'JSON:\n'
    + '{\n'
    + '  "action": "create|today|tomorrow|this_week|next_week|list|delete|help|unknown",\n'
    + '  "title": "ten su kien",\n'
    + '  "datetime": "ISO 8601 +07:00",\n'
    + '  "repeat": "none|daily|weekly",\n'
    + '  "remind_before": [so phut],\n'
    + '  "mention": "@user1 @user2 hoac null",\n'
    + '  "note": "noi dung chinh hoac null",\n'
    + '  "target_group": "ten nhom hoac null"\n'
    + '}\n'
    + 'Quy tac:\n'
    + '- "chieu mai 2h"=ngay mai 14:00, "sang mai 9h"=ngay mai 09:00\n'
    + '- "toi nay 8h"=hom nay 20:00, "chieu nay 5h"=hom nay 17:00\n'
    + '- Gio khong ro sang/chieu mac dinh chieu\n'
    + '- mention: chi @username co dau @\n'
    + '- remind_before: [20,10] neu "nhac truoc 20 phut va 10 phut", mac dinh=[]\n'
    + '- Co gio trong tin -> action="create"\n'
    + '- "hang ngay"/"moi ngay" -> repeat="daily", "hang tuan" -> repeat="weekly"\n'
    + '- "lich hom nay" -> action="today", "ngay mai co gi" -> action="tomorrow"\n'
    + '- "tuan nay" -> action="this_week", "tuan sau" -> action="next_week"\n'
    + '- /list hoac "xem lich" -> action="list"\n'
    + '- "vao nhom X" hoac "gui vao nhom X" -> target_group="X"\n'
    + '- QUAN TRONG: Neu co "noi dung:" thi title=tom tat ngan, note=noi dung sau "noi dung:" bo phan "vao nhom X"\n'
    + '- "vao nhom X" luon tach ra thanh target_group, KHONG de trong note';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
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

function scheduleJob(event) {
  const dt = new Date(event.datetime);
  if (event.repeat === 'none' && dt <= new Date()) return;
  const jobId = 'event_' + event.id;
  if (schedule.scheduledJobs[jobId]) schedule.scheduledJobs[jobId].cancel();
  const rule = event.repeat === 'daily'
    ? { hour: dt.getHours(), minute: dt.getMinutes(), tz: 'Asia/Ho_Chi_Minh' }
    : event.repeat === 'weekly'
      ? { dayOfWeek: dt.getDay(), hour: dt.getHours(), minute: dt.getMinutes(), tz: 'Asia/Ho_Chi_Minh' }
      : dt;
  const sendTo = event.target_chat_id || event.chat_id;
  schedule.scheduleJob(jobId, rule, async () => {
    const mention = event.mention ? event.mention + ' ' : '';
    const noteText = event.note ? '\n\uD83D\uDCDD ' + escHtml(event.note) : '';
    const msg = '\uD83D\uDD14 <b>Den gio roi!</b>\n\n' + mention + '\uD83D\uDCCC <b>' + escHtml(event.title) + '</b>\n\uD83D\uDD50 ' + formatDateTime(new Date(event.datetime)) + noteText;
    try { await bot.sendMessage(sendTo, msg, { parse_mode: 'HTML' }); } catch(e) { console.error('Loi gui nhac:', e.message); }
    if (event.repeat === 'none') db.deleteEvent(event.id);
  });
  const remindBefore = event.remind_before ? JSON.parse(event.remind_before) : [];
  remindBefore.forEach(function(minutes) {
    const remindTime = new Date(dt.getTime() - minutes * 60 * 1000);
    if (remindTime <= new Date()) return;
    const rJobId = 'event_' + event.id + '_before_' + minutes;
    if (schedule.scheduledJobs[rJobId]) schedule.scheduledJobs[rJobId].cancel();
    schedule.scheduleJob(rJobId, remindTime, async () => {
      const mention = event.mention ? event.mention + ' ' : '';
      const msg = '\u23F0 <b>Nhac truoc ' + minutes + ' phut!</b>\n\n' + mention + '\uD83D\uDCCC <b>' + escHtml(event.title) + '</b>\n\uD83D\uDD50 ' + formatDateTime(new Date(event.datetime));
      try { await bot.sendMessage(sendTo, msg, { parse_mode: 'HTML' }); } catch(e) {}
    });
  });
}

async function restoreJobs() {
  try {
    await new Promise(function(r) { setTimeout(r, 2000); });
    const events = await db.getAllEvents();
    let count = 0;
    for (const ev of events) {
      if (!ev.datetime) continue;
      if (ev.repeat === 'none' && new Date(ev.datetime) <= new Date()) { await db.deleteEvent(ev.id); continue; }
      scheduleJob(ev);
      count++;
    }
    console.log('Khoi phuc ' + count + ' lich nhac');
  } catch(e) { console.error('Loi khoi phuc lich:', e.message); }
}

function sendMainMenu(chatId) {
  bot.sendMessage(chatId, '<b>Xin chao! Chon chuc nang:</b>', {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        ['\uD83D\uDCC5 Hom nay', '\uD83D\uDCC5 Ngay mai'],
        ['\uD83D\uDCC6 Tuan nay', '\uD83D\uDCC6 Tuan sau'],
        ['\uD83D\uDDC2 Tat ca lich', '\u2753 Huong dan'],
        ['\uD83D\uDCE8 Tin co tag', '\uD83D\uDCDD Tin chua tag']
      ],
      resize_keyboard: true, persistent: true
    }
  });
}

async function showEvents(chatId, events, title) {
  if (!events.length) return bot.sendMessage(chatId, title + ': Khong co lich nao!');
  for (const ev of events) {
    const dt = new Date(ev.datetime);
    const remindBefore = ev.remind_before ? JSON.parse(ev.remind_before) : [];
    const remindText = remindBefore.length > 0 ? '\n\u23F0 Nhac truoc: ' + remindBefore.join(', ') + ' phut' : '';
    const noteText = ev.note ? '\n\uD83D\uDCDD ' + escHtml(ev.note) : '';
    const mentionText = ev.mention ? '\n\uD83D\uDC64 ' + ev.mention : '';
    const msg = '\uD83D\uDCCC <b>' + escHtml(ev.title) + '</b>\n\uD83D\uDD50 ' + formatDateTime(dt) + '\n' + repeatLabel(ev.repeat) + mentionText + remindText + noteText;
    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '\uD83D\uDDD1 Xoa lich nay', callback_data: 'del_' + ev.id }]] } });
  }
}

function getDateRange(type) {
  const vn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const s = function(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0); };
  const e = function(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59); };
  if (type === 'today') return { start: s(vn), end: e(vn) };
  if (type === 'tomorrow') { const t = new Date(vn); t.setDate(t.getDate()+1); return { start: s(t), end: e(t) }; }
  if (type === 'this_week') {
    const day = vn.getDay(); const mon = new Date(vn); mon.setDate(vn.getDate()-(day===0?6:day-1));
    const sun = new Date(mon); sun.setDate(mon.getDate()+6); return { start: s(mon), end: e(sun) };
  }
  if (type === 'next_week') {
    const day = vn.getDay(); const mon = new Date(vn); mon.setDate(vn.getDate()-(day===0?6:day-1)+7);
    const sun = new Date(mon); sun.setDate(mon.getDate()+6); return { start: s(mon), end: e(sun) };
  }
}

async function showByRange(chatId, userId, type, label, isGroup) {
  try {
    const range = getDateRange(type);
    const all = isGroup ? await db.getAllEventsForGroup(chatId) : await db.getAllEventsForChat(chatId, userId||0);
    const filtered = all.filter(function(ev) {
      const dt = new Date(ev.datetime);
      return dt >= range.start && dt <= range.end;
    }).sort(function(a,b) { return new Date(a.datetime) - new Date(b.datetime); });
    await showEvents(chatId, filtered, label);
  } catch(e) { console.error(e); bot.sendMessage(chatId, 'Loi tai lich!'); }
}

async function sendTemplateNow(chatId, userId, username, templateName, parsed, customMention) {
  const sendTime = new Date(Date.now() + 60 * 1000);
  const vnTime = new Date(sendTime.getTime() + 7 * 3600 * 1000);
  const pad = function(n) { return String(n).padStart(2, '0'); };
  const datetime = vnTime.getUTCFullYear() + '-' + pad(vnTime.getUTCMonth()+1) + '-' + pad(vnTime.getUTCDate()) + 'T' + pad(vnTime.getUTCHours()) + ':' + pad(vnTime.getUTCMinutes()) + ':00+07:00';
  let targetChatId = chatId, targetGroupName = null;
  if (parsed.target_group) {
    const group = await db.findGroupByName(parsed.target_group);
    if (group) { targetChatId = group.chat_id; targetGroupName = group.name; }
  }
  const mention = customMention || parsed.mention || null;
  const ev = await db.addEvent({ chat_id: chatId, user_id: userId, created_by: username, title: parsed.title || templateName, datetime: datetime, repeat: 'none', mention: mention, note: parsed.note || null, remind_before: '[]', target_chat_id: targetChatId });
  scheduleJob(ev);
  let replyText = 'Se gui <b>' + escHtml(templateName) + '</b> sau 1 phut!';
  if (mention) replyText += ' ' + mention;
  if (ev.note) replyText += '\n' + escHtml(ev.note);
  if (targetGroupName) replyText += '\nGui vao: <b>' + escHtml(targetGroupName) + '</b>';
  bot.sendMessage(chatId, replyText, { parse_mode: 'HTML' });
  sendMainMenu(chatId);
}

function helpText() {
  return '<b>Bot tro ly lich</b>\n\nNhan tin tu nhien:\n- hop team 2h chieu mai\n- nhac @Nam bao cao thu 2 9h\n- deadline 25/12 10h nhac truoc 30 phut\n- uong thuoc 8h sang hang ngay\n\n<b>Template:</b>\n/template tao "ten" [noi dung]\n/gui ten_template\n/template danh sach\n\nDung menu duoi de xem lich';
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
  const text = (msg.text || '').trim();
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!text || text === '/start') return sendMainMenu(chatId);
  if (text === '\uD83D\uDCC5 Hom nay') return showByRange(chatId, userId, 'today', 'Hom nay', isGroup);
  if (text === '\uD83D\uDCC5 Ngay mai') return showByRange(chatId, userId, 'tomorrow', 'Ngay mai', isGroup);
  if (text === '\uD83D\uDCC6 Tuan nay') return showByRange(chatId, userId, 'this_week', 'Tuan nay', isGroup);
  if (text === '\uD83D\uDCC6 Tuan sau') return showByRange(chatId, userId, 'next_week', 'Tuan sau', isGroup);
  if (text === '\uD83D\uDDC2 Tat ca lich') {
    const events = isGroup ? await db.getAllEventsForGroup(chatId) : await db.getAllEventsForChat(chatId, userId);
    const upcoming = events.filter(function(ev) { return ev.repeat !== 'none' || new Date(ev.datetime) > new Date(); }).sort(function(a,b) { return new Date(a.datetime)-new Date(b.datetime); });
    return showEvents(chatId, upcoming, 'Tat ca lich');
  }
  if (text === '\u2753 Huong dan') return bot.sendMessage(chatId, helpText(), { parse_mode: 'HTML' });

  if (text === '\uD83D\uDCE8 Tin co tag') {
    const templates = await db.listTemplates(userId);
    const tagged = templates.filter(function(t) { return t.data && t.data.mention; });
    if (!tagged.length) return bot.sendMessage(chatId, 'Chua co template nao co tag!\n\nTao bang: /template tao "ten" nhac @ai noi dung...', { parse_mode: 'HTML' });
    const keyboard = tagged.map(function(t) { return ['\uD83D\uDCE8 ' + t.name]; });
    keyboard.push(['\uD83D\uDD19 Quay lai']);
    return bot.sendMessage(chatId, '<b>Chon tin nhan co tag:</b>', { parse_mode: 'HTML', reply_markup: { keyboard: keyboard, resize_keyboard: true } });
  }

  if (text === '\uD83D\uDCDD Tin chua tag') {
    const templates = await db.listTemplates(userId);
    const untagged = templates.filter(function(t) { return !t.data || !t.data.mention; });
    if (!untagged.length) return bot.sendMessage(chatId, 'Chua co template nao chua tag!\n\nTao bang: /template tao "ten" noi dung...', { parse_mode: 'HTML' });
    const keyboard = untagged.map(function(t) { return ['\uD83D\uDCDD ' + t.name]; });
    keyboard.push(['\uD83D\uDD19 Quay lai']);
    return bot.sendMessage(chatId, '<b>Chon tin nhan chua tag:</b>', { parse_mode: 'HTML', reply_markup: { keyboard: keyboard, resize_keyboard: true } });
  }

  if (text === '\uD83D\uDD19 Quay lai') return sendMainMenu(chatId);

  const taggedMatch = text.match(/^\uD83D\uDCE8 (.+)$/);
  if (taggedMatch) {
    const templateName = taggedMatch[1].trim();
    const tmpl = await db.getTemplate(userId, templateName);
    if (!tmpl) return bot.sendMessage(chatId, 'Khong tim thay template!');
    return sendTemplateNow(chatId, userId, username, templateName, tmpl.data, null);
  }

  const untaggedMatch = text.match(/^\uD83D\uDCDD (.+)$/);
  if (untaggedMatch) {
    const templateName = untaggedMatch[1].trim();
    const tmpl = await db.getTemplate(userId, templateName);
    if (!tmpl) return bot.sendMessage(chatId, 'Khong tim thay template!');
    pendingTag.set(userId, { templateName: templateName, data: tmpl.data });
    return bot.sendMessage(chatId, 'Tag ai vao tin nhan <b>"' + escHtml(templateName) + '"</b>?\n\nNhap @username: <i>@Nam @Hoa</i>', { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
  }

  if (pendingTag.has(userId) && text.startsWith('@')) {
    const pending = pendingTag.get(userId);
    pendingTag.delete(userId);
    return sendTemplateNow(chatId, userId, username, pending.templateName, pending.data, text);
  }

  const deleteMatch = text.match(/^\/delete[_ ](\d+)$/i);
  if (deleteMatch) {
    const id = parseInt(deleteMatch[1]);
    const ok = await db.deleteEventByChat(id, chatId);
    if (schedule.scheduledJobs['event_' + id]) schedule.scheduledJobs['event_' + id].cancel();
    return bot.sendMessage(chatId, ok ? 'Da xoa lich #' + id : 'Khong tim thay lich #' + id);
  }

  try {
    await bot.sendChatAction(chatId, 'typing');
    const parsed = await parseEventFromText(text);
    if (parsed.action === 'help') return bot.sendMessage(chatId, helpText(), { parse_mode: 'HTML' });
    if (parsed.action === 'today') return showByRange(chatId, userId, 'today', 'Hom nay', isGroup);
    if (parsed.action === 'tomorrow') return showByRange(chatId, userId, 'tomorrow', 'Ngay mai', isGroup);
    if (parsed.action === 'this_week') return showByRange(chatId, userId, 'this_week', 'Tuan nay', isGroup);
    if (parsed.action === 'next_week') return showByRange(chatId, userId, 'next_week', 'Tuan sau', isGroup);
    if (parsed.action === 'list') {
      const events = isGroup ? await db.getAllEventsForGroup(chatId) : await db.getAllEventsForChat(chatId, userId);
      const upcoming = events.filter(function(ev) { return ev.repeat !== 'none' || new Date(ev.datetime) > new Date(); }).sort(function(a,b) { return new Date(a.datetime)-new Date(b.datetime); });
      return showEvents(chatId, upcoming, 'Tat ca lich');
    }
    if (parsed.action === 'create') {
      if (!parsed.datetime) return bot.sendMessage(chatId, 'Chua ro thoi gian. Vi du: hop team 2h chieu mai');
      const remindBefore = Array.isArray(parsed.remind_before) ? parsed.remind_before : [];
      let targetChatId = chatId, targetGroupName = null;
      if (parsed.target_group) {
        const group = await db.findGroupByName(parsed.target_group);
        if (group) { targetChatId = group.chat_id; targetGroupName = group.name; }
        else return bot.sendMessage(chatId, 'Khong tim thay nhom "' + escHtml(parsed.target_group) + '"! Vao nhom do gox /getid truoc.', { parse_mode: 'HTML' });
      }
      const ev = await db.addEvent({ chat_id: chatId, user_id: userId, created_by: username, title: parsed.title, datetime: parsed.datetime, repeat: parsed.repeat || 'none', mention: parsed.mention || null, note: parsed.note || null, remind_before: JSON.stringify(remindBefore), target_chat_id: targetChatId });
      scheduleJob(ev);
      const dt = new Date(parsed.datetime);
      const remindText = remindBefore.length > 0 ? '\n\u23F0 Nhac truoc: ' + remindBefore.map(function(m) { return m >= 60 ? m/60 + ' tieng' : m + ' phut'; }).join(', ') : '';
      const groupText = targetGroupName ? '\n\uD83D\uDCE2 Gui vao: <b>' + escHtml(targetGroupName) + '</b>' : '';
      let reply = '\u2705 <b>Da tao lich!</b>\n\n\uD83D\uDCCC <b>' + escHtml(ev.title) + '</b>\n\uD83D\uDD50 ' + formatDateTime(dt) + '\n' + repeatLabel(ev.repeat) + '\n';
      if (ev.mention) reply += '\uD83D\uDC64 ' + ev.mention + '\n';
      reply += remindText;
      if (ev.note) reply += '\n\uD83D\uDCDD ' + escHtml(ev.note);
      reply += groupText + '\n\nBot se nhac dung gio';
      return bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
    }
    return bot.sendMessage(chatId, 'Chua hieu. Thu: hop team 3h chieu mai');
  } catch(err) { console.error('Loi:', err.message); bot.sendMessage(chatId, 'Co loi xay ra, thu lai sau!'); }
}

bot.on('callback_query', async function(query) {
  const chatId = query.message.chat.id;
  if (query.data.startsWith('del_')) {
    const id = parseInt(query.data.replace('del_', ''));
    const ok = await db.deleteEventByChat(id, chatId);
    const suffixes = ['', '_before_10', '_before_20', '_before_30', '_before_60'];
    for (const s of suffixes) { const j = 'event_' + id + s; if (schedule.scheduledJobs[j]) schedule.scheduledJobs[j].cancel(); }
    await bot.answerCallbackQuery(query.id, { text: ok ? 'Da xoa!' : 'Khong tim thay!' });
    if (ok) { try { await bot.editMessageText('Da xoa lich nay', { chat_id: chatId, message_id: query.message.message_id }); } catch(e) {} }
  }
});

bot.onText(/\/start/, function(msg) { sendMainMenu(msg.chat.id); });
bot.onText(/\/today/, function(msg) { showByRange(msg.chat.id, msg.from.id, 'today', 'Hom nay', msg.chat.type === 'group' || msg.chat.type === 'supergroup'); });
bot.onText(/\/list/, async function(msg) {
  const isGrp = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const events = isGrp ? await db.getAllEventsForGroup(msg.chat.id) : await db.getAllEventsForChat(msg.chat.id, msg.from.id);
  showEvents(msg.chat.id, events.filter(function(ev) { return ev.repeat !== 'none' || new Date(ev.datetime) > new Date(); }), 'Tat ca lich');
});
bot.onText(/\/help/, function(msg) { bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'HTML' }); });
bot.onText(/\/getid/, async function(msg) {
  const chatId = msg.chat.id;
  const chatName = msg.chat.title || msg.chat.first_name || 'Chat nay';
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') await db.registerGroup(chatId, chatName);
  bot.sendMessage(chatId, '<b>' + escHtml(chatName) + '</b>\nChat ID: <code>' + chatId + '</code>\n\nDa dang ky nhom nay!', { parse_mode: 'HTML' });
});

bot.onText(/\/template (.+)/, async function(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const input = match[1].trim();
  const createMatch = input.match(/^t[ao]o\s+"([^"]+)"\s+(.+)/i);
  if (createMatch) {
    const name = createMatch[1];
    const templateContent = createMatch[2];
    try {
      await bot.sendChatAction(chatId, 'typing');
      const parsed = await parseEventFromText(templateContent + ' luc 12h trua');
      delete parsed.datetime;
      parsed.action = 'create';
      await db.saveTemplate(userId, name, parsed);
      const tagInfo = parsed.mention ? ' (co tag: ' + parsed.mention + ')' : ' (chua co tag)';
      return bot.sendMessage(chatId, 'Da luu template <b>"' + escHtml(name) + '"</b>' + tagInfo + '!\n\nDung: <code>/gui ' + name + '</code>', { parse_mode: 'HTML' });
    } catch(e) { console.error('Template error:', e.message); return bot.sendMessage(chatId, 'Loi tao template!'); }
    const templates = await db.listTemplates(userId);
    if (!templates.length) return bot.sendMessage(chatId, 'Chua co template nao!\n\nTao: <code>/template tao "ten" noi dung</code>', { parse_mode: 'HTML' });
    const lines = templates.map(function(t, i) { return (i+1) + '. <b>' + escHtml(t.name) + '</b>' + (t.data && t.data.mention ? ' \uD83D\uDCE8' : ' \uD83D\uDCDD'); }).join('\n');
    return bot.sendMessage(chatId, '<b>Danh sach template:</b>\n\n' + lines + '\n\nDung: <code>/gui ten_template</code>', { parse_mode: 'HTML' });
  }
  const delMatch = input.match(/^xoa\s+"?([^"]+)"?/i);
  if (delMatch) {
    const ok = await db.deleteTemplate(userId, delMatch[1].trim());
    return bot.sendMessage(chatId, ok ? 'Da xoa template <b>"' + escHtml(delMatch[1]) + '"</b>!' : 'Khong tim thay template!', { parse_mode: 'HTML' });
  }
  return bot.sendMessage(chatId, '<b>Cach dung template:</b>\nTao: <code>/template tao "ten" [noi dung]</code>\nGui: <code>/gui ten</code>\nXem: <code>/template danh sach</code>\nXoa: <code>/template xoa "ten"</code>', { parse_mode: 'HTML' });
});

bot.onText(/\/gui (.+)/, async function(msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? '@' + msg.from.username : msg.from.first_name;
  const templateName = match[1].trim();
  const tmpl = await db.getTemplate(userId, templateName);
  if (!tmpl) return bot.sendMessage(chatId, 'Khong tim thay template <b>"' + escHtml(templateName) + '"</b>!\n<code>/template danh sach</code>', { parse_mode: 'HTML' });
  return sendTemplateNow(chatId, userId, username, templateName, tmpl.data, null);
});

bot.on('new_chat_members', async function(msg) {
  const botInfo = await bot.getMe();
  if (msg.new_chat_members.some(function(m) { return m.id === botInfo.id; }) && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
    await db.registerGroup(msg.chat.id, msg.chat.title);
    bot.sendMessage(msg.chat.id, 'Xin chao! Da dang ky nhom <b>' + escHtml(msg.chat.title) + '</b>', { parse_mode: 'HTML' });
  }
});

bot.on('message', function(msg) {
  if (!msg.text) return;
  const text = msg.text.trim();
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const isMentioned = text.toLowerCase().includes(BOT_USERNAME.toLowerCase());
    const isCommand = text.startsWith('/');
    const menuBtns = ['\uD83D\uDCC5 Hom nay', '\uD83D\uDCC5 Ngay mai', '\uD83D\uDCC6 Tuan nay', '\uD83D\uDCC6 Tuan sau', '\uD83D\uDDC2 Tat ca lich', '\u2753 Huong dan', '\uD83D\uDCE8 Tin co tag', '\uD83D\uDCDD Tin chua tag', '\uD83D\uDD19 Quay lai'];
    const isMenuBtn = menuBtns.includes(text);
    if (!isMentioned && !isCommand && !isMenuBtn) return;
    msg.text = text.replace(new RegExp(BOT_USERNAME, 'gi'), '').trim();
  }
  if (!msg.text.startsWith('/')) handleMessage(msg);
});

restoreJobs();
console.log('Bot nhac lich dang chay (Groq AI)...');
