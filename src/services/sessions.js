import crypto from 'node:crypto';
import { withRoomLock, q } from '../db.js';
import { audit, newToken, fail } from '../lib/util.js';
import { ensurePlaying, openSessionOf } from './playback.js';

const newDoorCode = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

async function venueOf(c, roomId) {
  return (await c.query('SELECT venue_id FROM rooms WHERE id = $1', [roomId])).rows[0]?.venue_id;
}

/** Abre la sesión de la sala (o devuelve la que ya está abierta). `start` = "Iniciar noche" desde el televisor. */
export function openSession(roomId, actor, { start = false } = {}) {
  return withRoomLock(roomId, async (c, ps) => {
    let session = await openSessionOf(c, roomId);
    if (!session) {
      session = (await c.query(
        `INSERT INTO room_sessions(room_id, public_token, door_code, opened_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [roomId, newToken(9), newDoorCode(), actor])).rows[0];
      await c.query(
        `UPDATE playback_state SET session_id = $2, current_request_id = NULL, desired = 'play',
                attention = NULL, consecutive_failures = 0 WHERE room_id = $1`, [roomId, session.id]);
      Object.assign(ps, { session_id: session.id, current_request_id: null, attention: null, consecutive_failures: 0 });
      await audit(c, { venueId: await venueOf(c, roomId), roomId, sessionId: session.id, actor, action: 'sesion.abrir' });
    }
    if (start && !session.started) {
      await c.query('UPDATE room_sessions SET started = true WHERE id = $1', [session.id]);
      session.started = true;
      await audit(c, { roomId, sessionId: session.id, actor, action: 'sesion.iniciar_noche' });
    }
    if (session.started) await ensurePlaying(c, ps);
    return session;
  });
}

/** Cierra la sesión: el QR deja de aceptar solicitudes y lo pendiente queda cancelado (no se borra). */
export function closeSession(roomId, actor) {
  return withRoomLock(roomId, async (c, ps) => {
    const session = await openSessionOf(c, roomId);
    if (!session) fail(409, 'sin_sesion', 'La sala no tiene una sesión abierta.');
    await c.query("UPDATE requests SET status = 'omitida', ended_at = now() WHERE session_id = $1 AND status = 'reproduciendo'", [session.id]);
    await c.query("UPDATE requests SET status = 'cancelada', ended_at = now() WHERE session_id = $1 AND status IN ('pendiente','por_aprobar')", [session.id]);
    await c.query("UPDATE room_sessions SET status = 'cerrada', closed_at = now() WHERE id = $1", [session.id]);
    await c.query('UPDATE playback_state SET current_request_id = NULL, session_id = NULL, attention = NULL WHERE room_id = $1', [roomId]);
    ps.current_request_id = null;
    await audit(c, { venueId: await venueOf(c, roomId), roomId, sessionId: session.id, actor, action: 'sesion.cerrar' });
    return session;
  });
}

export function setRequestsOpen(roomId, open, actor) {
  return withRoomLock(roomId, async (c) => {
    const session = await openSessionOf(c, roomId);
    if (!session) fail(409, 'sin_sesion', 'La sala no tiene una sesión abierta.');
    await c.query('UPDATE room_sessions SET requests_open = $2 WHERE id = $1', [session.id, open]);
    await audit(c, { roomId, sessionId: session.id, actor, action: open ? 'solicitudes.abrir' : 'solicitudes.cerrar' });
  });
}

export function regenerateDoorCode(roomId, actor) {
  return withRoomLock(roomId, async (c) => {
    const session = await openSessionOf(c, roomId);
    if (!session) fail(409, 'sin_sesion', 'La sala no tiene una sesión abierta.');
    const code = newDoorCode();
    await c.query('UPDATE room_sessions SET door_code = $2 WHERE id = $1', [session.id, code]);
    await audit(c, { roomId, sessionId: session.id, actor, action: 'sesion.nuevo_codigo' });
    return code;
  });
}

export async function findOpenSessionByToken(token) {
  const { rows } = await q(
    `SELECT s.*, r.venue_id, r.provider, r.settings, r.name AS room_name
       FROM room_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.public_token = $1`, [token]);
  return rows[0] || null;
}
