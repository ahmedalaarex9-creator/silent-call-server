require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));

if (!process.env.FIREBASE_PROJECT_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('Firebase is not configured. Set FIREBASE_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS before use.');
}
try {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
} catch (e) { console.error('Firebase Admin initialization failed:', e.message); }

// Demo persistence for a single-server deployment. Use a real database and auth controls before public production.
const users = new Map();
const recentCalls = new Map();
const ONLINE_MS = 35_000;
function makeId() { let id; do { id = String(10000000 + crypto.randomInt(0, 90000000)); } while (users.has(id)); return id; }
function jsonError(res, status, error) { return res.status(status).json({ error }); }
function isOnline(user) { return !!user && !!user.lastSeen && Date.now() - user.lastSeen <= ONLINE_MS; }
async function push(user, data) {
  if (!user?.fcmToken) return false;
  if (!admin.apps.length) throw new Error('Firebase Admin is not configured on the server');
  await admin.messaging().send({ token: user.fcmToken, data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v ?? '')])), android: { priority: 'high' } });
  return true;
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'Silent Call' }));
app.post('/api/register', (req, res) => {
  const fcmToken = String(req.body?.fcmToken || '').trim();
  if (!fcmToken) return jsonError(res, 400, 'تعذر التسجيل: رمز إشعارات الجهاز مفقود');
  const userId = makeId();
  users.set(userId, { userId, fcmToken, lastSeen: Date.now(), createdAt: Date.now() });
  return res.json({ userId });
});
app.post('/api/token', (req, res) => {
  const id = String(req.body?.userId || '');
  const token = String(req.body?.fcmToken || '').trim();
  const user = users.get(id);
  if (!user) return jsonError(res, 404, 'الحساب غير موجود على الخادم الحالي');
  if (!token) return jsonError(res, 400, 'رمز الإشعارات مفقود');
  user.fcmToken = token; user.lastSeen = Date.now();
  res.json({ ok: true });
});
app.post('/api/presence', (req, res) => {
  const user = users.get(String(req.body?.userId || ''));
  if (!user) return jsonError(res, 404, 'الحساب غير موجود');
  user.lastSeen = Date.now(); res.json({ online: true });
});
app.post('/api/call', async (req, res) => {
  const from = String(req.body?.from || '');
  const to = String(req.body?.to || '');
  const message = String(req.body?.message || 'تنبيه وارد').slice(0, 180);
  if (!users.has(from)) return jsonError(res, 401, 'حساب المرسل غير معروف');
  if (from === to) return jsonError(res, 400, 'لا يمكنك الاتصال بنفسك');
  const target = users.get(to);
  if (!target || !isOnline(target)) return res.json({ ringing: false, status: 'unavailable' });
  try {
    await push(target, { type: 'incoming_call', from, message, timestamp: Date.now() });
    res.json({ ringing: true, status: 'sent' });
  } catch (e) { console.error('FCM call send failed:', e.message); res.json({ ringing: false, status: 'unavailable' }); }
});
app.post('/api/alarm', async (req, res) => {
  const from = String(req.body?.from || '');
  const to = String(req.body?.to || '');
  const at = Number(req.body?.at);
  const message = String(req.body?.message || 'حان موعد المنبّه').slice(0, 180);
  if (!users.has(from)) return jsonError(res, 401, 'حساب المرسل غير معروف');
  if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + 366 * 24 * 60 * 60 * 1000) return jsonError(res, 400, 'وقت المنبّه غير صالح');
  const target = users.get(to);
  if (!target || !isOnline(target)) return res.json({ sent: false, status: 'unavailable' });
  try {
    const alarmId = crypto.randomUUID();
    await push(target, { type: 'schedule_alarm', from, alarmId, at, message });
    res.json({ sent: true, alarmId });
  } catch (e) { console.error('FCM alarm send failed:', e.message); res.json({ sent: false, status: 'unavailable' }); }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, '0.0.0.0', () => console.log(`Silent Call server listening on ${port}`));
