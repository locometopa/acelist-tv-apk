// Reproductor de la versión web (y de reserva en la tele): pide al motor la versión HLS del canal
// y la reproduce con hls.js. Se recupera solo de los cortes de red y de los fallos del decodificador,
// y vigila que la imagen avance: si se queda parada, vuelve a cargar.

/* global Hls */

const VIGILA_MS = 2000;      // cada cuánto se mira si el vídeo avanza
const EMPUJON_MS = 8000;     // tiempo sin avanzar antes de saltar al directo (lo más suave)
const PARADO_MS = 20000;     // tiempo sin avanzar (sin estar en pausa) antes de recargar
const MAX_RECARGAS = 4;      // recargas seguidas antes de dar el enlace por perdido
const MAX_REABRIR = 3;       // veces que se vuelve a pedir el canal al servidor si la emisión se cierra

export class Player {
  constructor({ engine, onStats, onError, onClosed, onEstado = () => {}, onAviso = () => {} }) {
    this.engine = engine;
    this.onStats = onStats;
    this.onError = onError;
    this.onClosed = onClosed;
    this.onEstado = onEstado;   // { cargando: bool, texto }
    this.onAviso = onAviso;     // avisos que no paran la reproducción (p. ej. audio no compatible)
    this.video = document.getElementById('video');
    this.session = null;
    this.hls = null;
    this.timer = null;
    this.vigia = null;
    this.token = 0;
    this.url = '';
    this.enlaceExterno = '';
    this.usarAac = false;   // en la web servida por el servidor de casa: sonido convertido a AAC allí
    this.calidad = 'original';   // 'baja' = el servidor reduce la imagen a 720p (para ver desde fuera de casa)
    this.reaperturas = 0;
    this.escuchar();
  }

  // Estado de carga para la interfaz, a partir de los eventos del <video>
  escuchar() {
    const v = this.video;
    const cargando = (texto) => () => { if (this.url) this.onEstado({ cargando: true, texto }); };
    v.addEventListener('waiting', cargando('Cargando…'));
    v.addEventListener('playing', () => { this.recargas = 0; this.onEstado({ cargando: false }); });
    v.addEventListener('canplay', () => { if (!v.paused) this.onEstado({ cargando: false }); });
    // Si la imagen avanza, ya no está cargando (algunos navegadores no avisan con «playing» tras un corte)
    let antes = 0;
    v.addEventListener('timeupdate', () => {
      if (this.url && v.currentTime > antes + 0.5) { antes = v.currentTime; this.onEstado({ cargando: false }); }
      if (v.currentTime < antes) antes = v.currentTime;
    });
  }

  async play(channel, reabriendo = false) {
    await this.close(false);
    if (!reabriendo) this.reaperturas = 0;
    const token = ++this.token;
    this.channel = channel;
    this.recargas = 0;
    this.onEstado({ cargando: true, texto: channel.url ? 'Abriendo el canal…' : 'Pidiendo el canal al motor…' });
    let url;
    if (channel.url) {
      // Canal de TV normal (HLS): se reproduce directamente
      url = channel.url;
      this.enlaceExterno = channel.url;
      this.onStats({ status: 'dl', peers: null, speedDown: null, abierto: true });
    } else {
      let session = null;
      if (this.usarAac) session = await this.abrirAac(channel);
      if (token !== this.token) { if (session) this.cerrarSesion(session); return; }
      if (!session) {
        try {
          session = await this.engine.start(channel.id, { kind: channel.kind, manifest: true });
        } catch (e) {
          if (token === this.token) this.onError(e.message || String(e));
          return;
        }
      }
      if (token !== this.token) { this.cerrarSesion(session); return; }
      this.session = session;
      url = session.playbackUrl;
      // Para abrirlo en VLC u otro programa: el stream directo del motor (absoluto, que se pueda copiar)
      try { this.enlaceExterno = new URL(this.engine.url('ace/getstream', { [session.kind === 'infohash' ? 'infohash' : 'id']: channel.id }), location.href).href; } catch { this.enlaceExterno = ''; }
      this.onEstado({ cargando: true, texto: 'Conectando con los peers…' });
    }
    this.url = url;
    this.cargar(token);
    if (this.session) this.poll(token);
    this.vigilar(token);
  }

  // Pide al servidor de casa el canal con el sonido pasado a AAC. Si no puede (sin ffmpeg, error), null: se usa el motor directo
  async abrirAac(channel) {
    try {
      const q = new URLSearchParams({ id: channel.id });
      if (this.calidad === 'baja') q.set('calidad', 'baja');
      if (channel.kind) q.set('kind', channel.kind);
      const r = await fetch(`/aac/abrir?${q}`);
      if (r.status === 404) {
        const e = await r.json().catch(() => ({}));
        throw Object.assign(new Error(e.error || 'El motor no encuentra este canal'), { definitivo: true });
      }
      if (!r.ok) return null;
      const d = await r.json();
      this.onEstado({ cargando: true, texto: 'Preparando el sonido para el navegador…' });
      return { aac: true, sid: d.sid, kind: d.kind, playbackUrl: new URL(d.lista, location.href).href,
        statUrl: d.statUrl ? this.engine.rebase(d.statUrl) : null, commandUrl: null };
    } catch (e) {
      if (e.definitivo) { this.onError(e.message); this.token++; }
      return null;
    }
  }

  cerrarSesion(s) {
    if (!s) return null;
    if (s.aac) return fetch(`/aac/${s.sid}/cerrar`).catch(() => {});
    return this.engine.stop(s);
  }

  cargar(token) {
    const v = this.video;
    const url = this.url;
    // Siempre hls.js donde funcione. Chrome y Edge nuevos dicen que saben abrir HLS ellos solos, pero con las
    // emisiones del motor fallan («no puede abrir este stream»); el modo nativo queda solo para iPhone/iPad.
    const useHlsJs = typeof Hls !== 'undefined' && Hls.isSupported();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (useHlsJs) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // En directo: unos segundos de margen, sin acumular minutos de retraso
        // Colchón generoso: va unos 16 s por detrás del directo a cambio de aguantar los baches del P2P
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 14,
        maxBufferLength: 40,
        maxMaxBufferLength: 90,
        maxBufferHole: 1,
        nudgeMaxRetry: 10,
        highBufferWatchdogPeriod: 3,
        fragLoadingTimeOut: 30000,
        backBufferLength: 30,
        manifestLoadingTimeOut: 40000,   // el servidor espera a tener los primeros trozos antes de contestar
        manifestLoadingMaxRetry: 15,
        manifestLoadingRetryDelay: 2000,
        levelLoadingMaxRetry: 15,
        fragLoadingMaxRetry: 10,
        fragLoadingRetryDelay: 1000,
      });
      this.hls = hls;
      let redes = 0;
      let medios = 0;
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (token !== this.token) return;
        if (!data.fatal) {
          if (data.details === 'bufferAddCodecError' || data.details === 'bufferIncompatibleCodecsError') {
            this.onAviso('El audio de este canal no lo entiende el navegador. Prueba otro enlace o ábrelo en VLC.');
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && redes < 6) {
          // Corte de red o del motor: se vuelve a pedir en un momento
          redes++;
          this.onEstado({ cargando: true, texto: `Reconectando… (${redes})` });
          setTimeout(() => { if (token === this.token && this.hls === hls) hls.startLoad(); }, 1500 * redes);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && medios < 2) {
          // Fallo al decodificar: primero se recupera; si vuelve a fallar, se prueba cambiando el códec de audio
          medios++;
          this.onEstado({ cargando: true, texto: 'Recuperando la imagen…' });
          if (medios === 2) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        }
        // La emisión se cerró en el servidor (o el canal se cortó): se pide de nuevo antes de rendirse
        if (this.session && this.session.aac && this.reaperturas < MAX_REABRIR) {
          this.reaperturas++;
          this.onEstado({ cargando: true, texto: `El canal se ha cortado: volviendo a abrirlo (${this.reaperturas}/${MAX_REABRIR})…` });
          this.play(this.channel, true);
          return;
        }
        this.onError(`No se pudo reproducir el stream (${data.details})`);
      });
      hls.on(Hls.Events.FRAG_LOADED, () => { redes = 0; });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { medios = 0; });
      hls.on(Hls.Events.BUFFER_CODECS, (_ev, data) => {
        const a = data && data.audio;
        if (a && a.codec && window.MediaSource && !MediaSource.isTypeSupported(`audio/mp4; codecs="${a.codec}"`)) {
          this.onAviso('Este canal trae un audio que el navegador no puede reproducir (sin sonido). Prueba otro enlace o ábrelo en VLC.');
        }
      });
      hls.loadSource(url);
      hls.attachMedia(v);
    } else {
      v.src = url;
    }
    v.onerror = () => {
      if (token === this.token && !this.hls && v.error) this.onError('El navegador no puede abrir este stream');
    };
    v.play().catch(() => { /* empezará cuando haya datos (o al pulsar ▶ si el navegador pide un clic) */ });
  }

  // Si el vídeo no avanza (sin estar en pausa) se recarga; tras varias recargas se avisa como error
  vigilar(token) {
    clearInterval(this.vigia);
    let ultimo = -1;
    let desde = Date.now();
    let empujado = false;
    this.vigia = setInterval(() => {
      if (token !== this.token) { clearInterval(this.vigia); return; }
      const v = this.video;
      if (v.paused || document.hidden) { desde = Date.now(); return; }
      if (v.currentTime !== ultimo) { ultimo = v.currentTime; desde = Date.now(); empujado = false; return; }
      const parado = Date.now() - desde;
      // Primero, lo suave: saltar al punto del directo que ya está descargado (arregla huecos y saltos de tiempo)
      if (parado > EMPUJON_MS && !empujado && this.hls) {
        empujado = true;
        const b = v.buffered;
        const destino = b.length && b.end(b.length - 1) - v.currentTime > 1 ? Math.max(b.start(b.length - 1), b.end(b.length - 1) - 8) : this.hls.liveSyncPosition;
        if (destino && Math.abs(destino - v.currentTime) > 0.5) { this.onEstado({ cargando: true, texto: 'Saltando al directo…' }); v.currentTime = destino; }
        this.hls.startLoad();
        v.play().catch(() => {});
        return;
      }
      if (parado < PARADO_MS) return;
      empujado = false;
      desde = Date.now();
      if (this.recargas >= MAX_RECARGAS) { this.onError('El canal se ha quedado parado'); clearInterval(this.vigia); return; }
      this.recargas++;
      this.onEstado({ cargando: true, texto: `La imagen se ha parado: recargando (${this.recargas}/${MAX_RECARGAS})…` });
      this.cargar(token);
    }, VIGILA_MS);
  }

  reintentar() {
    if (this.channel) return this.play(this.channel);
    return null;
  }

  async poll(token) {
    clearTimeout(this.timer);
    if (token !== this.token || !this.session || !this.session.statUrl) return;
    try {
      const s = await this.engine.stats(this.session);
      if (token === this.token) this.onStats(s);
    } catch {
      /* se reintenta en el siguiente ciclo */
    }
    this.timer = setTimeout(() => this.poll(token), 3000);
  }

  async close(notify = true) {
    this.token++;
    clearTimeout(this.timer);
    clearInterval(this.vigia);
    this.url = '';
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    const s = this.session;
    this.session = null;
    if (s) await this.cerrarSesion(s);
    if (notify) this.onClosed();
  }
}
