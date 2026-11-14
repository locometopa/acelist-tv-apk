import { aplicarReglas } from './reglas.js';
// Datos de la app guardados en el propio dispositivo (localStorage).

const KEY = 'acelist-tv:v1';

// Fuentes que vienen con la app (desactivadas de serie)
export const FUENTES_INCLUIDAS = [
  {
    id: 'tdtchannels',
    name: 'TDTChannels · TV en abierto',
    url: 'https://www.tdtchannels.com/lists/tv.m3u8',
    nota: 'Canales de TDT españoles en abierto, 100 % legales y gratuitos (github.com/LaQuay/TDTChannels).',
    builtin: true,
    enabled: false,
  },
];

// Nombres limpios: «La_Liga__HD» → «La Liga HD»
export function limpiarTitulo(t) {
  return String(t || '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Clave para juntar categorías que solo cambian en mayúsculas, acentos o espacios («LA LIGA» = «LaLiga»)
export function claveCat(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PEQUENAS = new Set(['la', 'el', 'los', 'las', 'de', 'del', 'y', 'en', 'al']);
const SIGLAS = new Set(['DAZN', 'RFEF', 'TDT', 'UFC', 'NBA', 'NFL', 'MLB', 'NHL', 'ATP', 'WTA', 'F1', 'ESPN', 'HBO', 'TNT', 'TV',
  'INT', 'HD', 'FHD', 'UHD', 'BT', 'TVE', 'UK', 'USA', 'EEUU', 'PPV', 'LFP', 'ACB', 'UEFA', 'FIFA', 'MMA', 'WWE', 'NCAA', 'M+']);
// «LA LIGA» → «La Liga», «MOVISTAR DEPORTES» → «Movistar Deportes»; las siglas se quedan («DAZN», «Futbol INT», «1RFEF»)
export function categoriaBonita(t) {
  const s = limpiarTitulo(t);
  if (!s || s !== s.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]{3}/.test(s)) return s;
  return s.split(' ').map((w, i) => {
    const l = w.toLowerCase();
    if (SIGLAS.has(w) || /\d/.test(w) || !/[AEIOUÁÉÍÓÚ]/.test(w)) return w;
    if (PEQUENAS.has(l) && i) return l;
    return l.charAt(0).toUpperCase() + l.slice(1);
  }).join(' ');
}

function idFuente(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `f-${h.toString(16)}`;
}
const MAX_CHECKS = 10;

export const STATUS = {
  alive: { label: 'Vivo', cls: 'ok' },
  no_peers: { label: 'Sin peers', cls: 'warn' },
  not_found: { label: 'No encontrado', cls: 'bad' },
  error: { label: 'Error', cls: 'bad' },
  pending: { label: 'Sin comprobar', cls: 'none' },
};

export function defaultSettings(native) {
  return {
    engineUrl: native ? 'http://127.0.0.1:6878' : '/engine',
    orden: 'recomendado',
    preComprobar: 'marcados',
    urlActualizaciones: 'https://raw.githubusercontent.com/locometopa/acelist-tv-apk/main/',
    logos: true,
    servidorCasa: '',
    sincronizar: true,
    sincroLigero: true,   // la tele no guarda los canales de listas apagadas (el servidor los conserva y los devuelve al encender la lista)
    tvPorVpn: true, // canales IPTV/HLS por la pasarela VPN del servidor de casa (si la VPN está activa)
    minPeers: 1,
    timeoutSec: native ? 30 : 20,   // el motor de la tele es más lento que el del PC
    concurrency: native ? 1 : 2,
    retryFailed: true,              // segunda pasada para los que fallen
    autoVerify: false,
    autoVerifyHours: 12,
    hideDead: false,
    diseno: 'auto',        // 'auto' | 'tele' | 'movil' (pantalla táctil)
    filasCategorias: true, // filas por categoría en Inicio
    inicioLista: false,    // Inicio en modo lista (filas compactas) en vez de tarjetas
    formatoStream: 'ts',   // cómo pide el reproductor interno el canal al motor: 'ts' o 'hls'
    intro: true,           // vídeo de entrada si el servidor de casa tiene uno
    view: 'list',          // 'list' | 'grid'
    player: 'interno',     // 'interno' | 'aceplayer' | 'aceserve' | 'vlc' | 'elegir'
    okAction: native ? 'ficha' : 'reproducir',     // 'ficha' | 'reproducir'
    refreshSources: false, // actualizar las fuentes guardadas al abrir la app
    movilActivo: false,    // panel del móvil encendido
    movilPuerto: 8095,
    movilToken: '',
    agendaFuente: 'deportes', // 'deportes' | 'futbol' | 'marca'
    agendaMapa: {},           // nombre de canal en la agenda -> [ids de mis canales]
    agrupar: true,            // juntar en una fila los enlaces del mismo canal
  };
}

export class Store {
  constructor(native) {
    this.native = native;
    this.data = { channels: [], sources: [], settings: defaultSettings(native), vistos: [], recordatorios: [] };
    this.listeners = new Set();
    this.version = 0;   // sube con cada cambio que puede afectar a las listas de canales (para guardar resultados ya calculados)
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data.channels = Array.isArray(parsed.channels) ? parsed.channels : [];
        this.data.sources = Array.isArray(parsed.sources) ? parsed.sources : [];
        this.data.vistos = Array.isArray(parsed.vistos) ? parsed.vistos : [];
        this.data.recordatorios = Array.isArray(parsed.recordatorios) ? parsed.recordatorios : [];
        this.data.avisosQuitados = Array.isArray(parsed.avisosQuitados) ? parsed.avisosQuitados : [];
        this.data.settings = { ...defaultSettings(native), ...(parsed.settings || {}) };
        // 0.5.1: en la tele, valores más pacientes salvo que se hayan cambiado a mano
        if (native && !this.data.settings.ajustes051) {
          if (this.data.settings.timeoutSec === 20) this.data.settings.timeoutSec = 30;
          if (this.data.settings.concurrency === 2) this.data.settings.concurrency = 1;
        }
        this.data.settings.ajustes051 = true;
      }
    } catch {
      /* datos dañados o almacenamiento no disponible: se empieza de cero */
    }
    // Fuentes antiguas sin id ni interruptor, y las incluidas que falten
    for (const f of this.data.sources) {
      if (!f.id) f.id = idFuente(f.url || f.name);
      if (f.enabled === undefined) f.enabled = true;
    }
    // 0.9: un canal puede estar en varias listas (antes: una sola «source»)
    for (const c of this.data.channels) {
      if (!Array.isArray(c.listas)) c.listas = c.source ? [c.source] : [];
      delete c.source;
    }
    for (const inc of FUENTES_INCLUIDAS) {
      const f = this.data.sources.find((x) => x.id === inc.id);
      if (!f) this.data.sources.push({ ...inc, fetchedAt: null, count: null });
      else Object.assign(f, { name: inc.name, url: inc.url, nota: inc.nota, builtin: true });
    }
    // 0.8: nombres y categorías sin guiones bajos
    if (!this.data.settings.nombres08) {
      for (const c of this.data.channels) {
        c.title = limpiarTitulo(c.title) || c.title;
        if (c.category) c.category = limpiarTitulo(c.category) || null;
      }
      this.data.settings.nombres08 = true;
    }
    // 0.14: actualizaciones automáticas desde el repositorio público de la APK (si no se puso otra dirección)
    // 0.42 (web): un clic en un canal lo reproduce en la página (antes abría la ficha con opciones de la tele)
    if (!native && !this.data.settings.web042) { this.data.settings.okAction = 'reproducir'; this.data.settings.player = 'interno'; this.data.settings.web042 = true; }
    // 0.37: preparar partidos pasa de Sí/No a solo marcados / todos / no
    { const v = this.data.settings.preComprobar; if (v === true) this.data.settings.preComprobar = 'marcados'; else if (v === false) this.data.settings.preComprobar = 'no'; }
    if (!this.data.settings.upd14) {
      if (!this.data.settings.urlActualizaciones) this.data.settings.urlActualizaciones = defaultSettings(native).urlActualizaciones;
      this.data.settings.upd14 = true;
    }
    // 0.12: categorías repetidas juntadas («MOTOR» y «Motor»)
    if (!this.data.settings.cats12) {
      this.unificarCategorias();
      this.data.settings.cats12 = true;
    }
    this._activos = null;
  }

  // Junta categorías con la misma clave; se queda con la que no esté toda en mayúsculas
  unificarCategorias() {
    const elegida = new Map();
    for (const c of this.data.channels) {
      if (!c.category) continue;
      const k = claveCat(c.category);
      const prev = elegida.get(k);
      const esMayus = c.category === c.category.toUpperCase();
      if (!prev || (prev === prev.toUpperCase() && !esMayus)) elegida.set(k, esMayus ? (prev && prev !== prev.toUpperCase() ? prev : categoriaBonita(c.category)) : c.category);
    }
    let n = 0;
    for (const c of this.data.channels) {
      if (!c.category) continue;
      const nueva = elegida.get(claveCat(c.category));
      if (nueva && nueva !== c.category) { c.category = nueva; n++; }
    }
    return n;
  }

  // Categoría con la que entra un canal nuevo: la que ya exista con la misma clave, o la nueva más legible
  categoriaDe(cat) {
    const s = limpiarTitulo(cat);
    if (!s) return null;
    const k = claveCat(s);
    if (!this._mapaCats) {
      this._mapaCats = new Map();
      for (const c of this.data.channels) if (c.category && !this._mapaCats.has(claveCat(c.category))) this._mapaCats.set(claveCat(c.category), c.category);
    }
    if (!this._mapaCats.has(k)) this._mapaCats.set(k, categoriaBonita(s));
    return this._mapaCats.get(k);
  }

  // Canales visibles: los que no vienen de una fuente desactivada
  get channels() {
    if (!this._activos) {
      const ocultas = new Set((this.data.settings.catOcultas || []).map(claveCat));
      this._activos = ocultas.size ? this.channelsConOcultas.filter((c) => !c.category || !ocultas.has(claveCat(c.category))) : this.channelsConOcultas;
    }
    return this._activos;
  }

  // Visibles por listas (si no está en ninguna lista, si alguna de sus listas está activa o si es favorito), con las categorías ocultas
  get channelsConOcultas() {
    if (!this._porListas) {
      const off = new Set(this.data.sources.filter((f) => f.enabled === false).map((f) => f.id));
      // Fuera también los ocultos (a mano o por una regla de las listas)
      this._porListas = this.data.channels.filter((c) => !c.oculto && (!off.size || c.favorite || !c.listas.length || c.listas.some((id) => !off.has(id))));
    }
    return this._porListas;
  }
  // Para buscar: también los de listas apagadas (los ocultos a mano y las categorías ocultas siguen fuera)
  get channelsBusqueda() {
    if (!this._busqueda) {
      const ocultas = new Set((this.data.settings.catOcultas || []).map(claveCat));
      this._busqueda = this.data.channels.filter((c) => !c.oculto && (!c.category || !ocultas.has(claveCat(c.category))));
    }
    return this._busqueda;
  }
  get allChannels() { return this.data.channels; }
  get sources() { return this.data.sources; }
  get settings() { return this.data.settings; }

  // sinAviso: cambios que no tocan los canales (p. ej. «últimos vistos»): se guardan sin repintar nada
  save(sinAviso = false) {
    if (sinAviso) {
      clearTimeout(this._tEscribir);
      this._tEscribir = setTimeout(() => this.escribir(), 400);
      return;
    }
    this.version++;
    this._activos = null;
    this._porListas = null;
    this._busqueda = null;
    this._mapaCats = null;
    // Escribir todos los canales cuesta: se juntan los cambios seguidos (p. ej. al comprobar muchos canales)
    // en una sola escritura. Al salir de la app o esconderla se escribe al momento.
    clearTimeout(this._tEscribir);
    this._tEscribir = setTimeout(() => this.escribir(), 1500);
    for (const fn of this.listeners) fn();
  }

  escribir() {
    clearTimeout(this._tEscribir);
    this._tEscribir = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* sin espacio o sin almacenamiento */
    }
  }

  // Si hay algo pendiente de escribir, se escribe ya
  escribirPendiente() { if (this._tEscribir) this.escribir(); }

  onChange(fn) { this.listeners.add(fn); }

  // Búsqueda por id con un índice (antes recorría todos los canales cada vez); se rehace si cambia la lista de canales
  find(id) {
    const arr = this.data.channels;
    if (!this._idx || this._idxArr !== arr || this._idxN !== arr.length || this._idxVer !== this.version) {
      this._idx = new Map();
      for (const c of arr) this._idx.set(c.id, c);
      this._idxArr = arr; this._idxN = arr.length; this._idxVer = this.version;
    }
    const c = this._idx.get(id);
    return c && c.id === id ? c : arr.find((x) => x.id === id);
  }

  // Añade los canales que aún no están; devuelve cuántos se crearon y cuántos se repetían.
  addChannels(entries, lista = null) {
    let created = 0;
    let repeated = 0;
    const byId = new Map(this.data.channels.map((c) => [c.id, c]));
    for (const e of entries) {
      const prev = byId.get(e.id);
      if (prev) {
        repeated++;
        if (e.logo && !prev.logo) prev.logo = e.logo;
        if (e.epgId && !prev.epgId) prev.epgId = e.epgId;
        if (lista && !prev.listas.includes(lista)) prev.listas.push(lista);
        continue;
      }
      const ch = {
        id: e.id,
        url: e.url || null,
        alts: Array.isArray(e.alts) && e.alts.length ? e.alts : undefined,
        logo: e.logo || null,
        epgId: e.epgId || null,
        listas: lista ? [lista] : [],
        title: limpiarTitulo(e.title).slice(0, 200) || `Canal ${e.id.replace(/^url-/, '').slice(0, 8)}`,
        titlePending: !limpiarTitulo(e.title),
        category: this.categoriaDe(e.category),
        language: e.language || null,
        country: e.country || null,
        resolution: e.resolution || null,
        createdAt: e.createdAt || new Date().toISOString(),
        kind: null,
        favorite: false,
        checks: [],
      };
      this.data.channels.push(ch);
      byId.set(ch.id, ch);
      created++;
    }
    this.aplicarReglas(false);
    this.save();
    return { created, repeated };
  }

  updateChannel(id, patch) {
    const c = this.find(id);
    if (!c) return;
    if (typeof patch.title === 'string') patch.title = limpiarTitulo(patch.title) || c.title;
    if (typeof patch.category === 'string') patch.category = limpiarTitulo(patch.category) || null;
    Object.assign(c, patch);
    // Lo editado a mano pasa a ser el original sobre el que actúan las reglas
    if ('title' in patch || 'category' in patch) delete c.orig;
    this.save();
  }

  // Reglas de las listas (se editan en el panel del servidor y llegan con la sincronización)
  aplicarReglas(guardar = true) {
    const n = aplicarReglas(this.data.channels, this.data.settings.reglas, (v) => this.categoriaDe(v));
    if (n && guardar) this.save();
    return n;
  }

  removeChannel(id) {
    this.data.channels = this.data.channels.filter((c) => c.id !== id);
    this.save();
  }

  addCheck(id, result) {
    const c = this.find(id);
    if (!c) return;
    c.checks.unshift({
      at: new Date().toISOString(),
      status: result.status,
      peers: result.peers ?? null,
      speed: result.speed ?? null,
      error: result.error || null,
      diag: result.diag || null,
    });
    c.checks.length = Math.min(c.checks.length, MAX_CHECKS);
    if (result.kind) c.kind = result.kind;
    this.save();
  }

  setSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
  }

  saveSource(name, url) {
    let s = this.data.sources.find((x) => x.url === url);
    if (s) s.name = name || s.name;
    else {
      s = { id: idFuente(url), name: name || url, url, fetchedAt: null, count: null, enabled: true };
      this.data.sources.push(s);
    }
    this.save();
    return s;
  }

  // Lista sin dirección (archivo, texto pegado…). Si ya hay una con ese nombre, se reutiliza.
  localList(name) {
    const nombre = limpiarTitulo(name) || 'Mi lista';
    let s = this.data.sources.find((x) => !x.url && x.name.toLowerCase() === nombre.toLowerCase());
    if (!s) {
      s = { id: `l-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: nombre, url: null, local: true, enabled: true, fetchedAt: new Date().toISOString() };
      this.data.sources.push(s);
      this.save();
    }
    return s;
  }

  renameSource(id, name) {
    const s = this.source(id);
    const nombre = limpiarTitulo(name);
    if (s && nombre && !s.builtin) { s.name = nombre; this.save(); }
  }

  channelsOf(id) {
    return this.data.channels.filter((c) => c.listas.includes(id));
  }

  source(idOrUrl) {
    return this.data.sources.find((x) => x.id === idOrUrl || x.url === idOrUrl);
  }

  setSourceEnabled(id, enabled) {
    const s = this.source(id);
    if (s) { s.enabled = !!enabled; this.save(); }
  }

  // Quitar una lista (las incluidas solo se desactivan). Con borrarCanales, se borran también
  // los canales que solo estaban en esa lista; si no, se quedan sueltos.
  removeSource(idOrUrl, { borrarCanales = false } = {}) {
    const s = this.source(idOrUrl);
    if (!s) return;
    if (s.builtin) {
      s.enabled = false;
      if (borrarCanales) this.data.channels = this.data.channels.filter((c) => !(c.listas.length === 1 && c.listas[0] === s.id));
      this.save();
      return;
    }
    if (borrarCanales) this.data.channels = this.data.channels.filter((c) => !(c.listas.length === 1 && c.listas[0] === s.id));
    for (const c of this.data.channels) c.listas = c.listas.filter((id) => id !== s.id);
    this.data.sources = this.data.sources.filter((x) => x !== s);
    this.save();
  }

  categories() {
    const set = new Set();
    for (const c of this.data.channels) if (c.category) set.add(c.category);
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }

  // Exporta en el mismo formato que AceList, para poder llevarlo de vuelta.
  exportJson() {
    return JSON.stringify({
      format: 'acelist',
      version: 1,
      exported_at: new Date().toISOString(),
      channels: this.channels.map((c) => ({
        title: c.title,
        title_pending: !!c.titlePending,
        ...(c.url ? { url: c.url } : { content_id: c.id, link: `acestream://${c.id}` }),
        logo: c.logo || null,
        category: c.category,
        language: c.language,
        country: c.country,
        resolution: c.resolution,
        created_at: c.createdAt,
      })),
    }, null, 2);
  }
}

export function lastCheck(channel) {
  return channel.checks && channel.checks[0];
}

export function statusOf(channel) {
  return lastCheck(channel)?.status || 'pending';
}
