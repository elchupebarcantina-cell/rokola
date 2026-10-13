// Repertorio del bar: listas de reproducción de YouTube importadas como metadatos (nunca video).
// Leer una lista cuesta 1 unidad por cada 50 videos, contra 100 por cada búsqueda. La búsqueda de los
// clientes consulta primero aquí, sin gastar cuota. Política de YouTube: los datos se refrescan o se
// borran a los 30 días; aquí se refrescan a los 25 y se purga lo que no se pudo refrescar a los 30.
import { q, tx } from '../db.js';
import { AppError, audit } from '../lib/util.js';

const MAX_ITEMS = 3000;          // tope por lista (60 páginas + 60 lotes = 120 unidades)
const REFRESH_DAYS = 25;

/** Acepta un enlace de lista, un enlace de video con &list=, o el identificador tal cual. */
export function parsePlaylistId(input) {
  const s = String(input || '').trim();
  let id = s;
  try { const u = new URL(s); id = u.searchParams.get('list') || ''; } catch { /* no es URL */ }
  if (!/^[A-Za-z0-9_-]{10,60}$/.test(id)) throw new AppError(422, 'lista_invalida', 'Pega el enlace de una lista de reproducción de YouTube (…/playlist?list=PL…).');
  if (/^RD/.test(id)) throw new AppError(422, 'lista_invalida', 'Las listas "Mix" las arma YouTube para cada persona y no se pueden importar. Crea una lista propia.');
  return id;
}

const toItem = (r) => ({
  provider: 'youtube', mediaId: r.media_id, title: r.title, channel: r.channel, thumbnail: r.thumbnail,
  durationSec: r.duration_sec, live: r.live, embeddable: r.embeddable, madeForKids: r.made_for_kids,
});

/** Búsqueda local por título o canal. Prioriza coincidencias al inicio del título. */
export async function searchRepertoire(query, { venueId = null, limit = 30 } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const conds = words.map((_, i) => `(lower(i.title) LIKE $${i + 2} OR lower(coalesce(i.channel,'')) LIKE $${i + 2})`).join(' AND ');
  const params = [venueId, ...words.map((w) => `%${w.replace(/[%_\\]/g, '\\$&')}%`)];
  const { rows } = await q(
    `SELECT DISTINCT ON (i.media_id) i.*
       FROM repertoire_items i JOIN repertoire_lists l ON l.id = i.list_id
      WHERE (l.venue_id IS NULL OR l.venue_id = $1) AND i.fetched_at > now() - interval '30 days' AND ${conds}
      ORDER BY i.media_id, i.fetched_at DESC`, params);
  const first = words[0];
  rows.sort((a, b) => (b.title.toLowerCase().startsWith(first) - a.title.toLowerCase().startsWith(first)) || a.title.localeCompare(b.title));
  return rows.slice(0, limit).map(toItem);
}

export async function findInRepertoire(mediaId, { venueId = null } = {}) {
  const { rows } = await q(
    `SELECT i.* FROM repertoire_items i JOIN repertoire_lists l ON l.id = i.list_id
      WHERE i.media_id = $2 AND (l.venue_id IS NULL OR l.venue_id = $1) AND i.fetched_at > now() - interval '30 days'
      ORDER BY i.fetched_at DESC LIMIT 1`, [venueId, mediaId]);
  return rows[0] ? toItem(rows[0]) : null;
}

/** Importa o refresca una lista. Devuelve { title, count, units }. */
export async function importList({ listRowId, venueId, listId, userId }) {
  const { youtube } = await import('../providers/youtube.js');
  const st = await youtube.status();
  if (!st.available) throw new AppError(503, 'proveedor_no_disponible', st.reason);
  const before = (await youtube.usageToday()).units;

  const info = await youtube.playlistInfo(listId);
  if (!info) throw new AppError(404, 'lista_no_encontrada', 'YouTube no encontró esa lista. Revisa que sea pública o "no listada".');

  const ids = [];
  let token = '';
  do {
    const page = await youtube.playlistPage(listId, token);
    ids.push(...page.ids);
    token = page.next;
  } while (token && ids.length < MAX_ITEMS);

  const videos = [];
  for (let i = 0; i < ids.length; i += 50) videos.push(...await youtube.fetchVideos(ids.slice(i, i + 50)));
  const units = (await youtube.usageToday()).units - before;

  const id = await tx(async (c) => {
    const row = listRowId
      ? (await c.query('UPDATE repertoire_lists SET title=$2, channel=$3, item_count=$4, units_spent=units_spent+$5, last_error=NULL, refreshed_at=now() WHERE id=$1 RETURNING id',
        [listRowId, info.title, info.channel, videos.length, units])).rows[0]
      : (await c.query(
        `INSERT INTO repertoire_lists(venue_id, provider, list_id, title, channel, item_count, units_spent, created_by, refreshed_at)
         VALUES ($1,'youtube',$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (venue_id, provider, list_id) DO UPDATE SET title=EXCLUDED.title, channel=EXCLUDED.channel, item_count=EXCLUDED.item_count,
           units_spent=repertoire_lists.units_spent+EXCLUDED.units_spent, last_error=NULL, refreshed_at=now() RETURNING id`,
        [venueId, listId, info.title, info.channel, videos.length, units, userId])).rows[0];
    await c.query('DELETE FROM repertoire_items WHERE list_id = $1', [row.id]);
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      await c.query(
        `INSERT INTO repertoire_items(list_id, media_id, title, channel, thumbnail, duration_sec, embeddable, live, made_for_kids, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (list_id, media_id) DO NOTHING`,
        [row.id, v.mediaId, v.title, v.channel, v.thumbnail, v.durationSec, v.embeddable, v.live, v.madeForKids, i]);
    }
    await audit(c, { venueId, actor: userId ? `usuario:${userId}` : 'sistema', action: listRowId ? 'repertorio.refrescar' : 'repertorio.importar', detail: { listId, title: info.title, count: videos.length, units } });
    return row.id;
  });
  return { id, title: info.title, count: videos.length, units, truncated: ids.length >= MAX_ITEMS };
}

/** Refresca las listas con más de 25 días y purga lo que lleve más de 30 sin refrescar (política de YouTube). */
export async function refreshStale() {
  const { rows } = await q(`SELECT * FROM repertoire_lists WHERE refreshed_at IS NULL OR refreshed_at < now() - make_interval(days => $1) ORDER BY refreshed_at NULLS FIRST LIMIT 10`, [REFRESH_DAYS]);
  const out = { refreshed: 0, failed: 0 };
  for (const l of rows) {
    try { await importList({ listRowId: l.id, venueId: l.venue_id, listId: l.list_id, userId: null }); out.refreshed++; } catch (e) {
      out.failed++;
      await q('UPDATE repertoire_lists SET last_error = $2 WHERE id = $1', [l.id, String(e.message).slice(0, 200)]);
    }
  }
  out.purged = (await q("DELETE FROM repertoire_items WHERE fetched_at < now() - interval '30 days'")).rowCount;
  return out;
}
