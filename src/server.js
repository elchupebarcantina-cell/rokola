import { createApp } from './app.js';
import { config } from './config.js';
import { migrate, closePool } from './db.js';
import { startRealtime, stopRealtime } from './lib/realtime.js';
import { scheduleRetention } from './services/retention.js';

const applied = await migrate();
if (applied.length) console.log('[db] migraciones aplicadas:', applied.join(', '));
// Primer arranque: si se definen ADMIN_EMAIL y ADMIN_PASSWORD se crean el administrador general,
// las sedes y el catálogo DEMO (solo lo que no exista). Después conviene borrar ADMIN_PASSWORD del hosting.
if (process.env.ADMIN_EMAIL && (process.env.ADMIN_PASSWORD || '').length >= 10) {
  const { seed } = await import('./seed.js');
  await seed({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  console.log('[inicio] datos iniciales verificados para', process.env.ADMIN_EMAIL);
}
await startRealtime();
scheduleRetention();

const server = createApp().listen(config.port, () => {
  console.log(`Rockola El Chupe en el puerto ${config.port}`);
  if (!config.publicBaseUrl) console.warn('[aviso] PUBLIC_BASE_URL no está definida: el QR usará el host de cada petición.');
});
server.keepAliveTimeout = 65_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await stopRealtime();
    server.close(async () => { await closePool(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
