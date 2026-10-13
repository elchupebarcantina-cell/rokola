// API de la pantalla del televisor. Se autentica con la credencial del equipo (cookie httpOnly),
// creada por un usuario autorizado. Solo la pestaña líder puede avanzar la reproducción.
import crypto from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { q, withRoomLock, notifyRoom } from '../db.js';
import { config } from '../config.js';
import { requireDevice, createDevice } from '../lib/auth.js';
import { subscribe } from '../lib/realtime.js';
import { cleanText, fail, logError, newToken, rateLimit, sha256, toId, wrap } from '../lib/util.js';
import { openSession } from '../services/sessions.js';
import { finishCurrent, markPlaying } from '../services/playback.js';
import { tvSnapshot } from '../services/snapshot.js';

export const tvRouter = Router();
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

// ───────── Vinculación por código (para un equipo distinto al del administrador) ─────────
tvRouter.post('/pair/start', wrap(async (req, res) => {
  rateLimit(`pair:${req.ip}`, 10, 300);
  await q('DELETE FROM pairing_codes WHERE expires_at < now()');
  const secret = newToken();
  for (let i = 0; i < 5; i++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const ins = await q("INSERT INTO pairing_codes(code, secret_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes') ON CONFLICT (code) DO NOTHING",
      [code, sha256(secret)]);
    if (ins.rowCount) return res.json({ code, secret });
  }
  fail(503, 'reintenta', 'No se pudo generar el código. Intenta de nuevo.');
}));

tvRouter.post('/pair/claim', wrap(async (req, res) => {
  rateLimit(`claim:${req.ip}`, 120, 300);
  const { rows } = await q('SELECT * FROM pairing_codes WHERE code = $1 AND secret_hash = $2 AND expires_at > now()',
    [String(req.body.code || ''), sha256(String(req.body.secret || ''))]);
  if (!rows[0]) fail(404, 'codigo_vencido', 'El código venció. Genera uno nuevo.');
  if (!rows[0].room_id) return res.json({ paired: false });
  await createDevice(req, res, rows[0].room_id, rows[0].approved_by, 'Vinculada por código');
  await q('DELETE FROM pairing_codes WHERE code = $1', [rows[0].code]);
  res.json({ paired: true });
}));

// ───────── Todo lo demás exige pantalla vinculada ─────────
tvRouter.use(requireDevice);

tvRouter.get('/state', wrap(async (req, res) => {
  res.json(await tvSnapshot(req.device.room_id, baseUrl(req)));
}));

tvRouter.get('/events', wrap(async (req, res) => {
  subscribe(req, res, req.device.room_id, 'tv');
}));

tvRouter.get('/qr.svg', wrap(async (req, res) => {
  const snap = await tvSnapshot(req.device.room_id, baseUrl(req));
  if (!snap?.joinUrl) fail(404, 'sin_sesion', 'No hay sesión abierta.');
  // Nivel de corrección Q: tolera reflejos y distancia en un televisor.
  const svg = await QRCode.toString(snap.joinUrl, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2, color: { dark: '#0b0a08', light: '#f3ead6' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
}));

/**
 * Latido + liderazgo. Una sola pestaña por sala es la reproductora principal:
 * toma el liderazgo si está libre o vencido y lo renueva en cada latido. Si esa pestaña muere,
 * el liderazgo vence solo (LIDER_VIGENCIA_SEG) y otra pantalla puede recuperarlo.
 */
tvRouter.post('/heartbeat', wrap(async (req, res) => {
  const tabId = cleanText(req.body.tabId, 64);
  if (tabId.length < 8) fail(400, 'solicitud_invalida', 'Falta identificador de pestaña.');
  const status = cleanText(req.body.status, 24) || 'desconocido';
  const detail = cleanText(req.body.detail, 200) || null;
  const takeover = req.body.takeover === true;
  const roomId = req.device.room_id;

  const before = (await q('SELECT leader_id, player_status, player_detail FROM playback_state WHERE room_id = $1', [roomId])).rows[0];
  const { rows } = await q(
    `UPDATE playback_state
        SET leader_id = $2, leader_expires_at = now() + make_interval(secs => $3),
            player_status = $4, player_detail = $5, last_heartbeat = now()
      WHERE room_id = $1 AND ($6 OR leader_id IS NULL OR leader_id = $2 OR leader_expires_at < now())
      RETURNING leader_id`, [roomId, tabId, config.leaderLeaseSec, status, detail, takeover]);
  const leader = rows.length > 0;
  if (leader && (before.leader_id !== tabId || before.player_status !== status || before.player_detail !== detail)) {
    if (takeover && before.leader_id && before.leader_id !== tabId) {
      await q("INSERT INTO audit_log(room_id, actor, action) VALUES ($1,$2,'pantalla.tomar_control')", [roomId, req.actor]);
    }
    await notifyRoom(roomId); // el panel ve el cambio de estado del reproductor
  }
  res.json({ leader });
}));

async function assertLeader(c, ps, tabId) {
  // Basta con que el líder registrado siga siendo esta pestaña. Si su vigencia venció por un corte de red
  // pero ninguna otra pantalla tomó el control, su aviso de fin sigue siendo válido (si otra lo hubiera
  // tomado, leader_id ya sería distinto).
  if (!tabId || ps.leader_id !== tabId) {
    fail(409, 'no_es_lider', 'Otra pantalla es la reproductora principal de esta sala.');
  }
}

// "Iniciar noche": abre la sesión si hace falta y arranca la reproducción.
tvRouter.post('/start', wrap(async (req, res) => {
  const roomId = req.device.room_id;
  const ps = (await q('SELECT * FROM playback_state WHERE room_id = $1', [roomId])).rows[0];
  await assertLeader(null, ps, cleanText(req.body.tabId, 64));
  await openSession(roomId, req.actor, { start: true });
  res.json(await tvSnapshot(roomId, baseUrl(req)));
}));

tvRouter.post('/playing', wrap(async (req, res) => {
  await withRoomLock(req.device.room_id, async (c, ps) => {
    await assertLeader(c, ps, cleanText(req.body.tabId, 64));
    await markPlaying(c, ps, (toId(req.body.requestId) ?? 0));
  });
  res.json({ ok: true });
}));

// El reproductor confirmó (con su evento oficial de fin) que el video terminó.
tvRouter.post('/ended', wrap(async (req, res) => {
  const out = await withRoomLock(req.device.room_id, async (c, ps) => {
    await assertLeader(c, ps, cleanText(req.body.tabId, 64));
    return finishCurrent(c, ps, { requestId: (toId(req.body.requestId) ?? 0), outcome: 'completada' });
  });
  res.json({ ...out, state: await tvSnapshot(req.device.room_id, baseUrl(req)) });
}));

// Video no disponible / no integrable / error de carga tras los reintentos del reproductor.
tvRouter.post('/failed', wrap(async (req, res) => {
  const reason = cleanText(req.body.reason, 120) || 'desconocido';
  const requestId = (toId(req.body.requestId) ?? 0);
  const out = await withRoomLock(req.device.room_id, async (c, ps) => {
    await assertLeader(c, ps, cleanText(req.body.tabId, 64));
    return finishCurrent(c, ps, { requestId, outcome: 'fallida', reason });
  });
  if (out.changed) {
    const r = (await q('SELECT session_id, provider, media_id, title FROM requests WHERE id = $1', [requestId])).rows[0];
    await logError({ roomId: req.device.room_id, sessionId: r?.session_id, kind: 'reproduccion.fallo',
      message: reason, detail: { requestId, provider: r?.provider, mediaId: r?.media_id, title: r?.title, halted: Boolean(out.halted) } });
  }
  res.json({ ...out, state: await tvSnapshot(req.device.room_id, baseUrl(req)) });
}));

// Diagnóstico: autoplay bloqueado, reconexiones, errores del reproductor.
tvRouter.post('/report', wrap(async (req, res) => {
  rateLimit(`report:${req.device.id}`, 30, 60);
  await logError({ roomId: req.device.room_id, kind: `pantalla.${cleanText(req.body.kind, 40) || 'aviso'}`,
    message: cleanText(req.body.message, 300) || '(sin detalle)' });
  res.json({ ok: true });
}));
