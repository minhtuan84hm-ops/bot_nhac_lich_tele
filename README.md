# 🤖 Bot Nhắc Lịch Telegram

Bot Telegram nhắc lịch thông minh — hiểu ngôn ngữ tự nhiên tiếng Việt nhờ Claude AI.

## Tính năng

- 💬 Nhận lịch qua chat tự nhiên (không cần format cứng)
- 🔔 Tự động nhắc đúng giờ trong group
- 🔁 Hỗ trợ lặp lại: hàng ngày, hàng tuần
- 👤 Tag mention thành viên khi nhắc
- 📋 Xem danh sách lịch hôm nay / sắp tới
- 💾 Lưu dữ liệu bằng SQLite

---

## Cài đặt nhanh (15 phút)

### Bước 1: Tạo Telegram Bot

1. Mở Telegram, tìm **@BotFather**
2. Gõ `/newbot` → đặt tên → đặt username (kết thúc bằng `_bot`)
3. Copy **Bot Token** được cấp

### Bước 2: Lấy Anthropic API Key

1. Vào https://console.anthropic.com
2. Tạo API Key mới
3. Copy key

### Bước 3: Deploy lên Railway (miễn phí)

1. **Fork/upload code** lên GitHub repo mới
2. Vào https://railway.app → **New Project** → **Deploy from GitHub repo**
3. Chọn repo vừa tạo
4. Vào tab **Variables**, thêm:
   ```
   TELEGRAM_BOT_TOKEN = <token từ BotFather>
   ANTHROPIC_API_KEY  = <key từ Anthropic>
   ```
5. Railway tự động deploy — xong! ✅

> **Lưu ý Railway:** Free tier ngủ sau 30 phút không dùng.
> Nâng lên $5/tháng để chạy 24/7 không gián đoạn.

### Deploy lên Render (thay thế)

1. Vào https://render.com → **New Web Service**
2. Connect GitHub repo
3. Build Command: `npm install`
4. Start Command: `node bot.js`
5. Thêm Environment Variables tương tự

---

## Chạy local để test

```bash
# Clone repo
git clone <your-repo>
cd telegram-calendar-bot

# Cài dependencies
npm install

# Tạo file .env
cp .env.example .env
# Điền TELEGRAM_BOT_TOKEN và ANTHROPIC_API_KEY vào .env

# Chạy bot
npm start

# Hoặc dev mode (tự reload khi sửa code)
npm run dev
```

---

## Cách dùng trong group

### Thêm bot vào group
1. Mở group → **Add Member** → tìm username bot
2. Cấp quyền **Admin** (để bot gửi được message)

### Nhắn tin tự nhiên

```
họp team 2h chiều mai
nhắc @Tuấn báo cáo thứ 2 tuần sau 9h sáng
uống thuốc 8h sáng hàng ngày
deadline project ngày 25 tháng 12 lúc 10h
```

### Lệnh nhanh

| Lệnh | Tác dụng |
|------|----------|
| `/today` | Xem lịch hôm nay |
| `/list` | Xem tất cả lịch sắp tới |
| `/help` | Hướng dẫn sử dụng |

---

## Cấu trúc code

```
telegram-calendar-bot/
├── bot.js          # Logic chính: nhận tin, gọi Claude, lên lịch
├── db.js           # Database layer (SQLite)
├── package.json
├── railway.json    # Config deploy Railway
├── Procfile        # Config deploy Render/Heroku
├── .env.example    # Mẫu biến môi trường
└── README.md
```

---

## Tuỳ chỉnh

**Đổi múi giờ:** Tìm `Asia/Ho_Chi_Minh` trong `bot.js` và thay bằng timezone mày muốn.

**Đổi ngôn ngữ nhắc:** Sửa phần `msg` trong hàm `scheduleJob()` ở `bot.js`.

**Thêm lệnh mới:** Thêm `bot.onText(/\/lệnh/, handler)` vào cuối `bot.js`.
