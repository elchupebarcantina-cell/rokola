// Tiempo real con Server-Sent Events + LISTEN/NOTIFY de PostgreSQL.
// Cada cambio de una sala hace pg_notify al confirmar la transacción; todas las instancias del servidor
// lo reciben y lo reenvían a sus conexiones abiertas. Así funciona igual con una o con varias instancias.
import pg from 'pg';
import { config } from '../config.js';
import { publicSnapshot, stripInternal } from '../services/snapshot.js';

const subs = new Map(); // roomId → Set<{ res, kind }>
const timers = new Map();
let listener; let stopped = false; let pingTimer;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** kind: 'public' recibe el estado público completo; 'tv' y 'admin' reciben un aviso y vuelven a consultar el suyo. */
export function subscribe(req, res, roomId, kind, sessionId = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const sub = { res, kind, sessionId };
  if (!subs.has(roomId)) subs.set(roomId, new Set());
  subs.get(roomId).add(sub);
  req.on('close', () => {
    subs.get(roomId)?.delete(sub);
    if (subs.get(roomId)?.size === 0) subs.delete(roomId);
  });
  broadcast(roomId, [sub]).catch(() => {}); // estado inicial inmediato (también tras cada reconexión)
}

async function broadcast(roomId, only) {
  const targets = only || [...(subs.get(roomId) || [])];
  if (!targets.length) return;
  const full = await publicSnapshot(roomId);
  if (!full) return;
  const currentSession = full._b.sid || null;
  const snap = stripInternal(full);
  for (const s of targets) {
    try {
      if (s.kind !== 'public') { send(s.res, 'cambio', { version: snap.version }); continue; }
      if (s.sessionId !== currentSession) {
        // Su sesión ya cerró: no recibe la fila de la noche siguiente. Se le avisa y se corta el canal.
        send(s.res, 'estado', { session: null, now: null, queue: [], version: snap.version });
        s.res.end();
        subs.get(roomId)?.delete(s);
        continue;
      }
      send(s.res, 'estado', snap);
    } catch { /* conexión cerrada */ }
  }
}

function schedule(roomId) {
  if (timers.has(roomId)) return;
  timers.set(roomId, setTimeout(() => {
    timers.delete(roomId);
    broadcast(roomId).catch((e) => console.error('[realtime] difusión falló:', e.message));
  }, 40));
}

export async function startRealtime() {
  stopped = false;
  let retryTimer = null;
  // Un único reintento pendiente a la vez: un fallo de conexión dispara tanto el catch como el
  // evento 'end', y sin esta guarda los reintentos se duplicarían en cada caída de la base.
  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 2000);
    retryTimer.unref();
  };
  const connect = async () => {
    if (stopped) return;
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      ssl: /sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    listener = client;
    client.on('notification', (m) => schedule(Number(m.payload)));
    client.on('error', (e) => { console.error('[realtime] listener:', e.message); });
    client.on('end', () => { if (listener === client) scheduleRetry(); });
    try {
      await client.connect();
      await client.query('LISTEN rockola');
      // Tras reconectar pudo perderse algún aviso: se reenvía el estado de todas las salas con oyentes.
      for (const roomId of subs.keys()) schedule(roomId);
    } catch (e) {
      console.error('[realtime] no se pudo escuchar:', e.message);
      client.removeAllListeners();
      client.on('error', () => {});
      client.end().catch(() => {});
      scheduleRetry();
    }
  };
  await connect();
  // Latido para que proxies y balanceadores no corten conexiones inactivas.
  pingTimer = setInterval(() => {
    for (const set of subs.values()) for (const s of set) { try { s.res.write(': ping\n\n'); } catch { /* cerrada */ } }
  }, 20_000);
  pingTimer.unref();
}

export async function stopRealtime() {
  stopped = true;
  clearInterval(pingTimer);
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const set of subs.values()) for (const s of set) { try { s.res.end(); } catch { /* cerrada */ } }
  subs.clear();
  if (listener) await listener.end().catch(() => {});
}

export const subscriberCount = (roomId) => subs.get(roomId)?.size || 0;
