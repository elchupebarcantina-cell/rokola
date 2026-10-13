// Autenticación y autorización. TODA comprobación de permisos ocurre aquí, en el backend.
import { q } from '../db.js';
import { config } from '../config.js';
import { fail, newToken, parseCookies, setCookie, sha256, toId, wrap } from './util.js';

export const RANK = { operador: 1, admin_sede: 2, admin_general: 3 };

// ───────── Administradores ─────────
export async function createAdminSession(req, res, userId) {
  const token = newToken();
  await q("INSERT INTO admin_sessions(token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))",
    [sha256(token), userId, config.adminSessionHours]);
  setCookie(req, res, 'rk_admin', token, { maxAgeSec: config.adminSessionHours * 3600 });
}

export async function currentUser(req) {
  const token = parseCookies(req).rk_admin;
  if (!token) return null;
  const { rows } = await q(
    `SELECT u.id, u.email, u.name, u.role, u.venue_id FROM admin_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha256(token)]);
  return rows[0] || null;
}

export const requireUser = (minRole = 'operador') => wrap(async (req, res, next) => {
  const user = await currentUser(req);
  if (!user) fail(401, 'no_autenticado', 'Inicia sesión para continuar.');
  if (RANK[user.role] < RANK[minRole]) fail(403, 'sin_permiso', 'Tu rol no permite esta acción.');
  req.user = user;
  req.actor = `usuario:${user.id}`;
  next();
});

/** Aislamiento entre sedes: solo el administrador general cruza sedes. */
export function assertVenue(user, venueId, minRole = 'operador') {
  if (RANK[user.role] < RANK[minRole]) fail(403, 'sin_permiso', 'Tu rol no permite esta acción.');
  if (user.role !== 'admin_general' && user.venue_id !== venueId) fail(403, 'sin_permiso', 'No tienes acceso a esa sede.');
}

export async function loadRoom(req, minRole = 'operador') {
  const { rows } = await q('SELECT * FROM rooms WHERE id = $1', [toId(req.params.roomId) ?? -1]);
  if (!rows[0]) fail(404, 'no_encontrado', 'Sala no encontrada.');
  assertVenue(req.user, rows[0].venue_id, minRole);
  return rows[0];
}

// ───────── Pantalla del televisor ─────────
export async function createDevice(req, res, roomId, userId, label) {
  const token = newToken();
  const { rows } = await q('INSERT INTO player_devices(room_id, token_hash, label, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [roomId, sha256(token), label || null, userId]);
  if (res) setCookie(req, res, 'rk_tv', token, { maxAgeSec: 365 * 86400 });
  return { id: rows[0].id, token };
}

export const requireDevice = wrap(async (req, res, next) => {
  const token = parseCookies(req).rk_tv;
  const { rows } = token ? await q(
    'SELECT id, room_id FROM player_devices WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]) : { rows: [] };
  if (!rows[0]) fail(401, 'pantalla_no_vinculada', 'Esta pantalla no está vinculada a una sala.');
  req.device = rows[0];
  req.actor = `pantalla:${rows[0].id}`;
  next();
});

// ───────── Clientes (participantes de una sesión) ─────────
export const participantCookie = (sessionToken) => `rkp_${sessionToken}`;

export async function currentParticipant(req, session) {
  const token = parseCookies(req)[participantCookie(session.public_token)];
  if (!token) return null;
  const { rows } = await q('SELECT * FROM participants WHERE token_hash = $1 AND session_id = $2', [sha256(token), session.id]);
  return rows[0] || null;
}

/** Defensa CSRF: toda mutación debe ser JSON y, si el navegador envía Origin, coincidir con el host. */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.headers.host) return next(Object.assign(new Error('Origen no permitido'), { status: 403, code: 'origen_invalido' }));
  }
  if (req.method !== 'DELETE' && !req.is('application/json')) {
    return next(Object.assign(new Error('Se esperaba JSON'), { status: 415, code: 'tipo_invalido' }));
  }
  next();
}
