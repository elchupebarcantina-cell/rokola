// Utilidades compartidas por las tres pantallas.
export class ApiError extends Error {
  constructor(status, body) { super(body?.message || 'No se pudo completar la acción.'); this.status = status; this.code = body?.error; this.body = body; }
}

/** fetch JSON. Los fallos de red se distinguen (code = 'sin_conexion') para no confundirlos con rechazos. */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', signal: AbortSignal.timeout?.(10000),
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, { error: 'sin_conexion', message: 'Sin conexión. Revisa tu internet e intenta de nuevo.' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/**
 * Suscripción en tiempo real con respaldo: EventSource se reconecta solo; además se consulta cada
 * `pollMs` por si un proxy corta el canal. onStatus(true|false) informa el estado de conexión.
 */
export function live(url, { onEvent, onStatus, poll, pollMs = 15000 }) {
  let es; let closed = false; let timer;
  const open = () => {
    es = new EventSource(url);
    es.onopen = () => onStatus?.(true);
    es.onerror = () => onStatus?.(false);
    for (const name of ['estado', 'cambio']) es.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data)));
  };
  open();
  if (poll) timer = setInterval(() => { if (!closed) poll().then(() => onStatus?.(true), () => onStatus?.(false)); }, pollMs);
  return () => { closed = true; es?.close(); clearInterval(timer); };
}

export const dur = (s) => (s || s === 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

/** Miniatura: imagen del proveedor o un disco con la inicial para el catálogo propio. */
export function thumb(item) {
  if (item.thumbnail && /^https:\/\//.test(item.thumbnail)) return `<img class="mini" src="${esc(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="strict-origin-when-cross-origin">`;
  return `<span class="mini disco" aria-hidden="true">${esc((item.title || '?').trim()[0] || '?')}</span>`;
}
