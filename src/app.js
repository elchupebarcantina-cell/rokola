import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { csrfGuard } from './lib/auth.js';
import { publicRouter } from './routes/public.js';
import { tvRouter } from './routes/tv.js';
import { adminRouter } from './routes/admin.js';
import { q } from './db.js';
import { AppError } from './lib/util.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "media-src 'self' https: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás del proxy HTTPS del hosting (Railway, etc.)

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      // YouTube exige recibir el Referer para identificar al cliente del reproductor integrado.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/salud', async (req, res) => {
    try { await q('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api', express.json({ limit: '20kb' }), csrfGuard, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/s', publicRouter);
  app.use('/api/tv', tvRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'no_encontrado', message: 'Ruta no encontrada.' }));

  const page = (file) => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, file));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/s/:token', page('cliente/index.html'));
  app.get('/tv', page('tv/index.html'));
  app.get('/admin', page('admin/index.html'));
  app.get('/privacidad', page('privacidad.html'));
  app.use(express.static(PUBLIC, { index: false, maxAge: config.isProd ? '1h' : 0 }));
  app.use((req, res) => res.status(404).type('text').send('No encontrado'));

  // Errores: mensaje claro para la persona, sin filtrar detalles internos ni datos personales.
  app.use((err, req, res, _next) => {
    const status = Number.isInteger(err.status) ? err.status : (err.type === 'entity.parse.failed' ? 400 : 500);
    // Solo los errores propios (AppError) o los de validación del framework llevan un mensaje apto para mostrar.
    // Cualquier otro (base de datos, fallos inesperados) se registra y se responde con un texto genérico.
    const known = err instanceof AppError || (status < 500 && Boolean(err.code));
    if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err.code || '', err.message);
    if (err.extra?.retryAfter) res.set('Retry-After', String(err.extra.retryAfter));
    res.status(status).json({
      error: known ? err.code : (status >= 500 ? 'error_interno' : 'solicitud_invalida'),
      message: known ? err.message : (status >= 500 ? 'Algo falló de nuestro lado. Intenta de nuevo.' : 'Solicitud inválida.'),
      ...(known ? err.extra || {} : {}),
    });
  });
  return app;
}
