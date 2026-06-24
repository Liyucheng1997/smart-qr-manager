import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, genId } from './db.js';
import { createOrder, verifyNotify, paymentConfigured, MEMBERSHIP_PRICE } from './payment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || 'smart-qr-dev-secret-change-me';
const isProd = process.env.NODE_ENV === 'production';

if (isProd && JWT_SECRET === 'smart-qr-dev-secret-change-me') {
  console.warn('[警告] 生产环境未设置 JWT_SECRET，请在环境变量中配置一个随机密钥！');
}

// Cookie options — secure flag enabled in production (served over HTTPS)
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7 * 24 * 60 * 60 * 1000 };

// Admin emails — comma-separated list in the ADMIN_EMAILS env var.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const isAdminEmail = (email) => ADMIN_EMAILS.has(String(email || '').toLowerCase());

// Public base URL. Prefer an explicit override; otherwise derive from the
// incoming request so QR codes always point at whatever domain was used
// (works automatically on Vercel preview/production and custom domains).
function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const app = express();
app.set('trust proxy', 1); // behind a proxy (Vercel/Nginx) — trust X-Forwarded-* headers
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: false })); // 支付回调是 form 表单格式
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

// Requires a valid login AND an admin email. Run after authMiddleware.
function adminMiddleware(req, res, next) {
  if (!isAdminEmail(req.user && req.user.email))
    return res.status(403).json({ error: '无权限' });
  next();
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
  if (await db.findUserByEmail(email)) return res.status(409).json({ error: '该邮箱已注册' });

  const user = {
    id: genId(10),
    name: name || String(email).split('@')[0],
    email,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: Date.now(),
  };
  await db.createUser(user);
  res.cookie('token', signToken(user), COOKIE_OPTS);
  res.json({ id: user.id, name: user.name, email: user.email });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.findUserByEmail(email || '');
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash)))
    return res.status(401).json({ error: '邮箱或密码错误' });
  res.cookie('token', signToken(user), COOKIE_OPTS);
  res.json({ id: user.id, name: user.name, email: user.email });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: isProd });
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const u = await db.findUserById(req.user.id);
  const isAdmin = isAdminEmail(req.user.email);
  res.json({
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    isAdmin,
    isPaid: !!(u && u.isPaid),
    isMember: isAdmin || !!(u && u.isPaid), // 管理员视同会员
  });
});

// Account info + all of the user's projects (QR codes and forms)
app.get('/api/profile', authMiddleware, async (req, res) => {
  const user = await db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const qrRecords = await db.listQrcodes(user.id);
  const qrcodes = [];
  for (const q of qrRecords) {
    const scans = await db.scansFor(q.id);
    qrcodes.push({ id: q.id, title: q.title, target: q.target, createdAt: q.createdAt, scanCount: scans.length });
  }
  const formRecords = await db.listForms(user.id);
  const forms = [];
  for (const f of formRecords) {
    const subs = await db.submissionsFor(f.id);
    forms.push({
      id: f.id,
      title: f.title,
      theme: f.theme || 'classic',
      fieldCount: (f.fields || []).length,
      createdAt: f.createdAt,
      submissionCount: subs.length,
    });
  }

  res.json({
    user: {
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      isPaid: !!user.isPaid,
      isMember: isAdminEmail(user.email) || !!user.isPaid,
      paidAt: user.paidAt || null,
    },
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

// ---------- Billing / Membership API ----------
// 价格与通道状态，供开通页展示。mode=auto 走虎皮椒扫码，manual 走收款码人工确认
app.get('/api/billing/config', authMiddleware, async (req, res) => {
  const u = await db.findUserById(req.user.id);
  const orders = await db.allOrders();
  const pending = orders.find((o) => o.userId === req.user.id && o.status === 'requested');
  res.json({
    price: MEMBERSHIP_PRICE,
    mode: paymentConfigured ? 'auto' : 'manual',
    isPaid: !!(u && u.isPaid),
    isMember: isAdminEmail(req.user.email) || !!(u && u.isPaid),
    hasPendingRequest: !!pending,
  });
});

// 手动模式：用户扫收款码付款后点「我已支付」，登记一条待确认订单
app.post('/api/billing/request', authMiddleware, async (req, res) => {
  const u = await db.findUserById(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (isAdminEmail(u.email) || u.isPaid) return res.status(400).json({ error: '你已经是会员了' });
  const orders = await db.allOrders();
  const existing = orders.find((o) => o.userId === u.id && o.status === 'requested');
  if (existing) return res.json({ ok: true, orderId: existing.id, pending: true });
  const order = {
    id: genId(20),
    userId: u.id,
    amount: MEMBERSHIP_PRICE,
    status: 'requested', // 等管理员在后台确认
    createdAt: Date.now(),
    paidAt: null,
    transactionId: null,
  };
  await db.createOrder(order);
  res.json({ ok: true, orderId: order.id, pending: true });
});

// 创建会员订单，返回支付二维码/跳转链接
app.post('/api/billing/order', authMiddleware, async (req, res) => {
  const u = await db.findUserById(req.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (isAdminEmail(u.email) || u.isPaid) return res.status(400).json({ error: '你已经是会员了' });
  if (!paymentConfigured) return res.status(503).json({ error: '支付通道尚未配置，请联系管理员手动开通' });

  const orderId = genId(20);
  const base = baseUrl(req);
  try {
    const pay = await createOrder({
      tradeOrderId: orderId,
      totalFee: MEMBERSHIP_PRICE,
      title: '永久会员',
      notifyUrl: `${base}/api/billing/notify`,
      returnUrl: `${base}/upgrade.html?paid=1`,
      callbackUrl: base,
    });
    await db.createOrder({
      id: orderId,
      userId: u.id,
      amount: MEMBERSHIP_PRICE,
      status: 'pending',
      createdAt: Date.now(),
      paidAt: null,
      transactionId: null,
    });
    res.json({ orderId, url: pay.url, urlQrcode: pay.urlQrcode });
  } catch (err) {
    res.status(502).json({ error: err.message || '下单失败' });
  }
});

// 前端轮询订单状态（回调是服务端到服务端，前端只查我们自己的库）
app.get('/api/billing/order/:id', authMiddleware, async (req, res) => {
  const o = await db.getOrder(req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: '订单不存在' });
  res.json({ status: o.status });
});

// 虎皮椒异步回调：验签 → 标记订单已付 + 用户升级为会员。必须返回纯文本 success
app.post('/api/billing/notify', async (req, res) => {
  const body = req.body || {};
  if (!verifyNotify(body)) return res.status(400).send('sign error');
  const order = await db.getOrder(body.trade_order_id);
  if (!order) return res.status(404).send('order not found');

  // status === 'OD' 表示支付完成
  if (body.status === 'OD' && order.status !== 'paid') {
    await db.updateOrder(order.id, {
      status: 'paid',
      paidAt: Date.now(),
      transactionId: body.transaction_id || null,
    });
    await db.updateUser(order.userId, { isPaid: true, paidAt: Date.now() });
  }
  res.send('success');
});

// ---------- Admin API (requires login + admin email) ----------
// Overview: every user with aggregated counts.
app.get('/api/admin/overview', authMiddleware, adminMiddleware, async (req, res) => {
  const [users, qrcodes, forms, scans, submissions] = await Promise.all([
    db.allUsers(), db.allQrcodes(), db.allForms(), db.allScans(), db.allSubmissions(),
  ]);

  // Pre-index scans by qrId and submissions by formId for O(1) lookups
  const scanByQr = {};
  for (const s of scans) scanByQr[s.qrId] = (scanByQr[s.qrId] || 0) + 1;
  const subByForm = {};
  for (const s of submissions) subByForm[s.formId] = (subByForm[s.formId] || 0) + 1;

  const orders = await db.allOrders();
  const pendingUserIds = new Set(orders.filter((o) => o.status === 'requested').map((o) => o.userId));

  const list = users.map((u) => {
    const userQr = qrcodes.filter((q) => q.userId === u.id);
    const userForms = forms.filter((f) => f.userId === u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      isAdmin: isAdminEmail(u.email),
      isPaid: !!u.isPaid,
      paidAt: u.paidAt || null,
      pendingRequest: pendingUserIds.has(u.id),
      qrCount: userQr.length,
      formCount: userForms.length,
      totalScans: userQr.reduce((s, q) => s + (scanByQr[q.id] || 0), 0),
      totalSubmissions: userForms.reduce((s, f) => s + (subByForm[f.id] || 0), 0),
    };
  });

  res.json({
    totals: {
      users: users.length,
      qrcodes: qrcodes.length,
      forms: forms.length,
      scans: scans.length,
      submissions: submissions.length,
    },
    users: list,
  });
});

// Drill-down: one user's full detail — every QR code and form with content.
app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const qrRecords = await db.listQrcodes(user.id);
  const qrcodes = [];
  for (const q of qrRecords) {
    const scans = await db.scansFor(q.id);
    qrcodes.push({
      id: q.id, title: q.title, target: q.target, createdAt: q.createdAt,
      scanCount: scans.length, redirectUrl: `${baseUrl(req)}/r/${q.id}`,
    });
  }

  const formRecords = await db.listForms(user.id);
  const forms = [];
  for (const f of formRecords) {
    const submissions = await db.submissionsFor(f.id);
    forms.push({
      id: f.id, title: f.title, description: f.description, theme: cleanTheme(f.theme),
      fields: f.fields || [], createdAt: f.createdAt, formUrl: `${baseUrl(req)}/f/${f.id}`,
      submissionCount: submissions.length, submissions,
    });
  }

  res.json({
    user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, isAdmin: isAdminEmail(user.email), isPaid: !!user.isPaid, paidAt: user.paidAt || null },
    qrcodes,
    forms,
  });
});

// 手动设/取消会员（兜底：支付通道没接好、或线下付款时用）
app.post('/api/admin/users/:id/membership', authMiddleware, adminMiddleware, async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const isPaid = !!(req.body && req.body.isPaid);
  await db.updateUser(user.id, { isPaid, paidAt: isPaid ? (user.paidAt || Date.now()) : null });
  // 同步把该用户待确认的订单标记为已付（手动开通时对账用）
  if (isPaid) {
    const orders = await db.allOrders();
    for (const o of orders) {
      if (o.userId === user.id && o.status !== 'paid') {
        await db.updateOrder(o.id, { status: 'paid', paidAt: o.paidAt || Date.now() });
      }
    }
  }
  res.json({ ok: true, isPaid });
});

// 所有订单（对账用）
app.get('/api/admin/orders', authMiddleware, adminMiddleware, async (req, res) => {
  const [orders, users] = await Promise.all([db.allOrders(), db.allUsers()]);
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  res.json(orders.map((o) => ({
    ...o,
    userName: byId[o.userId] ? byId[o.userId].name : '(已删除)',
    userEmail: byId[o.userId] ? byId[o.userId].email : '',
  })));
});

// Delete a user and everything they own.
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.id === req.user.id) return res.status(400).json({ error: '不能删除自己的账号' });
  await db.deleteUser(user.id);
  res.json({ ok: true });
});

// Delete any QR code / form (admin override of the per-owner endpoints).
app.delete('/api/admin/qrcodes/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr) return res.status(404).json({ error: '未找到' });
  await db.deleteQrcode(qr.id);
  res.json({ ok: true });
});

app.delete('/api/admin/forms/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f) return res.status(404).json({ error: '未找到' });
  await db.deleteForm(f.id);
  res.json({ ok: true });
});

// ---------- QR code API ----------
app.get('/api/qrcodes', authMiddleware, async (req, res) => {
  const records = await db.listQrcodes(req.user.id);
  const list = [];
  for (const q of records) {
    const scans = await db.scansFor(q.id);
    list.push({ ...q, scanCount: scans.length, redirectUrl: `${baseUrl(req)}/r/${q.id}` });
  }
  res.json(list);
});

app.post('/api/qrcodes', authMiddleware, async (req, res) => {
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
  await db.createQrcode(qr);
  res.json({ ...qr, redirectUrl: `${baseUrl(req)}/r/${qr.id}` });
});

app.get('/api/qrcodes/:id', authMiddleware, async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const scans = await db.scansFor(qr.id);
  res.json({ ...qr, scanCount: scans.length, redirectUrl: `${baseUrl(req)}/r/${qr.id}` });
});

app.put('/api/qrcodes/:id', authMiddleware, async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const patch = { updatedAt: Date.now() };
  if (req.body.title != null) patch.title = String(req.body.title).trim();
  if (req.body.target != null) {
    let url = String(req.body.target).trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    patch.target = url;
  }
  const updated = await db.updateQrcode(qr.id, patch);
  res.json({ ...updated, redirectUrl: `${baseUrl(req)}/r/${updated.id}` });
});

app.delete('/api/qrcodes/:id', authMiddleware, async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  await db.deleteQrcode(qr.id);
  res.json({ ok: true });
});

// QR image (PNG) of the tracked redirect URL
app.get('/api/qrcodes/:id/image', authMiddleware, async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  try {
    const png = await QRCode.toBuffer(`${baseUrl(req)}/r/${qr.id}`, {
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
app.get('/api/qrcodes/:id/stats', authMiddleware, async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr || qr.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const scans = await db.scansFor(qr.id);

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
app.get('/api/forms', authMiddleware, async (req, res) => {
  const records = await db.listForms(req.user.id);
  const list = [];
  for (const f of records) {
    const subs = await db.submissionsFor(f.id);
    list.push({
      id: f.id,
      title: f.title,
      description: f.description,
      fieldCount: (f.fields || []).length,
      submissionCount: subs.length,
      hasLogo: !!f.logo,
      createdAt: f.createdAt,
      formUrl: `${baseUrl(req)}/f/${f.id}`,
    });
  }
  res.json(list);
});

app.post('/api/forms', authMiddleware, async (req, res) => {
  // 付费闸门：创建表单是会员功能（管理员视同会员）
  const owner = await db.findUserById(req.user.id);
  if (!isAdminEmail(req.user.email) && !(owner && owner.isPaid)) {
    return res.status(402).json({ error: '创建表单是会员功能，请先开通会员', needUpgrade: true });
  }
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
  await db.createForm(form);
  res.json({ ...form, formUrl: `${baseUrl(req)}/f/${form.id}` });
});

app.get('/api/forms/:id', authMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const subs = await db.submissionsFor(f.id);
  res.json({ ...f, formUrl: `${baseUrl(req)}/f/${f.id}`, submissionCount: subs.length });
});

app.put('/api/forms/:id', authMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
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
    const logo = req.body.logo;
    if (logo === null || logo === '') patch.logo = null;
    else if (typeof logo === 'string' && logo.startsWith('data:image/') && logo.length < 4_000_000)
      patch.logo = logo;
    else return res.status(400).json({ error: 'Logo 不合法或过大' });
  }
  const updated = await db.updateForm(f.id, patch);
  res.json({ ...updated, formUrl: `${baseUrl(req)}/f/${updated.id}` });
});

app.delete('/api/forms/:id', authMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  await db.deleteForm(f.id);
  res.json({ ok: true });
});

// QR PNG for the form (high error correction so a center logo still scans)
app.get('/api/forms/:id/image', authMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  try {
    const png = await QRCode.toBuffer(`${baseUrl(req)}/f/${f.id}`, {
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
app.get('/api/forms/:id/submissions', authMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const submissions = await db.submissionsFor(f.id);
  res.json({ form: { id: f.id, title: f.title, fields: f.fields }, submissions });
});

// CSV export of submissions
app.get('/api/forms/:id/export', authMiddleware, async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f || f.userId !== req.user.id) return res.status(404).json({ error: '未找到' });
  const subs = await db.submissionsFor(f.id);
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
app.get('/api/public/forms/:id', async (req, res) => {
  const f = await db.getForm(req.params.id);
  if (!f) return res.status(404).json({ error: '表单不存在或已删除' });
  res.json({ id: f.id, title: f.title, description: f.description, fields: f.fields, logo: f.logo, theme: cleanTheme(f.theme) });
});

app.post('/api/public/forms/:id/submit', async (req, res) => {
  const f = await db.getForm(req.params.id);
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
  await db.addSubmission({
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
app.get('/r/:id', async (req, res) => {
  const qr = await db.getQrcode(req.params.id);
  if (!qr) return res.status(404).send('<h1>404 - 二维码不存在或已删除</h1>');
  await db.addScan({
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

export default app;
