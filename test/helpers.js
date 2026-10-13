// Utilidades de prueba: base PostgreSQL real, servidor HTTP real y clientes con su propio tarro de cookies.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/rockola_test';
process.env.YOUTUBE_HABILITADO = 'si';
process.env.YOUTUBE_API_KEY = 'clave-de-prueba';
process.env.PUBLIC_BASE_URL = '';

const { q, closePool } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { seed } = await import('../src/seed.js');
const { startRealtime, stopRealtime } = await import('../src/lib/realtime.js');
const { resetRateLimits, hashPassword } = await import('../src/lib/util.js');

export { q, resetRateLimits };
export const ADMIN = { email: 'admin@elchupe.test', password: 'clave-super-segura' };

let server; let base;
export const baseUrl = () => base;

export async function start() {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed({ ...ADMIN, venues: ['Sede A', 'Sede B'] });
  await startRealtime();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

export async function stop() {
  await stopRealtime();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await closePool();
}

/** Cliente HTTP con cookies propias (simula un navegador: celular, televisor o panel). */
export function agent() {
  const jar = new Map();
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  };
  return {
    jar,
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p),
  };
}

export async function adminAgent(creds = ADMIN) {
  const a = agent();
  const r = await a.post('/api/admin/login', creds);
  if (r.status !== 200) throw new Error(`login falló: ${JSON.stringify(r.body)}`);
  return a;
}

export async function rooms() {
  const { rows } = await q('SELECT r.id, r.venue_id, v.name FROM rooms r JOIN venues v ON v.id = r.venue_id ORDER BY v.name');
  return rows;
}

export async function createUser({ email, role, venueId, password = 'clave-super-segura' }) {
  await q('INSERT INTO users(email, name, password_hash, role, venue_id) VALUES ($1,$2,$3,$4,$5)', [email, email, await hashPassword(password), role, venueId]);
  return { email, password };
}

/** Televisor vinculado a una sala y ya convertido en líder. */
export async function tvFor(admin, roomId, tabId = `tab-${Math.random().toString(36).slice(2, 12)}`) {
  const tv = agent();
  for (const [k, v] of admin.jar) tv.jar.set(k, v);
  const link = await tv.post(`/api/admin/rooms/${roomId}/tv/link`, {});
  if (link.status !== 201) throw new Error('no se pudo vincular la pantalla');
  tv.jar.delete('rk_admin'); // el televisor queda SOLO con su credencial de pantalla
  tv.tabId = tabId;
  tv.beat = (extra = {}) => tv.post('/api/tv/heartbeat', { tabId: tv.tabId, status: 'reproduciendo', ...extra });
  await tv.beat();
  return tv;
}

/** Cliente que escaneó el QR y se registró. */
export async function guest(token, alias) {
  const g = agent();
  const r = await g.post(`/api/s/${token}/join`, { alias, acepta: true });
  if (r.status !== 201) throw new Error(`join falló: ${JSON.stringify(r.body)}`);
  g.me = r.body.me;
  g.add = (mediaId, idemKey = crypto.randomUUID(), provider = 'catalogo') => g.post(`/api/s/${token}/requests`, { provider, mediaId, idemKey });
  return g;
}

export async function tokenOf(roomId) {
  return (await q("SELECT public_token FROM room_sessions WHERE room_id = $1 AND status = 'abierta'", [roomId])).rows[0]?.public_token;
}

export const setSettings = (roomId, s) => q('UPDATE rooms SET settings = settings || $2::jsonb WHERE id = $1', [roomId, JSON.stringify(s)]);
