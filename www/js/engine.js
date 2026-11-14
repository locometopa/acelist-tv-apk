// Cliente del motor de Ace Stream (misma API HTTP que usa AceList).
// En la APK el motor está en la propia tele (http://127.0.0.1:6878);
// en la versión web se llega a él a través del servidor local (/engine).

export class EngineError extends Error {}
export class EngineUnavailableError extends EngineError {}
export class ContentNotFoundError extends EngineError {}

const NOT_FOUND = 'failed to load content';
const CONTENT_ID = /^[0-9a-f]{40}$/i;

export function parseContentId(value) {
  let v = String(value ?? '').trim();
  if (v.toLowerCase().startsWith('acestream://')) v = v.slice(12);
  if (!CONTENT_ID.test(v)) return null;
  return v.toLowerCase();
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  constructor(baseUrl, { timeout = 15000 } = {}) {
    this.base = String(baseUrl || '').replace(/\/+$/, '');
    this.timeout = timeout;
  }

  url(path, params) {
    const u = new URL(this.base + '/' + path.replace(/^\/+/, ''), location.href);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  // Las URL que devuelve el motor apuntan a 127.0.0.1:6878; se reescriben
  // para que vayan siempre por la dirección configurada.
  rebase(engineUrl) {
    const u = new URL(engineUrl);
    return this.url(u.pathname + u.search);
  }

  async getJson(url, timeout = this.timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      if (ctrl.signal.aborted) throw new EngineError('El motor no respondió a tiempo');
      throw new EngineUnavailableError('No se puede contactar con el motor de Ace Stream');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 502 || res.status === 504) {
      throw new EngineUnavailableError('No se puede contactar con el motor de Ace Stream');
    }
    if (!res.ok) throw new EngineError(`Respuesta HTTP ${res.status} del motor`);
    try {
      return await res.json();
    } catch {
      throw new EngineError('El motor devolvió una respuesta no válida');
    }
  }

  async version() {
    const data = await this.getJson(this.url('webui/api/service', { method: 'get_version' }), 5000);
    if (data.error || !data.result) throw new EngineError(String(data.error || 'Respuesta inesperada'));
    return data.result; // {version, code, platform}
  }

  // Abre una sesión. `manifest` pide la versión HLS (para reproducir en la app).
  // Prueba el identificador como Content ID y como infohash, igual que AceList.
  async start(contentId, { kind = null, manifest = false } = {}) {
    const kinds = kind === 'infohash' ? ['infohash', 'content_id'] : ['content_id', 'infohash'];
    const path = manifest ? 'ace/manifest.m3u8' : 'ace/getstream';
    for (const k of kinds) {
      const params = { format: 'json', pid: uuid() };
      params[k === 'infohash' ? 'infohash' : 'id'] = contentId;
      let data;
      try {
        data = await this.getJson(this.url(path, params), k === 'infohash' ? 40000 : this.timeout);
      } catch (e) {
        if (k === 'infohash' && !(e instanceof EngineUnavailableError)) continue;
        throw e;
      }
      if (data.error === NOT_FOUND) continue;
      if (data.error) throw new EngineError(`Error del motor: ${data.error}`);
      const r = data.response;
      if (!r || !r.playback_url || !r.stat_url || !r.command_url) {
        throw new EngineError('Respuesta inesperada del motor');
      }
      return {
        contentId,
        kind: k,
        infohash: r.infohash || null,
        playbackUrl: this.rebase(r.playback_url),
        statUrl: this.rebase(r.stat_url),
        commandUrl: this.rebase(r.command_url),
      };
    }
    throw new ContentNotFoundError(contentId);
  }

  async stats(session) {
    const data = await this.getJson(session.statUrl);
    if (data.error) throw new EngineError(`Error del motor: ${data.error}`);
    const r = data.response || {};
    return {
      status: r.status || 'idle',
      peers: r.peers ?? null,
      speedDown: r.speed_down ?? null,
      downloaded: r.downloaded ?? null,
    };
  }

  async stop(session) {
    try {
      const u = new URL(session.commandUrl);
      u.searchParams.set('method', 'stop');
      await this.getJson(u.toString(), 5000);
    } catch {
      /* una parada fallida no debe tapar otros errores */
    }
  }

  // Verificación igual que AceList: vivo cuando el motor llega a "dl",
  // ha descargado datos y tiene al menos `minPeers` peers.
  async verify(contentId, { kind = null, minPeers = 1, timeout = 20000, poll = 2000, signal } = {}) {
    let session;
    try {
      session = await this.start(contentId, { kind });
    } catch (e) {
      if (e instanceof ContentNotFoundError) return { status: 'not_found' };
      if (e instanceof EngineUnavailableError) throw e;
      return { status: 'error', error: e.message };
    }
    let maxPeers = null;
    let last = null;
    const t0 = Date.now();
    // Resumen de lo que vio el motor, para saber por qué un canal no se da por vivo
    const diag = () => last && `${last.status}${last.peers != null ? ` · ${last.peers} peers` : ''}`
      + `${last.downloaded != null ? ` · ${Math.round(last.downloaded / 1024)} KB` : ' · sin dato de descarga'}`
      + ` · ${Math.round((Date.now() - t0) / 1000)} s`;
    try {
      const deadline = Date.now() + timeout;
      let fallos = 0;
      for (;;) {
        if (signal?.aborted) return { status: 'cancelled' };
        try {
          last = await this.stats(session);
          fallos = 0;
        } catch (e) {
          // Un fallo suelto al consultar no invalida el canal: se reintenta
          if (++fallos > 2) throw e;
          await sleep(poll);
          continue;
        }
        if (last.peers != null) maxPeers = Math.max(maxPeers ?? 0, last.peers);
        // Vivo: el motor descarga datos con peers suficientes. Algunos motores (Android)
        // no informan de lo descargado: entonces basta con estar en «dl» con peers.
        const descarga = last.downloaded == null ? (last.speedDown || 0) > 0 || last.status === 'dl' : last.downloaded > 0;
        if (last.status === 'dl' && descarga && (last.peers || 0) >= minPeers) {
          return { status: 'alive', peers: maxPeers, speed: last.speedDown, kind: session.kind, diag: diag() };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { status: 'no_peers', peers: maxPeers, speed: last.speedDown, kind: session.kind, diag: diag() };
        }
        await sleep(Math.min(poll, remaining));
      }
    } catch (e) {
      if (e instanceof EngineUnavailableError) throw e;
      return { status: 'error', error: e.message, peers: maxPeers, diag: diag() };
    } finally {
      await this.stop(session);
    }
  }
}
