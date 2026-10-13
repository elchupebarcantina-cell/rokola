// Limpieza periódica: conservación limitada de datos personales y de caché de metadatos.
import { q } from '../db.js';
import { config } from '../config.js';

export async function runRetention() {
  const out = {};
  // Teléfonos: se eliminan N días después de cerrar la sesión (RETENCION_TELEFONO_DIAS).
  out.telefonos = (await q(
    `UPDATE participants p SET phone = NULL, marketing_consent = false
       FROM room_sessions s
      WHERE s.id = p.session_id AND p.phone IS NOT NULL AND s.status = 'cerrada'
        AND s.closed_at < now() - make_interval(days => $1)`, [config.phoneRetentionDays])).rowCount;
  // Metadatos de proveedores: nunca más de 30 días (política de YouTube API Services).
  out.media = (await q("DELETE FROM media_cache WHERE fetched_at < now() - interval '30 days'")).rowCount;
  out.busquedas = (await q("DELETE FROM search_cache WHERE fetched_at < now() - interval '30 days'")).rowCount;
  await q('DELETE FROM admin_sessions WHERE expires_at < now()');
  await q('DELETE FROM pairing_codes WHERE expires_at < now()');
  return out;
}

export function scheduleRetention() {
  const tick = () => runRetention().catch((e) => console.error('[retencion]', e.message));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}
