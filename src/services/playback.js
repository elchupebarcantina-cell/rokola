// Avance de la reproducción. Todas las funciones reciben (c, ps): el cliente de la transacción y la
// fila playback_state ya bloqueada por withRoomLock. Por eso cada avance ocurre exactamente una vez.
import { config } from '../config.js';
import { getProvider } from '../providers/index.js';
import { audit } from '../lib/util.js';

export async function openSessionOf(c, roomId) {
  const { rows } = await c.query("SELECT * FROM room_sessions WHERE room_id = $1 AND status = 'abierta'", [roomId]);
  return rows[0] || null;
}

async function setCurrent(c, ps, requestId) {
  ps.current_request_id = requestId;
  await c.query('UPDATE playback_state SET current_request_id = $2 WHERE room_id = $1', [ps.room_id, requestId]);
}

/** Elige lo siguiente: primero la fila (FIFO por seq); si está vacía, la lista de respaldo. */
async function pickNext(c, ps, session) {
  const next = await c.query(
    "SELECT id FROM requests WHERE session_id = $1 AND status = 'pendiente' ORDER BY seq LIMIT 1", [session.id]);
  if (next.rowCount) {
    await c.query("UPDATE requests SET status = 'reproduciendo', started_at = now() WHERE id = $1", [next.rows[0].id]);
    await setCurrent(c, ps, next.rows[0].id);
    return next.rows[0].id;
  }

  const room = (await c.query('SELECT venue_id FROM rooms WHERE id = $1', [ps.room_id])).rows[0];
  const { rows: items } = await c.query(
    `SELECT f.* FROM fallback_items f
      WHERE f.room_id = $1
        AND NOT EXISTS (SELECT 1 FROM blocked_media b WHERE b.venue_id = $2 AND b.provider = f.provider AND b.media_id = f.media_id)
      ORDER BY f.position, f.id`, [ps.room_id, room.venue_id]);
  // Comprobación en memoria (sin tocar la base): dentro del candado no se piden más conexiones al pool.
  const usable = items.filter((it) => { try { return getProvider(it.provider).isConfigured(); } catch { return false; } });
  if (!usable.length) { await setCurrent(c, ps, null); return null; }

  const it = usable[ps.fallback_cursor % usable.length];
  const ins = await c.query(
    `INSERT INTO requests(session_id, room_id, source, provider, media_id, title, channel, thumbnail, duration_sec, status, started_at)
     VALUES ($1,$2,'respaldo',$3,$4,$5,$6,$7,$8,'reproduciendo', now()) RETURNING id`,
    [session.id, ps.room_id, it.provider, it.media_id, it.title, it.channel, it.thumbnail, it.duration_sec]);
  ps.fallback_cursor = (ps.fallback_cursor + 1) % 1_000_000;
  await c.query('UPDATE playback_state SET fallback_cursor = $2 WHERE room_id = $1', [ps.room_id, ps.fallback_cursor]);
  await setCurrent(c, ps, ins.rows[0].id);
  return ins.rows[0].id;
}

/** Si la noche está iniciada y no suena nada, arranca lo siguiente. Nunca interrumpe lo que suena. */
export async function ensurePlaying(c, ps) {
  if (ps.current_request_id || ps.attention) return null;
  const session = await openSessionOf(c, ps.room_id);
  if (!session || !session.started) return null;
  return pickNext(c, ps, session);
}

/**
 * Cierra la canción actual y avanza. Es un "comparar y cambiar": si requestId ya no es la actual
 * (otra pestaña, un reintento o el administrador ya avanzaron) no hace nada.
 */
export async function finishCurrent(c, ps, { requestId, outcome, reason, actor }) {
  if (!requestId || ps.current_request_id !== requestId) return { changed: false };

  if (outcome === 'fallida') {
    ps.consecutive_failures += 1;
    if (ps.consecutive_failures >= config.maxConsecutiveFailures) {
      // Varios fallos seguidos huelen a problema general (internet, proveedor caído), no a un video malo.
      // No se sigue descartando la fila: la canción vuelve a "pendiente" conservando su turno y se pide intervención.
      const r = (await c.query('SELECT source FROM requests WHERE id = $1', [requestId])).rows[0];
      if (r.source === 'respaldo') {
        await c.query("UPDATE requests SET status = 'fallida', ended_at = now(), fail_reason = $2 WHERE id = $1", [requestId, reason || null]);
      } else {
        await c.query("UPDATE requests SET status = 'pendiente', started_at = NULL WHERE id = $1", [requestId]);
      }
      ps.attention = 'Fallaron varias canciones seguidas. Revisa la conexión a internet del equipo y pulsa «Reanudar».';
      await c.query('UPDATE playback_state SET consecutive_failures = $2, attention = $3 WHERE room_id = $1',
        [ps.room_id, ps.consecutive_failures, ps.attention]);
      await setCurrent(c, ps, null);
      await audit(c, { roomId: ps.room_id, sessionId: ps.session_id, actor: 'sistema', action: 'reproduccion.detenida_por_fallos', detail: { reason } });
      return { changed: true, halted: true };
    }
    await c.query('UPDATE playback_state SET consecutive_failures = $2 WHERE room_id = $1', [ps.room_id, ps.consecutive_failures]);
  }

  await c.query('UPDATE requests SET status = $2, ended_at = now(), fail_reason = $3 WHERE id = $1',
    [requestId, outcome, outcome === 'fallida' ? (reason || 'desconocido') : null]);
  await setCurrent(c, ps, null);
  if (outcome === 'omitida' && actor) {
    await audit(c, { roomId: ps.room_id, sessionId: ps.session_id, actor, action: 'reproduccion.saltar', detail: { requestId } });
  }
  const nextId = await ensurePlaying(c, ps);
  return { changed: true, nextId };
}

/** El televisor confirma que la canción empezó a sonar de verdad: se reinicia el contador de fallos. */
export async function markPlaying(c, ps, requestId) {
  if (ps.current_request_id !== requestId) return;
  if (ps.consecutive_failures) {
    ps.consecutive_failures = 0;
    await c.query('UPDATE playback_state SET consecutive_failures = 0 WHERE room_id = $1', [ps.room_id]);
  }
}

export async function clearAttention(c, ps, actor) {
  ps.attention = null;
  ps.consecutive_failures = 0;
  await c.query('UPDATE playback_state SET attention = NULL, consecutive_failures = 0 WHERE room_id = $1', [ps.room_id]);
  await audit(c, { roomId: ps.room_id, sessionId: ps.session_id, actor, action: 'reproduccion.reanudar_tras_fallos' });
  return ensurePlaying(c, ps);
}

export async function setDesired(c, ps, desired, actor) {
  await c.query('UPDATE playback_state SET desired = $2 WHERE room_id = $1', [ps.room_id, desired]);
  await audit(c, { roomId: ps.room_id, sessionId: ps.session_id, actor, action: desired === 'pause' ? 'reproduccion.pausar' : 'reproduccion.continuar' });
}
