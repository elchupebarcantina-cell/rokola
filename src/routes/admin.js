// Panel administrativo. Roles: admin_general > admin_sede > operador.
// Cada ruta comprueba rol y sede en el backend; el frontend solo oculta lo que no aplica.
import { Router } from 'express';
import QRCode from 'qrcode';
import { q, tx, notifyRoom, withRoomLock } from '../db.js';
import { sanitizeSettings, mergeSettings } from '../config.js';
import { getProvider, listProviders } from '../providers/index.js';
import { youtube } from '../providers/youtube.js';
import { assertVenue, createAdminSession, createDevice, currentUser, loadRoom, RANK, requireUser } from '../lib/auth.js';
import { subscribe } from '../lib/realtime.js';
import { audit, cleanText, fail, hashPassword, toId, parseCookies, rateLimit, setCookie, sha256, verifyPassword, wrap } from '../lib/util.js';
import { closeSession, openSession, regenerateDoorCode, setRequestsOpen } from '../services/sessions.js';
import { adminApprove, adminMove, adminRemove, adminSkip, blockedSet, mediaRejection } from '../services/queue.js';
import { clearAttention, finishCurrent, setDesired } from '../services/playback.js';
import { adminSnapshot } from '../services/snapshot.js';
import { importList, parsePlaylistId } from '../services/repertorio.js';

export const adminRouter = Router();
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sala';
const intParam = (v) => toId(v) ?? fail(400, 'solicitud_invalida', 'Identificador inválido.');

// ───────── Sesión de administrador ─────────
adminRouter.post('/login', wrap(async (req, res) => {
  const email = cleanText(req.body.email, 120).toLowerCase();
  rateLimit(`login:${req.ip}`, 10, 300);
  rateLimit(`login:${email}`, 8, 300);
  const { rows } = await q('SELECT * FROM users WHERE email = $1 AND active', [email]);
  const ok = rows[0] && await verifyPassword(String(req.body.password || ''), rows[0].password_hash);
  if (!ok) fail(401, 'credenciales', 'Correo o contraseña incorrectos.');
  await createAdminSession(req, res, rows[0].id);
  res.json({ user: { id: rows[0].id, name: rows[0].name, role: rows[0].role, venueId: rows[0].venue_id } });
}));

adminRouter.post('/logout', wrap(async (req, res) => {
  const token = parseCookies(req).rk_admin;
  if (token) await q('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
  setCookie(req, res, 'rk_admin', '', { maxAgeSec: 0 });
  res.json({ ok: true });
}));

adminRouter.get('/me', wrap(async (req, res) => {
  const u = await currentUser(req);
  res.json({ user: u && { id: u.id, name: u.name, email: u.email, role: u.role, venueId: u.venue_id } });
}));

adminRouter.use(requireUser('operador'));

// ───────── Sedes y salas ─────────
adminRouter.get('/overview', wrap(async (req, res) => {
  const all = req.user.role === 'admin_general';
  const { rows: venues } = await q(`SELECT id, slug, name, logo_url AS logo, accent FROM venues WHERE $1 OR id = $2 ORDER BY name`, [all, req.user.venue_id]);
  const { rows: rooms } = await q(
    `SELECT r.id, r.venue_id AS "venueId", r.name, r.provider, s.id IS NOT NULL AS open, s.started,
            (SELECT count(*)::int FROM requests x WHERE x.session_id = s.id AND x.status = 'pendiente') AS pending,
            ps.attention, (ps.last_heartbeat > now() - interval '20 seconds') AS "playerOnline"
       FROM rooms r JOIN playback_state ps ON ps.room_id = r.id
       LEFT JOIN room_sessions s ON s.room_id = r.id AND s.status = 'abierta'
      WHERE $1 OR r.venue_id = $2 ORDER BY r.name`, [all, req.user.venue_id]);
  res.json({ venues: venues.map((v) => ({ ...v, rooms: rooms.filter((r) => r.venueId === v.id) })),
    providers: listProviders().map((p) => ({ id: p.id, label: p.label })) });
}));

adminRouter.post('/venues', requireUser('admin_general'), wrap(async (req, res) => {
  const name = cleanText(req.body.name, 60);
  if (name.length < 2) fail(422, 'nombre_invalido', 'Escribe el nombre de la sede.');
  const out = await tx(async (c) => {
    const slug = `${slugify(name)}-${Date.now().toString(36).slice(-4)}`;
    const v = (await c.query('INSERT INTO venues(slug, name, logo_url) VALUES ($1,$2,$3) RETURNING *', [slug, name, '/img/logo-el-chupe.jpg'])).rows[0];
    const r = (await c.query("INSERT INTO rooms(venue_id, slug, name) VALUES ($1,'principal','Sala principal') RETURNING id", [v.id])).rows[0];
    await c.query('INSERT INTO playback_state(room_id) VALUES ($1)', [r.id]);
    await audit(c, { venueId: v.id, actor: req.actor, action: 'sede.crear', detail: { name } });
    return v;
  });
  res.status(201).json({ venue: out });
}));

adminRouter.patch('/venues/:venueId', wrap(async (req, res) => {
  const venueId = intParam(req.params.venueId);
  assertVenue(req.user, venueId, 'admin_sede');
  const name = cleanText(req.body.name, 60);
  const logo = cleanText(req.body.logo, 300);
  const accent = cleanText(req.body.accent, 7);
  if (logo && !/^(https:\/\/|\/img\/)/.test(logo)) fail(422, 'logo_invalido', 'El logo debe ser una URL https.');
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) fail(422, 'color_invalido', 'Color inválido.');
  await q('UPDATE venues SET name = COALESCE(NULLIF($2,\'\'), name), logo_url = COALESCE(NULLIF($3,\'\'), logo_url), accent = COALESCE(NULLIF($4,\'\'), accent) WHERE id = $1',
    [venueId, name, logo, accent]);
  await audit({ query: q }, { venueId, actor: req.actor, action: 'sede.editar', detail: { name, logo, accent } });
  for (const r of (await q('SELECT id FROM rooms WHERE venue_id = $1', [venueId])).rows) await notifyRoom(r.id);
  res.json({ ok: true });
}));

adminRouter.post('/venues/:venueId/rooms', wrap(async (req, res) => {
  const venueId = intParam(req.params.venueId);
  assertVenue(req.user, venueId, 'admin_sede');
  const name = cleanText(req.body.name, 60);
  if (name.length < 2) fail(422, 'nombre_invalido', 'Escribe el nombre de la sala.');
  const room = await tx(async (c) => {
    const r = (await c.query('INSERT INTO rooms(venue_id, slug, name) VALUES ($1,$2,$3) RETURNING *',
      [venueId, `${slugify(name)}-${Date.now().toString(36).slice(-4)}`, name])).rows[0];
    await c.query('INSERT INTO playback_state(room_id) VALUES ($1)', [r.id]);
    await audit(c, { venueId, roomId: r.id, actor: req.actor, action: 'sala.crear', detail: { name } });
    return r;
  });
  res.status(201).json({ room });
}));

// ───────── Usuarios ─────────
adminRouter.get('/users', requireUser('admin_sede'), wrap(async (req, res) => {
  const all = req.user.role === 'admin_general';
  const { rows } = await q(
    `SELECT u.id, u.email, u.name, u.role, u.venue_id AS "venueId", u.active, v.name AS "venueName"
       FROM users u LEFT JOIN venues v ON v.id = u.venue_id WHERE $1 OR u.venue_id = $2 ORDER BY u.name`, [all, req.user.venue_id]);
  res.json({ users: rows });
}));

function assertCanManage(actor, role, venueId) {
  // Nadie crea ni edita usuarios de rango igual o superior al suyo (salvo el administrador general).
  if (!RANK[role]) fail(422, 'rol_invalido', 'Rol inválido.');
  if (actor.role !== 'admin_general') {
    if (RANK[role] >= RANK[actor.role]) fail(403, 'sin_permiso', 'No puedes gestionar ese rol.');
    if (venueId !== actor.venue_id) fail(403, 'sin_permiso', 'No tienes acceso a esa sede.');
  }
  if (role !== 'admin_general' && !venueId) fail(422, 'sede_requerida', 'Ese rol necesita una sede.');
}

adminRouter.post('/users', requireUser('admin_sede'), wrap(async (req, res) => {
  const email = cleanText(req.body.email, 120).toLowerCase();
  const name = cleanText(req.body.name, 60);
  const role = String(req.body.role || '');
  const venueId = role === 'admin_general' ? null : toId(req.body.venueId);
  const password = String(req.body.password || '');
  assertCanManage(req.user, role, venueId);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(422, 'correo_invalido', 'Correo inválido.');
  if (name.length < 2) fail(422, 'nombre_invalido', 'Escribe el nombre.');
  if (password.length < 10) fail(422, 'clave_corta', 'La contraseña debe tener al menos 10 caracteres.');
  try {
    const { rows } = await q('INSERT INTO users(email, name, password_hash, role, venue_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [email, name, await hashPassword(password), role, venueId]);
    await audit({ query: q }, { venueId, actor: req.actor, action: 'usuario.crear', detail: { userId: rows[0].id, role } });
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') fail(409, 'correo_en_uso', 'Ya existe un usuario con ese correo.');
    if (e.code === '23503') fail(422, 'sede_invalida', 'Esa sede no existe.');
    throw e;
  }
}));

adminRouter.patch('/users/:id', requireUser('admin_sede'), wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [intParam(req.params.id)]);
  if (!rows[0]) fail(404, 'no_encontrado', 'Usuario no encontrado.');
  if (rows[0].id !== req.user.id) assertCanManage(req.user, rows[0].role, rows[0].venue_id);
  if (req.body.active !== undefined) {
    if (rows[0].id === req.user.id) fail(409, 'accion_invalida', 'No puedes desactivar tu propio usuario.');
    await q('UPDATE users SET active = $2 WHERE id = $1', [rows[0].id, Boolean(req.body.active)]);
    if (!req.body.active) await q('DELETE FROM admin_sessions WHERE user_id = $1', [rows[0].id]);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 10) fail(422, 'clave_corta', 'La contraseña debe tener al menos 10 caracteres.');
    await q('UPDATE users SET password_hash = $2 WHERE id = $1', [rows[0].id, await hashPassword(String(req.body.password))]);
    await q('DELETE FROM admin_sessions WHERE user_id = $1 AND token_hash <> $2', [rows[0].id, sha256(parseCookies(req).rk_admin || '')]);
  }
  await audit({ query: q }, { venueId: rows[0].venue_id, actor: req.actor, action: 'usuario.editar', detail: { userId: rows[0].id, active: req.body.active, password: Boolean(req.body.password) } });
  res.json({ ok: true });
}));

// ───────── Estado y operación de una sala ─────────
adminRouter.get('/rooms/:roomId/state', wrap(async (req, res) => {
  const room = await loadRoom(req);
  res.json(await adminSnapshot(room.id, baseUrl(req), { showPhones: RANK[req.user.role] >= RANK.admin_sede }));
}));

adminRouter.get('/rooms/:roomId/events', wrap(async (req, res) => {
  const room = await loadRoom(req);
  subscribe(req, res, room.id, 'admin');
}));

adminRouter.get('/rooms/:roomId/qr.svg', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const snap = await adminSnapshot(room.id, baseUrl(req), { showPhones: false });
  if (!snap.joinUrl) fail(404, 'sin_sesion', 'No hay sesión abierta.');
  res.type('image/svg+xml').set('Cache-Control', 'no-store')
    .send(await QRCode.toString(snap.joinUrl, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 }));
}));

adminRouter.post('/rooms/:roomId/session/:action', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const a = req.params.action;
  if (a === 'abrir') await openSession(room.id, req.actor);
  else if (a === 'cerrar') await closeSession(room.id, req.actor);
  else if (a === 'solicitudes') await setRequestsOpen(room.id, Boolean(req.body.open), req.actor);
  else if (a === 'codigo') await regenerateDoorCode(room.id, req.actor);
  else fail(404, 'no_encontrado', 'Acción desconocida.');
  res.json({ ok: true });
}));

adminRouter.post('/rooms/:roomId/control', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const a = req.body.action;
  if (a === 'saltar') await adminSkip(room.id, req.actor);
  else if (a === 'pausar' || a === 'continuar') await withRoomLock(room.id, (c, ps) => setDesired(c, ps, a === 'pausar' ? 'pause' : 'play', req.actor));
  else if (a === 'reanudar') await withRoomLock(room.id, (c, ps) => clearAttention(c, ps, req.actor));
  else fail(400, 'solicitud_invalida', 'Acción desconocida.');
  res.json({ ok: true });
}));

adminRouter.post('/rooms/:roomId/requests/:id/:action', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const id = intParam(req.params.id);
  const a = req.params.action;
  if (a === 'quitar') await adminRemove(room.id, id, req.actor);
  else if (a === 'aprobar') await adminApprove(room.id, id, true, req.actor);
  else if (a === 'rechazar') await adminApprove(room.id, id, false, req.actor);
  else if (a === 'mover') await adminMove(room.id, id, String(req.body.where), req.actor);
  else fail(404, 'no_encontrado', 'Acción desconocida.');
  res.json({ ok: true });
}));

adminRouter.post('/rooms/:roomId/participants/:pid/bloqueo', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const blocked = Boolean(req.body.blocked);
  await withRoomLock(room.id, async (c) => {
    const { rows } = await c.query(
      `UPDATE participants p SET blocked = $3 FROM room_sessions s
        WHERE p.id = $1 AND s.id = p.session_id AND s.room_id = $2 RETURNING p.id, p.session_id`, [intParam(req.params.pid), room.id, blocked]);
    if (!rows[0]) fail(404, 'no_encontrado', 'Participante no encontrado.');
    if (blocked) await c.query("UPDATE requests SET status = 'cancelada', ended_at = now() WHERE participant_id = $1 AND status IN ('pendiente','por_aprobar')", [rows[0].id]);
    await audit(c, { venueId: room.venue_id, roomId: room.id, sessionId: rows[0].session_id, actor: req.actor, action: blocked ? 'participante.bloquear' : 'participante.desbloquear', detail: { participantId: rows[0].id } });
  });
  res.json({ ok: true });
}));

// ───────── Configuración (administrador de sede o superior) ─────────
adminRouter.put('/rooms/:roomId/settings', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  let changes;
  try { changes = sanitizeSettings(req.body || {}); } catch (e) { fail(422, 'config_invalida', e.message); }
  const name = cleanText(req.body.name, 60);
  let provider = room.provider;
  if (req.body.provider && req.body.provider !== room.provider) {
    const p = getProvider(String(req.body.provider));
    const st = await p.status();
    if (!st.available) fail(409, 'proveedor_no_disponible', st.reason);
    const open = await q("SELECT 1 FROM room_sessions WHERE room_id = $1 AND status = 'abierta'", [room.id]);
    if (open.rowCount) fail(409, 'sesion_abierta', 'Cierra la sesión antes de cambiar el proveedor de contenido.');
    provider = p.id;
  }
  await q('UPDATE rooms SET settings = settings || $2::jsonb, provider = $3, name = COALESCE(NULLIF($4,\'\'), name) WHERE id = $1',
    [room.id, JSON.stringify(changes), provider, name]);
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'sala.configurar', detail: { ...changes, provider } });
  await notifyRoom(room.id);
  res.json({ settings: mergeSettings({ ...room.settings, ...changes }), provider });
}));

adminRouter.get('/rooms/:roomId/search', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  rateLimit(`asearch:${req.user.id}`, 20, 60);
  const query = cleanText(req.query.q, 80);
  const provider = getProvider(room.provider);
  if (query.length < 3 && provider.id !== 'catalogo') fail(422, 'consulta_corta', 'Escribe al menos 3 letras.');
  const scope = req.query.scope === 'youtube' ? 'youtube' : 'repertorio';
  const out = await provider.search(query, { venueId: room.venue_id, scope });
  res.json({ items: out.items.map(({ playUrl, ...i }) => i), source: out.source || provider.id, canExpand: Boolean(out.canExpand) });
}));

// Lista de respaldo
adminRouter.get('/rooms/:roomId/fallback', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const { rows } = await q('SELECT id, provider, media_id AS "mediaId", title, channel, thumbnail, duration_sec AS "durationSec" FROM fallback_items WHERE room_id = $1 ORDER BY position, id', [room.id]);
  res.json({ items: rows });
}));

adminRouter.post('/rooms/:roomId/fallback', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  const item = await getProvider(room.provider).getMedia(String(req.body.mediaId || ''), { venueId: room.venue_id });
  const rej = mediaRejection(item, { ...mergeSettings(room.settings), duracion_max_seg: 7200 }, await blockedSet(room.venue_id));
  if (rej) fail(422, rej.code, rej.message);
  await q(
    `INSERT INTO fallback_items(room_id, provider, media_id, title, channel, thumbnail, duration_sec, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT COALESCE(max(position),0)+1 FROM fallback_items WHERE room_id = $1))`,
    [room.id, item.provider, item.mediaId, item.title, item.channel, item.thumbnail, item.durationSec]);
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'respaldo.agregar', detail: { title: item.title } });
  res.status(201).json({ ok: true });
}));

adminRouter.delete('/rooms/:roomId/fallback/:id', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  await q('DELETE FROM fallback_items WHERE id = $1 AND room_id = $2', [intParam(req.params.id), room.id]);
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'respaldo.quitar', detail: { id: req.params.id } });
  res.json({ ok: true });
}));

// Videos bloqueados (por sede)
adminRouter.get('/rooms/:roomId/blocked', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const { rows } = await q('SELECT id, provider, media_id AS "mediaId", title, reason, created_at AS "createdAt" FROM blocked_media WHERE venue_id = $1 ORDER BY created_at DESC', [room.venue_id]);
  res.json({ items: rows });
}));

adminRouter.post('/rooms/:roomId/blocked', wrap(async (req, res) => {
  const room = await loadRoom(req); // el operador puede bloquear en caliente
  const provider = getProvider(String(req.body.provider || room.provider)).id;
  const mediaId = cleanText(req.body.mediaId, 80);
  if (!mediaId) fail(422, 'solicitud_invalida', 'Falta el video.');
  await q(
    `INSERT INTO blocked_media(venue_id, provider, media_id, title, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (venue_id, provider, media_id) DO NOTHING`,
    [room.venue_id, provider, mediaId, cleanText(req.body.title, 200) || null, cleanText(req.body.reason, 200) || null, req.user.id]);
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'video.bloquear', detail: { provider, mediaId } });
  // El bloqueo es de toda la sede: en cada sala sale de la fila y, si está sonando, se salta.
  const { rows: salas } = await q('SELECT id FROM rooms WHERE venue_id = $1', [room.venue_id]);
  for (const sala of salas) {
    await withRoomLock(sala.id, async (c, ps) => {
      await c.query("UPDATE requests SET status = 'cancelada', ended_at = now(), fail_reason = 'bloqueada' WHERE room_id = $1 AND provider = $2 AND media_id = $3 AND status IN ('pendiente','por_aprobar')",
        [sala.id, provider, mediaId]);
      const sonando = await c.query("SELECT id FROM requests WHERE id = $1 AND provider = $2 AND media_id = $3", [ps.current_request_id, provider, mediaId]);
      if (sonando.rowCount) await finishCurrent(c, ps, { requestId: sonando.rows[0].id, outcome: 'omitida', actor: req.actor });
    });
  }
  res.status(201).json({ ok: true });
}));

adminRouter.delete('/rooms/:roomId/blocked/:id', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  await q('DELETE FROM blocked_media WHERE id = $1 AND venue_id = $2', [intParam(req.params.id), room.venue_id]);
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'video.desbloquear', detail: { id: req.params.id } });
  res.json({ ok: true });
}));

// ───────── Historial, errores, auditoría, consumo ─────────
adminRouter.get('/rooms/:roomId/history', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const { rows } = await q(
    `SELECT r.id, r.title, r.channel, r.status, r.source, r.provider, r.media_id AS "mediaId", r.fail_reason AS "failReason",
            r.created_at AS "createdAt", r.started_at AS "startedAt", r.ended_at AS "endedAt", p.alias
       FROM requests r LEFT JOIN participants p ON p.id = r.participant_id
      WHERE r.room_id = $1 ORDER BY r.id DESC LIMIT 200`, [room.id]);
  res.json({ items: rows });
}));

adminRouter.get('/rooms/:roomId/errors', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const { rows } = await q('SELECT id, kind, message, detail, created_at AS "createdAt" FROM error_log WHERE room_id = $1 ORDER BY id DESC LIMIT 100', [room.id]);
  res.json({ items: rows });
}));

adminRouter.get('/rooms/:roomId/audit', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  const { rows } = await q(
    `SELECT a.id, a.actor, a.action, a.detail, a.created_at AS "createdAt", u.name AS "userName"
       FROM audit_log a LEFT JOIN users u ON a.actor = 'usuario:' || u.id
      WHERE a.room_id = $1 ORDER BY a.id DESC LIMIT 200`, [room.id]);
  res.json({ items: rows });
}));

adminRouter.get('/usage', requireUser('admin_sede'), wrap(async (req, res) => {
  const { rows } = await q("SELECT day, units, searches, cache_hits AS \"cacheHits\", errors, exhausted_at AS \"exhaustedAt\" FROM api_usage WHERE provider = 'youtube' ORDER BY day DESC LIMIT 14");
  res.json({ today: await youtube.usageToday(), status: await youtube.status(), days: rows });
}));

// ───────── Pantallas (televisor) ─────────
adminRouter.post('/rooms/:roomId/tv/link', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const d = await createDevice(req, res, room.id, req.user.id, cleanText(req.body.label, 60) || 'Vinculada desde el panel');
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'pantalla.vincular', detail: { deviceId: d.id } });
  res.status(201).json({ ok: true });
}));

adminRouter.post('/rooms/:roomId/tv/pair', wrap(async (req, res) => {
  const room = await loadRoom(req);
  rateLimit(`pairok:${req.user.id}`, 10, 300);
  const { rowCount } = await q('UPDATE pairing_codes SET room_id = $2, approved_by = $3 WHERE code = $1 AND expires_at > now() AND room_id IS NULL',
    [cleanText(req.body.code, 6), room.id, req.user.id]);
  if (!rowCount) fail(404, 'codigo_invalido', 'Ese código no existe o ya venció.');
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'pantalla.vincular_codigo' });
  res.json({ ok: true });
}));

adminRouter.get('/rooms/:roomId/tv/devices', wrap(async (req, res) => {
  const room = await loadRoom(req);
  const { rows } = await q('SELECT id, label, created_at AS "createdAt" FROM player_devices WHERE room_id = $1 AND revoked_at IS NULL ORDER BY id DESC', [room.id]);
  res.json({ items: rows });
}));

adminRouter.delete('/rooms/:roomId/tv/devices/:id', wrap(async (req, res) => {
  const room = await loadRoom(req, 'admin_sede');
  await q('UPDATE player_devices SET revoked_at = now() WHERE id = $1 AND room_id = $2', [intParam(req.params.id), room.id]);
  await audit({ query: q }, { venueId: room.venue_id, roomId: room.id, actor: req.actor, action: 'pantalla.revocar', detail: { deviceId: req.params.id } });
  res.json({ ok: true });
}));

// ───────── Catálogo autorizado (contenido propio o con licencia) ─────────
adminRouter.get('/venues/:venueId/catalog', wrap(async (req, res) => {
  const venueId = intParam(req.params.venueId);
  assertVenue(req.user, venueId);
  const { rows } = await q(
    `SELECT id, media_id AS "mediaId", title, artist, duration_sec AS "durationSec", url, license_note AS "licenseNote", is_demo AS demo, active, venue_id AS "venueId"
       FROM catalog_items WHERE venue_id IS NULL OR venue_id = $1 ORDER BY title`, [venueId]);
  res.json({ items: rows });
}));

adminRouter.post('/venues/:venueId/catalog', wrap(async (req, res) => {
  const venueId = intParam(req.params.venueId);
  assertVenue(req.user, venueId, 'admin_sede');
  const title = cleanText(req.body.title, 120);
  const url = cleanText(req.body.url, 500);
  const duration = Number(req.body.durationSec);
  const note = cleanText(req.body.licenseNote, 200);
  if (title.length < 2) fail(422, 'titulo_invalido', 'Escribe el título.');
  if (!/^https:\/\/\S+$/.test(url)) fail(422, 'url_invalida', 'La URL del archivo debe empezar por https://');
  if (!Number.isInteger(duration) || duration < 5 || duration > 7200) fail(422, 'duracion_invalida', 'Duración inválida (en segundos).');
  if (note.length < 3) fail(422, 'licencia_requerida', 'Indica de dónde viene el derecho de uso (propio, licencia, contrato…).');
  const { rows } = await q(
    `INSERT INTO catalog_items(venue_id, media_id, title, artist, duration_sec, url, license_note)
     VALUES ($1, 'cat-' || substr(md5(random()::text), 1, 12), $2, $3, $4, $5, $6) RETURNING id`,
    [venueId, title, cleanText(req.body.artist, 80) || null, duration, url, note]);
  await audit({ query: q }, { venueId, actor: req.actor, action: 'catalogo.agregar', detail: { id: rows[0].id, title } });
  res.status(201).json({ id: rows[0].id });
}));

adminRouter.delete('/venues/:venueId/catalog/:id', wrap(async (req, res) => {
  const venueId = intParam(req.params.venueId);
  assertVenue(req.user, venueId, 'admin_sede');
  const { rowCount } = await q('UPDATE catalog_items SET active = false WHERE id = $1 AND venue_id = $2', [intParam(req.params.id), venueId]);
  if (!rowCount) fail(404, 'no_encontrado', 'Solo puedes retirar contenido de tu sede.');
  await audit({ query: q }, { venueId, actor: req.actor, action: 'catalogo.retirar', detail: { id: req.params.id } });
  res.json({ ok: true });
}));

// ───────── Repertorio (listas de YouTube importadas: búsqueda sin gastar cuota) ─────────
function repertoireScope(req) {
  const venueId = intParam(req.params.venueId);
  assertVenue(req.user, venueId, 'admin_sede');
  return venueId;
}

adminRouter.get('/venues/:venueId/repertoire', wrap(async (req, res) => {
  const venueId = repertoireScope(req);
  const { rows } = await q(
    `SELECT id, venue_id AS "venueId", list_id AS "listId", title, channel, item_count AS count, units_spent AS units, last_error AS "lastError",
            created_at AS "createdAt", refreshed_at AS "refreshedAt"
       FROM repertoire_lists WHERE venue_id = $1 OR venue_id IS NULL ORDER BY title`, [venueId]);
  const total = (await q(
    `SELECT count(DISTINCT i.media_id)::int AS n FROM repertoire_items i JOIN repertoire_lists l ON l.id = i.list_id WHERE l.venue_id = $1 OR l.venue_id IS NULL`, [venueId])).rows[0].n;
  res.json({ lists: rows, total, youtube: await youtube.status() });
}));

adminRouter.post('/venues/:venueId/repertoire', wrap(async (req, res) => {
  const venueId = repertoireScope(req);
  rateLimit(`import:${req.user.id}`, 20, 600);
  const listId = parsePlaylistId(req.body.url);
  const shared = req.body.todas === true && req.user.role === 'admin_general'; // disponible en todas las sedes
  const out = await importList({ venueId: shared ? null : venueId, listId, userId: req.user.id });
  res.status(201).json(out);
}));

adminRouter.post('/venues/:venueId/repertoire/:id/refresh', wrap(async (req, res) => {
  const venueId = repertoireScope(req);
  rateLimit(`import:${req.user.id}`, 20, 600);
  const { rows } = await q('SELECT * FROM repertoire_lists WHERE id = $1 AND (venue_id = $2 OR (venue_id IS NULL AND $3))', [intParam(req.params.id), venueId, req.user.role === 'admin_general']);
  if (!rows[0]) fail(404, 'no_encontrado', 'Lista no encontrada.');
  res.json(await importList({ listRowId: rows[0].id, venueId: rows[0].venue_id, listId: rows[0].list_id, userId: req.user.id }));
}));

adminRouter.delete('/venues/:venueId/repertoire/:id', wrap(async (req, res) => {
  const venueId = repertoireScope(req);
  const { rowCount } = await q('DELETE FROM repertoire_lists WHERE id = $1 AND (venue_id = $2 OR (venue_id IS NULL AND $3))', [intParam(req.params.id), venueId, req.user.role === 'admin_general']);
  if (!rowCount) fail(404, 'no_encontrado', 'Lista no encontrada.');
  await audit({ query: q }, { venueId, actor: req.actor, action: 'repertorio.quitar', detail: { id: req.params.id } });
  res.json({ ok: true });
}));
