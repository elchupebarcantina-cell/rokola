// Panel administrativo. Lo que se muestra depende del rol, pero la autorización real está en el servidor.
import { api, live, dur, esc, $ } from '/js/api.js';

const app = $('#app');
let user = null;
let overview = null;
let stopLive = null;
let R = null;            // estado de la sala abierta
let route = { name: 'inicio' };

const ROLES = { admin_general: 'Administrador general', admin_sede: 'Administrador de sede', operador: 'Operador de sala' };
const RANK = { operador: 1, admin_sede: 2, admin_general: 3 };
const can = (role) => RANK[user.role] >= RANK[role];
const fecha = (d) => (d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '');
const ESTADO = { por_aprobar: 'Por aprobar', pendiente: 'En fila', reproduciendo: 'Sonando', completada: 'Sonó', omitida: 'Saltada', cancelada: 'Retirada', fallida: 'Falló' };

function toast(msg, error = false) {
  const t = $('#tostada');
  t.textContent = msg; t.className = `tostada${error ? ' error' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2600);
}
/** Ejecuta una acción y muestra el resultado; devuelve true si salió bien. */
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) {
    if (e.status === 401) { user = null; return render(); }
    toast(e.message, true); return false;
  }
}
const formData = (form) => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, v]));

// ───────── Rutas ─────────
function parseRoute() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'sala' && p[1]) return { name: 'sala', roomId: Number(p[1]), tab: p[2] || 'vivo' };
  if (p[0] === 'usuarios') return { name: 'usuarios' };
  if (p[0] === 'consumo') return { name: 'consumo' };
  if (p[0] === 'catalogo' && p[1]) return { name: 'catalogo', venueId: Number(p[1]) };
  if (p[0] === 'repertorio' && p[1]) return { name: 'repertorio', venueId: Number(p[1]) };
  return { name: 'inicio' };
}
window.addEventListener('hashchange', () => { route = parseRoute(); render(); });

async function boot() {
  try { user = (await api('GET', '/api/admin/me')).user; } catch { user = null; }
  route = parseRoute();
  render();
}

function shell(inner) {
  return `<header class="tope">
    <img src="/img/logo-el-chupe.jpg" alt=""><a class="marca" href="#/">Rockola</a>
    <nav>
      <a href="#/" ${route.name === 'inicio' || route.name === 'sala' ? 'aria-current="page"' : ''}>Sedes y salas</a>
      ${can('admin_sede') ? `<a href="#/usuarios" ${route.name === 'usuarios' ? 'aria-current="page"' : ''}>Usuarios</a>
      <a href="#/consumo" ${route.name === 'consumo' ? 'aria-current="page"' : ''}>Consumo de API</a>` : ''}
    </nav>
    <div class="quien"><b>${esc(user.name)}</b><br><span class="tenue">${ROLES[user.role]}</span> · <button id="salir">Salir</button></div>
  </header>${inner}`;
}

let gen = 0; // generación de render: descarta trabajo de una vista que ya se abandonó
async function render() {
  gen++;
  stopLive?.(); stopLive = null;
  if (!user) return renderLogin();
  if (route.name === 'sala') return renderRoom();
  const view = route.name === 'usuarios' && can('admin_sede') ? renderUsers
    : route.name === 'consumo' && can('admin_sede') ? renderUsage
      : route.name === 'catalogo' ? renderCatalog
        : route.name === 'repertorio' && can('admin_sede') ? renderRepertoire : renderHome;
  try { await view(); } catch (e) {
    if (e.status === 401) { user = null; return renderLogin(); }
    mount(`<p class="aviso error" style="margin-top:20px">${esc(e.message)} <a href="#/">Volver</a></p>`);
  }
}
function mount(html) {
  app.innerHTML = shell(html);
  $('#salir').onclick = async () => { await api('POST', '/api/admin/logout').catch(() => {}); user = null; render(); };
}

// ───────── Ingreso ─────────
function renderLogin() {
  app.innerHTML = `<div class="login">
    <img src="/img/logo-el-chupe.jpg" alt="El Chupe Cantina">
    <h1 class="titulo">Panel de la rockola</h1>
    <form><label class="campo"><span>Correo</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="campo"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label>
      <p class="aviso error" id="err" hidden></p>
      <button class="btn principal">Entrar</button></form></div>`;
  $('form').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/api/admin/login', formData(ev.target)); user = (await api('GET', '/api/admin/me')).user; render(); } catch (e) { $('#err').textContent = e.message; $('#err').hidden = false; }
  };
}

// ───────── Sedes y salas ─────────
async function renderHome() {
  try { overview = await api('GET', '/api/admin/overview'); } catch (e) { if (e.status === 401) { user = null; return render(); } return mount(`<p class="aviso error" style="margin-top:20px">${esc(e.message)}</p>`); }
  mount(`<h1 class="titulo">Sedes y salas</h1>
    <p class="tenue">Cada sala tiene su propia fila, su configuración y su sesión.</p>
    <div class="sedes">${overview.venues.map((v) => `<section class="sede-card">
      <header><h2>${esc(v.name)}</h2>
        <span class="fila-acc">
          <a class="btn chico" href="#/repertorio/${v.id}">Repertorio</a>
          <a class="btn chico" href="#/catalogo/${v.id}">Catálogo autorizado</a>
          ${can('admin_sede') ? `<button class="btn chico" data-nueva-sala="${v.id}">Agregar sala</button><button class="btn chico" data-editar-sede="${v.id}">Editar sede</button>` : ''}
        </span></header>
      <div class="salas">${v.rooms.map((r) => `<a class="sala" href="#/sala/${r.id}">
        <b>${esc(r.name)}</b>
        <span class="tenue"><span class="punto ${r.attention ? 'mal' : r.open ? 'ok' : ''}"></span>${r.attention ? 'Necesita atención' : r.open ? (r.started ? `Noche en curso · ${r.pending} en fila` : 'Sesión abierta, sin iniciar') : 'Cerrada'}</span><br>
        <span class="tenue"><span class="punto ${r.playerOnline ? 'ok' : ''}"></span>Pantalla ${r.playerOnline ? 'conectada' : 'sin conexión'}</span>
      </a>`).join('') || '<p class="tenue">Sin salas.</p>'}</div>
    </section>`).join('') || '<p class="vacio">Aún no hay sedes.</p>'}</div>
    ${can('admin_general') ? `<h2 class="sub">Nueva sede</h2>
      <form id="nueva-sede" class="fila-acc"><input class="entrada" name="name" placeholder="Ej.: El Chupe · Medellín" maxlength="60" required style="max-width:340px">
      <button class="btn principal">Crear sede</button></form>` : ''}`);
  if ($('#nueva-sede')) $('#nueva-sede').onsubmit = async (ev) => { ev.preventDefault(); if (await act(() => api('POST', '/api/admin/venues', formData(ev.target)), 'Sede creada')) renderHome(); };
  app.querySelectorAll('[data-nueva-sala]').forEach((b) => { b.onclick = async () => {
    const name = prompt('Nombre de la sala (por ejemplo: Terraza)');
    if (name && await act(() => api('POST', `/api/admin/venues/${b.dataset.nuevaSala}/rooms`, { name }), 'Sala creada')) renderHome();
  }; });
  app.querySelectorAll('[data-editar-sede]').forEach((b) => { b.onclick = async () => {
    const v = overview.venues.find((x) => x.id === Number(b.dataset.editarSede));
    const name = prompt('Nombre de la sede', v.name); if (name === null) return;
    const logo = prompt('URL https del logo (deja igual para no cambiar)', v.logo || ''); if (logo === null) return;
    const accent = prompt('Color de acento en hexadecimal', v.accent); if (accent === null) return;
    if (await act(() => api('PATCH', `/api/admin/venues/${v.id}`, { name, logo, accent }), 'Sede actualizada')) renderHome();
  }; });
}

// ───────── Sala ─────────
const TABS = [['vivo', 'En vivo'], ['config', 'Configuración', 'admin_sede'], ['respaldo', 'Lista de respaldo'], ['bloqueos', 'Bloqueos'], ['historial', 'Historial'], ['errores', 'Errores'], ['auditoria', 'Auditoría', 'admin_sede'], ['pantallas', 'Pantallas']];

async function renderRoom() {
  const mine = gen;
  const base = `/api/admin/rooms/${route.roomId}`;
  const load = async () => { R = await api('GET', `${base}/state`); };
  try { await load(); } catch (e) {
    if (mine !== gen) return;
    if (e.status === 401) { user = null; return render(); }
    return mount(`<p class="aviso error" style="margin-top:20px">${esc(e.message)} <a href="#/">Volver</a></p>`);
  }
  mount(`<p class="migas"><a href="#/">Sedes y salas</a> / ${esc(R.venue.name)}</p>
    <h1 class="titulo">${esc(R.room.name)}</h1>
    <nav class="pestanas">${TABS.filter((t) => !t[2] || can(t[2])).map(([id, label]) => `<a href="#/sala/${route.roomId}/${id}" ${route.tab === id ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div id="vista"></div>`);
  const view = { vivo: tabLive, config: tabConfig, respaldo: tabFallback, bloqueos: tabBlocked, historial: tabHistory, errores: tabErrors, auditoria: tabAudit, pantallas: tabScreens }[route.tab] || tabLive;
  if (mine !== gen) return;
  try { await view(base); } catch (e) { if (mine === gen) $('#vista').innerHTML = `<p class="aviso error">${esc(e.message)}</p>`; }
  if (mine !== gen) return;
  if (route.tab === 'vivo' || !route.tab) {
    stopLive = live(`${base}/events`, {
      onEvent: async () => { try { await load(); tabLive(base); } catch { /* se reintenta en el siguiente evento */ } },
      poll: async () => { await load(); tabLive(base); }, pollMs: 10000,
    });
  }
}

function tabLive(base) {
  const v = $('#vista'); if (!v || route.name !== 'sala' || route.tab !== 'vivo') return;
  const s = R.session; const now = R.now;
  const post = (path, body, ok) => act(() => api('POST', `${base}${path}`, body), ok);
  const playerTxt = R.player.online ? `Conectada · ${esc(R.player.status || '')}` : 'Sin conexión';
  v.innerHTML = `
    ${R.attention ? `<div class="alerta" role="alert"><span>${esc(R.attention)}</span><button class="btn chico" data-control="reanudar">Reanudar</button></div>` : ''}
    ${!R.providerStatus.available ? `<div class="alerta" role="alert"><span>${esc(R.providerStatus.reason)}</span></div>` : R.providerStatus.searchExhausted ? `<div class="alerta" role="alert"><span>Búsqueda sin cuota por hoy: los clientes solo pueden elegir de las sugeridas. La fila sigue funcionando.</span></div>` : ''}
    <div class="vivo"><div>
      <section class="panel ahora">
        <h3>Sonando ahora</h3>
        ${now ? `<p class="t">${esc(now.title)} ${now.demo ? '<span class="chapa demo">DEMO</span>' : ''}</p>
          <p class="tenue">${now.alias ? `La pidió ${esc(now.alias)}` : 'Lista de respaldo'} · ${dur(now.durationSec)} · ${esc(R.room.providerLabel)}</p>`
    : `<p class="tenue">${s ? (s.started ? 'Nada sonando: la fila y el respaldo están vacíos.' : 'La noche aún no inicia. Pulsa «Iniciar noche» en la pantalla del televisor.') : 'No hay sesión abierta.'}</p>`}
        <div class="fila-acc" style="margin-top:12px">
          ${R.desired === 'pause' ? '<button class="btn principal" data-control="continuar">Continuar</button>' : `<button class="btn" data-control="pausar" ${now ? '' : 'disabled'}>Pausar</button>`}
          <button class="btn" data-control="saltar" ${now ? '' : 'disabled'}>Saltar canción</button>
          ${now ? `<button class="btn chico peligro" data-bloquear='${esc(JSON.stringify({ provider: now.provider, mediaId: now.mediaId, title: now.title }))}'>Bloquear este video</button>` : ''}
        </div>
        <p class="ayuda" style="margin-top:10px"><span class="punto ${R.player.online ? 'ok' : 'mal'}"></span>Pantalla: ${playerTxt}</p>
      </section>

      ${R.pending.length ? `<section class="panel"><h3>Por aprobar (${R.pending.length})</h3><table><tbody>
        ${R.pending.map((r) => `<tr><td>${esc(r.title)}<br><span class="tenue">${esc(r.alias)} · ${dur(r.durationSec)}</span></td>
          <td class="acc"><button class="btn chico principal" data-req="${r.id}" data-a="aprobar">Aprobar</button> <button class="btn chico" data-req="${r.id}" data-a="rechazar">Rechazar</button></td></tr>`).join('')}
      </tbody></table></section>` : ''}

      <section class="panel"><h3>Fila (${R.queue.length})</h3>
        ${R.queue.length ? `<div class="tabla-scroll"><table><tbody>${R.queue.map((r, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td>${esc(r.title)}<br><span class="tenue">${esc(r.alias)} · ${dur(r.durationSec)}</span></td>
          <td class="acc">
            <button class="btn ic" title="Subir un puesto" aria-label="Subir un puesto" data-req="${r.id}" data-a="mover" data-w="subir" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn ic" title="Bajar un puesto" aria-label="Bajar un puesto" data-req="${r.id}" data-a="mover" data-w="bajar" ${i === R.queue.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn ic peligro" data-req="${r.id}" data-a="quitar">Quitar</button>
          </td></tr>`).join('')}</tbody></table></div>
          <p class="ayuda" style="margin-top:8px">La fila va en orden de llegada. Mover o quitar una canción queda registrado en Auditoría con tu usuario.</p>`
    : '<p class="vacio">La fila está vacía.</p>'}
      </section>

      ${s ? `<section class="panel"><h3>Participantes (${R.participants.length})</h3>
        ${R.participants.length ? `<div class="tabla-scroll"><table><thead><tr><th>Alias</th><th>Celular</th><th>Pedidos</th><th></th></tr></thead><tbody>
        ${R.participants.map((p) => `<tr><td>${esc(p.alias)} ${p.blocked ? '<span class="chapa demo">Bloqueado</span>' : ''}</td>
          <td>${p.phone ? esc(p.phone) : '<span class="tenue">—</span>'}${p.marketing_consent ? ' <span class="chapa">Acepta promos</span>' : ''}</td><td>${p.solicitudes}</td>
          <td class="acc"><button class="btn chico ${p.blocked ? '' : 'peligro'}" data-part="${p.id}" data-b="${p.blocked ? '0' : '1'}">${p.blocked ? 'Desbloquear' : 'Bloquear'}</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="vacio">Nadie ha escaneado el código todavía.</p>'}</section>` : ''}
    </div>

    <div>
      <section class="panel"><h3>Sesión de esta noche</h3>
        ${s ? `<p><span class="punto ok"></span>Abierta desde ${fecha(R.sessionOpenedAt)}${s.started ? '' : ' · sin iniciar en el televisor'}</p>
          <div class="qr-admin" style="margin:12px 0"><img src="${base}/qr.svg?t=${encodeURIComponent(R.joinUrl)}" alt="Código QR de la sesión">
            <p class="url tenue">${esc(R.joinUrl)}</p></div>
          <p>Código del local: <span class="codigo-grande">${esc(R.doorCode)}</span></p>
          <p class="ayuda">${R.settings.exigir_codigo ? 'Se está exigiendo a quien entra. Reduce el abuso de quien guardó el enlace, pero no prueba que la persona esté en el bar.' : 'No se está exigiendo (actívalo en Configuración).'}</p>
          <div class="fila-acc" style="margin-top:12px">
            <button class="btn chico" data-ses="solicitudes" data-open="${s.requestsOpen ? '0' : '1'}">${s.requestsOpen ? 'Pausar solicitudes' : 'Reabrir solicitudes'}</button>
            <button class="btn chico" data-ses="codigo">Cambiar código</button>
            <button class="btn chico peligro" data-ses="cerrar">Cerrar sesión de la noche</button>
          </div>`
    : `<p class="tenue">Cerrada. Al abrirla se genera un QR nuevo; el de noches anteriores deja de servir.</p>
          <div class="fila-acc" style="margin-top:12px"><button class="btn principal" data-ses="abrir">Abrir sesión</button></div>`}
      </section>
      <section class="panel"><h3>Pantalla del televisor</h3>
        <p class="ayuda">Ábrela en el equipo conectado al televisor. Si es este mismo equipo, usa el botón.</p>
        <div class="fila-acc" style="margin-top:10px"><button class="btn principal" id="abrir-tv">Abrir pantalla del televisor</button>
          <a class="btn chico" href="#/sala/${route.roomId}/pantallas">Vincular con código</a></div>
      </section>
    </div></div>`;

  v.querySelectorAll('[data-control]').forEach((b) => { b.onclick = () => post('/control', { action: b.dataset.control }); });
  v.querySelectorAll('[data-req]').forEach((b) => { b.onclick = () => {
    if (b.dataset.a === 'quitar' && !confirm('¿Quitar esta canción de la fila?')) return;
    post(`/requests/${b.dataset.req}/${b.dataset.a}`, { where: b.dataset.w });
  }; });
  v.querySelectorAll('[data-part]').forEach((b) => { b.onclick = () => post(`/participants/${b.dataset.part}/bloqueo`, { blocked: b.dataset.b === '1' }); });
  v.querySelectorAll('[data-ses]').forEach((b) => { b.onclick = async () => {
    const a = b.dataset.ses;
    if (a === 'cerrar' && !confirm('Se cierra la noche: la fila pendiente se cancela y el QR deja de servir. ¿Cerrar?')) return;
    if (await post(`/session/${a}`, { open: b.dataset.open === '1' }) && (a === 'abrir' || a === 'cerrar')) { R = await api('GET', `${base}/state`); tabLive(base); }
  }; });
  v.querySelectorAll('[data-bloquear]').forEach((b) => { b.onclick = () => {
    const d = JSON.parse(b.dataset.bloquear);
    if (confirm(`¿Bloquear «${d.title}» en toda la sede? Se salta ahora y no se podrá volver a pedir.`)) post('/blocked', d, 'Video bloqueado y saltado');
  }; });
  $('#abrir-tv').onclick = async () => {
    const w = window.open('about:blank', '_blank'); // se abre dentro del clic para que el navegador no la bloquee
    if (await post('/tv/link', { label: 'Vinculada desde el panel' })) { if (w) w.location = '/tv'; else location.href = '/tv'; } else w?.close();
  };
}

async function tabConfig(base) {
  const s = R.settings; const v = $('#vista');
  if (!overview) overview = await api('GET', '/api/admin/overview').catch(() => null);
  const num = (k, label, help, min, max) => `<label class="campo"><span>${label}</span><input type="number" name="${k}" value="${s[k]}" min="${min}" max="${max}" required><span class="ayuda">${help}</span></label>`;
  const chk = (k, label) => `<label class="casilla"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}><span>${label}</span></label>`;
  v.innerHTML = `<form id="cfg">
    <section class="panel"><h3>Límites por persona y de la fila</h3><div class="form-grid">
      ${num('max_pendientes', 'Canciones en espera por persona', 'Cuántas puede tener alguien en la fila a la vez.', 1, 20)}
      ${num('intervalo_seg', 'Segundos entre solicitudes', 'Tiempo mínimo entre dos pedidos de la misma persona.', 0, 3600)}
      ${num('duracion_max_seg', 'Duración máxima (segundos)', '480 = 8 minutos.', 30, 7200)}
      ${num('limite_fila', 'Tamaño máximo de la fila', 'Al llenarse no entran más hasta que avance.', 1, 500)}
      ${num('repeticion_min', 'Minutos para repetir una canción', 'Cuánto esperar antes de volver a pedir algo que ya sonó. 0 = sin espera.', 0, 1440)}
    </div></section>
    <section class="panel"><h3>Moderación</h3><div class="form-grid">
      ${chk('permitir_duplicados', 'Permitir la misma canción varias veces en la fila')}
      ${chk('excluir_en_vivo', 'Rechazar transmisiones en vivo')}
      ${chk('aprobacion_manual', 'Aprobar cada solicitud a mano antes de que entre a la fila')}
      ${chk('exigir_codigo', 'Exigir el código de 4 dígitos visible en el televisor')}
      <label class="campo"><span>Celular del cliente</span><select name="telefono"><option value="no" ${s.telefono === 'no' ? 'selected' : ''}>No pedirlo</option><option value="opcional" ${s.telefono === 'opcional' ? 'selected' : ''}>Pedirlo como opcional</option></select>
        <span class="ayuda">Nunca se muestra en pantallas públicas y se borra solo días después del cierre.</span></label>
    </div><p class="ayuda" style="margin-top:10px">Estos filtros reducen problemas, pero no garantizan que todo el contenido sea apropiado: para eso están «Bloquear este video» y la aprobación manual.</p></section>
    <section class="panel"><h3>Contenido y mezcla</h3><div class="form-grid">
      <label class="campo"><span>Proveedor de contenido de la sala</span><select name="provider">${(overview?.providers || [{ id: R.room.provider, label: R.room.providerLabel }]).map((p) => `<option value="${p.id}" ${p.id === R.room.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <span class="ayuda">Se cambia con la sesión cerrada. YouTube solo se activa cuando el servidor lo tiene habilitado.</span></label>
      ${num('crossfade_seg', 'Crossfade (segundos)', 'Mezcla entre canciones. Solo aplica al catálogo autorizado; con YouTube siempre es 0 porque sus condiciones no permiten mezclar ni procesar el audio.', 0, 12)}
      <label class="campo"><span>Nombre de la sala</span><input name="name" value="${esc(R.room.name)}" maxlength="60"></label>
    </div></section>
    <div class="fila-acc" style="margin-top:16px"><button class="btn principal">Guardar configuración</button></div></form>`;
  $('#cfg').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target; const body = { telefono: f.telefono.value, provider: f.provider.value, name: f.name.value };
    for (const k of ['max_pendientes', 'intervalo_seg', 'duracion_max_seg', 'limite_fila', 'repeticion_min', 'crossfade_seg']) body[k] = Number(f[k].value);
    for (const k of ['permitir_duplicados', 'excluir_en_vivo', 'aprobacion_manual', 'exigir_codigo']) body[k] = f[k].checked;
    if (await act(() => api('PUT', `${base}/settings`, body), 'Configuración guardada')) renderRoom();
  };
}

async function tabFallback(base) {
  const v = $('#vista');
  const { items } = await api('GET', `${base}/fallback`);
  const edit = can('admin_sede');
  v.innerHTML = `<section class="panel"><h3>Lista de respaldo (${items.length})</h3>
    <p class="ayuda">Suena en orden y en ciclo cuando nadie ha pedido nada. Si entra una solicitud, la canción de respaldo termina y luego sigue la fila.</p>
    ${items.length ? `<table><tbody>${items.map((i, n) => `<tr><td class="num">${n + 1}</td><td>${esc(i.title)}<br><span class="tenue">${esc(i.channel || '')} · ${dur(i.durationSec)}</span></td>
      <td class="acc">${edit ? `<button class="btn chico peligro" data-del="${i.id}">Quitar</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="vacio">Sin canciones de respaldo: con la fila vacía la pantalla queda en silencio.</p>'}
    </section>
    ${edit ? `<section class="panel"><h3>Agregar al respaldo</h3>
      <form id="buscar" class="fila-acc"><input class="entrada" name="q" placeholder="Busca en ${esc(R.room.providerLabel)}" style="max-width:360px"><button class="btn">Buscar</button>
        ${R.room.provider === 'youtube' ? '<label class="casilla" style="min-height:auto"><input type="checkbox" name="todo"><span>En todo YouTube (gasta 100 unidades)</span></label>' : ''}</form>
      ${R.room.provider === 'youtube' ? '<p class="ayuda" style="margin-top:6px">Sin la casilla busca en el repertorio del bar, que no gasta cuota.</p>' : ''}
      <div id="res"></div></section>` : ''}`;
  v.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (await act(() => api('DELETE', `${base}/fallback/${b.dataset.del}`), 'Quitada del respaldo')) tabFallback(base); }; });
  if ($('#buscar')) $('#buscar').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const { items: found } = await api('GET', `${base}/search?q=${encodeURIComponent(ev.target.q.value)}${ev.target.todo?.checked ? '&scope=youtube' : ''}`);
      $('#res').innerHTML = found.length ? `<table style="margin-top:10px"><tbody>${found.map((i) => `<tr><td>${esc(i.title)}<br><span class="tenue">${esc(i.channel || '')} · ${dur(i.durationSec)}</span></td>
        <td class="acc"><button class="btn chico principal" data-add="${esc(i.mediaId)}">Agregar</button></td></tr>`).join('')}</tbody></table>` : '<p class="vacio">Sin resultados.</p>';
      $('#res').querySelectorAll('[data-add]').forEach((b) => { b.onclick = async () => { if (await act(() => api('POST', `${base}/fallback`, { mediaId: b.dataset.add }), 'Agregada al respaldo')) tabFallback(base); }; });
    } catch (e) { toast(e.message, true); }
  };
}

async function tabBlocked(base) {
  const { items } = await api('GET', `${base}/blocked`);
  $('#vista').innerHTML = `<section class="panel"><h3>Videos bloqueados en la sede (${items.length})</h3>
    <p class="ayuda">Aplican a todas las salas de la sede. Se bloquea desde «En vivo» (botón «Bloquear este video») o desde Historial.</p>
    ${items.length ? `<table><tbody>${items.map((i) => `<tr><td>${esc(i.title || i.mediaId)}<br><span class="tenue">${esc(i.provider)} · ${fecha(i.createdAt)}</span></td>
      <td class="acc">${can('admin_sede') ? `<button class="btn chico" data-del="${i.id}">Desbloquear</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="vacio">No hay videos bloqueados.</p>'}</section>`;
  $('#vista').querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (await act(() => api('DELETE', `${base}/blocked/${b.dataset.del}`), 'Desbloqueado')) tabBlocked(base); }; });
}

async function tabHistory(base) {
  const { items } = await api('GET', `${base}/history`);
  $('#vista').innerHTML = `<section class="panel"><h3>Últimas 200 solicitudes</h3>
    ${items.length ? `<div class="tabla-scroll"><table><thead><tr><th>Hora</th><th>Canción</th><th>Pidió</th><th>Estado</th><th></th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${fecha(i.createdAt)}</td><td>${esc(i.title)}</td><td>${i.source === 'respaldo' ? '<span class="tenue">Respaldo</span>' : esc(i.alias || 'Invitado')}</td>
      <td>${ESTADO[i.status]}${i.failReason ? `<br><span class="tenue">${esc(i.failReason)}</span>` : ''}</td>
      <td class="acc"><button class="btn chico" data-bloq='${esc(JSON.stringify({ provider: i.provider, mediaId: i.mediaId, title: i.title }))}'>Bloquear</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="vacio">Aún no hay solicitudes.</p>'}</section>`;
  $('#vista').querySelectorAll('[data-bloq]').forEach((b) => { b.onclick = () => { const d = JSON.parse(b.dataset.bloq); if (confirm(`¿Bloquear «${d.title}» en esta sede?`)) act(() => api('POST', `${base}/blocked`, d), 'Video bloqueado'); }; });
}

async function tabErrors(base) {
  const { items } = await api('GET', `${base}/errors`);
  $('#vista').innerHTML = `<section class="panel"><h3>Errores y avisos recientes</h3>
    ${items.length ? `<div class="tabla-scroll"><table><thead><tr><th>Hora</th><th>Tipo</th><th>Detalle</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${fecha(i.createdAt)}</td><td>${esc(i.kind)}</td><td>${esc(i.message)}${i.detail?.title ? `<br><span class="tenue">${esc(i.detail.title)}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="vacio">Sin errores registrados.</p>'}</section>`;
}

async function tabAudit(base) {
  const { items } = await api('GET', `${base}/audit`);
  $('#vista').innerHTML = `<section class="panel"><h3>Quién hizo qué</h3>
    ${items.length ? `<div class="tabla-scroll"><table><thead><tr><th>Hora</th><th>Quién</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
    ${items.map((i) => `<tr><td>${fecha(i.createdAt)}</td><td>${esc(i.userName || i.actor)}</td><td>${esc(i.action)}</td><td class="tenue">${esc(i.detail?.title || (Object.keys(i.detail || {}).length ? JSON.stringify(i.detail) : ''))}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="vacio">Sin registros.</p>'}</section>`;
}

async function tabScreens(base) {
  const { items } = await api('GET', `${base}/tv/devices`);
  $('#vista').innerHTML = `<section class="panel"><h3>Vincular una pantalla con código</h3>
    <p class="ayuda">En el equipo del televisor abre <b>${esc(location.origin)}/tv</b>. Aparece un código de 6 dígitos: escríbelo aquí.</p>
    <form id="par" class="fila-acc" style="margin-top:10px"><input class="entrada" name="code" inputmode="numeric" maxlength="6" placeholder="000000" required style="max-width:160px"><button class="btn principal">Vincular pantalla</button></form></section>
    <section class="panel"><h3>Pantallas vinculadas (${items.length})</h3>
    ${items.length ? `<table><tbody>${items.map((d) => `<tr><td>${esc(d.label || 'Pantalla')}<br><span class="tenue">Desde ${fecha(d.createdAt)}</span></td>
      <td class="acc">${can('admin_sede') ? `<button class="btn chico peligro" data-rev="${d.id}">Desvincular</button>` : ''}</td></tr>`).join('')}</tbody></table>
      <p class="ayuda" style="margin-top:8px">Aunque haya varias vinculadas, solo una reproduce a la vez. Desvincula las que ya no se usen.</p>` : '<p class="vacio">Ninguna pantalla vinculada.</p>'}</section>`;
  $('#par').onsubmit = async (ev) => { ev.preventDefault(); if (await act(() => api('POST', `${base}/tv/pair`, formData(ev.target)), 'Pantalla vinculada')) tabScreens(base); };
  $('#vista').querySelectorAll('[data-rev]').forEach((b) => { b.onclick = async () => { if (confirm('¿Desvincular esta pantalla?') && await act(() => api('DELETE', `${base}/tv/devices/${b.dataset.rev}`), 'Pantalla desvinculada')) tabScreens(base); }; });
}

// ───────── Usuarios ─────────
async function renderUsers() {
  const [{ users }, ov] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/overview')]);
  overview = ov;
  const roles = Object.keys(ROLES).filter((r) => user.role === 'admin_general' || RANK[r] < RANK[user.role]);
  mount(`<h1 class="titulo">Usuarios</h1>
    <section class="panel" style="margin-top:14px"><div class="tabla-scroll"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Sede</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)} ${u.active ? '' : '<span class="chapa demo">Inactivo</span>'}</td><td>${esc(u.email)}</td><td>${ROLES[u.role]}</td><td>${esc(u.venueName || 'Todas')}</td>
      <td class="acc"><button class="btn chico" data-clave="${u.id}">Cambiar contraseña</button> ${u.id !== user.id ? `<button class="btn chico" data-activo="${u.id}" data-v="${u.active ? '0' : '1'}">${u.active ? 'Desactivar' : 'Activar'}</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></section>
    <h2 class="sub">Nuevo usuario</h2>
    <form id="nuevo" class="panel"><div class="form-grid">
      <label class="campo"><span>Nombre</span><input name="name" required maxlength="60"></label>
      <label class="campo"><span>Correo</span><input name="email" type="email" required></label>
      <label class="campo"><span>Contraseña (mínimo 10 caracteres)</span><input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
      <label class="campo"><span>Rol</span><select name="role">${roles.map((r) => `<option value="${r}">${ROLES[r]}</option>`).join('')}</select></label>
      <label class="campo"><span>Sede</span><select name="venueId">${ov.venues.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
    </div><div class="fila-acc" style="margin-top:14px"><button class="btn principal">Crear usuario</button></div></form>`);
  $('#nuevo').onsubmit = async (ev) => { ev.preventDefault(); const d = formData(ev.target); d.venueId = Number(d.venueId); if (await act(() => api('POST', '/api/admin/users', d), 'Usuario creado')) renderUsers(); };
  app.querySelectorAll('[data-clave]').forEach((b) => { b.onclick = async () => { const password = prompt('Nueva contraseña (mínimo 10 caracteres)'); if (password) act(() => api('PATCH', `/api/admin/users/${b.dataset.clave}`, { password }), 'Contraseña cambiada'); }; });
  app.querySelectorAll('[data-activo]').forEach((b) => { b.onclick = async () => { if (await act(() => api('PATCH', `/api/admin/users/${b.dataset.activo}`, { active: b.dataset.v === '1' }), 'Usuario actualizado')) renderUsers(); }; });
}

// ───────── Consumo de API ─────────
async function renderUsage() {
  const u = await api('GET', '/api/admin/usage');
  const pct = Math.min(100, Math.round((u.today.units / u.today.dailyQuota) * 100));
  mount(`<h1 class="titulo">Consumo de la API de YouTube</h1>
    ${!u.status.available ? `<p class="aviso" style="margin-top:14px">${esc(u.status.reason)}</p>` : ''}
    ${u.today.exhausted_at ? '<div class="alerta" style="margin-top:14px">Cuota agotada hoy. Se reinicia a medianoche, hora del Pacífico (2–3 a. m. en Colombia). La fila y la reproducción no se afectan.</div>' : ''}
    <section class="panel" style="margin-top:14px"><h3>Hoy (día de cuota ${esc(u.today.day)})</h3>
      <div class="barra-uso"><i style="width:${pct}%"></i></div>
      <p style="margin-top:8px"><b>${u.today.units}</b> de ${u.today.dailyQuota} unidades · ${u.today.searches} búsquedas reales · ${u.today.cache_hits} resueltas desde caché · ${u.today.errors} errores</p>
      <p class="ayuda">Cada búsqueda cuesta ${u.today.searchCost} unidades; validar un video cuesta 1. La cuota es por proyecto de Google Cloud y la comparten todas las sedes. No se puede comprar más: se solicita a YouTube con una auditoría de cumplimiento.</p></section>
    <section class="panel"><h3>Últimos 14 días</h3>
      ${u.days.length ? `<table><thead><tr><th>Día</th><th>Unidades</th><th>Búsquedas</th><th>Desde caché</th><th>Errores</th><th>¿Se agotó?</th></tr></thead><tbody>
      ${u.days.map((d) => `<tr><td>${esc(String(d.day).slice(0, 10))}</td><td>${d.units}</td><td>${d.searches}</td><td>${d.cacheHits}</td><td>${d.errors}</td><td>${d.exhaustedAt ? fecha(d.exhaustedAt) : 'No'}</td></tr>`).join('')}</tbody></table>` : '<p class="vacio">Sin consumo registrado.</p>'}</section>`);
}

// ───────── Repertorio (listas de YouTube importadas) ─────────
async function renderRepertoire() {
  const base = `/api/admin/venues/${route.venueId}/repertoire`;
  const d = await api('GET', base);
  mount(`<p class="migas"><a href="#/">Sedes y salas</a> / Repertorio</p>
    <h1 class="titulo">Repertorio de YouTube</h1>
    <p class="tenue">Listas de reproducción importadas. Los clientes buscan primero aquí <b>sin gastar cuota</b>; solo si no encuentran, pueden buscar en todo YouTube. Importar cuesta 1 unidad por cada 50 videos (una búsqueda normal cuesta 100).</p>
    ${!d.youtube.available ? `<p class="aviso" style="margin-top:14px">${esc(d.youtube.reason)}</p>` : ''}
    <section class="panel" style="margin-top:14px"><h3>${d.total} canciones en el repertorio · ${d.lists.length} listas</h3>
      ${d.lists.length ? `<div class="tabla-scroll"><table><thead><tr><th>Lista</th><th>Canciones</th><th>Actualizada</th><th>Unidades gastadas</th><th></th></tr></thead><tbody>
      ${d.lists.map((l) => `<tr><td>${esc(l.title || l.listId)}<br><span class="tenue">${esc(l.channel || '')}${l.venueId ? '' : ' · todas las sedes'}</span>${l.lastError ? `<br><span class="chapa demo">Error al refrescar</span> <span class="tenue">${esc(l.lastError)}</span>` : ''}</td>
        <td>${l.count}</td><td>${fecha(l.refreshedAt)}</td><td>${l.units}</td>
        <td class="acc"><button class="btn chico" data-ref="${l.id}">Refrescar</button> <button class="btn chico peligro" data-del="${l.id}">Quitar</button></td></tr>`).join('')}
      </tbody></table></div><p class="ayuda" style="margin-top:8px">Se refrescan solas cada 25 días (YouTube exige renovar los datos antes de 30).</p>`
    : '<p class="vacio">Aún no hay listas. Pega abajo el enlace de una lista de reproducción de YouTube.</p>'}
    </section>
    <h2 class="sub">Importar una lista</h2>
    <form id="imp" class="panel"><div class="form-grid">
      <label class="campo"><span>Enlace de la lista de reproducción</span><input name="url" required placeholder="https://www.youtube.com/playlist?list=PL…"></label>
      ${user.role === 'admin_general' ? '<label class="casilla"><input type="checkbox" name="todas"><span>Disponible en todas las sedes</span></label>' : ''}
    </div><p class="ayuda" style="margin-top:8px">La lista debe ser pública o «no listada». Las listas «Mix» de YouTube no se pueden importar. Máximo 3.000 videos por lista.</p>
    <div class="fila-acc" style="margin-top:14px"><button class="btn principal">Importar</button><span id="imp-estado" class="tenue"></span></div></form>`);
  $('#imp').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button'); btn.disabled = true; $('#imp-estado').textContent = 'Importando… puede tardar un minuto.';
    const ok = await act(async () => {
      const r = await api('POST', base, { url: ev.target.url.value, todas: ev.target.todas?.checked || false });
      toast(`«${r.title}»: ${r.count} canciones importadas (${r.units} unidades)${r.truncated ? ' · se tomaron las primeras 3.000' : ''}`);
    });
    if (ok) renderRepertoire(); else { btn.disabled = false; $('#imp-estado').textContent = ''; }
  };
  app.querySelectorAll('[data-ref]').forEach((b) => { b.onclick = async () => { b.disabled = true; if (await act(() => api('POST', `${base}/${b.dataset.ref}/refresh`), 'Lista actualizada')) renderRepertoire(); else b.disabled = false; }; });
  app.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (confirm('¿Quitar esta lista del repertorio?') && await act(() => api('DELETE', `${base}/${b.dataset.del}`), 'Lista quitada')) renderRepertoire(); }; });
}

// ───────── Catálogo autorizado ─────────
async function renderCatalog() {
  const base = `/api/admin/venues/${route.venueId}/catalog`;
  let items;
  try { ({ items } = await api('GET', base)); } catch (e) { return mount(`<p class="aviso error" style="margin-top:20px">${esc(e.message)}</p>`); }
  mount(`<p class="migas"><a href="#/">Sedes y salas</a> / Catálogo autorizado</p>
    <h1 class="titulo">Catálogo autorizado</h1>
    <p class="tenue">Contenido propio o con licencia que el bar puede comunicar al público. Es el único que admite crossfade.</p>
    <section class="panel" style="margin-top:14px"><div class="tabla-scroll"><table><thead><tr><th>Título</th><th>Duración</th><th>Origen del derecho</th><th></th></tr></thead><tbody>
    ${items.filter((i) => i.active).map((i) => `<tr><td>${esc(i.title)} ${i.demo ? '<span class="chapa demo">DEMO</span>' : ''}<br><span class="tenue">${esc(i.artist || '')}</span></td><td>${dur(i.durationSec)}</td><td class="tenue">${esc(i.licenseNote || '')}</td>
      <td class="acc">${i.venueId && can('admin_sede') ? `<button class="btn chico peligro" data-del="${i.id}">Retirar</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></section>
    ${can('admin_sede') ? `<h2 class="sub">Agregar contenido</h2>
    <form id="nuevo" class="panel"><div class="form-grid">
      <label class="campo"><span>Título</span><input name="title" required maxlength="120"></label>
      <label class="campo"><span>Artista</span><input name="artist" maxlength="80"></label>
      <label class="campo"><span>URL https del archivo (mp4, webm o mp3)</span><input name="url" type="url" required placeholder="https://…"></label>
      <label class="campo"><span>Duración en segundos</span><input name="durationSec" type="number" min="5" max="7200" required></label>
      <label class="campo"><span>Origen del derecho de uso</span><input name="licenseNote" required maxlength="200" placeholder="Ej.: producción propia / contrato con el proveedor X"></label>
    </div><p class="ayuda" style="margin-top:8px">Solo agrega contenido que el bar tenga derecho a reproducir en público. El archivo debe estar en un alojamiento que permita reproducirlo desde esta página.</p>
    <div class="fila-acc" style="margin-top:14px"><button class="btn principal">Agregar al catálogo</button></div></form>` : ''}`);
  if ($('#nuevo')) $('#nuevo').onsubmit = async (ev) => { ev.preventDefault(); const d = formData(ev.target); d.durationSec = Number(d.durationSec); if (await act(() => api('POST', base, d), 'Agregado al catálogo')) renderCatalog(); };
  app.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (await act(() => api('DELETE', `${base}/${b.dataset.del}`), 'Retirado del catálogo')) renderCatalog(); }; });
}

boot();
