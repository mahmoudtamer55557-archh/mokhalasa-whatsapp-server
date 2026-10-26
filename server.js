const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'mokhalasa_secret_otp_key_2026';
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

app.use(cors());
app.use(express.json());

// Global state
let sock = null;
let currentQrRaw = null;
let currentQrDataUrl = null;
let connectionStatus = 'disconnected'; // 'connecting' | 'qr_ready' | 'connected' | 'disconnected'
let connectedUser = null;
let reconnectAttempts = 0;

// Format phone number to WhatsApp JID (Egyptian numbers: 01xxxxxxxxx -> 201xxxxxxxxx@s.whatsapp.net)
function formatPhoneToJid(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('20')) {
    // already 201...
  } else if (cleaned.startsWith('01')) {
    cleaned = '20' + cleaned.substring(1);
  } else if (cleaned.startsWith('1') && cleaned.length === 10) {
    cleaned = '20' + cleaned;
  }
  return `${cleaned}@s.whatsapp.net`;
}

// Initialize Baileys WhatsApp Socket
async function connectToWhatsApp() {
  connectionStatus = 'connecting';
  console.log('[WhatsApp Gateway] Starting connection to WhatsApp Multi-Device...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: true,
      browser: ['Mokhalasa OTP Gateway', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        try {
          currentQrDataUrl = await qrcode.toDataURL(qr, { margin: 2, scale: 7 });
          connectionStatus = 'qr_ready';
          console.log('[WhatsApp Gateway] New QR code generated. Waiting for scan...');
        } catch (err) {
          console.error('[WhatsApp Gateway] QR generation error:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.warn(`[WhatsApp Gateway] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

        connectionStatus = 'disconnected';
        currentQrRaw = null;
        currentQrDataUrl = null;
        connectedUser = null;

        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 3000, 15000);
          console.log(`[WhatsApp Gateway] Reconnecting in ${delay / 1000}s...`);
          setTimeout(connectToWhatsApp, delay);
        } else {
          console.log('[WhatsApp Gateway] Session logged out. Cleaning up credentials...');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
          setTimeout(connectToWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        connectionStatus = 'connected';
        currentQrRaw = null;
        currentQrDataUrl = null;
        connectedUser = sock?.user?.id ? sock.user.id.split(':')[0] : 'Connected';
        console.log(`[WhatsApp Gateway] Connected successfully as: ${connectedUser}`);
      }
    });

  } catch (err) {
    console.error('[WhatsApp Gateway] Initialization error:', err);
    connectionStatus = 'disconnected';
    setTimeout(connectToWhatsApp, 5000);
  }
}

// Security Middleware (optional API Key verification)
function checkAuth(req, res, next) {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  // If API_KEY is set and client provided a key, verify it
  if (API_KEY && providedKey && providedKey !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Key' });
  }
  next();
}

// -----------------------------------------------------------------------------
// REST API ENDPOINTS
// -----------------------------------------------------------------------------

// Status Endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    connectedUser,
    hasQr: !!currentQrDataUrl,
    timestamp: new Date().toISOString()
  });
});

// QR Code Raw Image Endpoint
app.get('/api/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ status: 'connected', message: 'Already connected to WhatsApp.' });
  }
  if (!currentQrDataUrl) {
    return res.status(503).json({ status: 'waiting', message: 'QR Code is generating, please refresh in 2 seconds.' });
  }
  res.json({
    status: 'qr_ready',
    qrDataUrl: currentQrDataUrl
  });
});

// Send OTP Endpoint
app.post('/api/send-otp', checkAuth, async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ success: false, error: 'Both phone and code are required.' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp Gateway is not connected. Please scan the QR code first.'
    });
  }

  const jid = formatPhoneToJid(phone);
  if (!jid) {
    return res.status(400).json({ success: false, error: 'Invalid Egyptian phone number.' });
  }

  const otpMessage = 
    `🔒 *منصة مخلصة | Mokhalasa*\n` +
    `رمز التحقق الخاص بك لتأكيد الحساب هو:\n\n` +
    `👉 *${code}* 👈\n\n` +
    `⏱️ الكود صالح لمدة 5 دقائق فقط.\n` +
    `⚠️ تنبيه: لا تشارك هذا الرمز مع أي شخص لحماية حسابك وبياناتك.`;

  try {
    const result = await sock.sendMessage(jid, { text: otpMessage });
    console.log(`[WhatsApp Gateway] OTP sent to ${jid} (ID: ${result?.key?.id})`);
    return res.json({
      success: true,
      messageId: result?.key?.id,
      phone: jid.split('@')[0]
    });
  } catch (err) {
    console.error(`[WhatsApp Gateway] Failed to send OTP to ${jid}:`, err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to send WhatsApp message' });
  }
});

// Send General Message Endpoint (for Alerts & Notifications)
app.post('/api/send-message', checkAuth, async (req, res) => {
  const { phone, text, message } = req.body;
  const content = text || message;

  if (!phone || !content) {
    return res.status(400).json({ success: false, error: 'Both phone and message text are required.' });
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp Gateway is not connected. Please scan the QR code first.'
    });
  }

  const jid = formatPhoneToJid(phone);
  if (!jid) {
    return res.status(400).json({ success: false, error: 'Invalid phone number.' });
  }

  try {
    const result = await sock.sendMessage(jid, { text: content });
    console.log(`[WhatsApp Gateway] Message sent to ${jid}`);
    return res.json({
      success: true,
      messageId: result?.key?.id
    });
  } catch (err) {
    console.error(`[WhatsApp Gateway] Failed to send message to ${jid}:`, err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to send message' });
  }
});

// Interactive Web Dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>بوابة واتساب مخلصة | Mokhalasa WhatsApp Gateway</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Cairo', sans-serif; }
    body { background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 28px; max-width: 480px; width: 100%; padding: 32px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); text-align: center; }
    .logo { display: inline-flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 900; color: #10b981; margin-bottom: 8px; }
    .subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 6px 16px; border-radius: 9999px; font-size: 12px; font-weight: 700; margin-bottom: 20px; }
    .badge.connected { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge.waiting { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge.disconnected { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .qr-container { background: #ffffff; padding: 16px; border-radius: 20px; display: inline-block; margin-bottom: 20px; min-width: 260px; min-height: 260px; display: flex; align-items: center; justify-content: center; }
    .qr-container img { width: 240px; height: 240px; display: block; border-radius: 12px; }
    .instructions { font-size: 12px; color: #cbd5e1; line-height: 1.8; text-align: right; background: #0f172a; padding: 16px; border-radius: 16px; border: 1px solid #334155; margin-bottom: 20px; }
    .test-box { background: #0f172a; padding: 16px; border-radius: 16px; border: 1px solid #334155; margin-top: 16px; text-align: right; }
    .test-box input { width: 100%; padding: 10px 14px; border-radius: 10px; border: 1px solid #334155; background: #1e293b; color: #fff; font-size: 13px; margin-top: 6px; margin-bottom: 10px; direction: ltr; text-align: right; }
    .btn { background: #10b981; color: #022c22; font-weight: 900; font-size: 13px; padding: 12px 20px; border-radius: 12px; border: none; cursor: pointer; width: 100%; transition: all 0.2s; }
    .btn:hover { background: #059669; color: #fff; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #test-feedback { margin-top: 8px; font-size: 12px; font-weight: 700; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span>⚡ مخلّصة</span>
      <span style="color:#94a3b8; font-weight:400;">| بوابة واتساب</span>
    </div>
    <p class="subtitle">نظام إرسال رموز التحقق (OTP) والتنبيهات المباشرة</p>

    <div id="status-badge" class="badge waiting">جاري فحص الاتصال...</div>

    <div id="qr-section" style="display:none;">
      <div class="qr-container">
        <img id="qr-img" src="" alt="WhatsApp QR Code">
      </div>
      <div class="instructions">
        <strong>📱 خطوات ربط رقمك بالمنصة:</strong><br>
        1. افتح تطبيق الواتساب على موبايلك.<br>
        2. اضغط على القائمة (الثلاث نقاط) أو الإعدادات.<br>
        3. اختر <strong>الأجهزة المرتبطة (Linked Devices)</strong>.<br>
        4. اضغط <strong>ربط جهاز</strong> ووجّه الكاميرا نحو الـ QR Code أعلاه.
      </div>
    </div>

    <div id="connected-section" style="display:none;">
      <div style="background: rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3); border-radius:16px; padding:20px; margin-bottom:16px;">
        <div style="font-size:36px; margin-bottom:8px;">✅</div>
        <h3 style="font-size:16px; font-weight:900; color:#34d399; margin-bottom:4px;">متصل وجاهز للعمل بنجاح!</h3>
        <p style="font-size:12px; color:#94a3b8;" id="connected-phone">الرقم المتصل: جاري التحميل...</p>
      </div>

      <div class="test-box">
        <strong style="font-size:12px; color:#f8fafc;">🧪 اختبار إرسال كود OTP تجريبي:</strong>
        <input type="tel" id="test-phone" placeholder="010xxxxxxxx" />
        <button class="btn" id="test-btn" onclick="sendTestOtp()">إرسال كود تجريبي لهاتفي الآن</button>
        <div id="test-feedback"></div>
      </div>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const badge = document.getElementById('status-badge');
        const qrSection = document.getElementById('qr-section');
        const connectedSection = document.getElementById('connected-section');

        if (data.status === 'connected') {
          badge.className = 'badge connected';
          badge.innerText = '🟢 متصل بالواتساب';
          qrSection.style.display = 'none';
          connectedSection.style.display = 'block';
          document.getElementById('connected-phone').innerText = 'الرقم المربوط: ' + (data.connectedUser || 'نشط');
        } else {
          connectedSection.style.display = 'none';
          // fetch QR
          const qrRes = await fetch('/api/qr');
          const qrData = await qrRes.json();
          if (qrData.status === 'qr_ready' && qrData.qrDataUrl) {
            badge.className = 'badge waiting';
            badge.innerText = '🟡 بانتظار مسح الـ QR Code';
            document.getElementById('qr-img').src = qrData.qrDataUrl;
            qrSection.style.display = 'block';
          } else {
            badge.className = 'badge disconnected';
            badge.innerText = '⏳ جاري تجهيز الـ QR Code...';
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function sendTestOtp() {
      const phone = document.getElementById('test-phone').value.trim();
      const fb = document.getElementById('test-feedback');
      const btn = document.getElementById('test-btn');

      if (!phone) {
        fb.style.color = '#f87171';
        fb.innerText = 'يرجى إدخال رقم الهاتف أولاً.';
        return;
      }

      btn.disabled = true;
      fb.style.color = '#fbbf24';
      fb.innerText = 'جاري الإرسال عبر الواتساب...';

      try {
        const res = await fetch('/api/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code: Math.floor(1000 + Math.random() * 9000).toString() })
        });
        const data = await res.json();
        if (data.success) {
          fb.style.color = '#34d399';
          fb.innerText = '🎉 تم إرسال رسالة الـ OTP بنجاح! راجع هاتفك.';
        } else {
          fb.style.color = '#f87171';
          fb.innerText = 'خطأ: ' + (data.error || 'تعذر الإرسال');
        }
      } catch (err) {
        fb.style.color = '#f87171';
        fb.innerText = 'فشل الاتصال بالسيرفر.';
      } finally {
        btn.disabled = false;
      }
    }

    setInterval(checkStatus, 3500);
    checkStatus();
  </script>
</body>
</html>`);
});

// Start Server & Connect
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Mokhalasa WhatsApp Gateway running on port: ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`=======================================================`);
  connectToWhatsApp();
});
