// Fila de reproducción: alta, retiro, aprobación y reordenamiento.
// El orden (seq) lo asigna SIEMPRE el servidor dentro del candado de la sala.
import { withRoomLock, q } from '../db.js';
import { mergeSettings } from '../config.js';
import { getProvider } from '../providers/index.js';
import { AppError, audit, fail } from '../lib/util.js';
import { ensurePlaying, finishCurrent, openSessionOf } from './playback.js';

const fmtMin = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/** Motivo por el que un contenido no puede pedirse en esta sala, o null si es válido. */
export function mediaRejection(item, settings, blocked) {
  if (!item) return { code: 'no_encontrado', message: 'No encontramos ese video.' };
  if (blocked?.has(`${item.provider}:${item.mediaId}`)) return { code: 'bloqueada', message: 'Esta canción no está disponible en este bar.' };
  // YouTube exige tratamiento especial de datos para videos "hechos para niños"; en un bar simplemente no se ofrecen.
  if (item.madeForKids) return { code: 'no_reproducible', message: 'Este video no está disponible aquí.' };
  if (item.embeddable === false) return { code: 'no_reproducible', message: 'Este video no permite reproducirse aquí.' };
  if (item.live && settings.excluir_en_vivo) return { code: 'en_vivo', message: 'No se aceptan transmisiones en vivo.' };
  if (item.durationSec && item.durationSec > settings.duracion_max_seg) {
    return { code: 'muy_larga', message: `Es muy larga: el máximo es ${fmtMin(settings.duracion_max_seg)} min.` };
  }
  return null;
}

export async function blockedSet(venueId) {
  const { rows } = await q('SELECT provider, media_id FROM blocked_media WHERE venue_id = $1', [venueId]);
  return new Set(rows.map((r) => `${r.provider}:${r.media_id}`));
}

async function nextSeq(c, sessionId) {
  const { rows } = await c.query('UPDATE room_sessions SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq - 1 AS seq', [sessionId]);
  return rows[0].seq;
}

export async function positionOf(db, request) {
  if (request.status !== 'pendiente') return null;
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM requests WHERE session_id = $1 AND status = 'pendiente' AND seq <= $2", [request.session_id, request.seq]);
  return rows[0].n;
}

/**
 * Agrega una solicitud. `session` viene de findOpenSessionByToken; `participant` del token del cliente.
 * Idempotente por (sesión, participante, idemKey): doble clic o reintento devuelven la misma fila.
 */
export async function addRequest({ session, participant, provider, mediaId, idemKey }) {
  const settings = mergeSettings(session.settings);
  if (provider !== session.provider) fail(400, 'proveedor_invalido', 'Ese contenido no pertenece al catálogo de esta sala.');
  if (typeof idemKey !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(idemKey)) fail(400, 'solicitud_invalida', 'Solicitud inválida.');

  // Reintento de algo ya aceptado: se responde igual, sin volver a validar ni consumir cuota.
  const prior = await q('SELECT * FROM requests WHERE session_id = $1 AND participant_id = $2 AND idem_key = $3',
    [session.id, participant.id, idemKey]);
  if (prior.rowCount) return { request: prior.rows[0], position: await positionOf({ query: q }, prior.rows[0]), duplicate: true };

  // Validación del contenido en el servidor (fuera del candado: puede tocar la red). Nunca se confía en el título del cliente.
  const item = await getProvider(provider).getMedia(mediaId, { venueId: session.venue_id });
  const rejection = mediaRejection(item, settings, await blockedSet(session.venue_id));
  if (rejection) throw new AppError(422, rejection.code, rejection.message);

  return withRoomLock(session.room_id, async (c, ps) => {
    const again = await c.query('SELECT * FROM requests WHERE session_id = $1 AND participant_id = $2 AND idem_key = $3',
      [session.id, participant.id, idemKey]);
    if (again.rowCount) return { request: again.rows[0], position: await positionOf(c, again.rows[0]), duplicate: true };

    const live = await openSessionOf(c, session.room_id);
    if (!live || live.id !== session.id) fail(410, 'sesion_cerrada', 'La sesión de esta noche ya terminó.');
    if (!live.requests_open) fail(409, 'solicitudes_cerradas', 'El bar pausó las solicitudes por ahora.');

    const p = (await c.query('SELECT * FROM participants WHERE id = $1', [participant.id])).rows[0];
    if (!p || p.blocked) fail(403, 'bloqueado', 'No puedes pedir canciones en esta sesión.');

    const mine = await c.query(
      "SELECT count(*)::int AS n FROM requests WHERE session_id = $1 AND participant_id = $2 AND status IN ('pendiente','por_aprobar')",
      [session.id, p.id]);
    if (mine.rows[0].n >= settings.max_pendientes) {
      fail(409, 'limite_persona', `Ya tienes ${settings.max_pendientes} canciones en espera. Cuando suene una, pides otra.`);
    }
    if (p.last_request_at && settings.intervalo_seg > 0) {
      const wait = settings.intervalo_seg - (Date.now() - new Date(p.last_request_at).getTime()) / 1000;
      if (wait > 0) fail(429, 'espera', `Espera ${Math.ceil(wait)} s para pedir otra canción.`, { retryAfter: Math.ceil(wait) });
    }
    const total = await c.query(
      "SELECT count(*)::int AS n FROM requests WHERE session_id = $1 AND status IN ('pendiente','por_aprobar')", [session.id]);
    if (total.rows[0].n >= settings.limite_fila) fail(409, 'fila_llena', 'La fila está llena. Intenta en unos minutos.');

    if (!settings.permitir_duplicados) {
      const dup = await c.query(
        `SELECT 1 FROM requests WHERE session_id = $1 AND provider = $2 AND media_id = $3
            AND status IN ('pendiente','por_aprobar','reproduciendo') LIMIT 1`, [session.id, provider, mediaId]);
      if (dup.rowCount) fail(409, 'duplicada', 'Esa canción ya está en la fila.');
    }
    if (settings.repeticion_min > 0) {
      const rep = await c.query(
        `SELECT 1 FROM requests WHERE room_id = $1 AND provider = $2 AND media_id = $3 AND status = 'completada'
            AND ended_at > now() - make_interval(mins => $4) LIMIT 1`, [session.room_id, provider, mediaId, settings.repeticion_min]);
      if (rep.rowCount) fail(409, 'repetida_reciente', `Esa canción sonó hace poco. Se puede volver a pedir después de ${settings.repeticion_min} min.`);
    }

    const manual = settings.aprobacion_manual;
    const seq = manual ? null : await nextSeq(c, session.id);
    const { rows } = await c.query(
      `INSERT INTO requests(session_id, room_id, participant_id, source, provider, media_id, title, channel, thumbnail,
                            duration_sec, status, seq, idem_key, accepted_at)
       VALUES ($1,$2,$3,'cliente',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [session.id, session.room_id, p.id, provider, item.mediaId, item.title, item.channel, item.thumbnail,
        item.durationSec, manual ? 'por_aprobar' : 'pendiente', seq, idemKey, manual ? null : new Date()]);
    await c.query('UPDATE participants SET last_request_at = now() WHERE id = $1', [p.id]);

    // Si no suena nada (fila y respaldo vacíos) arranca de una; si suena algo, NO se interrumpe.
    await ensurePlaying(c, ps);
    const request = (await c.query('SELECT * FROM requests WHERE id = $1', [rows[0].id])).rows[0];
    return { request, position: await positionOf(c, request), duplicate: false };
  });
}

/** El cliente retira una canción suya que aún no ha sonado. */
export function cancelOwnRequest({ session, participant, requestId }) {
  return withRoomLock(session.room_id, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE requests SET status = 'cancelada', ended_at = now()
        WHERE id = $1 AND session_id = $2 AND participant_id = $3 AND status IN ('pendiente','por_aprobar')`,
      [requestId, session.id, participant.id]);
    if (!rowCount) fail(409, 'no_cancelable', 'Esa canción ya no se puede retirar.');
  });
}

// ───────── Intervenciones del administrador (todas quedan en auditoría) ─────────

async function getRoomRequest(c, roomId, requestId) {
  const { rows } = await c.query('SELECT * FROM requests WHERE id = $1 AND room_id = $2', [requestId, roomId]);
  if (!rows[0]) fail(404, 'no_encontrado', 'Solicitud no encontrada.');
  return rows[0];
}

export function adminRemove(roomId, requestId, actor) {
  return withRoomLock(roomId, async (c, ps) => {
    const r = await getRoomRequest(c, roomId, requestId);
    if (r.status === 'reproduciendo') {
      await finishCurrent(c, ps, { requestId: r.id, outcome: 'omitida', actor });
    } else if (['pendiente', 'por_aprobar'].includes(r.status)) {
      await c.query("UPDATE requests SET status = 'cancelada', ended_at = now() WHERE id = $1", [r.id]);
    } else fail(409, 'no_cancelable', 'Esa solicitud ya terminó.');
    await audit(c, { roomId, sessionId: r.session_id, actor, action: 'fila.quitar', detail: { requestId: r.id, title: r.title } });
  });
}

export function adminApprove(roomId, requestId, approve, actor) {
  return withRoomLock(roomId, async (c, ps) => {
    const r = await getRoomRequest(c, roomId, requestId);
    if (r.status !== 'por_aprobar') fail(409, 'estado_invalido', 'Esa solicitud ya fue revisada.');
    if (approve) {
      // El turno se asigna en el momento de la aceptación.
      const seq = await nextSeq(c, r.session_id);
      await c.query("UPDATE requests SET status = 'pendiente', seq = $2, accepted_at = now() WHERE id = $1", [r.id, seq]);
      await ensurePlaying(c, ps);
    } else {
      await c.query("UPDATE requests SET status = 'cancelada', ended_at = now(), fail_reason = 'rechazada' WHERE id = $1", [r.id]);
    }
    await audit(c, { roomId, sessionId: r.session_id, actor, action: approve ? 'fila.aprobar' : 'fila.rechazar', detail: { requestId: r.id, title: r.title } });
  });
}

/** Reordenamiento excepcional: sube/baja un puesto o manda al inicio. */
export function adminMove(roomId, requestId, where, actor) {
  return withRoomLock(roomId, async (c) => {
    const r = await getRoomRequest(c, roomId, requestId);
    if (r.status !== 'pendiente') fail(409, 'estado_invalido', 'Solo se pueden mover canciones pendientes.');
    const { rows: fila } = await c.query(
      "SELECT id, seq FROM requests WHERE session_id = $1 AND status = 'pendiente' ORDER BY seq", [r.session_id]);
    const i = fila.findIndex((x) => x.id === r.id);
    const j = where === 'subir' ? i - 1 : where === 'bajar' ? i + 1 : where === 'inicio' ? 0 : -1;
    if (j < 0 || j >= fila.length || j === i) fail(409, 'movimiento_invalido', 'No se puede mover más en esa dirección.');
    const ids = fila.map((x) => x.id);
    const seqs = fila.map((x) => x.seq);
    ids.splice(j, 0, ids.splice(i, 1)[0]);
    // Se reasignan los mismos números de turno al nuevo orden (primero a NULL para no chocar con el índice único).
    await c.query('UPDATE requests SET seq = NULL WHERE id = ANY($1)', [ids]);
    for (let k = 0; k < ids.length; k++) await c.query('UPDATE requests SET seq = $2 WHERE id = $1', [ids[k], seqs[k]]);
    await audit(c, { roomId, sessionId: r.session_id, actor, action: 'fila.reordenar', detail: { requestId: r.id, title: r.title, de: i + 1, a: j + 1 } });
  });
}

export function adminSkip(roomId, actor) {
  return withRoomLock(roomId, async (c, ps) => {
    if (!ps.current_request_id) fail(409, 'nada_sonando', 'No hay nada sonando.');
    return finishCurrent(c, ps, { requestId: ps.current_request_id, outcome: 'omitida', actor });
  });
}
