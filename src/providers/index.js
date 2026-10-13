/**
 * Proveedores de contenido intercambiables.
 *
 * Contrato de un proveedor:
 *   id            'catalogo' | 'youtube' | …
 *   capabilities  { crossfade: boolean, externalPlayer: boolean }
 *   isConfigured() → boolean                         comprobación en memoria (sin base ni red)
 *   status()      → { available, reason }            ¿se puede usar ahora mismo?
 *   search(q, { page, venueId }) → { items, nextPage, fromCache }
 *   getMedia(id, { venueId })    → item | null       validación en servidor antes de aceptar una solicitud
 *
 * Un item: { provider, mediaId, title, channel, thumbnail, durationSec, live, embeddable, playUrl?, demo? }
 *
 * Para sumar un catálogo comercial (p. ej. un proveedor de video con licencia para negocios) se crea
 * otro archivo con este contrato, se registra aquí y se añade su adaptador de reproducción en
 * public/tv/players.js. Nada más del sistema cambia.
 */
import { catalogo } from './catalogo.js';
import { youtube } from './youtube.js';
import { AppError } from '../lib/util.js';

const providers = { catalogo, youtube };

export function getProvider(id) {
  if (typeof id !== 'string' || !Object.hasOwn(providers, id)) throw new AppError(400, 'proveedor_invalido', 'Proveedor de contenido desconocido.');
  return providers[id];
}
export const listProviders = () => Object.values(providers);
