// Proveedor YouTube con la red SIMULADA (no hay credenciales reales en este entorno).
// Comprueba el contrato del adaptador, la contabilidad de cuota y el escenario 14 (cuota agotada).
// La reproducción real con el IFrame Player API se verifica a mano: ver docs/PRUEBAS.md.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, q, adminAgent, tvFor, guest, tokenOf, rooms, setSettings, resetRateLimits } from './helpers.js';
import { youtube, parseIsoDuration, quotaDay } from '../src/providers/youtube.js';

let admin; let A; let calls;

const video = (id, over = {}) => ({
  id,
  snippet: { title: `Video ${id}`, channelTitle: 'Canal', liveBroadcastContent: over.live ? 'live' : 'none', thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
  contentDetails: { duration: over.duration || 'PT3M30S', ...(over.blockedCO ? { regionRestriction: { blocked: ['CO'] } } : {}), ...(over.age ? { contentRating: { ytRating: 'ytAgeRestricted' } } : {}) },
  status: { embeddable: over.embeddable ?? true, madeForKids: Boolean(over.kids) },
});
const IDS = ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3', 'dddddddddd4', 'eeeeeeeeee5', 'ffffffffff6', 'gggggggggg7'];
const CATALOG = {
  [IDS[0]]: video(IDS[0]),
  [IDS[1]]: video(IDS[1], { duration: 'PT12M' }),
  [IDS[2]]: video(IDS[2], { live: true, duration: 'P0D' }),
  [IDS[3]]: video(IDS[3], { embeddable: false }),
  [IDS[4]]: video(IDS[4], { blockedCO: true }),
  [IDS[5]]: video(IDS[5], { age: true }),
  [IDS[6]]: video(IDS[6], { kids: true }),
};
const json = (status, body) => ({ ok: status === 200, status, json: async () => body });

function mockOk() {
  youtube._fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname.split('/').pop());
    assert.equal(u.searchParams.get('key'), 'clave-de-prueba');
    if (u.pathname.endsWith('/search')) {
      assert.equal(u.searchParams.get('type'), 'video');
      assert.equal(u.searchParams.get('videoEmbeddable'), 'true');
      return json(200, { items: IDS.map((id) => ({ id: { videoId: id } })), nextPageToken: 'PAG2' });
    }
    return json(200, { items: u.searchParams.get('id').split(',').map((id) => CATALOG[id]).filter(Boolean) });
  };
}
function mockQuotaExceeded() {
  youtube._fetch = async (url) => {
    calls.push(new URL(url).pathname.split('/').pop());
    return json(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
  };
}

before(async () => { await start(); admin = await adminAgent(); [A] = await rooms(); });
after(stop);
beforeEach(async () => {
  resetRateLimits();
  calls = [];
  await admin.post(`/api/admin/rooms/${A.id}/session/cerrar`);
  await q('TRUNCATE api_usage, search_cache, media_cache');
  await q('DELETE FROM fallback_items');
  await q("UPDATE rooms SET provider = 'youtube', settings = '{}' WHERE id = $1", [A.id]);
  await setSettings(A.id, { intervalo_seg: 0, repeticion_min: 0 });
  await q('UPDATE playback_state SET leader_id = NULL WHERE room_id = $1', [A.id]);
  mockOk();
});

async function night() {
  const tv = await tvFor(admin, A.id);
  await tv.post('/api/tv/start', { tabId: tv.tabId });
  const token = await tokenOf(A.id);
  return { tv, token, g: await guest(token, 'Ana') };
}

test('duraciones ISO 8601 y día de cuota (hora del Pacífico)', () => {
  assert.equal(parseIsoDuration('PT3M30S'), 210);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(quotaDay(new Date('2026-10-13T06:30:00Z')), '2026-10-12', '06:30 UTC todavía es el día anterior en el Pacífico');
});

test('búsqueda: resultados anotados, caché y contabilidad de cuota', async () => {
  const { g, token } = await night();
  const r = await g.get(`/api/s/${token}/search?q=${encodeURIComponent('carlos vives')}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.nextPage, 'PAG2');
  const by = Object.fromEntries(r.body.items.map((i) => [i.mediaId, i]));
  assert.deepEqual(r.body.items.map((i) => i.mediaId), IDS, 'mismo orden que devolvió YouTube, sin quitar resultados');
  assert.equal(by[IDS[0]].available, true);
  assert.equal(by[IDS[0]].durationSec, 210);
  assert.match(by[IDS[1]].reason, /muy larga/);           // 12 min > 8 min
  assert.match(by[IDS[2]].reason, /en vivo/);
  assert.match(by[IDS[3]].reason, /no permite/);          // no integrable
  assert.equal(by[IDS[4]].available, false, 'bloqueado en Colombia');
  assert.equal(by[IDS[5]].available, false, 'restricción de edad');
  assert.equal(by[IDS[6]].available, false, 'hecho para niños');
  assert.ok(!JSON.stringify(r.body).includes('clave-de-prueba'), 'la clave jamás llega al cliente');

  // Misma consulta (aunque cambien mayúsculas): sale de caché, cero llamadas nuevas.
  await g.get(`/api/s/${token}/search?q=${encodeURIComponent('Carlos Vives')}`);
  assert.deepEqual(calls, ['search', 'videos']);
  const u = (await admin.get('/api/admin/usage')).body.today;
  assert.equal(u.units, 101, '100 de search.list + 1 de videos.list');
  assert.equal(u.searches, 1);
  assert.equal(u.cache_hits, 1);

  // Consultas cortas no llegan a la API.
  assert.equal((await g.get(`/api/s/${token}/search?q=ab`)).status, 422);
  assert.equal(calls.length, 2);
});

test('una solicitud de YouTube se valida en el servidor antes de entrar a la fila', async () => {
  const { g, tv } = await night();
  const ok = await g.add(IDS[0], crypto.randomUUID(), 'youtube');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.request.title, `Video ${IDS[0]}`, 'título tomado de la API, no del cliente');
  const now = (await tv.get('/api/tv/state')).body.now;
  assert.deepEqual([now.provider, now.mediaId], ['youtube', IDS[0]]);
  assert.equal((await g.add(IDS[1], crypto.randomUUID(), 'youtube')).body.error, 'muy_larga');
  assert.equal((await g.add(IDS[2], crypto.randomUUID(), 'youtube')).body.error, 'en_vivo');
  assert.equal((await g.add(IDS[3], crypto.randomUUID(), 'youtube')).body.error, 'no_reproducible');
  assert.equal((await g.add('zzzzzzzzzz9', crypto.randomUUID(), 'youtube')).body.error, 'no_encontrado');
  assert.equal((await g.add('../../etc', crypto.randomUUID(), 'youtube')).body.error, 'no_encontrado');
  assert.equal((await g.add('demo-01', crypto.randomUUID(), 'catalogo')).body.error, 'proveedor_invalido', 'no se mezclan catálogos en una sala');
});

test('14 · cuota agotada: mensaje claro y la fila no se borra', async () => {
  const { g, token, tv } = await night();
  await g.add(IDS[0], crypto.randomUUID(), 'youtube');
  await g.get(`/api/s/${token}/search?q=primera`); // cachea metadatos
  const antes = (await tv.get('/api/tv/state')).body;

  mockQuotaExceeded();
  calls = [];
  const r = await g.get(`/api/s/${token}/search?q=segunda`);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'cuota_agotada');
  assert.match(r.body.message, /límite/);
  assert.match(r.body.message, /fila sigue funcionando/);

  // Ya marcada como agotada: no se vuelve a llamar a YouTube en lo que queda del día.
  const r2 = await g.get(`/api/s/${token}/search?q=tercera`);
  assert.equal(r2.body.error, 'cuota_agotada');
  assert.deepEqual(calls, ['search']);

  // La fila y lo que suena siguen igual, y el avance no depende de la cuota.
  const despues = (await tv.get('/api/tv/state')).body;
  assert.equal(despues.now.id, antes.now.id);
  assert.equal((await tv.post('/api/tv/ended', { tabId: tv.tabId, requestId: antes.now.id })).body.changed, true);

  // Lo ya buscado sigue disponible desde caché, y hay sugerencias sin gastar cuota.
  assert.equal((await g.get(`/api/s/${token}/search?q=primera`)).status, 200);
  const sug = await g.get(`/api/s/${token}/sugeridas`);
  assert.equal(sug.status, 200);
  assert.ok(sug.body.items.some((i) => i.mediaId === IDS[0]), 'lo que ya sonó se puede volver a elegir');

  // El panel muestra el problema y queda en el registro de errores.
  const usage = (await admin.get('/api/admin/usage')).body;
  assert.ok(usage.today.exhausted_at);
  assert.equal(usage.status.searchExhausted, true);
  const errs = (await admin.get(`/api/admin/rooms/${A.id}/errors`)).body.items;
  assert.ok(errs.some((e) => e.kind === 'busqueda.cuota_agotada'));
});

test('presupuesto propio: las búsquedas se frenan antes de tocar la reserva para validar videos', async () => {
  const { g, token } = await night();
  await q("INSERT INTO api_usage(day, provider, units) VALUES ($1,'youtube', 9450)", [quotaDay()]);
  const r = await g.get(`/api/s/${token}/search?q=reserva`);
  assert.equal(r.body.error, 'cuota_agotada');
  assert.deepEqual(calls, [], 'ni siquiera se llamó a la API');
  assert.equal((await g.add(IDS[0], crypto.randomUUID(), 'youtube')).status, 201, 'validar un video (1 unidad) aún es posible');
});

test('YouTube deshabilitado: no se puede asignar a una sala', async () => {
  const { config } = await import('../src/config.js');
  await q("UPDATE rooms SET provider = 'catalogo' WHERE id = $1", [A.id]);
  config.youtube.enabled = false;
  try {
    const r = await admin.put(`/api/admin/rooms/${A.id}/settings`, { provider: 'youtube' });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /autorización de uso comercial/);
  } finally { config.youtube.enabled = true; }
});
