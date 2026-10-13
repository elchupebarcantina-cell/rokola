// Pantalla del televisor: reproduce la fila, muestra el QR y se recupera sola de cortes y recargas.
import { api, live, esc, $ } from '/js/api.js';
import { createYouTubePlayer, createCatalogPlayer, unlockAudio } from '/tv/players.js';

// Identificador de pestaña: sobrevive a una recarga (sessionStorage) para conservar el liderazgo.
let tabId = sessionStorage.getItem('rk_tab');
if (!tabId) { tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; sessionStorage.setItem('rk_tab', tabId); }

const els = { yt: $('#yt-host'), cat: $('#cat-host'), reposo: $('#reposo'), barra: $('#barra'), lateral: $('#lateral') };

let S = null;               // estado de la sala según el servidor
let paired = true;
let leader = false;
let unlocked = false;       // hubo gesto del usuario en esta pestaña (sonido permitido)
let blocked = false;        // el navegador bloqueó el autoplay
let serverOk = true;
let playerStatus = 'en espera';
let loadedId = null;        // solicitud cargada en el reproductor
let startedId = null;
let retries = 0;
let pendingReport = null;   // aviso de fin/fallo aún no confirmado por el servidor
let pairing = null;

const handlers = {
  onPlaying(id) { startedId = id; retries = 0; blocked = false; playerStatus = 'reproduciendo'; send('/api/tv/playing', { requestId: id }).catch(() => {}); render(); },
  onEnded(id) { loadedId = null; report('/api/tv/ended', { requestId: id }); },
  onError(id, { reason, network, retriable }) {
    if (id === null || id !== loadedId) return;
    // Sin internet NO es culpa del video: se espera y se reintenta la misma canción. La fila queda intacta.
    if (network || !navigator.onLine || !serverOk) { playerStatus = 'sin conexión'; loadedId = null; render(); return setTimeout(reconcile, 5000); }
    if (retries < (retriable ? 2 : 1)) { retries++; playerStatus = `reintentando (${retries})`; loadedId = null; render(); return setTimeout(reconcile, 3000); }
    retries = 0; loadedId = null;
    report('/api/tv/failed', { requestId: id, reason });
  },
  onBlocked() {
    if (!blocked) send('/api/tv/report', { kind: 'autoplay_bloqueado', message: 'El navegador bloqueó la reproducción automática' }).catch(() => {});
    blocked = true; playerStatus = 'esperando activación'; render();
  },
  onStatus(t) { if (playerStatus !== t) { playerStatus = t; } },
};
const players = { youtube: createYouTubePlayer(els.yt, handlers), catalogo: createCatalogPlayer(els.cat, handlers) };
let active = null;

const send = (path, body) => api('POST', path, { tabId, ...body });

/** Avisos de fin/fallo: se reintentan hasta que el servidor los confirme (es idempotente: avanza una sola vez). */
async function report(path, body) {
  pendingReport = { path, body };
  try {
    const out = await send(path, body);
    pendingReport = null; serverOk = true;
    if (out.state) S = out.state;
  } catch (e) {
    if (e.status === 409 || e.status === 401) { pendingReport = null; leader = false; }
    else if (path === '/api/tv/failed') {
      // No se pudo ni avisar del fallo: lo más probable es que el problema sea la red, no el video.
      // Se descarta el aviso y se vuelve a intentar la MISMA canción cuando haya conexión.
      pendingReport = null; serverOk = false; playerStatus = 'sin conexión';
      return setTimeout(reconcile, 5000);
    } else { serverOk = false; setTimeout(() => pendingReport && report(pendingReport.path, pendingReport.body), 3000); }
  }
  reconcile();
}

async function refresh() {
  try {
    const wasDown = !serverOk;
    S = await api('GET', '/api/tv/state');
    paired = true; serverOk = true; ensureLive();
    // Si la canción cargada nunca llegó a sonar y veníamos de un corte, se recarga en vez de quedarse esperando.
    if (wasDown && loadedId && startedId !== loadedId) { blocked = false; loadedId = null; }
  } catch (e) {
    if (e.status === 401) return unpair();
    serverOk = false;
  }
  reconcile();
}

function stopAll() { for (const p of Object.values(players)) p.stop(); loadedId = null; active = null; }
function unpair() { paired = false; stopAll(); stopLive?.(); stopLive = null; S = null; startPairing(); }

/** Lleva el reproductor a lo que dice el servidor. Es el único lugar que carga o detiene contenido. */
function reconcile() {
  if (!S || !paired) return render();
  if (!leader || !unlocked) { if (!leader) stopAll(); return render(); }
  const now = S.now;
  if (!now) { if (!pendingReport) { stopAll(); playerStatus = 'en espera'; } return render(); }
  if (pendingReport) return render(); // aún no se confirma el avance: no recargar nada
  if (now.id !== loadedId) {
    const next = players[now.provider];
    if (!next) { report('/api/tv/failed', { requestId: now.id, reason: `proveedor sin reproductor: ${now.provider}` }); return; }
    if (active && active !== next) active.stop();
    active = next; loadedId = now.id; blocked = false;
    els.yt.hidden = now.provider !== 'youtube'; els.cat.hidden = now.provider !== 'catalogo';
    next.load(now, { crossfadeSec: S.crossfadeSec });
  }
  if (S.desired === 'pause' && startedId === now.id) { active?.pause(); playerStatus = 'en pausa'; }
  else if (S.desired === 'play' && playerStatus === 'en pausa') active?.resume();
  render();
}

// ───────── Liderazgo: un solo reproductor principal por sala ─────────
async function heartbeat(takeover = false) {
  if (!paired) return;
  try {
    const status = !unlocked ? 'esperando inicio' : blocked ? 'autoplay bloqueado' : playerStatus;
    const r = await send('/api/tv/heartbeat', { status, takeover });
    serverOk = true;
    if (r.leader !== leader) { leader = r.leader; if (leader) await refresh(); else reconcile(); }
  } catch (e) {
    if (e.status === 401) return unpair();
    serverOk = false;
    render();
  }
}

// ───────── Gestos del encargado ─────────
async function startNight() {
  unlocked = true; blocked = false;
  await unlockAudio();
  goFullscreen();
  try { navigator.wakeLock?.request('screen').catch(() => {}); } catch { /* no disponible */ }
  try { S = await send('/api/tv/start', {}); serverOk = true; } catch (e) { if (e.status === 409) leader = false; else serverOk = false; }
  reconcile();
}
async function reactivate() {
  unlocked = true; blocked = false;
  await unlockAudio();
  if (active && loadedId) active.resume(); else reconcile();
  render();
}
function goFullscreen() {
  // Pantalla completa del CONTENEDOR de la aplicación: el QR y la fila siguen visibles junto al video.
  const el = document.documentElement;
  (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el).catch?.(() => {});
}
document.addEventListener('fullscreenchange', render);

// ───────── Vinculación ─────────
async function startPairing() {
  if (pairing) return render();
  try {
    pairing = await api('POST', '/api/tv/pair/start', {});
    const poll = setInterval(async () => {
      try {
        const r = await api('POST', '/api/tv/pair/claim', pairing);
        if (r.paired) { clearInterval(poll); pairing = null; paired = true; await heartbeat(); refresh(); }
      } catch (e) { if (e.status === 404) { clearInterval(poll); pairing = null; startPairing(); } }
    }, 3000);
  } catch { pairing = null; setTimeout(startPairing, 5000); }
  render();
}

// El canal en tiempo real se abre cuando la pantalla ya está vinculada (antes respondería 401 y no reconectaría).
let stopLive = null;
function ensureLive() {
  if (stopLive) return;
  stopLive = live('/api/tv/events', {
    onEvent: () => refresh(),
    onStatus: (ok) => { if (!ok && serverOk) { serverOk = false; render(); } else if (ok && !serverOk) refresh(); },
    poll: refresh, pollMs: 10000,
  });
}

// Solo se toca el DOM cuando el contenido cambia: el QR no parpadea ni se vuelve a descargar.
function setHtml(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }

// ───────── Dibujo ─────────
function render() {
  if (!paired) {
    els.yt.hidden = els.cat.hidden = true; els.reposo.hidden = false;
    setHtml(els.reposo, `<div><img src="/img/logo-el-chupe.jpg" alt="">
      <h1>Vincula esta pantalla</h1>
      <p>En el panel de administración entra a la sala y elige «Vincular pantalla con código».</p>
      <p class="codigo">${pairing ? esc(pairing.code) : '······'}</p>
      <p>¿Ya iniciaste sesión en este equipo? <a href="/admin">Abre el panel</a> y pulsa «Abrir pantalla del televisor».</p></div>`);
    setHtml(els.barra, ''); setHtml(els.lateral, '');
    return;
  }
  if (!S) return;
  const v = S.venue; const now = S.now;
  const logo = v.logo ? `<img src="${esc(v.logo)}" alt="">` : '';
  if (v.accent) document.documentElement.style.setProperty('--oro', v.accent);

  // Zona de video: reposo solo cuando NO hay un reproductor activo a la vista.
  let reposo = '';
  if (!leader) {
    reposo = `<div>${logo}<h1>Otra pantalla es la reproductora de esta sala</h1>
      <p>Para que no suenen dos a la vez, solo una pantalla reproduce. Si la otra se cerró, esta tomará el control sola en unos segundos.</p>
      <button class="btn" id="tomar">Usar esta pantalla</button></div>`;
  } else if (!S.session || !S.session.started) {
    reposo = `<div>${logo}<h1>${esc(v.name)}</h1><p class="lema">¿Un chupe o qué?</p>
      <button class="btn principal" id="iniciar">Iniciar noche</button>
      <p>Activa el sonido, la pantalla completa y el código QR de esta sesión.</p></div>`;
  } else if (!unlocked || (blocked && !loadedId)) {
    reposo = `<div>${logo}<h1>La noche sigue abierta</h1>
      <p>El navegador necesita un toque para volver a reproducir con sonido.</p>
      <button class="btn principal" id="reactivar">Reanudar reproducción</button></div>`;
  } else if (!now && !pendingReport) {
    reposo = `<div>${logo}<h1>Escanea y pide tu canción</h1>
      <p class="lema">${S.attention ? 'Reproducción detenida' : 'La fila está vacía: la primera suena de una'}</p></div>`;
  }
  setHtml(els.reposo, reposo);
  els.reposo.hidden = !reposo;
  if (reposo) { els.yt.hidden = true; els.cat.hidden = true; } else if (now) { els.yt.hidden = now.provider !== 'youtube'; els.cat.hidden = now.provider !== 'catalogo'; }
  if ($('#iniciar')) $('#iniciar').onclick = startNight;
  if ($('#reactivar')) $('#reactivar').onclick = reactivate;
  if ($('#tomar')) $('#tomar').onclick = () => heartbeat(true);

  // Barra inferior (fuera del reproductor): canción, quién la pidió y avisos para el encargado.
  const alerta = !serverOk ? 'Sin conexión con el servidor. Reintentando… la fila no se pierde.'
    : S.attention ? esc(S.attention)
      : (blocked && loadedId) ? 'El navegador bloqueó el sonido automático.'
        : playerStatus === 'sin conexión' ? 'Sin internet para cargar el video. Se reintenta solo; la fila se conserva.'
          : S.desired === 'pause' && now ? 'Reproducción en pausa desde el panel.' : '';
  setHtml(els.barra, `
    ${alerta ? `<div class="alerta" role="alert"><span>${alerta}</span>${blocked && loadedId ? '<button class="btn" id="activar">Activar sonido</button>' : ''}</div>` : ''}
    <div>${now ? `<p class="rotulo">${reposo ? 'Lista para sonar' : 'Sonando ahora'} ${now.demo ? '<span class="chapa demo">DEMO</span>' : ''}</p><h2>${esc(now.title)}</h2>`
    : `<p class="rotulo">${esc(S.room.name)}</p><h2>${S.session?.started ? 'Esperando la próxima canción' : 'Rockola lista'}</h2>`}</div>
    ${now ? `<p class="quien">${now.alias ? `La pidió<b>${esc(now.alias)}</b>` : '<b>Música de la casa</b>'}</p>` : ''}`);
  if ($('#activar')) $('#activar').onclick = reactivate;

  // Lateral: sede, QR grande y próximas canciones.
  const qrKey = S.joinUrl || '';
  const fs = Boolean(document.fullscreenElement);
  const siguen = S.queue.slice(0, 4);
  setHtml(els.lateral, `
    <div class="sede">${logo}<div><h3>${esc(v.name)}</h3><p>${esc(S.room.name)}</p></div></div>
    ${S.joinUrl ? `<div class="qr">
      <p class="llamado">Escanea y pide tu canción</p>
      <div class="etiqueta"><div class="dentro"><img id="qr" alt="Código QR para pedir canciones" src="/api/tv/qr.svg?s=${encodeURIComponent(qrKey)}"></div></div>
      ${S.doorCode ? `<p class="codigo">Código de esta noche<b>${esc(S.doorCode)}</b></p>` : ''}
      ${S.session.requestsOpen ? '' : '<p class="codigo">Solicitudes en pausa</p>'}
    </div>` : '<div class="qr"><p class="llamado">El código QR aparece al iniciar la noche</p></div>'}
    <div class="siguen">
      <p class="rombos">◆ Siguen ◆</p>
      ${siguen.length ? `<ol>${siguen.map((r, i) => `<li><span class="n">${i + 1}</span><span><span class="t">${esc(r.title)}</span><span class="a">${esc(r.alias || '')}</span></span></li>`).join('')}</ol>
        ${S.queue.length > 4 ? `<p class="a" style="margin-top:1vh;text-align:center">y ${S.queue.length - 4} más en la fila</p>` : ''}`
    : '<p class="vacia">Nadie en la fila.<br>¡La tuya suena enseguida!</p>'}
    </div>
    <div class="pie-tv">
      ${serverOk ? '<span></span>' : '<span class="conexion">● Sin conexión</span>'}
      ${S.room.provider === 'youtube' ? '<span>Videos de YouTube</span>' : ''}
      ${fs ? '' : '<button class="btn" id="fs">Pantalla completa</button>'}
    </div>`);
  if ($('#fs')) $('#fs').onclick = goFullscreen;
}

// ───────── Arranque y recuperación ─────────
window.addEventListener('online', () => { refresh(); });
window.addEventListener('offline', () => { serverOk = false; render(); });

await heartbeat();
await refresh();
// Tras una recarga con la noche ya iniciada se intenta seguir sin intervención; si el navegador
// exige un gesto, aparece el botón «Reanudar reproducción» / «Activar sonido».
if (paired && leader && S?.session?.started) { unlocked = true; reconcile(); }
setInterval(heartbeat, 5000);
