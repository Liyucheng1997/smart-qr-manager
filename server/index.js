import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, genId } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'smart-qr-dev-secret-change-me';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const isProd = process.env.NODE_ENV === 'production';

if (isProd && JWT_SECRET === 'smart-qr-dev-secret-change-me') {
  console.warn('[警告] 生产环境未设置 JWT_SECRET，请在环境变量中配置一个随机密钥！');
}

// Cookie options — secure flag enabled in production (served over HTTPS)
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7 * 24 * 60 * 60 * 1000 };

const app = express();
app.set('trust proxy', 1); // behind Nginx/Cloudflare — trust X-Forwarded-* headers
app.use(express.json({ limit: '6mb' }));
app.use(cookieParser());

const FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'select', 'radio', 'checkbox', 'date'];
const THEMES = ['classic', 'business', 'elegant', 'vibrant', 'nature', 'dark'];
const cleanTheme = (t) => (THEMES.includes(t) ? t : 'classic');

// Normalize/validate a user-designed field schema
function sanitizeFields(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((f) => f && f.label)
    .slice(0, 30)
    .map((f) => {
      const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
      const field = {
        id: typeof f.id === 'string' && f.id ? f.id : genId(6),
        label: String(f.label).slice(0, 120),
        type,
        required: !!f.required,
      };
      if (['select', 'radio', 'checkbox'].includes(type)) {
        field.options = (Array.isArray(f.options) ? f.options : [])
          .map((o) => String(o).slice(0, 120))
          .filter(Boolean)
          .slice(0, 30);
      }
      return field;
    });
}

// ---------- Helpers ----------
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期' });
  }
}

function detectDevice(ua = '') {
  const s = ua.toLowerCase();
  if (/tablet|ipad|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s)))
    return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile/.test(s)) return 'mobile';
  return 'desktop';
}

// ---------- Auth API ----------
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (db.findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已注册' });

  const user = {
    id: genId(10),
    name: name || String(email).split('@')[0],
    email,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: Date.now(),
  };
  db.createUser(user);
  res.cookie('token', signToken(user), COOKIE_OPTS);
  res.json({ id: user.id, name: user.name, email: user.email });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.findUserByEmail(email || '');
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash)))
    return res.status(401).json({ error: '邮箱或密码错误' });
  res.cookie('token', signToken(user), COOKIE_OPTS);
  res.json({ id: user.id, name: user.name, email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: isProd });
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email });
});

// Account info + all of the user's projects (QR codes and forms)
app.get('/api/profile', authMiddleware, (req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const qrcodes = db.listQrcodes(user.id).map((q) => ({
    id: q.id,
    title: q.title,
    target: q.target,
    createdAt: q.createdAt,
    scanCount: db.scansFor(q.id).length,
  }));
  const forms = db.listForms(user.id).map((f) => ({
    id: f.id,
    title: f.title,
    theme: f.theme || 'classic',
    fieldCount: (f.fields || []).length,
    createdAt: f.createdAt,
    submissionCount: db.submissionsFor(f.id).length,
  }));

  res.json({
    user: { name: user.name, email: user.email, createdAt: user.createdAt },
    stats: {
      qrCount: qrcodes.length,
      formCount: forms.length,
      totalScans: qrcodes.reduce((s, q) => s + q.scanCount, 0),
      totalSubmissions: forms.reduce((s, f) => s + f.submissionCount, 0),
    },
    qrcodes,
    forms,
  });
});

// ---------- QR code API ----------
app.get('/api/qrcodes', authMiddleware, (req, res) => {
  const list = db.listQrcodes(req.user.id).map((q) => {
    const scans = db.scansFor(q.id);
    return { ...q, scanCount: scans.length, redirectUrl: `${BASE_URL}/r/${q.id}` };
  });
  res.json(list);
});

app.post('/api/qrcodes', authMiddleware, (req, res) => {
  const { title, target } = req.body || {};
  if (!title || !target) return res.status(400).json({ error: '标题和目标链接必填' });
  let url = String(target).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const qr = {
    id: genId(8),
    userId: req.user.id,
    title: String(title).trim(),
    target: url,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createQrcode(qr);
  res.json({ ...qr, redirectUrl: `${BASE_URL}/r/${qr.id}` });
});

app.get('/api/qrcodes/:id', authMiddleware, (req, res) => {
  const qr = db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const scans = db.scansFor(qr.id);
  res.json({ ...qr, scanCount: scans.length, redirectUrl: `${BASE_URL}/r/${qr.id}` });
});

app.put('/api/qrcodes/:id', authMiddleware, (req, res) => {
  const qr = db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const patch = { updatedAt: Date.now() };
  if (req.body.title != null) patch.title = String(req.body.title).trim();
  if (req.body.target != null) {
    let url = String(req.body.target).trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    patch.target = url;
  }
  const updated = db.updateQrcode(qr.id, patch);
  res.json({ ...updated, redirectUrl: `${BASE_URL}/r/${updated.id}` });
});

app.delete('/api/qrcodes/:id', authMiddleware, (req, res) => {
  const qr = db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  db.deleteQrcode(qr.id);
  res.json({ ok: true });
});

// QR image (PNG) of the tracked redirect URL
app.get('/api/qrcodes/:id/image', authMiddleware, async (req, res) => {
  const qr = db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  try {
    const png = await QRCode.toBuffer(`${BASE_URL}/r/${qr.id}`, {
      width: 512,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('png').send(png);
  } catch {
    res.status(500).json({ error: '生成失败' });
  }
});

// Stats: counts, daily trend, device breakdown
app.get('/api/qrcodes/:id/stats', authMiddleware, (req, res) => {
  const qr = db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const scans = db.scansFor(qr.id);

  // Daily trend for the last 14 days
  const days = 14;
  const trend = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    trend.push({ date: key, count: 0 });
  }
  const trendMap = Object.fromEntries(trend.map((t) => [t.date, t]));

  const devices = { mobile: 0, tablet: 0, desktop: 0 };
  for (const s of scans) {
    const key = new Date(s.at).toISOString().slice(0, 10);
    if (trendMap[key]) trendMap[key].count++;
    if (devices[s.device] != null) devices[s.device]++;
  }

  // Today vs total
  const todayKey = today.toISOString().slice(0, 10);
  const todayCount = scans.filter((s) => new Date(s.at).toISOString().slice(0, 10) === todayKey).length;

  const last = scans.length ? Math.max(...scans.map((s) => s.at)) : null;

  res.json({
    id: qr.id,
    title: qr.title,
    total: scans.length,
    today: todayCount,
    lastScan: last,
    trend,
    devices,
  });
});

// ---------- Forms API (owner) ----------
app.get('/api/forms', authMiddleware, (req, res) => {
  const list = db.listForms(req.user.id).map((f) => ({
    id: f.id,
    title: f.title,
    description: f.description,
    fieldCount: (f.fields || []).length,
    submissionCount: db.submissionsFor(f.id).length,
    hasLogo: !!f.logo,
    createdAt: f.createdAt,
    formUrl: `${BASE_URL}/f/${f.id}`,
  }));
  res.json(list);
});

app.post('/api/forms', authMiddleware, (req, res) => {
  const { title, description, fields } = req.body || {};
  if (!title) return res.status(400).json({ error: '表单标题必填' });
  const clean = sanitizeFields(fields);
  if (!clean.length) return res.status(400).json({ error: '请至少添加一个字段' });
  const form = {
    id: genId(8),
    userId: req.user.id,
    title: String(title).trim().slice(0, 120),
    description: String(description || '').trim().slice(0, 500),
    fields: clean,
    theme: cleanTheme(req.body.theme),
    logo: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.createForm(form);
  res.json({ ...form, formUrl: `${BASE_URL}/f/${form.id}` });
});

app.get('/api/forms/:id', authMiddleware, (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  res.json({ ...f, formUrl: `${BASE_URL}/f/${f.id}`, submissionCount: db.submissionsFor(f.id).length });
});

app.put('/api/forms/:id', authMiddleware, (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const patch = { updatedAt: Date.now() };
  if (req.body.title != null) patch.title = String(req.body.title).trim().slice(0, 120);
  if (req.body.description != null) patch.description = String(req.body.description).trim().slice(0, 500);
  if (req.body.theme != null) patch.theme = cleanTheme(req.body.theme);
  if (req.body.fields != null) {
    const clean = sanitizeFields(req.body.fields);
    if (!clean.length) return res.status(400).json({ error: '请至少添加一个字段' });
    patch.fields = clean;
  }
  if (req.body.logo !== undefined) {
    // accept a data URL image or null to clear
    const logo = req.body.logo;
    if (logo === null || logo === '') patch.logo = null;
    else if (typeof logo === 'string' && logo.startsWith('data:image/') && logo.length < 4_000_000)
      patch.logo = logo;
    else return res.status(400).json({ error: 'Logo 不合法或过大' });
  }
  const updated = db.updateForm(f.id, patch);
  res.json({ ...updated, formUrl: `${BASE_URL}/f/${updated.id}` });
});

app.delete('/api/forms/:id', authMiddleware, (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  db.deleteForm(f.id);
  res.json({ ok: true });
});

// QR PNG for the form (high error correction so a center logo still scans)
app.get('/api/forms/:id/image', authMiddleware, async (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  try {
    const png = await QRCode.toBuffer(`${BASE_URL}/f/${f.id}`, {
      width: 512,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('png').send(png);
  } catch {
    res.status(500).json({ error: '生成失败' });
  }
});

// Submissions for the owner
app.get('/api/forms/:id/submissions', authMiddleware, (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  res.json({
    form: { id: f.id, title: f.title, fields: f.fields },
    submissions: db.submissionsFor(f.id),
  });
});

// CSV export of submissions
app.get('/api/forms/:id/export', authMiddleware, (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const subs = db.submissionsFor(f.id);
  const esc = (v) => {
    const s = v == null ? '' : Array.isArray(v) ? v.join(' / ') : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['提交时间', ...f.fields.map((fl) => fl.label)];
  const rows = subs.map((s) => [
    new Date(s.at).toLocaleString('zh-CN', { hour12: false }),
    ...f.fields.map((fl) => esc(s.data[fl.id])),
  ]);
  const csv = '﻿' + [header.map(esc).join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="form-${f.id}.csv"`);
  res.send(csv);
});

// ---------- Public form API (no auth) ----------
// Schema for rendering the fill page — never exposes owner/submissions
app.get('/api/public/forms/:id', (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f) return res.status(404).json({ error: '表单不存在或已删除' });
  res.json({ id: f.id, title: f.title, description: f.description, fields: f.fields, logo: f.logo, theme: cleanTheme(f.theme) });
});

app.post('/api/public/forms/:id/submit', (req, res) => {
  const f = db.getForm(req.params.id);
  if (!f) return res.status(404).json({ error: '表单不存在或已删除' });
  const incoming = (req.body && req.body.data) || {};
  const data = {};
  for (const field of f.fields) {
    let v = incoming[field.id];
    if (field.type === 'checkbox') v = Array.isArray(v) ? v.map((x) => String(x).slice(0, 500)) : [];
    else v = v == null ? '' : String(v).slice(0, 2000);
    const empty = field.type === 'checkbox' ? v.length === 0 : v === '';
    if (field.required && empty) return res.status(400).json({ error: `「${field.label}」为必填项` });
    data[field.id] = v;
  }
  db.addSubmission({
    id: genId(12),
    formId: f.id,
    at: Date.now(),
    device: detectDevice(req.headers['user-agent']),
    data,
  });
  res.json({ ok: true });
});

// Serve the public fill page for /f/:id
app.get('/f/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'form-fill.html'));
});

// Public quick-generate (no auth) — static QR PNG of any text/link
app.get('/api/quick', async (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  try {
    const png = await QRCode.toBuffer(text, {
      width: 512,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.type('png').send(png);
  } catch {
    res.status(500).json({ error: '生成失败' });
  }
});

// ---------- Public redirect (logs the scan) ----------
app.get('/r/:id', (req, res) => {
  const qr = db.getQrcode(req.params.id);
  if (!qr) return res.status(404).send('<h1>404 - 二维码不存在或已删除</h1>');
  db.addScan({
    id: genId(12),
    qrId: qr.id,
    at: Date.now(),
    device: detectDevice(req.headers['user-agent']),
    ref: req.headers['referer'] || null,
  });
  res.redirect(302, qr.target);
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Smart QR Manager running at ${BASE_URL}`);
});
