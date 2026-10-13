// Fotografías del estado de una sala para cada audiencia.
// La pública NUNCA incluye teléfonos, tokens ni datos privados.
import { q } from '../db.js';
import { config, mergeSettings } from '../config.js';
import { getProvider } from '../providers/index.js';

const REQ_COLS = `r.id, r.title, r.channel, r.thumbnail, r.duration_sec, r.status, r.source, r.provider, r.media_id,
                  r.seq, r.started_at, r.participant_id, p.alias`;

const pub = (r) => r && ({
  id: r.id, title: r.title, channel: r.channel, thumbnail: r.thumbnail, durationSec: r.duration_sec,
  source: r.source, alias: r.source === 'respaldo' ? null : (r.alias || 'Invitado'), pid: r.participant_id,
  startedAt: r.started_at || undefined,
});

async function base(roomId) {
  const { rows } = await q(
    `SELECT r.id AS room_id, r.name AS room_name, r.provider, r.settings, v.id AS venue_id, v.name AS venue_name,
            v.logo_url, v.accent, ps.*, s.id AS sid, s.public_token, s.door_code, s.requests_open, s.started, s.opened_at
       FROM rooms r JOIN venues v ON v.id = r.venue_id
       JOIN playback_state ps ON ps.room_id = r.id
       LEFT JOIN room_sessions s ON s.room_id = r.id AND s.status = 'abierta'
      WHERE r.id = $1`, [roomId]);
  return rows[0] || null;
}

export async function publicSnapshot(roomId) {
  const b = await base(roomId);
  if (!b) return null;
  const settings = mergeSettings(b.settings);
  const provider = getProvider(b.provider);
  let now = null; let queue = [];
  if (b.sid) {
    const { rows } = await q(
      `SELECT ${REQ_COLS} FROM requests r LEFT JOIN participants p ON p.id = r.participant_id
        WHERE r.session_id = $1 AND r.status IN ('reproduciendo','pendiente') ORDER BY r.seq NULLS FIRST`, [b.sid]);
    now = rows.find((r) => r.status === 'reproduciendo') || null;
    queue = rows.filter((r) => r.status === 'pendiente');
  }
  return {
    _b: b, _now: now, _queue: queue, // uso interno; se eliminan antes de enviar
    venue: { name: b.venue_name, logo: b.logo_url, accent: b.accent },
    room: { name: b.room_name, provider: b.provider, providerLabel: provider.label, externalPlayer: provider.capabilities.externalPlayer },
    session: b.sid ? {
      requestsOpen: b.requests_open, started: b.started, needCode: settings.exigir_codigo, phone: settings.telefono,
      manualApproval: settings.aprobacion_manual, maxPending: settings.max_pendientes,
    } : null,
    paused: b.desired === 'pause',
    now: pub(now),
    queue: queue.map(pub),
    version: b.version,
    serverTime: new Date().toISOString(),
  };
}

export function stripInternal(snap) {
  if (!snap) return snap;
  const { _b, _now, _queue, ...rest } = snap;
  return rest;
}

async function playUrls(items) {
  const ids = items.filter((r) => r && r.provider === 'catalogo').map((r) => r.media_id);
  if (!ids.length) return new Map();
  const { rows } = await q('SELECT media_id, url, is_demo FROM catalog_items WHERE media_id = ANY($1)', [ids]);
  return new Map(rows.map((r) => [r.media_id, r]));
}

/** Estado para el televisor: añade lo necesario para reproducir y el enlace del QR. */
export async function tvSnapshot(roomId, baseUrl) {
  const snap = await publicSnapshot(roomId);
  if (!snap) return null;
  const b = snap._b;
  const settings = mergeSettings(b.settings);
  const urls = await playUrls([snap._now, snap._queue[0]]);
  const play = (r) => r && ({
    ...pub(r), provider: r.provider, mediaId: r.media_id,
    playUrl: urls.get(r.media_id)?.url, demo: urls.get(r.media_id)?.is_demo || false,
  });
  return {
    ...stripInternal(snap),
    now: play(snap._now),
    next: play(snap._queue[0]),
    desired: b.desired,
    attention: b.attention,
    leaderId: b.leader_expires_at && new Date(b.leader_expires_at) > new Date() ? b.leader_id : null,
    crossfadeSec: getProvider(b.provider).capabilities.crossfade ? settings.crossfade_seg : 0,
    joinUrl: b.sid ? `${config.publicBaseUrl || baseUrl}/s/${b.public_token}` : null,
    doorCode: b.sid && settings.exigir_codigo ? b.door_code : null,
    youtubeRegion: config.youtube.regionCode,
  };
}

/** Estado para el panel: añade por aprobar, participantes y salud del reproductor. */
export async function adminSnapshot(roomId, baseUrl, { showPhones }) {
  const tv = await tvSnapshot(roomId, baseUrl);
  if (!tv) return null;
  const b = await base(roomId);
  let pending = []; let participants = [];
  if (b.sid) {
    pending = (await q(
      `SELECT ${REQ_COLS} FROM requests r LEFT JOIN participants p ON p.id = r.participant_id
        WHERE r.session_id = $1 AND r.status = 'por_aprobar' ORDER BY r.created_at`, [b.sid])).rows.map(pub);
    participants = (await q(
      `SELECT p.id, p.alias, p.phone, p.marketing_consent, p.blocked, p.created_at,
              (SELECT count(*)::int FROM requests r WHERE r.participant_id = p.id) AS solicitudes
         FROM participants p WHERE p.session_id = $1 ORDER BY p.created_at DESC LIMIT 300`, [b.sid])).rows
      .map((p) => ({ ...p, phone: showPhones ? p.phone : (p.phone ? '•••' : null) }));
  }
  const alive = b.last_heartbeat && Date.now() - new Date(b.last_heartbeat).getTime() < 20_000;
  return {
    ...tv,
    roomId: b.room_id, venueId: b.venue_id,
    settings: mergeSettings(b.settings),
    doorCode: b.sid ? b.door_code : null,
    sessionOpenedAt: b.opened_at,
    pending, participants,
    player: { online: Boolean(alive), status: alive ? b.player_status : 'sin_conexion', detail: b.player_detail, lastSeen: b.last_heartbeat },
    providerStatus: await getProvider(b.provider).status(),
  };
}
