// Data access layer — async, backed by server/store.js (file or Redis).
import { load, save } from './store.js';

// Generate a short, URL-safe id
export function genId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export const db = {
  // ---- Users ----
  async findUserByEmail(email) {
    const d = await load();
    return d.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  },
  async findUserById(id) {
    const d = await load();
    return d.users.find((u) => u.id === id);
  },
  async createUser(user) {
    const d = await load();
    d.users.push(user);
    await save(d);
    return user;
  },

  async updateUser(id, patch) {
    const d = await load();
    const idx = d.users.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    d.users[idx] = { ...d.users[idx], ...patch };
    await save(d);
    return d.users[idx];
  },

  // ---- Orders (membership payments) ----
  async createOrder(order) {
    const d = await load();
    d.orders.push(order);
    await save(d);
    return order;
  },
  async getOrder(id) {
    const d = await load();
    return d.orders.find((o) => o.id === id);
  },
  async updateOrder(id, patch) {
    const d = await load();
    const idx = d.orders.findIndex((o) => o.id === id);
    if (idx === -1) return null;
    d.orders[idx] = { ...d.orders[idx], ...patch };
    await save(d);
    return d.orders[idx];
  },
  async allOrders() {
    const d = await load();
    return [...d.orders].sort((a, b) => b.createdAt - a.createdAt);
  },

  // ---- Admin (whole-dataset views) ----
  async allUsers() {
    const d = await load();
    return [...d.users].sort((a, b) => b.createdAt - a.createdAt);
  },
  async allQrcodes() {
    const d = await load();
    return d.qrcodes;
  },
  async allForms() {
    const d = await load();
    return d.forms;
  },
  async allScans() {
    const d = await load();
    return d.scans;
  },
  async allSubmissions() {
    const d = await load();
    return d.submissions;
  },
  // Remove a user and everything they own (qrcodes+scans, forms+submissions)
  async deleteUser(userId) {
    const d = await load();
    const qrIds = new Set(d.qrcodes.filter((q) => q.userId === userId).map((q) => q.id));
    const formIds = new Set(d.forms.filter((f) => f.userId === userId).map((f) => f.id));
    d.users = d.users.filter((u) => u.id !== userId);
    d.qrcodes = d.qrcodes.filter((q) => q.userId !== userId);
    d.scans = d.scans.filter((s) => !qrIds.has(s.qrId));
    d.forms = d.forms.filter((f) => f.userId !== userId);
    d.submissions = d.submissions.filter((s) => !formIds.has(s.formId));
    d.orders = (d.orders || []).filter((o) => o.userId !== userId);
    await save(d);
  },

  // ---- QR codes ----
  async listQrcodes(userId) {
    const d = await load();
    return d.qrcodes.filter((q) => q.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  },
  async getQrcode(id) {
    const d = await load();
    return d.qrcodes.find((q) => q.id === id);
  },
  async createQrcode(qr) {
    const d = await load();
    d.qrcodes.push(qr);
    await save(d);
    return qr;
  },
  async updateQrcode(id, patch) {
    const d = await load();
    const idx = d.qrcodes.findIndex((q) => q.id === id);
    if (idx === -1) return null;
    d.qrcodes[idx] = { ...d.qrcodes[idx], ...patch };
    await save(d);
    return d.qrcodes[idx];
  },
  async deleteQrcode(id) {
    const d = await load();
    d.qrcodes = d.qrcodes.filter((q) => q.id !== id);
    d.scans = d.scans.filter((s) => s.qrId !== id);
    await save(d);
  },

  // ---- Scans ----
  async addScan(scan) {
    const d = await load();
    d.scans.push(scan);
    await save(d);
    return scan;
  },
  async scansFor(qrId) {
    const d = await load();
    return d.scans.filter((s) => s.qrId === qrId);
  },

  // ---- Forms ----
  async listForms(userId) {
    const d = await load();
    return d.forms.filter((f) => f.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  },
  async getForm(id) {
    const d = await load();
    return d.forms.find((f) => f.id === id);
  },
  async createForm(form) {
    const d = await load();
    d.forms.push(form);
    await save(d);
    return form;
  },
  async updateForm(id, patch) {
    const d = await load();
    const idx = d.forms.findIndex((f) => f.id === id);
    if (idx === -1) return null;
    d.forms[idx] = { ...d.forms[idx], ...patch };
    await save(d);
    return d.forms[idx];
  },
  async deleteForm(id) {
    const d = await load();
    d.forms = d.forms.filter((f) => f.id !== id);
    d.submissions = d.submissions.filter((s) => s.formId !== id);
    await save(d);
  },

  // ---- Submissions ----
  async addSubmission(sub) {
    const d = await load();
    d.submissions.push(sub);
    await save(d);
    return sub;
  },
  async submissionsFor(formId) {
    const d = await load();
    return d.submissions.filter((s) => s.formId === formId).sort((a, b) => b.at - a.at);
  },
};
