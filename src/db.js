import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';

pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT → number (ids y seq caben de sobra)

let pool;
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 15,
      connectionTimeoutMillis: 10_000, // nunca esperar una conexión para siempre
      ssl: /sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (e) => console.error('[db] error en conexión inactiva:', e.message));
  }
  return pool;
}
export const q = (text, params) => getPool().query(text, params);
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }

/** Ejecuta fn dentro de una transacción. Reintenta una vez ante interbloqueo o fallo de serialización. */
export async function tx(fn) {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt < 2 && ['40001', '40P01'].includes(e.code)) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

/**
 * Candado por sala: toda mutación de la fila o de la reproducción pasa por aquí.
 * Un solo candado por sala ⇒ orden total de operaciones y cero interbloqueos.
 */
export function withRoomLock(roomId, fn) {
  return tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM playback_state WHERE room_id = $1 FOR UPDATE', [roomId]);
    if (!rows[0]) throw Object.assign(new Error('Sala no encontrada'), { status: 404 });
    const result = await fn(c, rows[0]);
    await c.query('UPDATE playback_state SET version = version + 1 WHERE room_id = $1', [roomId]);
    await c.query("SELECT pg_notify('rockola', $1)", [String(roomId)]); // se entrega al confirmar
    return result;
  });
}

export async function notifyRoom(roomId) {
  await q("SELECT pg_notify('rockola', $1)", [String(roomId)]);
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate() {
  await q('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    const done = await q('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
    if (done.rowCount) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
