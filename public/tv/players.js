// Adaptadores de reproducción del televisor. Uno por proveedor de contenido, todos con la misma interfaz:
//   load(item, { crossfadeSec })   pause()   resume()   stop()
// y los mismos avisos hacia tv.js: onPlaying(id) · onEnded(id) · onError(id, {reason, network}) · onBlocked() · onStatus(texto)
//
// El final de una canción se toma SIEMPRE del evento oficial del reproductor (nunca de un temporizador),
// así la publicidad o el búfer no se confunden con "terminó".

// ───────────────────────── YouTube (IFrame Player API oficial) ─────────────────────────
// · Controles y marca de YouTube visibles; no se superpone nada al reproductor.
// · Sin reproductores ocultos, sin extraer audio, sin crossfade.
// · fs=0 (parámetro documentado): la pantalla completa la maneja la aplicación para que el QR siga visible.
let ytApi;
function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApi = null; reject(new Error('No se pudo cargar el reproductor de YouTube')); };
      document.head.appendChild(s);
    });
  }
  return ytApi;
}

const YT_ERRORS = {
  2: 'yt-2: identificador de video inválido',
  5: 'yt-5: el video no se puede reproducir en este navegador',
  100: 'yt-100: video eliminado o privado',
  101: 'yt-101: el propietario no permite reproducción integrada',
  150: 'yt-150: el propietario no permite reproducción integrada',
};

export function createYouTubePlayer(host, h) {
  let player; let ready; let currentId = null; let watchdog; let started = false;

  const clearWatch = () => clearTimeout(watchdog);
  const armWatch = () => {
    clearWatch();
    // Si a los 12 s no ha empezado: sin red → se espera; con red y sin arrancar → el navegador bloqueó el autoplay.
    watchdog = setTimeout(() => {
      if (started || currentId === null) return;
      if (!navigator.onLine) return h.onError(currentId, { reason: 'sin conexión al cargar', network: true });
      const st = player?.getPlayerState?.();
      if (st === -1 || st === 5 || st === 2) h.onBlocked();
      else if (st === 3) { h.onStatus('cargando'); armWatch(); }
    }, 12000);
  };

  async function ensure(videoId) {
    if (ready) return ready;
    ready = (async () => {
      const YT = await loadYouTubeApi();
      const el = document.createElement('div');
      host.replaceChildren(el);
      await new Promise((resolve) => {
        player = new YT.Player(el, {
          width: '100%', height: '100%', videoId,
          playerVars: {
            autoplay: 1, controls: 1, playsinline: 1, rel: 0, fs: 0, hl: 'es',
            origin: location.origin, widget_referrer: location.origin,
          },
          events: {
            onReady: resolve,
            onStateChange: (e) => {
              if (currentId === null) return;
              if (e.data === YT.PlayerState.PLAYING) { clearWatch(); if (!started) { started = true; h.onPlaying(currentId); } h.onStatus('reproduciendo'); }
              else if (e.data === YT.PlayerState.BUFFERING) h.onStatus('cargando');
              else if (e.data === YT.PlayerState.PAUSED) h.onStatus('en pausa');
              else if (e.data === YT.PlayerState.ENDED) { clearWatch(); const id = currentId; currentId = null; h.onEnded(id); }
            },
            onError: (e) => {
              clearWatch();
              const network = !navigator.onLine;
              h.onError(currentId, { reason: YT_ERRORS[e.data] || `yt-${e.data}`, network, retriable: e.data === 5 });
            },
            onAutoplayBlocked: () => h.onBlocked(),
          },
        });
      });
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  return {
    kind: 'youtube',
    async load(item) {
      currentId = item.id; started = false;
      h.onStatus('cargando');
      try {
        const first = !ready;
        await ensure(item.mediaId);
        if (!first) player.loadVideoById(item.mediaId);
        else player.playVideo?.();
        armWatch();
      } catch (e) {
        h.onError(item.id, { reason: e.message, network: true });
      }
    },
    pause() { player?.pauseVideo?.(); },
    resume() { player?.playVideo?.(); if (!started) armWatch(); },
    stop() { clearWatch(); currentId = null; player?.stopVideo?.(); },
  };
}

// ───────────────────────── Catálogo autorizado (contenido propio o con licencia) ─────────────────────────
// Aquí SÍ se puede mezclar: crossfade configurable de audio y video, porque el bar tiene el derecho de hacerlo.
// Fuentes: URL https (mp4/webm/mp3) o "synth:N" (pista DEMO generada en el navegador).

let audioCtx;
const ctx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
// Sin gesto del usuario, resume() puede quedarse esperando para siempre: se le da medio segundo.
const resumeCtx = () => Promise.race([ctx().resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);

/** Pista de demostración: melodía generativa + tarjeta animada. Contenido propio, sin derechos de terceros. */
class SynthTrack {
  constructor(item, host) {
    this.item = item;
    this.duration = item.durationSec || 30;
    this.seed = parseInt(String(item.playUrl).split(':')[1], 10) || 1;
    this.canvas = document.createElement('canvas');
    this.canvas.style.opacity = '0';
    host.appendChild(this.canvas);
    this.gain = ctx().createGain();
    this.gain.gain.value = 0;
    this.gain.connect(ctx().destination);
    this.pos = 0; this.playing = false; this.done = false; this.nextNote = 0; this.step = 0;
  }

  rand(i) { const x = Math.sin((this.seed * 9301 + i * 49297) % 233280) * 43758.5453; return x - Math.floor(x); }

  async play(fadeIn = 0.15) {
    if (ctx().state !== 'running') await resumeCtx();
    if (ctx().state !== 'running') throw Object.assign(new Error('audio bloqueado'), { blocked: true });
    this.playing = true;
    this.startedAt = ctx().currentTime - this.pos;
    this.nextNote = ctx().currentTime + 0.05;
    this.gain.gain.cancelScheduledValues(ctx().currentTime);
    this.gain.gain.setValueAtTime(this.gain.gain.value, ctx().currentTime);
    this.gain.gain.linearRampToValueAtTime(0.5, ctx().currentTime + fadeIn);
    this.canvas.style.transition = `opacity ${fadeIn}s`;
    this.canvas.style.opacity = '1';
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 100);
    this.draw();
  }

  tick() {
    if (!this.playing) return;
    this.pos = ctx().currentTime - this.startedAt;
    const scale = this.seed % 2 ? [0, 2, 3, 5, 7, 8, 10, 12] : [0, 2, 4, 5, 7, 9, 11, 12]; // menor / mayor
    const root = 196 * 2 ** ((this.seed % 5) / 12);
    const beat = 0.24 + (this.seed % 4) * 0.02;
    while (this.nextNote < ctx().currentTime + 0.4) {
      const t = this.nextNote; const i = this.step++;
      if (this.rand(i) > 0.25) this.note(root * 2 ** (scale[Math.floor(this.rand(i + 500) * scale.length)] / 12) * (i % 8 === 0 ? 2 : 1), t, beat * 0.9, 'triangle', 0.16);
      if (i % 4 === 0) this.note(root / 2 * 2 ** (scale[[0, 3, 4, 0][Math.floor(i / 8) % 4]] / 12), t, beat * 3.6, 'sine', 0.3);
      if (i % 2 === 1) this.note(6000 + this.rand(i) * 2000, t, 0.03, 'square', 0.02);
      this.nextNote += beat;
    }
    if (this.pos >= this.duration && !this.done) { this.done = true; this.onended?.(); }
    this.ontime?.(this.pos, this.duration);
  }

  note(freq, t, len, type, vol) {
    const o = ctx().createOscillator(); const g = ctx().createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(this.gain); o.start(t); o.stop(t + len + 0.02);
  }

  draw() {
    if (!this.canvas.isConnected) return;
    const c = this.canvas; const w = c.width = c.clientWidth; const hh = c.height = c.clientHeight;
    const g = c.getContext('2d'); const k = hh / 100; const t = this.pos;
    g.fillStyle = '#0a0908'; g.fillRect(0, 0, w, hh);
    // Discos concéntricos que laten con el pulso: etiqueta de botella vista de frente.
    for (let r = 0; r < 5; r++) {
      const pulse = 1 + 0.04 * Math.sin(t * 4 + r);
      g.beginPath(); g.arc(w / 2, hh * 0.42, (12 + r * 6) * k * pulse, 0, Math.PI * 2);
      g.strokeStyle = r % 2 ? '#b08d3e' : '#3a3122'; g.lineWidth = (r % 2 ? 0.35 : 0.2) * k; g.stroke();
    }
    g.textAlign = 'center'; g.fillStyle = '#efe3c8';
    g.font = `${6.2 * k}px "Alfa Slab One", Georgia, serif`;
    g.fillText(this.item.title.replace(' (DEMO)', ''), w / 2, hh * 0.44, w * 0.8);
    g.fillStyle = '#d6b56a'; g.font = `${3 * k}px Rye, Georgia, serif`;
    g.fillText('pista de demostración', w / 2, hh * 0.52);
    g.fillStyle = '#d9614a'; g.font = `600 ${2.6 * k}px Jost, sans-serif`;
    g.fillText('DEMO · contenido de prueba generado por el sistema', w / 2, hh * 0.9);
    g.fillStyle = '#3a3122'; g.fillRect(w * 0.2, hh * 0.8, w * 0.6, 0.6 * k);
    g.fillStyle = '#b08d3e'; g.fillRect(w * 0.2, hh * 0.8, w * 0.6 * Math.min(1, t / this.duration), 0.6 * k);
    if (this.playing) this.raf = requestAnimationFrame(() => this.draw());
  }

  pause() { this.playing = false; this.pos = ctx().currentTime - this.startedAt; this.gain.gain.setTargetAtTime(0, ctx().currentTime, 0.03); cancelAnimationFrame(this.raf); }
  fadeOutAndRemove(sec) {
    this.onended = null; this.ontime = null;
    this.gain.gain.cancelScheduledValues(ctx().currentTime);
    this.gain.gain.setValueAtTime(this.gain.gain.value, ctx().currentTime);
    this.gain.gain.linearRampToValueAtTime(0, ctx().currentTime + Math.max(0.05, sec));
    this.canvas.style.transition = `opacity ${Math.max(0.05, sec)}s`; this.canvas.style.opacity = '0';
    setTimeout(() => this.destroy(), Math.max(0.05, sec) * 1000 + 80);
  }
  destroy() { this.playing = false; clearInterval(this.timer); cancelAnimationFrame(this.raf); try { this.gain.disconnect(); } catch { /* ya desconectado */ } this.canvas.remove(); }
}

/** Archivo de video/audio con licencia, reproducido con <video>. */
class MediaTrack {
  constructor(item, host) {
    this.item = item;
    const v = this.el = document.createElement('video');
    v.src = item.playUrl; v.preload = 'auto'; v.playsInline = true; v.controls = true; v.volume = 0; v.style.opacity = '0';
    host.appendChild(v);
    v.addEventListener('ended', () => this.onended?.());
    v.addEventListener('timeupdate', () => this.ontime?.(v.currentTime, v.duration || item.durationSec || 0));
    v.addEventListener('error', () => this.onerror?.(`archivo-${v.error?.code || '?'}: no se pudo cargar el contenido`));
    v.addEventListener('waiting', () => this.onwaiting?.());
  }
  async play(fadeIn = 0.15) {
    try { await this.el.play(); } catch (e) {
      if (e.name === 'NotAllowedError') throw Object.assign(new Error('audio bloqueado'), { blocked: true });
      if (e.name !== 'AbortError') throw e;
    }
    this.el.style.transition = `opacity ${fadeIn}s`; this.el.style.opacity = '1';
    this.ramp(1, fadeIn);
  }
  ramp(to, sec) {
    clearInterval(this.rampTimer);
    const from = this.el.volume; const t0 = performance.now();
    this.rampTimer = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / (sec * 1000 || 1));
      this.el.volume = Math.max(0, Math.min(1, from + (to - from) * p));
      if (p >= 1) clearInterval(this.rampTimer);
    }, 40);
  }
  pause() { this.el.pause(); }
  fadeOutAndRemove(sec) {
    this.onended = this.ontime = this.onerror = null;
    const s = Math.max(0.05, sec);
    this.ramp(0, s); this.el.style.transition = `opacity ${s}s`; this.el.style.opacity = '0';
    setTimeout(() => this.destroy(), s * 1000 + 80);
  }
  destroy() { clearInterval(this.rampTimer); this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.el.remove(); }
}

export function createCatalogPlayer(host, h) {
  let cur = null; let started = false; let paused = false;

  return {
    kind: 'catalogo',
    async load(item, { crossfadeSec = 0 } = {}) {
      const prev = cur;
      // Si la anterior aún suena (se avisó su final antes para mezclar), se desvanece mientras entra la nueva.
      if (prev) prev.fadeOutAndRemove(crossfadeSec || 0.05);
      const track = cur = String(item.playUrl || '').startsWith('synth:') ? new SynthTrack(item, host) : new MediaTrack(item, host);
      started = false; paused = false;
      let endedSent = false;
      const end = () => { if (endedSent || cur !== track) return; endedSent = true; h.onEnded(item.id); };
      track.onended = () => { end(); if (cur === track) { cur = null; track.fadeOutAndRemove(0.05); } };
      track.ontime = (pos, total) => {
        if (!started && pos > 0.2) { started = true; h.onPlaying(item.id); h.onStatus('reproduciendo'); }
        // Crossfade: se anuncia el final N segundos antes; la pista sigue sonando hasta que la siguiente la releve.
        if (crossfadeSec > 0 && total > crossfadeSec * 3 && total - pos <= crossfadeSec) { track.tail = true; end(); }
      };
      track.onerror = (reason) => { if (cur === track) h.onError(item.id, { reason, network: !navigator.onLine, retriable: true }); };
      track.onwaiting = () => h.onStatus('cargando');
      h.onStatus('cargando');
      try { await track.play(prev && crossfadeSec ? crossfadeSec : 0.15); } catch (e) {
        if (e.blocked) return h.onBlocked();
        h.onError(item.id, { reason: e.message, network: !navigator.onLine, retriable: true });
      }
    },
    pause() { paused = true; cur?.pause(); h.onStatus('en pausa'); },
    resume() { if (cur) cur.play().then(() => { paused = false; h.onStatus('reproduciendo'); }, (e) => { if (e.blocked) h.onBlocked(); }); },
    stop() { if (cur?.tail) return; /* cola de un crossfade: termina sola */ cur?.fadeOutAndRemove(0.05); cur = null; },
    get paused() { return paused; },
  };
}

/** Desbloquea el audio dentro de un gesto del usuario ("Iniciar noche" / "Activar sonido"). */
export async function unlockAudio() {
  try { await resumeCtx(); } catch { /* sin Web Audio */ }
  return !audioCtx || audioCtx.state === 'running';
}
