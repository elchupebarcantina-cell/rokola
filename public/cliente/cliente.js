// Página del cliente: escanear → registrarse → buscar → agregar → seguir su turno.
import { api, live, dur, esc, $, uuid, thumb } from '/js/api.js';

const token = location.pathname.split('/').pop();
const base = `/api/s/${token}`;
const app = $('#app');
const hoja = $('#hoja');

let S = null;            // estado público de la sala
let me = null;           // mi registro
let mine = [];           // mis canciones
let tab = 'buscar';
let online = true;
let results = null;      // { items, nextPage, query } | null
let searchMsg = '';
let searching = false;
let query = '';
let debounce; let searchSeq = 0; let stopLive;

const ESTADOS = {
  por_aprobar: 'Esperando aprobación del bar', pendiente: 'En la fila', reproduciendo: 'Sonando ahora',
  completada: 'Ya sonó', omitida: 'El bar la saltó', cancelada: 'Retirada', fallida: 'No se pudo reproducir',
};

function toast(msg, error = false) {
  const t = $('#tostada');
  t.textContent = msg; t.className = `tostada${error ? ' error' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, error ? 5200 : 3200);
}

// ───────── Arranque ─────────
async function boot() {
  try {
    const d = await api('GET', base);
    ({ me, mine } = d);
    S = d;
    document.title = `Pide tu canción · ${S.venue.name}`;
    if (S.venue.accent) document.documentElement.style.setProperty('--oro', S.venue.accent);
    render();
    stopLive = live(`${base}/events`, {
      onEvent: (name, data) => { if (name === 'estado') { S = { ...S, ...data }; refreshMine(); render(); } },
      onStatus: (ok) => { if (ok !== online) { online = ok; render(); } },
      poll: async () => { const x = await api('GET', base); S = x; ({ me, mine } = x); render(); },
    });
  } catch (e) {
    stopLive?.();
    renderClosed(e);
  }
}

function renderClosed(e) {
  const v = e.body?.venue;
  app.innerHTML = `
    <div class="entrada-bar">
      ${v?.logo ? `<img src="${esc(v.logo)}" alt="">` : ''}
      <h1>${esc(v?.name || 'Rockola')}</h1>
    </div>
    <div class="vacio"><b>${e.code === 'sesion_cerrada' ? 'La rockola de esta noche ya cerró' : e.code === 'sin_conexion' ? 'Sin conexión' : 'Este código no es válido'}</b>
      ${e.code === 'sin_conexion' ? 'Revisa tu internet y vuelve a intentar.' : 'Escanea el código QR que aparece en el televisor del bar para entrar.'}
      <p style="margin-top:18px"><button class="btn" id="reintentar">Volver a intentar</button></p>
    </div>`;
  $('#reintentar').onclick = () => location.reload();
}

let mineTimer;
function refreshMine() {
  if (!me) return;
  clearTimeout(mineTimer);
  mineTimer = setTimeout(async () => {
    try { const d = await api('GET', `${base}/me`); me = d.me; mine = d.mine; render(); } catch (e) { if (e.status === 410) boot(); }
  }, 150);
}

// ───────── Vistas ─────────
function render() {
  if (!S) return;
  if (!S.session) return renderClosed({ code: 'sesion_cerrada', body: { venue: S.venue } });
  // No se redibuja mientras la persona escribe en el formulario de registro.
  if (!me) { if (!$('form.registro')) renderJoin(); return; }
  renderMain();
}

function renderJoin() {
  const yt = S.room.provider === 'youtube';
  app.innerHTML = `
    <div class="entrada-bar">
      ${S.venue.logo ? `<img src="${esc(S.venue.logo)}" alt="">` : ''}
      <h1>${esc(S.venue.name)}</h1>
      <p class="tenue">${esc(S.room.name)}</p>
      <p class="lema">Pide tu canción y suena en el televisor</p>
    </div>
    <form class="registro" novalidate>
      <label class="campo"><span>Tu nombre o apodo (se verá en la pantalla)</span>
        <input name="alias" maxlength="24" autocomplete="nickname" required placeholder="Ej.: La mesa del fondo"></label>
      ${S.session.needCode ? `<label class="campo"><span>Código de 4 dígitos que aparece en el televisor</span>
        <input name="codigo" inputmode="numeric" maxlength="4" autocomplete="off" required></label>` : ''}
      ${S.session.phone === 'opcional' ? `<label class="campo"><span>Celular (opcional)</span>
        <input name="telefono" type="tel" inputmode="tel" maxlength="16" autocomplete="tel"></label>
        <label class="casilla"><input type="checkbox" name="marketing"><span>Quiero recibir promociones de ${esc(S.venue.name)} en este número. Es opcional: puedes pedir canciones sin marcarlo.</span></label>` : ''}
      <label class="casilla"><input type="checkbox" name="acepta" required>
        <span>Acepto el <a href="/privacidad" target="_blank" rel="noopener">aviso de privacidad</a>${yt ? ' y los <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">Términos del Servicio de YouTube</a>' : ''}.</span></label>
      <p class="privacidad tenue">Tu nombre se muestra junto a tus canciones.${S.session.phone === 'opcional' ? ` El celular nunca se muestra en pantalla, solo lo ve la administración del bar y se borra ${S.privacy?.retentionDays || 30} días después de esta noche. Puedes eliminarlo antes desde «Eliminar mis datos».` : ''}</p>
      <p class="aviso error" id="err" hidden></p>
      <button class="btn principal" type="submit" style="min-height:56px;font-size:1.1rem">Entrar a pedir</button>
    </form>`;
  const form = $('form.registro');
  form.alias.value = localStorage.getItem('rk_alias') || '';
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = $('#err'); err.hidden = true;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const d = await api('POST', `${base}/join`, {
        alias: form.alias.value, acepta: form.acepta.checked, codigo: form.codigo?.value,
        telefono: form.telefono?.value || undefined, marketing: form.marketing?.checked || false,
      });
      me = d.me;
      try { localStorage.setItem('rk_alias', me.alias); } catch { /* modo privado */ }
      render(); loadSuggested();
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
  };
}

const myPending = () => mine.filter((m) => m.status === 'pendiente' && m.position).sort((a, b) => a.position - b.position);

function etaMin(position) {
  // Estimado: lo que falta de la actual + duraciones de las que van delante.
  let sec = 0;
  if (S.now?.durationSec && S.now.startedAt) sec += Math.max(0, S.now.durationSec - (Date.now() - new Date(S.now.startedAt).getTime()) / 1000);
  for (const qi of S.queue.slice(0, position - 1)) sec += qi.durationSec || 210;
  return Math.max(1, Math.round(sec / 60));
}

function topHtml() {
  const next = myPending()[0];
  const playingMine = mine.find((m) => m.status === 'reproduciendo');
  return `
    ${online ? '' : '<p class="sinred">Sin conexión. Reintentando… tu fila no se pierde.</p>'}
    <header class="cabeza">
      ${S.venue.logo ? `<img src="${esc(S.venue.logo)}" alt="">` : ''}
      <div><h1>${esc(S.venue.name)}</h1><p class="tenue">${esc(S.room.name)}</p></div>
      <div class="yo"><span class="tenue">Pides como</span><br><b>${esc(me.alias)}</b></div>
    </header>

    <section class="sonando etiqueta" aria-label="Sonando ahora">
      <div class="barras ${S.now && !S.paused ? '' : 'quieto'}" aria-hidden="true"><i></i><i></i><i></i></div>
      <div>${S.now
    ? `<p class="rotulo">${S.paused ? 'En pausa' : 'Sonando ahora'}</p><p class="titulo">${esc(S.now.title)}</p>
           <p class="tenue" style="font-size:.88rem">${S.now.alias ? `La pidió ${esc(S.now.alias)}` : 'Música de la casa'}</p>`
    : `<p class="rotulo">${S.session.started ? 'Silencio en la cantina' : 'La rockola abre en un momento'}</p>
           <p class="titulo">${S.session.started ? 'Pide una y arranca de una' : 'Ya puedes ir pidiendo'}</p>`}</div>
    </section>

    ${playingMine ? '<div class="turno"><strong>¡Está sonando la tuya!</strong></div>'
    : next ? `<div class="turno">Tu próxima canción va de <strong>#${next.position}</strong> en la fila
        <small class="tenue">Faltan unos ${etaMin(next.position)} min. Es un aproximado: cambia con la publicidad, la carga y lo que decida el bar.</small></div>` : ''}`;
}

function navHtml() {
  const active = mine.filter((m) => ['pendiente', 'por_aprobar', 'reproduciendo'].includes(m.status)).length;
  return [['buscar', 'Buscar'], ['fila', `Fila (${S.queue.length})`], ['mias', `Mis canciones${active ? ` (${active})` : ''}`]]
    .map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}</button>`).join('');
}

// El esqueleto se crea una vez; después solo se actualiza cada zona. Así el teclado del celular
// no se cierra ni se pierde lo escrito cuando llega un cambio de la fila en tiempo real.
function renderMain() {
  if (!$('#vista')) {
    app.innerHTML = `<div id="tope"></div><nav class="pestanas" role="tablist"></nav><main id="vista"></main>
    <footer class="pie">
      ${S.room.provider === 'youtube' ? '<p>Los resultados y videos vienen de YouTube. Al usar esta página aceptas los <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">Términos del Servicio de YouTube</a> y la <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Política de Privacidad de Google</a>.</p>' : ''}
      <p><a href="/privacidad" target="_blank" rel="noopener">Aviso de privacidad</a></p>
      <button id="borrar">Eliminar mis datos y salir</button>
    </footer>`;
    $('#borrar').onclick = confirmDelete;
    $('.pestanas').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; $('#vista').innerHTML = ''; renderMain(); } };
  }
  $('#tope').innerHTML = topHtml();
  $('.pestanas').innerHTML = navHtml();
  ({ buscar: viewSearch, fila: viewQueue, mias: viewMine })[tab]();
}

function row(item, { action, side = dur(item.durationSec), sub } = {}) {
  const tag = action && item.available !== false ? 'button' : 'div';
  return `<li><${tag} class="pista ${item.available === false ? 'no' : ''}" ${action && item.available !== false ? `data-id="${esc(item.mediaId)}"` : ''}>
    ${thumb(item)}
    <span><span class="titulo">${esc(item.title)}</span>
      <span class="sub">${esc(item.available === false ? item.reason : (sub ?? item.channel ?? ''))}</span></span>
    <span class="lado">${esc(side || '')}</span></${tag}></li>`;
}

function viewSearch() {
  const v = $('#vista');
  const list = results?.items;
  if (!$('#q')) {
    v.innerHTML = `
    <p class="aviso" id="cerrado" hidden>El bar pausó las solicitudes por ahora. Tus canciones en fila siguen ahí.</p>
    <div class="buscador">
      <input id="q" class="entrada" type="search" enterkeyhint="search" autocomplete="off" maxlength="80"
        placeholder="Busca una canción o artista" aria-label="Buscar canción o artista">
      <button class="limpiar" aria-label="Borrar búsqueda" hidden>×</button>
    </div>
    ${S.room.provider === 'youtube' ? '<p class="origen tenue">Resultados de YouTube</p>' : ''}
    <div id="res"></div>`;
    const input = $('#q');
    input.value = query;
    input.oninput = () => {
      query = input.value;
      v.querySelector('.limpiar').hidden = !query;
      clearTimeout(debounce);
      if (query.trim().length < 3) { searchSeq++; searchMsg = ''; searching = false; if (!query.trim()) loadSuggested(); return; }
      debounce = setTimeout(() => doSearch(query.trim()), 500); // espera breve al escribir: ahorra cuota
    };
    input.onkeydown = (e) => { if (e.key === 'Enter' && query.trim().length >= 3) { clearTimeout(debounce); doSearch(query.trim()); input.blur(); } };
    v.querySelector('.limpiar').onclick = () => { query = ''; input.value = ''; searchMsg = ''; v.querySelector('.limpiar').hidden = true; loadSuggested(); input.focus(); };
    $('#res').onclick = (e) => {
      const b = e.target.closest('button.pista');
      if (b) return confirmAdd(results.items.find((i) => i.mediaId === b.dataset.id));
      if (e.target.id === 'mas') doSearch(results.query, results.nextPage, results.scope);
      if (e.target.id === 'todo') doSearch(results.query, null, 'youtube');
    };
  }
  $('#cerrado').hidden = S.session.requestsOpen;
  v.querySelector('.limpiar').hidden = !query;
  const html = `${searching ? '<p class="vacio">Buscando…</p>'
    : searchMsg ? `<p class="aviso error" style="margin-top:12px">${esc(searchMsg)}</p>` : ''}
      ${list && !searching ? (list.length
    ? `${results.query ? '' : '<p class="tenue" style="margin-top:14px">Para empezar, algunas que suenan aquí:</p>'}
         <ul class="lista">${list.map((i) => row(i, { action: true })).join('')}</ul>
         ${results.nextPage ? '<button class="btn mas" id="mas">Ver más resultados</button>' : ''}
         ${results.query && results.source === 'repertorio' && results.canExpand ? '<p class="tenue" style="margin-top:14px;font-size:.88rem">¿No está la que buscas?</p><button class="btn mas" id="todo">Buscar en todo YouTube</button>' : ''}`
    : (results.query ? (results.source === 'repertorio' && results.canExpand
      ? '<div class="vacio"><b>No está en el repertorio del bar</b>Puedes buscarla en todo YouTube.<p style="margin-top:16px"><button class="btn principal" id="todo">Buscar en todo YouTube</button></p></div>'
      : '<div class="vacio"><b>Nada con ese nombre</b>Prueba con el artista o con menos palabras.</div>')
      : '<div class="vacio"><b>Busca tu canción</b>Escribe al menos 3 letras del nombre o del artista.</div>')) : ''}`;
  if ($('#res').dataset.html !== html) { $('#res').innerHTML = html; $('#res').dataset.html = html; }
}

async function doSearch(text, page, scope = 'repertorio') {
  const seq = ++searchSeq;
  searching = !page; searchMsg = ''; render();
  try {
    const d = await api('GET', `${base}/search?q=${encodeURIComponent(text)}${page ? `&page=${encodeURIComponent(page)}` : ''}${scope === 'youtube' ? '&scope=youtube' : ''}`);
    if (seq !== searchSeq) return; // llegó tarde: ya hay otra búsqueda
    results = { items: page ? [...results.items, ...d.items] : d.items, nextPage: d.nextPage, query: text, source: d.source, canExpand: d.canExpand, scope };
  } catch (e) {
    if (seq !== searchSeq) return;
    searchMsg = e.message;
    if (e.code === 'cuota_agotada') { searching = false; return loadSuggested(true); }
  }
  searching = false; render();
}

async function loadSuggested(keepMsg = false) {
  const seq = ++searchSeq; // una búsqueda posterior deja sin efecto esta respuesta si llega tarde
  if (!keepMsg) searchMsg = '';
  let items = [];
  try { items = (await api('GET', `${base}/sugeridas`)).items; } catch { /* sin sugerencias */ }
  if (seq !== searchSeq) return;
  results = { items, nextPage: null, query: '' };
  searching = false; render();
}

function viewQueue() {
  $('#vista').innerHTML = S.queue.length
    ? `<ul class="lista">${S.queue.map((r, i) => `<li><div class="pista ${r.pid === me.id ? 'mia' : ''}">
        <span class="puesto">${i + 1}</span>
        <span><span class="titulo">${esc(r.title)}</span><span class="sub">${r.pid === me.id ? 'La pediste tú' : `La pidió ${esc(r.alias)}`}</span></span>
        <span class="lado">${dur(r.durationSec)}</span></div></li>`).join('')}</ul>`
    : `<div class="vacio"><b>La fila está vacía</b>La próxima que pidas suena ${S.now ? 'apenas termine la actual' : 'de una'}.
       <p style="margin-top:16px"><button class="btn principal" id="ir">Buscar una canción</button></p></div>`;
  if ($('#ir')) $('#ir').onclick = () => { tab = 'buscar'; $('#vista').innerHTML = ''; renderMain(); $('#q')?.focus(); };
}

function viewMine() {
  $('#vista').innerHTML = mine.length
    ? `<ul class="lista">${mine.map((r) => `<li><div class="pista">
        ${r.position ? `<span class="puesto">#${r.position}</span>` : thumb(r)}
        <span><span class="titulo">${esc(r.title)}</span><span class="estado ${r.status}">${ESTADOS[r.status]}${r.status === 'fallida' && /yt-(101|150)/.test(r.failReason || '') ? ': el dueño del video no permite reproducirlo aquí. Busca otra versión.' : ''}</span></span>
        <span class="lado">${['pendiente', 'por_aprobar'].includes(r.status) ? `<button class="btn chico" data-quitar="${r.id}">Retirar</button>` : ''}</span></div></li>`).join('')}</ul>
       <p class="tenue" style="margin-top:12px;font-size:.88rem">Puedes tener hasta ${S.session.maxPending} canciones en espera.</p>`
    : `<div class="vacio"><b>Aún no has pedido nada</b>Busca una canción y agrégala a la fila.
       <p style="margin-top:16px"><button class="btn principal" id="ir">Buscar una canción</button></p></div>`;
  if ($('#ir')) $('#ir').onclick = () => { tab = 'buscar'; $('#vista').innerHTML = ''; renderMain(); $('#q')?.focus(); };
  app.querySelectorAll('[data-quitar]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await api('DELETE', `${base}/requests/${b.dataset.quitar}`); toast('Canción retirada de la fila'); } catch (e) { toast(e.message, true); }
      refreshMine();
    };
  });
}

// ───────── Agregar a la fila (con confirmación e idempotencia) ─────────
function closeSheet() { hoja.hidden = true; hoja.innerHTML = ''; }
hoja.addEventListener('click', (e) => { if (e.target === hoja) closeSheet(); });

function confirmAdd(item) {
  if (!item) return;
  const idemKey = uuid(); // una sola clave por intento: reintentar NO duplica
  hoja.innerHTML = `<div class="cuerpo">
    <h2 id="hoja-titulo">¿Agregar a la fila?</h2>
    <div class="pista" style="background:var(--tinta-2)">${thumb(item)}
      <span><span class="titulo">${esc(item.title)}</span><span class="sub">${esc(item.channel || '')}</span></span>
      <span class="lado">${dur(item.durationSec)}</span></div>
    <p class="aviso error" id="hoja-err" hidden></p>
    <div class="acciones">
      <button class="btn principal" id="si">Agregar a la fila</button>
      <button class="btn" id="no">Cancelar</button>
    </div></div>`;
  hoja.hidden = false;
  $('#no').onclick = closeSheet;
  const si = $('#si');
  si.focus();
  si.onclick = async () => {
    si.disabled = true; si.textContent = 'Agregando…'; $('#hoja-err').hidden = true;
    try {
      const d = await api('POST', `${base}/requests`, { provider: S.room.provider, mediaId: item.mediaId, idemKey });
      closeSheet();
      const r = d.request;
      toast(r.status === 'por_aprobar' ? 'Enviada. El bar la revisa antes de ponerla en la fila.'
        : r.status === 'reproduciendo' ? '¡Agregada! Ya está sonando.'
          : `¡Agregada a la fila! Vas de #${r.position}.`);
      tab = 'mias'; $('#vista').innerHTML = ''; refreshMine(); render();
    } catch (e) {
      const err = $('#hoja-err');
      if (!err) return;
      err.textContent = e.message; err.hidden = false;
      // Solo se ofrece reintentar si fue un problema de red; los rechazos explican el motivo.
      if (e.code === 'sin_conexion' || e.status >= 500) { si.disabled = false; si.textContent = 'Reintentar'; } else { si.hidden = true; $('#no').textContent = 'Entendido'; }
      if (e.code === 'sin_registro') { me = null; closeSheet(); app.innerHTML = ''; render(); }
    }
  };
}

function confirmDelete() {
  hoja.innerHTML = `<div class="cuerpo">
    <h2 id="hoja-titulo">¿Eliminar tus datos?</h2>
    <p>Se borra tu celular (si lo diste), tu nombre deja de mostrarse y se retiran tus canciones en espera.</p>
    <div class="acciones"><button class="btn peligro" id="si">Eliminar mis datos y salir</button><button class="btn" id="no">Cancelar</button></div></div>`;
  hoja.hidden = false;
  $('#no').onclick = closeSheet;
  $('#si').onclick = async () => {
    try { await api('DELETE', `${base}/me`); } catch (e) { return toast(e.message, true); }
    try { localStorage.removeItem('rk_alias'); } catch { /* modo privado */ }
    closeSheet(); me = null; mine = []; results = null; app.innerHTML = ''; render(); toast('Tus datos se eliminaron');
  };
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && S) refreshMine(); });
setInterval(() => { if (me && S?.session && hoja.hidden) render(); }, 30000); // refresca el tiempo estimado
await boot();
if (me) loadSuggested();
