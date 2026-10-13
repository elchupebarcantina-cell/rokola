// Pruebas de aceptación automatizadas (escenarios 1–11 y 14 del encargo) contra PostgreSQL y HTTP reales.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  start, stop, q, agent, adminAgent, tvFor, guest, tokenOf, rooms, setSettings, resetRateLimits, createUser, baseUrl,
} from './helpers.js';

let admin; let A; let B; // salas de la Sede A y la Sede B

before(async () => {
  await start();
  admin = await adminAgent();
  [A, B] = await rooms();
});
after(stop);

// Cada prueba arranca con sesiones cerradas, sin respaldo y con límites relajados (se ajustan donde importa).
beforeEach(async () => {
  resetRateLimits();
  for (const r of [A, B]) {
    await admin.post(`/api/admin/rooms/${r.id}/session/cerrar`);
    await q('DELETE FROM fallback_items WHERE room_id = $1', [r.id]);
    await q("UPDATE rooms SET provider = 'catalogo', settings = '{}' WHERE id = $1", [r.id]);
    await q('UPDATE playback_state SET leader_id = NULL, leader_expires_at = NULL WHERE room_id = $1', [r.id]);
    await setSettings(r.id, { intervalo_seg: 0, max_pendientes: 10, repeticion_min: 0 });
  }
  await q('DELETE FROM blocked_media');
});

const state = async (tv) => (await tv.get('/api/tv/state')).body;
const startNight = async (roomId) => {
  const tv = await tvFor(admin, roomId);
  const r = await tv.post('/api/tv/start', { tabId: tv.tabId });
  assert.equal(r.status, 200);
  return tv;
};
const ended = (tv, requestId) => tv.post('/api/tv/ended', { tabId: tv.tabId, requestId });
const failed = (tv, requestId, reason = 'yt-150') => tv.post('/api/tv/failed', { tabId: tv.tabId, requestId, reason });
const sid = async (roomId) => (await q("SELECT id FROM room_sessions WHERE room_id = $1 AND status = 'abierta'", [roomId])).rows[0].id;
const demo = (n) => `demo-${String(n).padStart(2, '0')}`;

test('1 · cinco clientes agregan a la vez: orden único y consistente', async () => {
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const first = await guest(token, 'Primero');
  await first.add(demo(12)); // algo sonando, para que las 5 queden en fila
  const guests = await Promise.all([1, 2, 3, 4, 5].map((i) => guest(token, `Cliente ${i}`)));
  const results = await Promise.all(guests.map((g, i) => g.add(demo(i + 1))));
  for (const r of results) assert.equal(r.status, 201);

  const positions = results.map((r) => r.body.request.position).sort();
  assert.deepEqual(positions, [1, 2, 3, 4, 5], 'cada solicitud recibe una posición distinta');

  const { rows } = await q("SELECT seq FROM requests WHERE room_id = $1 AND status = 'pendiente' ORDER BY seq", [A.id]);
  assert.equal(new Set(rows.map((r) => r.seq)).size, 5, 'turnos únicos');

  // Televisor y dos clientes distintos ven exactamente la misma fila.
  const fromTv = (await state(tv)).queue.map((x) => x.id);
  const fromG1 = (await guests[0].get(`/api/s/${token}`)).body.queue.map((x) => x.id);
  const fromG5 = (await guests[4].get(`/api/s/${token}`)).body.queue.map((x) => x.id);
  assert.deepEqual(fromG1, fromTv);
  assert.deepEqual(fromG5, fromTv);
});

test('1b · cuarenta solicitudes simultáneas no pierden ni repiten turnos', async () => {
  await startNight(A.id);
  const token = await tokenOf(A.id);
  await setSettings(A.id, { permitir_duplicados: true, limite_fila: 100 });
  const guests = await Promise.all(Array.from({ length: 8 }, (_, i) => guest(token, `G${i}`)));
  const results = await Promise.all(guests.flatMap((g) => [1, 2, 3, 4, 5].map((n) => g.add(demo(n)))));
  assert.equal(results.filter((r) => r.status === 201).length, 40);
  const { rows } = await q("SELECT seq FROM requests WHERE session_id = $1 AND source = 'cliente' AND seq IS NOT NULL ORDER BY seq", [await sid(A.id)]);
  assert.equal(rows.length, 40);
  rows.forEach((r, i) => assert.equal(r.seq, rows[0].seq + i, 'turnos consecutivos sin huecos'));
});

test('2 · doble clic o reintento no duplica la solicitud', async () => {
  await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Dedos rápidos');
  const key = crypto.randomUUID();
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => g.add(demo(3), key)));
  assert.equal(burst.filter((r) => r.status === 201).length, 1, 'solo una creación');
  assert.equal(burst.filter((r) => r.status === 200 && r.body.duplicate).length, 4, 'las demás devuelven la misma');
  assert.equal(new Set(burst.map((r) => r.body.request.id)).size, 1);
  const retry = await g.add(demo(3), key); // reintento tardío tras una reconexión
  assert.equal(retry.status, 200);
  const { rows } = await q('SELECT count(*)::int AS n FROM requests WHERE room_id = $1 AND idem_key = $2', [A.id, key]);
  assert.equal(rows[0].n, 1);
});

test('3 · al terminar una canción empieza la siguiente una sola vez', async () => {
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  await g.add(demo(1)); await g.add(demo(2)); await g.add(demo(3));
  const s0 = await state(tv);
  assert.equal(s0.now.mediaId, demo(1));
  // El evento de fin llega repetido (reintento de red, doble evento del reproductor).
  const outs = await Promise.all([1, 2, 3, 4].map(() => ended(tv, s0.now.id)));
  assert.equal(outs.filter((o) => o.body.changed).length, 1, 'un solo avance');
  const s1 = await state(tv);
  assert.equal(s1.now.mediaId, demo(2), 'avanzó exactamente un puesto');
  assert.deepEqual(s1.queue.map((x) => x.title), ['La Última y Nos Vamos (DEMO)']);
  const { rows } = await q("SELECT count(*)::int AS n FROM requests WHERE room_id = $1 AND status = 'reproduciendo'", [A.id]);
  assert.equal(rows[0].n, 1);
});

test('4 · una solicitud nueva no interrumpe el video actual', async () => {
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  await g.add(demo(1));
  const before = (await state(tv)).now;
  const h = await guest(token, 'Beto');
  const r = await h.add(demo(2));
  assert.equal(r.body.request.position, 1);
  const now = (await state(tv)).now;
  assert.equal(now.id, before.id);
  assert.equal(now.startedAt, before.startedAt, 'no se reinició');
});

test('5 · con la fila vacía continúa la lista de respaldo, y el respaldo se termina antes de atender solicitudes', async () => {
  await admin.post(`/api/admin/rooms/${A.id}/fallback`, { mediaId: demo(10) });
  await admin.post(`/api/admin/rooms/${A.id}/fallback`, { mediaId: demo(11) });
  const tv = await startNight(A.id);
  let s = await state(tv);
  assert.equal(s.now.source, 'respaldo');
  assert.equal(s.now.mediaId, demo(10));

  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  await g.add(demo(1));
  s = await state(tv);
  assert.equal(s.now.mediaId, demo(10), 'la canción de respaldo sigue hasta terminar');
  await ended(tv, s.now.id);
  s = await state(tv);
  assert.equal(s.now.mediaId, demo(1), 'luego entra la solicitud');
  await ended(tv, s.now.id);
  s = await state(tv);
  assert.equal(s.now.source, 'respaldo');
  assert.equal(s.now.mediaId, demo(11), 'el respaldo retoma donde iba');
  await ended(tv, s.now.id);
  assert.equal((await state(tv)).now.mediaId, demo(10), 'y rota');
});

test('6 · un video no reproducible se registra y no bloquea la sesión', async () => {
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  await g.add(demo(1)); await g.add(demo(2));
  const bad = (await state(tv)).now;
  const out = await failed(tv, bad.id, 'yt-101: el propietario no permite reproducción integrada');
  assert.equal(out.body.changed, true);
  assert.equal((await state(tv)).now.mediaId, demo(2), 'pasó a la siguiente');
  const r = (await q('SELECT status, fail_reason FROM requests WHERE id = $1', [bad.id])).rows[0];
  assert.equal(r.status, 'fallida');
  assert.match(r.fail_reason, /yt-101/);
  const log = await admin.get(`/api/admin/rooms/${A.id}/errors`);
  assert.ok(log.body.items.some((e) => e.kind === 'reproduccion.fallo' && e.detail.requestId === bad.id));
  const mine = (await g.get(`/api/s/${token}/me`)).body.mine;
  assert.equal(mine.find((m) => m.id === bad.id).status, 'fallida', 'quien la pidió ve qué pasó');
});

test('7 · una caída general no descarta la fila: se detiene y pide intervención', async () => {
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  for (let i = 1; i <= 6; i++) await g.add(demo(i));
  // Sin internet todo "falla" en cadena. Tras 3 fallos seguidos el servidor deja de descartar.
  for (let i = 0; i < 3; i++) await failed(tv, (await state(tv)).now.id, 'red');
  const s = await state(tv);
  assert.equal(s.now, null);
  assert.match(s.attention, /Fallaron varias/);
  const { rows } = await q('SELECT status, count(*)::int AS n FROM requests WHERE session_id = $1 GROUP BY status', [await sid(A.id)]);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  assert.equal(by.fallida, 2);
  assert.equal(by.pendiente, 4, 'el resto de la fila sigue intacta, incluida la tercera');
  assert.equal(s.queue[0].title, 'La Última y Nos Vamos (DEMO)', 'la tercera conserva su turno');
  // Un fallo adicional (reintento del televisor) no descarta nada más.
  assert.equal((await failed(tv, 999999, 'red')).body.changed, false);
  // El encargado revisa y reanuda.
  assert.equal((await admin.post(`/api/admin/rooms/${A.id}/control`, { action: 'reanudar' })).status, 200);
  const s2 = await state(tv);
  assert.equal(s2.attention, null);
  assert.equal(s2.now.mediaId, demo(3));
});

test('7b · una canción que sí suena reinicia el contador de fallos', async () => {
  const tv = await startNight(A.id);
  const g = await guest(await tokenOf(A.id), 'Ana');
  for (let i = 1; i <= 6; i++) await g.add(demo(i));
  await failed(tv, (await state(tv)).now.id);
  await failed(tv, (await state(tv)).now.id);
  const ok = (await state(tv)).now;
  await tv.post('/api/tv/playing', { tabId: tv.tabId, requestId: ok.id });
  await ended(tv, ok.id);
  await failed(tv, (await state(tv)).now.id);
  assert.equal((await state(tv)).attention, null, 'fallos aislados no detienen la noche');
});

test('8 · recargar la pantalla recupera la sesión sin vaciar la fila', async () => {
  const tv = await startNight(A.id);
  const g = await guest(await tokenOf(A.id), 'Ana');
  await g.add(demo(1)); await g.add(demo(2)); await g.add(demo(3));
  const antes = await state(tv);
  // Recarga = misma credencial de pantalla, pestaña nueva (otro tabId), cero estado en memoria.
  const recargada = agent();
  recargada.jar.set('rk_tv', tv.jar.get('rk_tv'));
  const despues = (await recargada.get('/api/tv/state')).body;
  assert.equal(despues.now.id, antes.now.id);
  assert.equal(despues.now.startedAt, antes.now.startedAt);
  assert.deepEqual(despues.queue.map((x) => x.id), antes.queue.map((x) => x.id));
  assert.equal(despues.session.started, true, 'no hay que volver a iniciar la noche en el servidor');
});

test('9 · abrir una segunda pantalla no crea dos reproductores principales', async () => {
  const tv1 = await startNight(A.id);
  const g = await guest(await tokenOf(A.id), 'Ana');
  await g.add(demo(1)); await g.add(demo(2));
  const tv2 = agent();
  tv2.jar.set('rk_tv', tv1.jar.get('rk_tv'));
  const beat2 = await tv2.post('/api/tv/heartbeat', { tabId: 'segunda-pestana', status: 'espera' });
  assert.equal(beat2.body.leader, false, 'la segunda no obtiene el liderazgo');
  const now = (await state(tv1)).now;
  const intento = await tv2.post('/api/tv/ended', { tabId: 'segunda-pestana', requestId: now.id });
  assert.equal(intento.status, 409, 'la segunda no puede avanzar la fila');
  assert.equal((await state(tv1)).now.id, now.id);
  assert.equal((await state(tv1)).leaderId, tv1.tabId);

  // Recuperación: la principal muere → su liderazgo vence → la otra lo toma sola.
  await q("UPDATE playback_state SET leader_expires_at = now() - interval '1 second' WHERE room_id = $1", [A.id]);
  assert.equal((await tv2.post('/api/tv/heartbeat', { tabId: 'segunda-pestana', status: 'reproduciendo' })).body.leader, true);
  assert.equal((await tv1.beat()).body.leader, false, 'la anterior ya no manda');
  assert.equal((await ended(tv1, now.id)).status, 409);
  // "Usar esta pantalla": toma de control explícita, queda en auditoría.
  assert.equal((await tv1.beat({ takeover: true })).body.leader, true);
  const audit = await admin.get(`/api/admin/rooms/${A.id}/audit`);
  assert.ok(audit.body.items.some((a) => a.action === 'pantalla.tomar_control'));
});

test('10 · dos sedes funcionan de manera independiente', async () => {
  const tvA = await startNight(A.id);
  const tvB = await startNight(B.id);
  const [ta, tb] = [await tokenOf(A.id), await tokenOf(B.id)];
  assert.notEqual(ta, tb);
  const ga = await guest(ta, 'Cliente A');
  const gb = await guest(tb, 'Cliente B');
  await ga.add(demo(1)); await ga.add(demo(2));
  await gb.add(demo(5));
  assert.deepEqual([(await state(tvA)).now.mediaId, (await state(tvA)).queue.length], [demo(1), 1]);
  assert.deepEqual([(await state(tvB)).now.mediaId, (await state(tvB)).queue.length], [demo(5), 0]);
  // La cookie de un cliente de A no sirve en B, y la pantalla de A no puede avanzar B.
  assert.equal((await ga.post(`/api/s/${tb}/requests`, { provider: 'catalogo', mediaId: demo(3), idemKey: crypto.randomUUID() })).status, 401);
  const nowB = (await state(tvB)).now;
  assert.equal((await ended(tvA, nowB.id)).body.changed, false);
  assert.equal((await state(tvB)).now.id, nowB.id);
  // Cerrar A no toca B.
  await admin.post(`/api/admin/rooms/${A.id}/session/cerrar`);
  assert.equal((await state(tvB)).now.id, nowB.id);
  assert.equal((await ga.get(`/api/s/${ta}`)).status, 410);
});

test('11 · permisos: clientes, pantallas y otros roles no ejecutan acciones ajenas', async () => {
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Curioso');
  const otro = await guest(token, 'Otro');
  const suya = (await otro.add(demo(1))).body.request;
  const enFila = (await otro.add(demo(2))).body.request;

  // Cliente: nada administrativo, nada del televisor, nada de otros clientes.
  for (const [m, p] of [['get', `/api/admin/rooms/${A.id}/state`], ['post', `/api/admin/rooms/${A.id}/control`], ['post', `/api/admin/rooms/${A.id}/session/cerrar`], ['get', '/api/admin/users']]) {
    assert.equal((await g[m](p, { action: 'saltar' })).status, 401, `${m} ${p}`);
  }
  assert.equal((await g.get('/api/tv/state')).status, 401);
  assert.equal((await g.post('/api/tv/ended', { tabId: tv.tabId, requestId: suya.id })).status, 401);
  assert.equal((await g.del(`/api/s/${token}/requests/${enFila.id}`)).status, 409, 'no puede retirar la canción de otro');
  assert.equal((await q('SELECT status FROM requests WHERE id = $1', [enFila.id])).rows[0].status, 'pendiente');

  // La credencial de la pantalla tampoco abre el panel.
  assert.equal((await tv.get(`/api/admin/rooms/${A.id}/state`)).status, 401);

  // Operador de la Sede B: no entra a la Sede A; y en su sede no cambia configuración.
  const op = await adminAgent(await createUser({ email: 'op@b.test', role: 'operador', venueId: B.venue_id }));
  assert.equal((await op.get(`/api/admin/rooms/${A.id}/state`)).status, 403);
  assert.equal((await op.post(`/api/admin/rooms/${A.id}/control`, { action: 'saltar' })).status, 403);
  assert.equal((await op.put(`/api/admin/rooms/${B.id}/settings`, { max_pendientes: 9 })).status, 403);
  assert.equal((await op.get('/api/admin/users')).status, 403);
  assert.equal((await op.post(`/api/admin/rooms/${B.id}/session/abrir`)).status, 200, 'sí opera su sala');
  const visto = (await op.get('/api/admin/overview')).body.venues;
  assert.deepEqual(visto.map((v) => v.id), [B.venue_id], 'solo ve su sede');

  // Administrador de sede: no crea administradores generales ni usuarios en otra sede.
  const as = await adminAgent(await createUser({ email: 'jefe@b.test', role: 'admin_sede', venueId: B.venue_id }));
  assert.equal((await as.post('/api/admin/users', { email: 'x@x.co', name: 'X', role: 'admin_general', password: 'clave-super-segura' })).status, 403);
  assert.equal((await as.post('/api/admin/users', { email: 'y@x.co', name: 'Y', role: 'operador', venueId: A.venue_id, password: 'clave-super-segura' })).status, 403);
  assert.equal((await as.post('/api/admin/users', { email: 'z@x.co', name: 'Zeta', role: 'operador', venueId: B.venue_id, password: 'clave-super-segura' })).status, 201);

});

test('11b · CSRF: un origen ajeno no puede mutar con la cookie del administrador', async () => {
  const cookie = `rk_admin=${admin.jar.get('rk_admin')}`;
  assert.equal((await admin.post(`/api/admin/rooms/${A.id}/session/abrir`)).status, 200);
  const r = await fetch(`${baseUrl()}/api/admin/rooms/${A.id}/session/cerrar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://sitio-malicioso.example' }, body: '{}',
  });
  assert.equal(r.status, 403);
  assert.ok(await tokenOf(A.id), 'la sesión sigue abierta');
});

test('límites y moderación configurables', async () => {
  await setSettings(A.id, { max_pendientes: 2, duracion_max_seg: 35 });
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  await g.add(demo(1)); // suena
  assert.equal((await g.add(demo(3))).body.error, 'muy_larga');            // 40 s > 35 s
  assert.equal((await g.add(demo(1))).body.error, 'duplicada');            // ya está sonando
  await g.add(demo(2)); await g.add(demo(5));
  assert.equal((await g.add(demo(7))).body.error, 'limite_persona');       // 2 en espera

  await setSettings(A.id, { intervalo_seg: 30, max_pendientes: 10 });
  const wait = await g.add(demo(7));
  assert.equal(wait.status, 429);
  assert.equal(wait.body.error, 'espera');
  await setSettings(A.id, { intervalo_seg: 0, repeticion_min: 60 });

  const now = (await state(tv)).now;
  await ended(tv, now.id);
  assert.equal((await g.add(demo(1))).body.error, 'repetida_reciente');

  // Bloqueo de un video: sale de la fila y no se puede volver a pedir.
  await admin.post(`/api/admin/rooms/${A.id}/blocked`, { mediaId: demo(5), title: 'x' });
  assert.ok(!(await state(tv)).queue.some((x) => x.title.startsWith('Salud')));
  assert.equal((await g.add(demo(5))).body.error, 'bloqueada');

  // Cierre de solicitudes y límite global.
  await admin.post(`/api/admin/rooms/${A.id}/session/solicitudes`, { open: false });
  assert.equal((await g.add(demo(9))).body.error, 'solicitudes_cerradas');
  await admin.post(`/api/admin/rooms/${A.id}/session/solicitudes`, { open: true });
  await setSettings(A.id, { limite_fila: 1 });
  assert.equal((await g.add(demo(9))).status, 201);
  assert.equal((await g.add(demo(10))).body.error, 'fila_llena');

  // Participante bloqueado.
  await admin.post(`/api/admin/rooms/${A.id}/participants/${g.me.id}/bloqueo`, { blocked: true });
  assert.equal((await g.add(demo(12))).status, 403);
});

test('aprobación manual, retiro propio y reordenamiento con auditoría', async () => {
  await setSettings(A.id, { aprobacion_manual: true });
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  const r1 = (await g.add(demo(1))).body.request;
  assert.equal(r1.status, 'por_aprobar');
  assert.equal((await state(tv)).now, null, 'nada suena hasta aprobar');
  assert.equal((await g.get(`/api/s/${token}`)).body.queue.length, 0, 'lo no aprobado no es público');
  await admin.post(`/api/admin/rooms/${A.id}/requests/${r1.id}/aprobar`);
  assert.equal((await state(tv)).now.id, r1.id);

  await setSettings(A.id, { aprobacion_manual: false });
  const ids = [];
  for (const n of [2, 3, 4]) ids.push((await g.add(demo(n))).body.request.id);
  assert.equal((await g.del(`/api/s/${token}/requests/${ids[0]}`)).status, 200);
  assert.deepEqual((await state(tv)).queue.map((x) => x.id), [ids[1], ids[2]]);
  await admin.post(`/api/admin/rooms/${A.id}/requests/${ids[2]}/mover`, { where: 'subir' });
  assert.deepEqual((await state(tv)).queue.map((x) => x.id), [ids[2], ids[1]]);
  const audit = (await admin.get(`/api/admin/rooms/${A.id}/audit`)).body.items;
  const mov = audit.find((a) => a.action === 'fila.reordenar');
  assert.ok(mov && mov.actor.startsWith('usuario:'), 'queda quién reordenó');
  assert.ok(audit.some((a) => a.action === 'fila.aprobar'));

  // Pausar / continuar / saltar llegan al televisor y quedan registrados.
  await admin.post(`/api/admin/rooms/${A.id}/control`, { action: 'pausar' });
  assert.equal((await state(tv)).desired, 'pause');
  await admin.post(`/api/admin/rooms/${A.id}/control`, { action: 'continuar' });
  await admin.post(`/api/admin/rooms/${A.id}/control`, { action: 'saltar' });
  assert.equal((await state(tv)).now.id, ids[2]);
  assert.equal((await q('SELECT status FROM requests WHERE id = $1', [r1.id])).rows[0].status, 'omitida');
});

test('privacidad: el teléfono nunca sale en pantallas públicas; código del local; borrado de datos', async () => {
  await setSettings(A.id, { telefono: 'opcional', exigir_codigo: true });
  const tv = await startNight(A.id);
  const token = await tokenOf(A.id);
  const code = (await state(tv)).doorCode;
  assert.match(code, /^\d{4}$/);

  const g = agent();
  assert.equal((await g.post(`/api/s/${token}/join`, { alias: 'Ana', acepta: true, codigo: '0000' === code ? '1111' : '0000' })).status, 403);
  assert.equal((await g.post(`/api/s/${token}/join`, { alias: 'Ana', codigo: code })).body.error, 'sin_aceptacion');
  const j = await g.post(`/api/s/${token}/join`, { alias: 'Ana', acepta: true, codigo: code, telefono: '300 123 4567' });
  assert.equal(j.status, 201);
  assert.equal(j.body.me.marketing, false, 'el marketing no se activa solo');
  await g.post(`/api/s/${token}/requests`, { provider: 'catalogo', mediaId: demo(1), idemKey: crypto.randomUUID() });

  const publico = JSON.stringify((await agent().get(`/api/s/${token}`)).body);
  const tele = JSON.stringify(await state(tv));
  assert.ok(!publico.includes('3001234567') && !tele.includes('3001234567'));
  assert.ok(!publico.includes(code), 'el código del local no viaja a quien no lo conoce');

  const op = await adminAgent(await createUser({ email: 'op@a.test', role: 'operador', venueId: A.venue_id }));
  const vistoOp = (await op.get(`/api/admin/rooms/${A.id}/state`)).body.participants[0];
  assert.equal(vistoOp.phone, '•••', 'el operador no ve teléfonos');
  assert.equal((await admin.get(`/api/admin/rooms/${A.id}/state`)).body.participants[0].phone, '3001234567');

  await g.del(`/api/s/${token}/me`);
  const p = (await q('SELECT alias, phone FROM participants WHERE session_id = (SELECT id FROM room_sessions WHERE public_token = $1)', [token])).rows[0];
  assert.deepEqual(p, { alias: 'Invitado', phone: null });
});

test('tiempo real: los clientes reciben la fila actualizada por SSE', async () => {
  await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl()}/api/s/${token}/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const nextState = async (pred) => {
    for (;;) {
      const m = /event: estado\ndata: (.*)\n\n/.exec(buf);
      if (m) {
        buf = buf.slice(m.index + m[0].length);
        const s = JSON.parse(m[1]);
        if (pred(s)) return s;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE cerrado');
      buf += dec.decode(value, { stream: true });
    }
  };
  await nextState(() => true); // estado inicial al conectar
  await g.add(demo(1));
  const s = await Promise.race([nextState((x) => x.now?.title?.startsWith('Cumbia')), new Promise((_, rej) => setTimeout(() => rej(new Error('sin evento en 3 s')), 3000))]);
  assert.equal(s.now.alias, 'Ana');
  ctrl.abort();
});

// ───────── Regresiones encontradas en la revisión independiente del código ─────────

test('un aviso de fin que llega tarde (corte de red > vigencia del líder) no repite la canción', async () => {
  const tv = await startNight(A.id);
  const g = await guest(await tokenOf(A.id), 'Ana');
  await g.add(demo(1)); await g.add(demo(2));
  const now = (await state(tv)).now;
  // La pantalla estuvo sin red: su liderazgo venció, pero ninguna otra lo tomó.
  await q("UPDATE playback_state SET leader_expires_at = now() - interval '30 seconds' WHERE room_id = $1", [A.id]);
  const out = await ended(tv, now.id);
  assert.equal(out.status, 200);
  assert.equal(out.body.changed, true);
  assert.equal((await state(tv)).now.mediaId, demo(2), 'avanzó en vez de volver a sonar la misma');
});

test('bloquear un video aplica a toda la sede: sale de las filas y se salta si está sonando', async () => {
  const otra = (await admin.post(`/api/admin/venues/${A.venue_id}/rooms`, { name: 'Terraza' })).body.room;
  const tv1 = await startNight(A.id);
  const tv2 = await startNight(otra.id);
  const g1 = await guest(await tokenOf(A.id), 'Ana');
  const g2 = await guest(await tokenOf(otra.id), 'Beto');
  await g1.add(demo(1)); await g1.add(demo(2));      // en la sala principal suena demo-01
  await g2.add(demo(3)); await g2.add(demo(1));      // en la terraza demo-01 espera en la fila
  const r = await admin.post(`/api/admin/rooms/${A.id}/blocked`, { mediaId: demo(1), title: 'x' });
  assert.equal(r.status, 201);
  assert.equal((await state(tv1)).now.mediaId, demo(2), 'se saltó donde estaba sonando');
  assert.deepEqual((await state(tv2)).queue, [], 'salió de la fila de la otra sala');
  assert.equal((await g2.add(demo(1))).body.error, 'bloqueada');
  await admin.post(`/api/admin/rooms/${otra.id}/session/cerrar`);
});

test('entradas malformadas no producen errores 500 ni filtran mensajes internos', async () => {
  await startNight(A.id);
  const token = await tokenOf(A.id);
  const g = await guest(token, 'Ana');
  const casos = [
    await g.del(`/api/s/${token}/requests/1.5`),
    await g.del(`/api/s/${token}/requests/99999999999999999999`),
    await admin.get('/api/admin/rooms/1e30/state'),
    await admin.post(`/api/admin/rooms/${A.id}/requests/99999999999/quitar`),
    await admin.put(`/api/admin/rooms/${A.id}/settings`, { provider: 'constructor' }),
    await admin.post(`/api/admin/rooms/${A.id}/blocked`, { provider: 'toString', mediaId: 'x' }),
    await admin.post('/api/admin/users', { email: 'q@q.co', name: 'Quien', role: 'operador', venueId: 987654, password: 'clave-super-segura' }),
    await g.get(`/api/s/${token}/search?q=demo&page=99999999999999999999`),
  ];
  for (const c of casos) {
    assert.ok(c.status < 500, `estado ${c.status}: ${JSON.stringify(c.body)}`);
    assert.ok(!/syntax|integer|violates|relation|column/i.test(JSON.stringify(c.body)), 'sin texto interno de la base');
  }
  // Una cookie corrupta se ignora en vez de romper la petición.
  const r = await fetch(`${baseUrl()}/api/admin/me`, { headers: { Cookie: 'rk_admin=%' } });
  assert.equal(r.status, 200);
});

test('quien conserva el canal de una sesión cerrada no recibe la fila de la noche siguiente', async () => {
  const tv = await startNight(A.id);
  const viejo = await tokenOf(A.id);
  const res = await fetch(`${baseUrl()}/api/s/${viejo}/events`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  let pending = null; // lectura en curso: se conserva entre llamadas para no perder fragmentos
  const drain = async (ms) => { // lee lo que llegue durante ms
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      pending ||= reader.read();
      const r = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok(null), Math.max(0, fin - Date.now())))]);
      if (!r) break;
      pending = null;
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
    }
  };
  await drain(300);
  await admin.post(`/api/admin/rooms/${A.id}/session/cerrar`);
  assert.equal((await tv.post('/api/tv/start', { tabId: tv.tabId })).status, 200); // noche nueva, misma pantalla
  const g = await guest(await tokenOf(A.id), 'Secreto');
  await g.add(demo(2));
  await drain(700);
  assert.ok(!buf.includes('Secreto') && !buf.includes('Guaro'), 'no ve alias ni canciones de la sesión nueva');
  assert.match(buf, /"session":null/, 'recibió el aviso de cierre');
});
