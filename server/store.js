// Storage abstraction with two backends, selected by environment:
//   - Redis (Upstash) when UPSTASH_REDIS_REST_URL/TOKEN are set  → Vercel/serverless
//   - local JSON file otherwise                                  → local dev / VPS
// The whole DB is stored as a single JSON document under one key.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_FILE = path.join(DATA_DIR, 'db.backup.json');
const REDIS_KEY = process.env.REDIS_KEY || 'smartqr:db';

export const DEFAULT_DATA = { users: [], qrcodes: [], scans: [], forms: [], submissions: [] };

const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
export const backend = useRedis ? 'redis' : 'file';

// Lazily construct the Redis client only when needed
let redisPromise = null;
function getRedis() {
  if (!redisPromise) {
    redisPromise = import('@upstash/redis').then(
      ({ Redis }) =>
        new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        })
    );
  }
  return redisPromise;
}

// ---------- file backend ----------
function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    if (fs.existsSync(BACKUP_FILE)) {
      try { fs.copyFileSync(BACKUP_FILE, DB_FILE); return; } catch { /* fall through */ }
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}
function fileLoad() {
  ensureFile();
  try {
    return { ...DEFAULT_DATA, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) };
  } catch {
    try {
      return { ...DEFAULT_DATA, ...JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8')) };
    } catch {
      return { ...DEFAULT_DATA };
    }
  }
}
function fileSave(data) {
  ensureFile();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(DB_FILE, json);
  try { fs.writeFileSync(BACKUP_FILE, json); } catch { /* best effort */ }
}

// ---------- public async API ----------
export async function load() {
  if (useRedis) {
    const r = await getRedis();
    const data = await r.get(REDIS_KEY);
    return data ? { ...DEFAULT_DATA, ...data } : { ...DEFAULT_DATA };
  }
  return fileLoad();
}

export async function save(data) {
  if (useRedis) {
    const r = await getRedis();
    await r.set(REDIS_KEY, data);
    return;
  }
  fileSave(data);
}
