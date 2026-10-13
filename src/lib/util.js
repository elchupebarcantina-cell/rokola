import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q } from '../db.js';

const scrypt = promisify(crypto.scrypt);

export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

/** Error con código HTTP y código legible para que el cliente muestre el mensaje correcto. */
export class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const fail = (status, code, message, extra) => { throw new AppError(status, code, message, extra); };

/** Identificador entero válido para columnas INT/BIGINT, o null. */
export const toId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? n : null; };

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie inválida: se ignora */ } }
  }
  return out;
}

export function setCookie(req, res, name, value, { maxAgeSec, path = '/' } = {}) {
  // "Secure" solo si la petición llegó por HTTPS: así también funciona en pruebas por HTTP en red local.
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (req.secure) parts.push('Secure');
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  res.append('Set-Cookie', parts.join('; '));
}

export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // quita caracteres de control y espacios repetidos
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function audit(db, { venueId, roomId, sessionId, actor, action, detail }) {
  await db.query(
    'INSERT INTO audit_log(venue_id, room_id, session_id, actor, action, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [venueId ?? null, roomId ?? null, sessionId ?? null, actor, action, detail ?? {}],
  );
}

export async function logError({ roomId, sessionId, kind, message, detail }) {
  try {
    await q('INSERT INTO error_log(room_id, session_id, kind, message, detail) VALUES ($1,$2,$3,$4,$5)',
      [roomId ?? null, sessionId ?? null, kind, String(message).slice(0, 500), detail ?? {}]);
  } catch (e) {
    console.error('[error_log] no se pudo registrar:', e.message);
  }
}

/** Limitador en memoria (ventana fija). Suficiente para una instancia; ver docs para escalar. */
const buckets = new Map();
export function rateLimit(key, limit, windowSec) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { n: 0, reset: now + windowSec * 1000 }; buckets.set(key, b); }
  b.n++;
  if (b.n > limit) {
    fail(429, 'demasiadas_solicitudes', 'Vas muy rápido. Espera un momento e intenta de nuevo.',
      { retryAfter: Math.ceil((b.reset - now) / 1000) });
  }
}
export function resetRateLimits() { buckets.clear(); }
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000).unref();
