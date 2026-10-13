// Catálogo propio o con licencia: el contenido que el bar SÍ puede comunicar públicamente y mezclar.
// Los items is_demo son pistas sintetizadas por el propio sistema (contenido propio) para demostración.
import { q } from '../db.js';

const toItem = (r) => ({
  provider: 'catalogo',
  mediaId: r.media_id,
  title: r.title,
  channel: r.artist,
  thumbnail: r.thumbnail,
  durationSec: r.duration_sec,
  live: false,
  embeddable: true,
  playUrl: r.url,
  demo: r.is_demo,
});

const PAGE = 20;

export const catalogo = {
  id: 'catalogo',
  label: 'Catálogo autorizado',
  capabilities: { crossfade: true, externalPlayer: false },

  isConfigured: () => true,
  async status() { return { available: true }; },

  async search(query, { page = '', venueId } = {}) {
    const offset = Math.min(100_000, Math.max(0, parseInt(page, 10) || 0));
    const { rows } = await q(
      `SELECT * FROM catalog_items
        WHERE active AND (venue_id IS NULL OR venue_id = $1)
          AND (title ILIKE $2 OR artist ILIKE $2)
        ORDER BY title LIMIT $3 OFFSET $4`,
      [venueId ?? null, `%${query.replace(/[%_\\]/g, '\\$&')}%`, PAGE + 1, offset],
    );
    return {
      items: rows.slice(0, PAGE).map(toItem),
      nextPage: rows.length > PAGE ? String(offset + PAGE) : null,
      fromCache: false,
    };
  },

  async getMedia(mediaId, { venueId } = {}) {
    const { rows } = await q(
      'SELECT * FROM catalog_items WHERE media_id = $1 AND active AND (venue_id IS NULL OR venue_id = $2)',
      [mediaId, venueId ?? null],
    );
    return rows[0] ? toItem(rows[0]) : null;
  },
};
