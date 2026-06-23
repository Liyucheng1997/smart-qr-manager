import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_FILE = path.join(DATA_DIR, 'db.backup.json');

const DEFAULT_DATA = { users: [], qrcodes: [], scans: [], forms: [], submissions: [] };

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    // if a backup exists, restore from it instead of starting empty
    if (fs.existsSync(BACKUP_FILE)) {
      try { fs.copyFileSync(BACKUP_FILE, DB_FILE); return; } catch { /* fall through */ }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}

function read() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return { ...DEFAULT_DATA, ...JSON.parse(raw) };
  } catch {
    // main file unreadable — try the backup before giving up
    try {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      return { ...DEFAULT_DATA, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_DATA };
    }
  }
}

function write(data) {
  ensureFile();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(DB_FILE, json);
  // keep a safety copy that survives accidental deletion of the main file
  try { fs.writeFileSync(BACKUP_FILE, json); } catch { /* best effort */ }
}

// Generate a short, URL-safe id
export function genId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export const db = {
  read,
  write,

  // ---- Users ----
  findUserByEmail(email) {
    return read().users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  },
  findUserById(id) {
    return read().users.find((u) => u.id === id);
  },
  createUser(user) {
    const data = read();
    data.users.push(user);
    write(data);
    return user;
  },

  // ---- QR codes ----
  listQrcodes(userId) {
    return read()
      .qrcodes.filter((q) => q.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  getQrcode(id) {
    return read().qrcodes.find((q) => q.id === id);
  },
  createQrcode(qr) {
    const data = read();
    data.qrcodes.push(qr);
    write(data);
    return qr;
  },
  updateQrcode(id, patch) {
    const data = read();
    const idx = data.qrcodes.findIndex((q) => q.id === id);
    if (idx === -1) return null;
    data.qrcodes[idx] = { ...data.qrcodes[idx], ...patch };
    write(data);
    return data.qrcodes[idx];
  },
  deleteQrcode(id) {
    const data = read();
    data.qrcodes = data.qrcodes.filter((q) => q.id !== id);
    data.scans = data.scans.filter((s) => s.qrId !== id);
    write(data);
  },

  // ---- Scans ----
  addScan(scan) {
    const data = read();
    data.scans.push(scan);
    write(data);
    return scan;
  },
  scansFor(qrId) {
    return read().scans.filter((s) => s.qrId === qrId);
  },

  // ---- Forms ----
  listForms(userId) {
    return read()
      .forms.filter((f) => f.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  getForm(id) {
    return read().forms.find((f) => f.id === id);
  },
  createForm(form) {
    const data = read();
    data.forms.push(form);
    write(data);
    return form;
  },
  updateForm(id, patch) {
    const data = read();
    const idx = data.forms.findIndex((f) => f.id === id);
    if (idx === -1) return null;
    data.forms[idx] = { ...data.forms[idx], ...patch };
    write(data);
    return data.forms[idx];
  },
  deleteForm(id) {
    const data = read();
    data.forms = data.forms.filter((f) => f.id !== id);
    data.submissions = data.submissions.filter((s) => s.formId !== id);
    write(data);
  },

  // ---- Submissions ----
  addSubmission(sub) {
    const data = read();
    data.submissions.push(sub);
    write(data);
    return sub;
  },
  submissionsFor(formId) {
    return read()
      .submissions.filter((s) => s.formId === formId)
      .sort((a, b) => b.at - a.at);
  },
};
