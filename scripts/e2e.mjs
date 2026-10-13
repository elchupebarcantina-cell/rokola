// Prueba de punta a punta en navegadores reales (Chromium): panel + televisor + dos celulares.
// Usa el catálogo DEMO. Requiere el servidor corriendo y los datos sembrados.
//   BASE=http://localhost:3210 ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/e2e.mjs
// Deja capturas en ./capturas y termina con código ≠ 0 si algo falla.
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3210';
const EMAIL = process.env.ADMIN_EMAIL; const PASSWORD = process.env.ADMIN_PASSWORD;
const OUT = process.env.OUT || 'capturas';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
await mkdir(OUT, { recursive: true });

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); console.log(`  ✓ ${name}`); } catch (e) { results.push(['FALLO', name]); console.log(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`); }
};
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };

// Política de autoplay estricta, como un navegador normal: sin gesto no hay sonido.
const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=document-user-activation-required'] });
const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const admin = await adminCtx.newPage();
let tv; let joinUrl; let roomId;

console.log('Panel');
await step('el administrador entra al panel', async () => {
  await admin.goto(`${BASE}/admin`);
  await admin.fill('input[name=email]', EMAIL); await admin.fill('input[name=password]', PASSWORD);
  await admin.click('button:has-text("Entrar")');
  await admin.waitForSelector('.sede-card');
  await admin.screenshot({ path: `${OUT}/01-panel-sedes.png` });
  await admin.click('.sala >> nth=0');
  await admin.waitForSelector('text=Sesión de esta noche');
  roomId = Number(new URL(admin.url()).hash.split('/')[2]);
  // deja la sala limpia por si hubo una corrida anterior
  await admin.evaluate(async (id) => { await fetch(`/api/admin/rooms/${id}/session/cerrar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }, roomId);
  await admin.evaluate(async (id) => { await fetch(`/api/admin/rooms/${id}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalo_seg: 0, repeticion_min: 0, crossfade_seg: 0, exigir_codigo: true }) }); }, roomId);
});

console.log('Televisor');
await step('la pantalla se vincula con código desde el panel', async () => {
  tv = await tvCtx.newPage();
  tv.on('pageerror', (e) => console.log('    [tv error]', e.message));
  await tv.goto(`${BASE}/tv`);
  await tv.waitForSelector('text=Vincula esta pantalla');
  await tv.waitForFunction(() => /^\d{6}$/.test(document.querySelector('.codigo')?.textContent || ''));
  const code = await tv.textContent('.codigo');
  await tv.screenshot({ path: `${OUT}/02-tv-vincular.png` });
  await admin.goto(`${BASE}/admin#/sala/${roomId}/pantallas`);
  await admin.fill('input[name=code]', code);
  await admin.click('button:has-text("Vincular pantalla")');
  await tv.waitForSelector('#iniciar', { timeout: 15000 });
});

await step('«Iniciar noche» arranca con sonido, QR y lista de respaldo', async () => {
  await tv.screenshot({ path: `${OUT}/03-tv-iniciar-noche.png` });
  await tv.click('#iniciar');
  await tv.waitForSelector('#qr');
  await tv.waitForFunction(() => document.querySelector('.barra h2')?.textContent.includes('(DEMO)'), null, { timeout: 15000 });
  await tv.waitForFunction(() => document.querySelector('#cat-host canvas'));
  assert.equal(await tv.evaluate(() => document.querySelector('#reposo').hidden), true, 'el video ocupa el escenario');
  assert.match(await tv.textContent('.barra .quien'), /Música de la casa/);
});

await step('el QR se lee desde una captura del televisor y lleva a la sesión', async () => {
  await tv.waitForTimeout(600);
  const shot = PNG.sync.read(await tv.screenshot({ path: `${OUT}/04-tv-sonando-respaldo.png` }));
  const qr = jsQR(new Uint8ClampedArray(shot.data), shot.width, shot.height);
  assert.ok(qr, 'se detecta un código QR en la pantalla');
  joinUrl = qr.data;
  assert.match(joinUrl, /\/s\/[A-Za-z0-9_-]+$/);
  // También legible "de lejos": la misma pantalla reducida a un tercio (640×360).
  const small = await tvCtx.newPage();
  await small.setViewportSize({ width: 640, height: 360 });
  await small.goto(`${BASE}/tv`);
  await small.waitForSelector('#qr');
  await small.waitForTimeout(500);
  const s2 = PNG.sync.read(await small.screenshot());
  assert.ok(jsQR(new Uint8ClampedArray(s2.data), s2.width, s2.height), 'el QR se lee con la pantalla a un tercio del tamaño');
  // …y de paso: una segunda pestaña NO se vuelve reproductora.
  await small.waitForSelector('text=Otra pantalla es la reproductora');
  assert.equal(await small.evaluate(() => document.querySelectorAll('#cat-host canvas, #yt-host iframe').length), 0, 'la segunda pestaña no reproduce nada');
  await small.screenshot({ path: `${OUT}/05-tv-segunda-pantalla.png` });
  await small.close();
});

console.log('Clientes');
const g1ctx = await browser.newContext(phone); const g2ctx = await browser.newContext(phone);
const g1 = await g1ctx.newPage(); const g2 = await g2ctx.newPage();
for (const [n, pg] of [['c1', g1], ['c2', g2], ['panel', admin]]) {
  pg.on('pageerror', (e) => console.log(`    [${n} error]`, e.message));
  if (process.env.DEBUG) pg.on('response', (r) => { if (r.status() >= 400) console.log(`    [${n}] ${r.status()} ${r.url()}`); });
}
const doorCode = async () => (await tv.textContent('.qr .codigo b')).trim();

async function join(page, alias) {
  await page.goto(joinUrl);
  await page.waitForSelector('form.registro');
  await page.fill('input[name=alias]', alias);
  await page.fill('input[name=codigo]', await doorCode());
  await page.check('input[name=acepta]');
  await page.click('button:has-text("Entrar a pedir")');
  await page.waitForSelector('#q');
}
async function request(page, text) {
  await page.click('[data-tab=buscar]');
  await page.fill('#q', text);
  await page.waitForSelector(`button.pista:has-text("${text}")`);
  await page.click(`button.pista:has-text("${text}") >> nth=0`);
  await page.waitForSelector('#si');
  await page.click('#si');
  await page.waitForSelector('#hoja', { state: 'hidden' });
}

await step('un cliente entra con el QR, sin instalar nada, y se registra', async () => {
  await g1.goto(joinUrl);
  await g1.waitForSelector('form.registro');
  await g1.screenshot({ path: `${OUT}/06-cliente-registro.png` });
  await join(g1, 'Mesa del fondo');
  await g1.waitForSelector('.lista .pista');
  await g1.screenshot({ path: `${OUT}/07-cliente-buscar.png` });
});

await step('busca, confirma y ve su posición; no interrumpe lo que suena', async () => {
  const before = await tv.textContent('.barra h2');
  await g1.fill('#q', 'Guaro');
  // espera a que la búsqueda reemplace las sugerencias: debe quedar un solo resultado
  await g1.waitForFunction(() => document.querySelectorAll('#res .pista').length === 1 && !document.querySelector('#res').textContent.includes('Para empezar'));
  await g1.click('button.pista:has-text("Guaro y Neón")');
  await g1.waitForSelector('#si');
  await g1.screenshot({ path: `${OUT}/08-cliente-confirmar.png` });
  await g1.dblclick('#si').catch(() => {}); // doble toque a propósito
  await g1.waitForSelector('.turno:has-text("#1")');
  await g1.screenshot({ path: `${OUT}/09-cliente-mi-turno.png` });
  assert.equal(await tv.textContent('.barra h2'), before, 'la canción actual sigue');
  await tv.waitForSelector('.siguen li:has-text("Guaro y Neón")');
  assert.equal(await tv.locator('.siguen li').count(), 1, 'el doble toque no duplicó');
});

await step('un segundo cliente ve la misma fila en tiempo real', async () => {
  await join(g2, 'Los del cumple');
  await request(g2, 'Rumba en la 72');
  await g2.waitForSelector('.turno:has-text("#2")');
  await g1.click('[data-tab=fila]');
  await g1.waitForSelector('.lista .pista:has-text("Rumba en la 72")');
  assert.equal(await g1.locator('#vista .pista').count(), 2);
  await request(g1, 'El Cubetazo');
  await tv.waitForFunction(() => document.querySelectorAll('.siguen li').length === 3);
  await g1.click('[data-tab=fila]');
  await g1.screenshot({ path: `${OUT}/10-cliente-fila.png` });
  await tv.screenshot({ path: `${OUT}/11-tv-con-fila.png` });
});

await step('pedir la misma canción explica por qué no se acepta', async () => {
  await g2.click('[data-tab=buscar]');
  await g2.fill('#q', 'Guaro');
  await g2.click('button.pista:has-text("Guaro y Neón")');
  await g2.click('#si');
  await g2.waitForSelector('#hoja-err:has-text("ya está en la fila")');
  await g2.screenshot({ path: `${OUT}/12-cliente-rechazo.png` });
  await g2.click('#no');
});

console.log('Operación');
await step('el panel refleja la fila y «Saltar canción» avanza una sola vez', async () => {
  await admin.goto(`${BASE}/admin#/sala/${roomId}/vivo`);
  await admin.waitForSelector('td:has-text("Guaro y Neón")');
  await admin.screenshot({ path: `${OUT}/13-panel-en-vivo.png`, fullPage: true });
  await admin.click('button:has-text("Saltar canción")');
  await tv.waitForFunction(() => document.querySelector('.barra h2')?.textContent.includes('Guaro y Neón'));
  assert.match(await tv.textContent('.barra .quien'), /Mesa del fondo/);
  assert.equal(await tv.locator('.siguen li').count(), 2);
  await g1.waitForSelector('.turno:has-text("Está sonando la tuya")');
  await tv.waitForTimeout(700);
  await tv.screenshot({ path: `${OUT}/14-tv-sonando-solicitud.png` });
});

await step('al terminar una canción (evento del reproductor) empieza la siguiente', async () => {
  // "Guaro y Neón" dura 28 s: se espera a que termine sola, sin intervención.
  await tv.waitForFunction(() => document.querySelector('.barra h2')?.textContent.includes('Rumba en la 72'), null, { timeout: 45000 });
  assert.match(await tv.textContent('.barra .quien'), /Los del cumple/);
  assert.equal(await tv.locator('.siguen li').count(), 1);
});

await step('pausar y continuar desde el panel llega al televisor', async () => {
  await admin.click('button:has-text("Pausar")');
  await tv.waitForSelector('.alerta:has-text("en pausa")');
  await admin.click('button:has-text("Continuar")');
  await tv.waitForSelector('.alerta', { state: 'detached' });
});

await step('un corte de internet no borra la fila y la pantalla se recupera sola', async () => {
  await tvCtx.setOffline(true);
  await tv.waitForSelector('.alerta:has-text("Sin conexión")', { timeout: 20000 });
  await tv.screenshot({ path: `${OUT}/15-tv-sin-conexion.png` });
  await request(g2, 'Brindis Llanero'); // mientras tanto, los clientes siguen pidiendo con sus datos
  await tvCtx.setOffline(false);
  await tv.waitForSelector('.siguen li:has-text("Brindis Llanero")', { timeout: 30000 });
  await tv.waitForSelector('.alerta', { state: 'detached', timeout: 20000 });
  assert.ok((await tv.locator('.siguen li').count()) >= 1, 'la fila sigue ahí');
});

await step('recargar el televisor conserva sesión, fila y liderazgo, y sigue sonando', async () => {
  const before = await tv.locator('.siguen li').allTextContents();
  await tv.reload();
  await tv.waitForSelector('#qr');
  assert.deepEqual(await tv.locator('.siguen li').allTextContents(), before, 'misma fila tras recargar');
  // Misma pestaña ⇒ conserva el liderazgo; el navegador recuerda el gesto previo y sigue con sonido,
  // o bien ofrece el botón de reactivar. Cualquiera de los dos es válido; quedarse mudo sin aviso, no.
  await tv.waitForFunction(() => document.querySelector('#activar, #reactivar') || (document.querySelector('#cat-host canvas') && !document.querySelector('.alerta')), null, { timeout: 20000 });
  if (await tv.$('#activar, #reactivar')) await tv.click('#activar, #reactivar');
  await tv.waitForFunction(() => document.querySelector('#cat-host canvas') && !document.querySelector('.alerta'), null, { timeout: 15000 });
});

await step('si el equipo se reinicia, otra pestaña toma el control sola y el autoplay bloqueado muestra un botón', async () => {
  const before = await tv.locator('.siguen li').allTextContents();
  await tv.close(); // "se fue la luz": la reproductora muere sin despedirse
  tv = await tvCtx.newPage(); // pestaña nueva, sin gesto del usuario
  await tv.goto(`${BASE}/tv`);
  await tv.waitForSelector('text=Otra pantalla es la reproductora');
  // A los ~15 s vence el liderazgo anterior y esta pantalla lo recupera sin intervención.
  await tv.waitForSelector('#activar, #reactivar', { timeout: 40000 });
  await tv.screenshot({ path: `${OUT}/16-tv-autoplay-bloqueado.png` });
  assert.deepEqual(await tv.locator('.siguen li').allTextContents(), before, 'la fila sobrevivió al reinicio');
  await tv.click('#activar, #reactivar');
  await tv.waitForFunction(() => document.querySelector('#cat-host canvas') && !document.querySelector('.alerta'), null, { timeout: 15000 });
});

await step('catálogo autorizado: el crossfade mezcla la canción que sale con la que entra', async () => {
  await admin.evaluate(async (id) => { await fetch(`/api/admin/rooms/${id}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ crossfade_seg: 4 }) }); }, roomId);
  await request(g1, 'Salud, Compadre');
  await request(g2, 'Un Chupe o Qué');
  // La que suena se cargó sin mezcla; se salta para que la siguiente ya entre con crossfade activo.
  await tv.waitForFunction(() => document.querySelectorAll('.siguen li').length >= 2);
  await admin.goto(`${BASE}/admin#/sala/${roomId}/vivo`);
  await admin.click('button:has-text("Saltar canción")');
  const title = await tv.textContent('.barra h2');
  // Durante la mezcla conviven dos pistas (la que se desvanece y la que entra).
  await tv.waitForFunction(() => document.querySelectorAll('#cat-host canvas').length === 2, null, { timeout: 60000, polling: 100 });
  await tv.waitForFunction((t) => document.querySelector('.barra h2')?.textContent !== t, title, { timeout: 10000 });
  await tv.waitForFunction(() => document.querySelectorAll('#cat-host canvas').length === 1, null, { timeout: 10000 });
});

await step('un cliente no puede abrir el panel ni la pantalla', async () => {
  const r = await g1.evaluate(async (id) => (await fetch(`/api/admin/rooms/${id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"saltar"}' })).status, roomId);
  assert.equal(r, 401);
  await g1.goto(`${BASE}/tv`);
  await g1.waitForSelector('text=Vincula esta pantalla');
});

await step('cerrar la noche invalida el QR', async () => {
  admin.once('dialog', (d) => d.accept());
  await admin.click('button:has-text("Cerrar sesión de la noche")');
  await admin.waitForSelector('button:has-text("Abrir sesión")');
  await g2.waitForSelector('text=ya cerró', { timeout: 20000 });
  await g2.screenshot({ path: `${OUT}/17-cliente-sesion-cerrada.png` });
  await tv.waitForSelector('#iniciar', { timeout: 15000 });
});

await browser.close();
const failed = results.filter((r) => r[0] !== 'ok');
console.log(`\n${results.length - failed.length} de ${results.length} pasos correctos`);
process.exit(failed.length ? 1 : 0);
