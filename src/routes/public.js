// API pública de la sesión (lo que abre el QR). El token del QR identifica sede + sesión
// y NO concede ningún permiso administrativo.
import { Router } from 'express';
import QRCode from 'qrcode';
import { q, notifyRoom, withRoomLock } from '../db.js';
import { config, mergeSettings } from '../config.js';
import { getProvider } from '../providers/index.js';
import { currentParticipant, participantCookie } from '../lib/auth.js';
import { subscribe } from '../lib/realtime.js';
import { cleanText, fail, newToken, rateLimit, setCookie, sha256, toId, wrap, logError } from '../lib/util.js';
import { findOpenSessionByToken } from '../services/sessions.js';
import { addRequest, blockedSet, cancelOwnRequest, mediaRejection, positionOf } from '../services/queue.js';
import { publicSnapshot, stripInternal } from '../services/snapshot.js';

export const publicRouter = Router();

async function loadSession(req, { mustBeOpen = true } = {}) {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) fail(404, 'no_encontrado', 'Este código QR no es válido.');
  const session = await findOpenSessionByToken(token);
  if (!session) fail(404, 'no_encontrado', 'Este código QR no es válido.');
  if (mustBeOpen && session.status !== 'abierta') fail(410, 'sesion_cerrada', 'La sesión de esta noche ya terminó. Escanea el QR del televisor para entrar a la nueva.');
  return session;
}

async function requireParticipant(req, session) {
  const p = await currentParticipant(req, session);
  if (!p) fail(401, 'sin_registro', 'Ingresa tu nombre para pedir canciones.');
  if (p.blocked) fail(403, 'bloqueado', 'No puedes pedir canciones en esta sesión.');
  return p;
}

async function myRequests(session, p) {
  const { rows } = await q(
    `SELECT id, title, channel, thumbnail, duration_sec AS "durationSec", status, seq, session_id, fail_reason AS "failReason"
       FROM requests WHERE session_id = $1 AND participant_id = $2 ORDER BY created_at DESC LIMIT 50`, [session.id, p.id]);
  for (const r of rows) { r.position = await positionOf({ query: q }, r); delete r.session_id; delete r.seq; }
  return rows;
}

const meOf = (p) => p && ({ id: p.id, alias: p.alias, hasPhone: Boolean(p.phone), marketing: p.marketing_consent });

// Estado inicial de la página del cliente
publicRouter.get('/:token', wrap(async (req, res) => {
  const session = await loadSession(req, { mustBeOpen: false });
  const snap = stripInternal(await publicSnapshot(session.room_id));
  if (session.status !== 'abierta') {
    return res.status(410).json({ error: 'sesion_cerrada', message: 'La sesión de esta noche ya terminó.', venue: snap.venue, room: snap.room });
  }
  const p = await currentParticipant(req, session);
  res.json({
    ...snap, me: meOf(p), mine: p ? await myRequests(session, p) : [],
    privacy: { retentionDays: config.phoneRetentionDays },
  });
}));

publicRouter.get('/:token/events', wrap(async (req, res) => {
  const session = await loadSession(req);
  subscribe(req, res, session.room_id, 'public', session.id);
}));

publicRouter.get('/:token/qr.svg', wrap(async (req, res) => {
  const session = await loadSession(req);
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  const svg = await QRCode.toString(`${base}/s/${session.public_token}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#0b0a08', light: '#f3ead6' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
}));

// Registro rápido: alias obligatorio; teléfono solo si la sala lo permite; marketing siempre aparte y opcional.
publicRouter.post('/:token/join', wrap(async (req, res) => {
  rateLimit(`join:${req.ip}`, 15, 300);
  const session = await loadSession(req);
  const settings = mergeSettings(session.settings);
  const alias = cleanText(req.body.alias, 24);
  if (alias.length < 2) fail(422, 'alias_invalido', 'Escribe un nombre o alias de al menos 2 letras.');
  if (req.body.acepta !== true) fail(422, 'sin_aceptacion', 'Debes aceptar el aviso de privacidad para continuar.');
  if (settings.exigir_codigo && String(req.body.codigo || '').trim() !== session.door_code) {
    fail(403, 'codigo_incorrecto', 'El código no coincide. Míralo en la pantalla del bar.');
  }
  let phone = null; let marketing = false;
  if (settings.telefono === 'opcional' && req.body.telefono) {
    phone = String(req.body.telefono).replace(/[^\d+]/g, '').slice(0, 16);
    if (phone.replace(/\D/g, '').length < 7) fail(422, 'telefono_invalido', 'Revisa el número de teléfono o déjalo vacío.');
    marketing = req.body.marketing === true; // casilla independiente; sin teléfono no hay marketing
  }
  const existing = await currentParticipant(req, session);
  if (existing) {
    if (existing.blocked) fail(403, 'bloqueado', 'No puedes pedir canciones en esta sesión.');
    await q('UPDATE participants SET alias = $2, phone = COALESCE($3, phone), marketing_consent = $4 WHERE id = $1',
      [existing.id, alias, phone, phone ? marketing : existing.marketing_consent]);
    await notifyRoom(session.room_id);
    return res.json({ me: meOf({ ...existing, alias, phone: phone || existing.phone, marketing_consent: marketing }) });
  }
  const token = newToken();
  const { rows } = await q(
    'INSERT INTO participants(session_id, alias, phone, marketing_consent, token_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [session.id, alias, phone, marketing, sha256(token)]);
  setCookie(req, res, participantCookie(session.public_token), token, { maxAgeSec: 18 * 3600 });
  res.status(201).json({ me: meOf(rows[0]) });
}));

publicRouter.get('/:token/me', wrap(async (req, res) => {
  const session = await loadSession(req);
  const p = await currentParticipant(req, session);
  res.json({ me: meOf(p), mine: p ? await myRequests(session, p) : [] });
}));

// "Eliminar mis datos": borra teléfono y consentimiento, anonimiza el alias y retira lo pendiente.
publicRouter.delete('/:token/me', wrap(async (req, res) => {
  const session = await loadSession(req, { mustBeOpen: false });
  const p = await currentParticipant(req, session);
  if (!p) return res.json({ ok: true });
  await withRoomLock(session.room_id, async (c) => {
    await c.query("UPDATE requests SET status = 'cancelada', ended_at = now() WHERE participant_id = $1 AND status IN ('pendiente','por_aprobar')", [p.id]);
    await c.query("UPDATE participants SET phone = NULL, marketing_consent = false, alias = 'Invitado', token_hash = $2 WHERE id = $1", [p.id, `eliminado:${p.id}:${newToken(8)}`]);
  });
  setCookie(req, res, participantCookie(session.public_token), '', { maxAgeSec: 0 });
  res.json({ ok: true });
}));

function annotate(items, settings, blocked) {
  return items.map(({ playUrl, embeddable, ...it }) => {
    const rej = mediaRejection({ ...it, embeddable }, settings, blocked);
    return { ...it, available: !rej, reason: rej?.message };
  });
}

publicRouter.get('/:token/search', wrap(async (req, res) => {
  const session = await loadSession(req);
  const p = await requireParticipant(req, session);
  rateLimit(`search:${p.id}`, 20, 60);
  const query = cleanText(req.query.q, 80);
  if (query.length < 3) fail(422, 'consulta_corta', 'Escribe al menos 3 letras.');
  const page = cleanText(req.query.page, 120);
  const provider = getProvider(session.provider);
  try {
    const out = await provider.search(query, { page, venueId: session.venue_id });
    res.json({ provider: provider.id, items: annotate(out.items, mergeSettings(session.settings), await blockedSet(session.venue_id)), nextPage: out.nextPage });
  } catch (e) {
    if (e.code === 'cuota_agotada' || e.code === 'proveedor_no_disponible') {
      await logError({ roomId: session.room_id, sessionId: session.id, kind: `busqueda.${e.code}`, message: e.message });
    }
    throw e;
  }
}));

// Sugerencias sin gastar cuota: lo que más ha sonado en la sala (metadatos ≤ 30 días) y la lista de la casa.
publicRouter.get('/:token/sugeridas', wrap(async (req, res) => {
  const session = await loadSession(req);
  await requireParticipant(req, session);
  const { rows } = await q(
    `SELECT provider, media_id AS "mediaId", max(title) AS title, max(channel) AS channel, max(thumbnail) AS thumbnail,
            max(duration_sec) AS "durationSec", count(*) AS veces
       FROM (SELECT provider, media_id, title, channel, thumbnail, duration_sec FROM requests
              WHERE room_id = $1 AND provider = $2 AND status = 'completada' AND source = 'cliente' AND ended_at > now() - interval '30 days'
             UNION ALL
             SELECT provider, media_id, title, channel, thumbnail, duration_sec FROM fallback_items WHERE room_id = $1 AND provider = $2) t
      GROUP BY provider, media_id ORDER BY veces DESC, title LIMIT 20`, [session.room_id, session.provider]);
  const items = rows.map(({ veces, ...r }) => ({ ...r, live: false }));
  if (session.provider === 'catalogo') {
    // El catálogo propio no gasta cuota: se puede mostrar completo para explorar.
    const seen = new Set(items.map((i) => i.mediaId));
    const all = await getProvider('catalogo').search('', { venueId: session.venue_id });
    items.push(...all.items.filter((i) => !seen.has(i.mediaId)));
  }
  res.json({ provider: session.provider, items: annotate(items, mergeSettings(session.settings), await blockedSet(session.venue_id)) });
}));

publicRouter.post('/:token/requests', wrap(async (req, res) => {
  const session = await loadSession(req);
  const p = await requireParticipant(req, session);
  rateLimit(`add:${p.id}`, 12, 60);
  const out = await addRequest({
    session, participant: p,
    provider: String(req.body.provider || ''), mediaId: String(req.body.mediaId || '').slice(0, 80), idemKey: req.body.idemKey,
  });
  const r = out.request;
  res.status(out.duplicate ? 200 : 201).json({
    request: { id: r.id, title: r.title, status: r.status, position: out.position }, duplicate: out.duplicate,
  });
}));

publicRouter.delete('/:token/requests/:id', wrap(async (req, res) => {
  const session = await loadSession(req);
  const p = await requireParticipant(req, session);
  await cancelOwnRequest({ session, participant: p, requestId: toId(req.params.id) ?? 0 });
  res.json({ ok: true });
}));
