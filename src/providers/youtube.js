// Proveedor YouTube: SOLO APIs oficiales.
//   · Búsqueda y metadatos: YouTube Data API v3 (search.list = 100 unidades, videos.list = 1 unidad).
//   · Reproducción: YouTube IFrame Player API en el televisor (public/tv/players.js).
// No descarga, no extrae audio, no hace scraping y no guarda video; solo cachea metadatos (≤ 30 días).
// La clave vive únicamente en el servidor.
import { q } from '../db.js';
import { config } from '../config.js';
import { AppError } from '../lib/util.js';
import { searchRepertoire, findInRepertoire } from '../services/repertorio.js';

const API = 'https://www.googleapis.com/youtube/v3';
const COST = { search: 100, videos: 1 };

/** La cuota de YouTube se reinicia a medianoche, hora del Pacífico. */
export function quotaDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

export function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

async function usage() {
  const { rows } = await q('SELECT * FROM api_usage WHERE day = $1 AND provider = $2', [quotaDay(), 'youtube']);
  return rows[0] || { units: 0, searches: 0, cache_hits: 0, errors: 0, exhausted_at: null };
}
async function addUsage(fields) {
  const cols = Object.keys(fields);
  await q(
    `INSERT INTO api_usage(day, provider, ${cols.join(',')}) VALUES ($1,'youtube',${cols.map((_, i) => `$${i + 2}`).join(',')})
     ON CONFLICT (day, provider) DO UPDATE SET ${cols.map((c) => (c === 'exhausted_at' ? `${c} = EXCLUDED.${c}` : `${c} = api_usage.${c} + EXCLUDED.${c}`)).join(',')}`,
    [quotaDay(), ...Object.values(fields)],
  );
}

const quotaError = () => new AppError(503, 'cuota_agotada',
  'La búsqueda de hoy llegó a su límite. La fila sigue funcionando: puedes elegir de las canciones sugeridas.');

async function call(endpoint, params, cost) {
  const url = `${API}/${endpoint}?${new URLSearchParams({ ...params, key: config.youtube.apiKey })}`;
  let res;
  try {
    res = await youtube._fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    await addUsage({ errors: 1 });
    throw new AppError(502, 'proveedor_no_disponible', 'No pudimos conectar con YouTube. Intenta de nuevo en un momento.');
  }
  if (res.ok) {
    await addUsage({ units: cost, ...(endpoint === 'search' ? { searches: 1 } : {}) });
    return res.json();
  }
  const body = await res.json().catch(() => ({}));
  const reason = body?.error?.errors?.[0]?.reason || '';
  // Las peticiones fallidas también consumen cuota (al menos 1 unidad).
  await addUsage({ units: 1, errors: 1 });
  if (res.status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) {
    await addUsage({ exhausted_at: new Date() });
    throw quotaError();
  }
  console.error(`[youtube] ${endpoint} ${res.status} ${reason}`);
  throw new AppError(502, 'proveedor_no_disponible', 'YouTube no respondió correctamente. Intenta de nuevo en un momento.');
}

function toItem(v) {
  const rr = v.contentDetails?.regionRestriction;
  const region = config.youtube.regionCode;
  const regionBlocked = (rr?.blocked?.includes(region)) || (rr?.allowed && !rr.allowed.includes(region)) || false;
  const ageRestricted = v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted';
  const t = v.snippet?.thumbnails || {};
  return {
    provider: 'youtube',
    mediaId: v.id,
    title: v.snippet?.title || '(sin título)',
    channel: v.snippet?.channelTitle || '',
    thumbnail: (t.medium || t.default || {}).url || null,
    durationSec: parseIsoDuration(v.contentDetails?.duration),
    live: (v.snippet?.liveBroadcastContent || 'none') !== 'none',
    // Los videos con restricción de edad o de país no se reproducen en un reproductor integrado.
    embeddable: Boolean(v.status?.embeddable) && !regionBlocked && !ageRestricted,
    madeForKids: Boolean(v.status?.madeForKids),
  };
}

export async function fetchVideos(ids) {
  if (!ids.length) return [];
  const data = await call('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: '50' }, COST.videos);
  const items = (data.items || []).map(toItem);
  for (const it of items) {
    await q(`INSERT INTO media_cache(provider, media_id, data) VALUES ('youtube',$1,$2)
             ON CONFLICT (provider, media_id) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`, [it.mediaId, it]);
  }
  return items;
}

export const youtube = {
  id: 'youtube',
  label: 'YouTube',
  capabilities: { crossfade: false, externalPlayer: true },
  _fetch: (...a) => fetch(...a), // reemplazable en pruebas

  isConfigured: () => config.youtube.enabled && Boolean(config.youtube.apiKey),

  async status() {
    if (!config.youtube.enabled) {
      return { available: false, reason: 'YouTube está deshabilitado hasta confirmar la autorización de uso comercial (YOUTUBE_HABILITADO).' };
    }
    if (!config.youtube.apiKey) return { available: false, reason: 'Falta YOUTUBE_API_KEY en el servidor.' };
    const u = await usage();
    if (u.exhausted_at) return { available: true, searchExhausted: true, reason: 'Cuota diaria agotada; se reinicia a medianoche (hora del Pacífico).' };
    return { available: true };
  },

  /** Título y canal de una lista de reproducción (1 unidad). */
  async playlistInfo(listId) {
    const data = await call('playlists', { part: 'snippet,contentDetails', id: listId, maxResults: '1' }, 1);
    const p = data.items?.[0];
    if (!p) return null;
    return { title: p.snippet?.title || listId, channel: p.snippet?.channelTitle || '', count: p.contentDetails?.itemCount ?? 0 };
  },

  /** Una página (hasta 50) de identificadores de video de una lista (1 unidad). */
  async playlistPage(listId, pageToken = '') {
    const data = await call('playlistItems', { part: 'contentDetails', playlistId: listId, maxResults: '50', ...(pageToken ? { pageToken } : {}) }, 1);
    return { ids: (data.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean), next: data.nextPageToken || null };
  },

  /** Detalles de hasta 50 videos (1 unidad). */
  fetchVideos,

  async usageToday() {
    const u = await usage();
    return { ...u, day: quotaDay(), dailyQuota: config.youtube.dailyQuota, searchCost: COST.search };
  },

  async search(query, { page = '', venueId = null, scope = 'repertorio' } = {}) {
    if (scope !== 'youtube') {
      // Repertorio del bar: listas importadas, búsqueda local, cero unidades de cuota.
      const items = await searchRepertoire(query, { venueId });
      return { items, nextPage: null, fromCache: true, source: 'repertorio', canExpand: this.isConfigured() };
    }
    const st = await this.status();
    if (!st.available) throw new AppError(503, 'proveedor_no_disponible', st.reason);
    const key = query.toLowerCase();

    const cached = await q(
      `SELECT data FROM search_cache WHERE provider='youtube' AND query=$1 AND page=$2
         AND fetched_at > now() - make_interval(hours => $3)`, [key, page, config.youtube.searchCacheHours]);
    if (cached.rowCount) {
      await addUsage({ cache_hits: 1 });
      return { ...cached.rows[0].data, fromCache: true, source: 'youtube' };
    }

    const u = await usage();
    const budget = config.youtube.dailyQuota - config.youtube.reserveUnits;
    if (u.exhausted_at || u.units + COST.search + COST.videos > budget) throw quotaError();

    const data = await call('search', {
      part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '25',
      q: query, regionCode: config.youtube.regionCode, safeSearch: 'moderate',
      ...(page ? { pageToken: page } : {}),
    }, COST.search);
    const ids = (data.items || []).map((i) => i.id?.videoId).filter(Boolean);
    const videos = await fetchVideos(ids);
    const byId = new Map(videos.map((v) => [v.mediaId, v]));
    // Se conserva el orden y el contenido de los resultados de YouTube, sin mezclar otras fuentes.
    const result = { items: ids.map((id) => byId.get(id)).filter(Boolean), nextPage: data.nextPageToken || null };
    await q(`INSERT INTO search_cache(provider, query, page, data) VALUES ('youtube',$1,$2,$3)
             ON CONFLICT (provider, query, page) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`, [key, page, result]);
    return { ...result, fromCache: false, source: 'youtube' };
  },

  /** Validación en el servidor antes de aceptar una solicitud (1 unidad si no está en caché reciente). */
  async getMedia(mediaId, { venueId = null } = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(mediaId)) return null;
    const known = await findInRepertoire(mediaId, { venueId });
    if (known) return known; // ya validado al importar la lista: 0 unidades
    const st = await this.status();
    if (!st.available) throw new AppError(503, 'proveedor_no_disponible', st.reason);
    const cached = await q(
      "SELECT data FROM media_cache WHERE provider='youtube' AND media_id=$1 AND fetched_at > now() - interval '6 hours'", [mediaId]);
    if (cached.rowCount) return cached.rows[0].data;
    const u = await usage();
    if (u.exhausted_at || u.units + COST.videos > config.youtube.dailyQuota) throw quotaError();
    const [item] = await fetchVideos([mediaId]);
    return item || null;
  },
};
