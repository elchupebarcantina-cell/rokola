// Datos iniciales (idempotente): administrador general, sedes de El Chupe, y catálogo DEMO.
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run seed
import { migrate, q, tx, closePool } from './db.js';
import { hashPassword } from './lib/util.js';

// Pistas de demostración: las sintetiza el propio sistema en el navegador (contenido propio, sin derechos de terceros).
const DEMO = [
  ['Cumbia del Chupe', 34], ['Guaro y Neón', 28], ['La Última y Nos Vamos', 40], ['Cantina a Medianoche', 32],
  ['Salud, Compadre', 26], ['Vallenato de Prueba', 36], ['Rumba en la 72', 30], ['Despecho en Do Menor', 38],
  ['Brindis Llanero', 29], ['El Cubetazo', 27], ['Noche en Acacías', 33], ['Un Chupe o Qué', 31],
];

export async function seed({ email, password, venues = ['El Chupe · Calle 72', 'El Chupe · Bachué', 'El Chupe · Acacías'] } = {}) {
  await migrate();
  await tx(async (c) => {
    if (email && password) {
      const exists = await c.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
      if (!exists.rowCount) {
        await c.query("INSERT INTO users(email, name, password_hash, role) VALUES ($1,'Administrador general',$2,'admin_general')",
          [email.toLowerCase(), await hashPassword(password)]);
      }
    }
    for (let i = 0; i < DEMO.length; i++) {
      const [title, dur] = DEMO[i];
      await c.query(
        `INSERT INTO catalog_items(media_id, title, artist, duration_sec, url, license_note, is_demo)
         VALUES ($1,$2,'Pista DEMO · contenido propio',$3,$4,'Generada por el sistema para demostración',true)
         ON CONFLICT (media_id) DO NOTHING`, [`demo-${String(i + 1).padStart(2, '0')}`, `${title} (DEMO)`, dur, `synth:${i + 1}`]);
    }
    for (const name of venues) {
      const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      let v = (await c.query('SELECT id FROM venues WHERE slug = $1', [slug])).rows[0];
      if (v) continue;
      v = (await c.query("INSERT INTO venues(slug, name, logo_url) VALUES ($1,$2,'/img/logo-el-chupe.jpg') RETURNING id", [slug, name])).rows[0];
      const r = (await c.query("INSERT INTO rooms(venue_id, slug, name) VALUES ($1,'principal','Sala principal') RETURNING id", [v.id])).rows[0];
      await c.query('INSERT INTO playback_state(room_id) VALUES ($1)', [r.id]);
      await c.query(
        `INSERT INTO fallback_items(room_id, provider, media_id, title, channel, duration_sec, position)
         SELECT $1, 'catalogo', media_id, title, artist, duration_sec, row_number() OVER (ORDER BY media_id)
           FROM catalog_items WHERE is_demo AND media_id IN ('demo-01','demo-04','demo-07','demo-10')`, [r.id]);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!email || !password || password.length < 10) {
    console.error('Define ADMIN_EMAIL y ADMIN_PASSWORD (mínimo 10 caracteres) para crear el administrador general.');
    process.exit(1);
  }
  await seed({ email, password });
  console.log('Listo: administrador, sedes y catálogo DEMO creados (si no existían).');
  await closePool();
}
