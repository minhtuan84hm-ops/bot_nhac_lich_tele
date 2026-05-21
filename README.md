# 🤖 Bot Nhắc Lịch Telegram (Gemini AI - Miễn phí)

Bot Telegram nhắc lịch thông minh — hiểu ngôn ngữ tự nhiên tiếng Việt nhờ **Google Gemini AI (miễn phí hoàn toàn)**.

---

## Cài đặt nhanh (15 phút)

### Bước 1: Tạo Telegram Bot

1. Mở Telegram → tìm **@BotFather**
2. Gõ `/newbot` → đặt tên → đặt username (kết thúc `_bot`)
3. Copy **Bot Token** được cấp (dạng `123456:ABC-DEF...`)

### Bước 2: Lấy Gemini API Key (MIỄN PHÍ)

1. Vào https://aistudio.google.com/app/apikey
2. Đăng nhập Google
3. Nhấn **"Create API key"** → chọn project hoặc tạo mới
4. Copy key (dạng `AIzaSy...`)

> ✅ Miễn phí 15 request/phút, 1 triệu token/ngày — đủ dùng thoải mái

### Bước 3: Deploy lên Railway (miễn phí)

1. **Push code** lên GitHub repo mới
2. Vào https://railway.app → **New Project** → **Deploy from GitHub repo**
3. Chọn repo vừa tạo
4. Vào tab **Variables**, thêm 2 biến:
   ```
   TELEGRAM_BOT_TOKEN = <token từ BotFather>
   GEMINI_API_KEY     = <key từ Google AI Studio>
   ```
5. Railway tự build và deploy ✅

---

## Chạy local để test

```bash
# Cài dependencies
npm install

# Tạo file .env
cp .env.example .env
# Mở .env và điền TELEGRAM_BOT_TOKEN + GEMINI_API_KEY

# Chạy bot
npm start
```

---

## Cách dùng trong group

### Thêm bot vào group
1. Mở group → **Add Member** → tìm username bot của mày
2. Cấp quyền **Admin** để bot gửi được tin nhắn

### Nhắn tin tự nhiên — ví dụ thực tế

```
họp team 2h chiều mai
nhắc @Tuấn nộp báo cáo thứ 2 tuần sau 9h sáng
uống thuốc 8h sáng hàng ngày
deadline project ngày 25/12 lúc 10h
tối nay 8h gọi khách VIP
```

### Lệnh nhanh

| Lệnh | Tác dụng |
|------|----------|
| `/today` | Xem lịch hôm nay |
| `/list` | Xem tất cả lịch sắp tới (kèm ID) |
| `/delete_3` | Xóa lịch có ID = 3 |
| `/help` | Hướng dẫn sử dụng |

---

## Cấu trúc code

```
telegram-calendar-bot/
├── bot.js          # Logic chính: nhận tin, gọi Gemini, lên lịch nhắc
├── db.js           # Database SQLite (lưu lịch)
├── package.json
├── railway.json    # Config Railway
├── Procfile        # Config Render
├── .env.example    # Mẫu biến môi trường
└── README.md
```

---

## Giới hạn Gemini free tier

| Chỉ số | Giới hạn |
|--------|----------|
| Request/phút | 15 |
| Token/ngày | 1,000,000 |
| Chi phí | $0 |

Với bot nhóm chat bình thường (~50-100 tin/ngày), hoàn toàn không chạm giới hạn.
