import { Engine, EngineUnavailableError, parseContentId } from './engine.js';
import { Store, STATUS, statusOf, lastCheck, limpiarTitulo, defaultSettings, claveCat } from './store.js';
import { parseText, toM3U } from './importer.js';
import { installNav, focusFirst, focusEl, activeLayer, modoTactil } from './nav.js';
import { Player } from './player.js';
import { Puente, newToken } from './puente.js';
import { crearAgenda, claveCanal } from './agenda.js';
import { calidad } from './reglas.js';
import { crearGuia } from './guia.js';

const VERSION = '0.57.0';
const cap = window.Capacitor;
const NATIVE = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
// Plugins nativos (solo existen en la APK)
const plugins = NATIVE
  ? { App: cap.registerPlugin('App'), Nativo: cap.registerPlugin('AceListNativo') }
  : {};

const store = new Store(NATIVE);
// Lo pendiente de guardar se escribe antes de que la app se esconda o se cierre
document.addEventListener('visibilitychange', () => { if (document.hidden) store.escribirPendiente(); });
window.addEventListener('pagehide', () => store.escribirPendiente());
let engine;
const $ = (sel, root = document) => root.querySelector(sel);

// Diseño de móvil (pantalla vertical y táctil) o de tele (mando). Automático salvo que se elija en Ajustes.
function pareceMovil() {
  const ua = navigator.userAgent || '';
  if (/AFT\w|Android TV|GoogleTV|BRAVIA|SMART-TV|SmartTV|;\s*TV\b/i.test(ua)) return false;
  const tactil = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  return !!tactil && (/Mobile|iPhone/i.test(ua) || Math.min(screen.width, screen.height) < 600);
}
// El diseño de móvil solo en pantallas táctiles: en una tele con mando no se podría volver a los menús
const TACTIL = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints || 0) > 0;
const MOVIL = (store.settings.diseno === 'movil' && TACTIL) || (store.settings.diseno !== 'tele' && pareceMovil());
document.documentElement.classList.toggle('movil', MOVIL);
// En el navegador (PC o móvil) el reproductor lleva controles de ratón/dedo; en la tele, el HUD de mando
const WEBPC = !NATIVE;
document.documentElement.classList.toggle('webpc', WEBPC);
modoTactil(MOVIL);

const ui = {
  search: '',
  filter: 'all',
  category: null,
  batch: null, // {total, done, alive, controller}
  checking: new Set(),
  engineOk: null,
  motorReserva: false,
};
engine = makeEngine();

// Motor en uso: el configurado (normalmente el del servidor de casa) o, si ese no responde, el de la propia tele
const MOTOR_TELE = 'http://127.0.0.1:6878';
function motorUrl() {
  return ui.motorReserva ? MOTOR_TELE : store.settings.engineUrl;
}
function usandoServidor() {
  return NATIVE && !!store.settings.servidorCasa && motorUrl() !== MOTOR_TELE;
}

function makeEngine() {
  return new Engine(motorUrl(), { timeout: 15000 });
}

// ---------- utilidades ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'ahora mismo';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

function peersTxt(n) {
  return n === 1 ? '1 peer' : `${n} peers`;
}

function speed(kb) {
  if (kb == null) return '';
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb} KB/s`;
}

function hue(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Logo del canal (o de otro enlace del mismo canal) y, si no hay o no carga, sus iniciales
function logoHtml(c, grupo = [c], cls = 'logo') {
  const url = store.settings.logos === false ? null : (grupo.find((x) => x.logo) || {}).logo;
  return `<span class="${cls}" style="--h:${hue(c.category || c.title)}"><span class="ini">${esc(initials(c.title))}</span>${url
    ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.parentNode.classList.add('con-img')" onerror="this.remove()">` : ''}</span>`;
}

// Clave del canal para juntar enlaces: la automática (por el nombre) salvo que se haya juntado o separado a mano
// (Juntar con… / Separar en la ficha del canal o en el panel; se comparte entre teles)
function claveDe(c) {
  const j = store.settings.juntar;
  if (j && j[c.id]) return j[c.id];
  const k = claveCanal(c.title);
  const sep = store.settings.separados;
  return sep && sep[c.id] ? `${k}#${c.id}` : k;
}

// Últimos canales vistos (para «Seguir viendo»)
function apuntarVisto(c) {
  if (!c) return;
  const vistos = (store.data.vistos || []).filter((v) => v.id !== c.id && v.clave !== claveDe(c));
  vistos.unshift({ id: c.id, clave: claveDe(c), at: new Date().toISOString() });
  store.data.vistos = vistos.slice(0, 20);
  store.save(true);   // no repinta la lista: abrir un canal no debe esperar a ordenar todos
}

function vistosRecientes() {
  return (store.data.vistos || []).map((v) => ({ c: store.find(v.id), at: v.at })).filter((x) => x.c && store.channels.includes(x.c));
}

function initials(title) {
  const words = String(title || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3500);
}

// ---------- capas (diálogos) ----------

const focusStack = [];

function openLayer(html, { cls = '', onClose } = {}) {
  focusStack.push(document.activeElement);
  const layer = document.createElement('div');
  layer.className = `layer open ${cls}`;
  layer.innerHTML = `<div class="dialog" role="dialog">${html}</div>`;
  layer._onClose = onClose;
  layer.addEventListener('click', (e) => {
    if (e.target === layer) closeLayer(layer);
    const btn = e.target.closest('[data-close]');
    if (btn) closeLayer(layer);
  });
  document.body.appendChild(layer);
  requestAnimationFrame(() => focusFirst(layer));
  return layer;
}

function closeLayer(layer = activeLayer()) {
  if (!layer || !layer.classList.contains('layer')) return false;
  layer.remove();
  if (layer._onClose) layer._onClose();
  const prev = focusStack.pop();
  if (prev && document.contains(prev)) prev.focus();
  else focusFirst();
  return true;
}

function confirmBox(text, yes = 'Sí') {
  return new Promise((resolve) => {
    let answered = false;
    const layer = openLayer(`
      <p class="confirm-text">${esc(text)}</p>
      <div class="actions">
        <button class="btn danger" data-yes>${esc(yes)}</button>
        <button class="btn" data-close data-autofocus>Cancelar</button>
      </div>`, { onClose: () => { if (!answered) resolve(false); } });
    $('[data-yes]', layer).onclick = () => { answered = true; closeLayer(layer); resolve(true); };
  });
}

// ---------- motor ----------

async function checkEngine(showToast = false) {
  const pill = $('#engine');
  if (!pill.textContent || ui.engineOk === null) { pill.className = 'pill engine wait'; pill.textContent = 'Motor…'; }
  const conServidor = NATIVE && !!store.settings.servidorCasa && store.settings.engineUrl !== MOTOR_TELE;
  // Si se está usando el de la tele de reserva, primero se mira si el servidor ha vuelto
  if (conServidor && ui.motorReserva) {
    try {
      await new Engine(store.settings.engineUrl, { timeout: 5000 }).version();
      ui.motorReserva = false;
      engine = makeEngine();
      toast('El servidor de casa vuelve a responder: se usa su motor', 'ok');
    } catch { /* sigue con el de la tele */ }
  }
  let v;
  try {
    v = await engine.version();
  } catch (e) {
    if (conServidor && !ui.motorReserva) {
      try {
        v = await new Engine(MOTOR_TELE, { timeout: 5000 }).version();
        ui.motorReserva = true;
        engine = makeEngine();
        toast('El servidor de casa no responde: se usa el motor de la tele', 'warn');
      } catch { /* tampoco hay motor en la tele */ }
    }
  }
  if (v) {
    ui.engineOk = true;
    pill.className = `pill engine ${ui.motorReserva ? 'warn' : 'ok'}`;
    pill.textContent = conServidor ? (ui.motorReserva ? 'Motor: tele (servidor caído)' : 'Motor: servidor de casa') : `Motor ${v.version}`;
    if (showToast) toast(`Motor de Ace Stream ${v.version}${usandoServidor() ? ' en el servidor de casa' : ''} funcionando`, 'ok');
  } else {
    ui.engineOk = false;
    pill.className = 'pill engine bad';
    pill.textContent = 'Motor apagado';
    if (showToast) engineHelp();
  }
}

function engineHelp() {
  openLayer(`
    <h2>No se encuentra el motor de Ace Stream</h2>
    ${NATIVE
      ? `<p>Abre la app <b>Ace Stream Media</b> en la tele (o <b>Ace Stream Engine</b>) para que el motor se ponga en marcha y vuelve aquí.</p>
         <p class="muted">Dirección configurada: ${esc(store.settings.engineUrl)}</p>`
      : `<p>Arranca el motor de Ace Stream en el PC (o AceList) y comprueba que el servidor local apunta a él.</p>
         <p class="muted">Dirección configurada: ${esc(store.settings.engineUrl)}</p>`}
    <div class="actions">
      <button class="btn primary" data-retry data-autofocus>Reintentar</button>
      <button class="btn" data-close>Cerrar</button>
    </div>`);
  const layer = activeLayer();
  $('[data-retry]', layer).onclick = () => { closeLayer(layer); checkEngine(true); };
}

// ---------- reproductores ----------

const PLAYERS = {
  interno: 'Ver aquí',
  aceplayer: 'Ace Player',
  vlc: 'VLC',
  ...(NATIVE ? { aceserve: 'AceServe' } : {}),
  elegir: NATIVE ? 'Otra app…' : 'App predeterminada',
};

// Canales de TV por dirección web (IPTV/HLS) a través de la VPN del servidor de casa:
// la tele los pide a su pasarela (http://servidor:8096/vpn/<archivo>?u=…), que los descarga por WARP.
function tvPorVpn() {
  return NATIVE && !!store.settings.servidorCasa && store.settings.tvPorVpn !== false &&
    !!ui.casa?.vpn?.activa && !!ui.casa.vpn.pasarela;
}
function viaVpn(url) {
  if (!url || !/^https?:\/\//i.test(url) || !tvPorVpn()) return url;
  // Se conserva el nombre del archivo (index.m3u8…): el reproductor decide por la extensión si es HLS
  let n = '';
  try { n = new URL(url).pathname.split('/').pop(); } catch { /* dirección rara */ }
  return `${urlCasa('/vpn/')}${/^[\w.-]{1,80}$/.test(n) ? n : 'emision'}?u=${encodeURIComponent(url)}`;
}

// Dirección HTTP del canal en el motor, para reproductores externos como VLC.
function streamUrl(c) {
  if (c.url) return viaVpn(c.url);
  const base = NATIVE ? motorUrl() : 'http://127.0.0.1:6878';
  return `${base.replace(/\/+$/, '')}/ace/getstream?id=${c.id}`;
}

function playerOrder(c) {
  const pref = store.settings.player in PLAYERS ? store.settings.player : 'interno';
  const orden = [pref, ...Object.keys(PLAYERS).filter((k) => k !== pref)];
  // Ace Player solo sirve para Acestream
  return c && c.url ? orden.filter((k) => k !== 'aceplayer' && k !== 'aceserve') : orden;
}

// Enlaces del mismo canal para cambiar solo si uno falla: primero el elegido (y sus copias de seguridad),
// luego los demás enlaces con el mismo nombre, los mejores primero. Los «no encontrados» no se prueban.
function mapaEnlaces() {
  const m = new Map();
  for (const x of store.channels) {
    if (statusOf(x) === 'not_found') continue;
    const k = claveDe(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  for (const l of m.values()) l.sort(cmpEnlace);
  return m;
}

// Entre enlaces del mismo canal: los que funcionan, y entre ellos la mejor calidad (4K, 1080, 720, SD) y más peers
function cmpEnlace(a, b) {
  return (b.favorite - a.favorite) || (RANK[statusOf(a)] - RANK[statusOf(b)])
    || (statusOf(a) === 'alive' ? calidad(b) - calidad(a) : 0)
    || ((lastCheck(b)?.peers || 0) - (lastCheck(a)?.peers || 0)) || a.title.localeCompare(b.title, 'es');
}

function enlacesDe(c, mapa = mapaEnlaces()) {
  const out = [{ id: c.id, url: c.url || '' }];
  for (const u of c.alts || []) out.push({ id: c.id, url: u });
  for (const x of mapa.get(claveDe(c)) || []) {
    if (x.id === c.id) continue;
    out.push({ id: x.id, url: x.url || '' });
    for (const u of x.alts || []) out.push({ id: x.id, url: u });
  }
  // Con los enlaces juntos, se empieza por el que funcionó la última vez en el reproductor
  const m = (store.settings.mejorEnlace || {})[claveDe(c)];
  if (m && store.settings.agrupar !== false && Date.now() - m.at < 7 * 864e5) {
    const i = out.findIndex((e) => e.id === m.id && (e.url || '') === (m.url || ''));
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  return out.slice(0, 8);
}

// ---------- lo que aprende el reproductor ----------
// El reproductor de la tele apunta si cada enlace arrancó (y con cuántos peers) o no. Al volver a la app se recoge:
// el que funcionó pasa a ser el primero de su canal y queda como comprobación (llega también a las otras teles).
function urlSinPasarela(u) {
  try { const x = new URL(u); if (x.pathname.startsWith('/vpn')) return x.searchParams.get('u') || u; } catch { /* no es una URL */ }
  return u || '';
}

async function aprenderDelReproductor() {
  if (!NATIVE || !plugins.Nativo.resultadosReproductor) return;
  let lista = [];
  try {
    const r = await plugins.Nativo.resultadosReproductor();
    lista = JSON.parse(r.resultados || '[]');
    // Si en el reproductor se cambió el formato con ≡, se queda como el elegido
    if ((r.formato === 'ts' || r.formato === 'hls') && r.formato !== (store.settings.formatoStream || 'ts')) store.setSettings({ formatoStream: r.formato });
  } catch { return; }
  if (!lista.length) return;
  const mejor = { ...(store.settings.mejorEnlace || {}) };
  for (const r of lista) {
    const c = store.find(r.id);
    if (!c) continue;
    const url = urlSinPasarela(r.url);
    const clave = claveDe(c);
    if (r.ok) mejor[clave] = { id: r.id, url, at: r.at || Date.now() };
    else if (mejor[clave] && mejor[clave].id === r.id && mejor[clave].url === url) delete mejor[clave];
    // Las copias alternativas de un canal no tienen ficha propia: solo cuenta su enlace principal
    if (url && url !== (c.url || '')) continue;
    const peers = r.peers >= 0 ? r.peers : null;
    if (r.ok) store.addCheck(r.id, { status: 'alive', peers, diag: 'funcionó en el reproductor' });
    else if (/no existe|caducado/i.test(r.motivo || '')) store.addCheck(r.id, { status: 'not_found', diag: `reproductor: ${r.motivo}` });
    else if (/^(No arranca|Se ha quedado)/.test(r.motivo || '')) store.addCheck(r.id, { status: 'no_peers', peers, diag: `reproductor: ${r.motivo}` });
    else store.addCheck(r.id, { status: 'error', error: r.motivo || 'No se pudo reproducir', diag: 'reproductor' });
  }
  // Se guardan los 400 canales más recientes
  const claves = Object.keys(mejor).sort((a, b) => mejor[b].at - mejor[a].at).slice(0, 400);
  store.setSettings({ mejorEnlace: Object.fromEntries(claves.map((k) => [k, mejor[k]])) });
  if (ui.section === 'canales' || ui.section === 'inicio' || ui.section === 'favoritos') render();
}

// Abre una página (p. ej. YouTube) en la app que la gestione
async function abrirWeb(url) {
  if (!/^https?:\/\//i.test(url || '')) return;
  if (NATIVE) {
    try { await plugins.Nativo.abrir({ app: 'web', url }); } catch (e) { toast(e.message || 'No se pudo abrir el enlace', 'bad'); }
    return;
  }
  window.open(url, '_blank', 'noopener');
}

// Enciende una lista apagada (la tele ligera recibe sus canales del servidor al sincronizar)
function activarLista(id) {
  const f = store.source(id);
  if (!f) return;
  store.setSourceEnabled(id, true);
  toast(`${f.name} activada${store.settings.servidorCasa && sincroLigera() ? ': sus canales llegan en unos segundos' : ''}`, 'ok');
}

async function openWith(app, c, list) {
  if (!c) return;
  apuntarVisto(c);
  if (c.url && (app === 'aceplayer' || app === 'aceserve')) app = 'interno';
  if (app === 'interno') {
    if (!NATIVE) return play(c, list);
    // En la tele: reproductor nativo (ExoPlayer), con zapping por la misma lista
    const mapa = mapaEnlaces();
    const item = (x) => ({
      id: x.id, title: x.title, url: viaVpn(x.url || ''),
      enlaces: JSON.stringify(enlacesDe(x, mapa).map((e) => ({ ...e, url: viaVpn(e.url) }))),
    });
    const items = (list && list.length ? list : listaZapping()).map(item);
    if (!items.some((x) => x.id === c.id)) items.unshift(item(c));
    try {
      if (bloqueada()) return;
      await plugins.Nativo.reproducir({ items, index: items.findIndex((x) => x.id === c.id), motor: motorUrl(), formato: store.settings.formatoStream || 'ts',
        bloqueo: store.settings.servidorCasa ? `${urlCasa('/bloqueo')}?${quienSoy()}` : '' });
    } catch (e) {
      toast(e.message || 'No se pudo abrir el reproductor', 'bad');
    }
    return;
  }
  if (NATIVE) {
    try {
      await plugins.Nativo.abrir({ app: c.url && app === 'elegir' ? 'url' : app, id: c.id, url: streamUrl(c), titulo: c.title });
    } catch (e) {
      toast(e.message || `No se pudo abrir en ${PLAYERS[app]}`, 'bad');
    }
    return;
  }
  // En el PC lo abre el servidor local (VLC o el programa asociado a acestream://)
  try {
    const q = c.url ? `app=vlc&url=${encodeURIComponent(c.url)}` : `app=${encodeURIComponent(app)}&id=${c.id}`;
    const r = await fetch(`/lanzar?${q}`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    toast(`Abriendo «${c.title}» en ${PLAYERS[app]}…`, 'ok');
  } catch (e) {
    toast(e.message || `No se pudo abrir en ${PLAYERS[app]}`, 'bad');
  }
}

function okOnChannel(id) {
  const c = store.find(id);
  if (!c) return;
  if (store.settings.okAction === 'reproducir') openWith(store.settings.player, c);
  else openDetail(id);
}

// ---------- lista ----------

// Filtro por listas: se pueden elegir varias a la vez ("-" = canales sin lista).
// Cada canal existe una sola vez (por su ID), así que aunque esté en varias listas elegidas sale una vez.
ui.listas = new Set();

function enListasElegidas(c) {
  if (!ui.listas.size) return true;
  if (ui.listas.has('-') && !c.listas.length) return true;
  return c.listas.some((id) => ui.listas.has(id));
}

// Canales de las listas elegidas (sin filtrar por categoría ni estado), para mostrar sus categorías
function visibleChannelsBase() {
  return store.channels.filter(enListasElegidas);
}

let memoVis = null;
function visibleChannels() {
  // Mismo resultado mientras no cambie nada: abrir un canal o repintar no vuelve a filtrar y ordenar miles de canales
  const clave = [store.version, ui.filter, ui.category, [...ui.listas].join(','), ui.search, store.settings.orden, store.settings.hideDead,
    store.settings.orden === 'evento' ? Math.floor(Date.now() / 60000) : 0].join('|');
  if (memoVis && memoVis.clave === clave) return memoVis.lista;
  const lista = calcularVisibles();
  memoVis = { clave, lista };
  return lista;
}

function calcularVisibles() {
  const q = ui.search.trim().toLowerCase();
  // Buscando se mira en todas las listas, también en las apagadas
  const list = (q ? store.channelsBusqueda : store.channels).filter((c) => {
    const st = statusOf(c);
    if (ui.filter === 'alive' && st !== 'alive') return false;
    if (ui.filter === 'fav' && !c.favorite) return false;
    if (ui.filter === 'pending' && st !== 'pending') return false;
    if (ui.filter === 'dead' && !['no_peers', 'not_found', 'error'].includes(st)) return false;
    if (ui.filter === 'all' && store.settings.hideDead && ['not_found'].includes(st)) return false;
    if (ui.category && c.category !== ui.category) return false;
    if (!enListasElegidas(c)) return false;
    if (q && !(`${c.title} ${c.category || ''} ${c.id}`.toLowerCase().includes(q))) return false;
    return true;
  });
  return ordenar(list);
}

const LIMITE_FILAS = 150;
ui.limite = LIMITE_FILAS;

const FILTROS = { all: 'Todos', alive: 'Vivos', fav: 'Favoritos', pending: 'Sin comprobar', dead: 'Caídos' };
const ORDENES = {
  recomendado: 'Recomendado', evento: 'Con partido primero', categoria: 'Por categoría', nombre: 'Nombre (A-Z)', peers: 'Más peers',
};
const ORDEN_AYUDA = {
  recomendado: 'Los vivos y con más peers primero',
  evento: 'Los que echan un partido ahora o pronto, arriba',
  categoria: 'Agrupados por categoría, con un título por grupo',
  nombre: 'Por orden alfabético',
  peers: 'Los que más gente están compartiendo',
};

const RANK = { alive: 0, no_peers: 1, pending: 2, error: 3, not_found: 4 };
// Los títulos que empiezan por un símbolo («▫Código…», «◦ …») van al final del listado
const raro = (c) => (/^[\p{L}\p{N}]/u.test(String(c.title || '').trim()) ? 0 : 1);
function cmpBase(a, b) {
  return (raro(a) - raro(b)) || (RANK[statusOf(a)] - RANK[statusOf(b)])
    || ((lastCheck(b)?.peers || 0) - (lastCheck(a)?.peers || 0)) || a.title.localeCompare(b.title, 'es');
}

const COLACION = new Intl.Collator('es');
function ordenar(list) {
  const orden = store.settings.orden || 'recomendado';
  let mapa = null;
  if (orden === 'evento') { try { mapa = agenda.eventoPorCanal(); } catch { mapa = new Map(); } }
  // Las claves de cada canal se calculan una vez (antes, en cada comparación: con miles de canales la tele tardaba segundos)
  const k = list.map((c) => {
    const ev = mapa ? mapa.get(c.id) : null;
    return { c, t: c.title || '', r: raro(c), s: RANK[statusOf(c)], p: -(lastCheck(c)?.peers || 0), g: c.category || '~',
      e: !mapa ? 0 : !ev ? 2 : ev.vivo ? 0 : 1, i: ev ? ev.ev.inicio || 0 : 0 };
  });
  const base = (a, b) => (a.r - b.r) || (a.s - b.s) || (a.p - b.p) || COLACION.compare(a.t, b.t);
  let cmp = base;
  if (orden === 'nombre') cmp = (a, b) => (a.r - b.r) || COLACION.compare(a.t, b.t);
  else if (orden === 'peers') cmp = (a, b) => (a.p - b.p) || base(a, b);
  else if (orden === 'categoria') cmp = (a, b) => COLACION.compare(a.g, b.g) || base(a, b);
  else if (orden === 'evento') cmp = (a, b) => (a.e - b.e) || (a.i - b.i) || base(a, b);
  k.sort(cmp);
  for (let n = 0; n < k.length; n++) list[n] = k[n].c;
  return list;
}

// Con orden por categoría, un título antes de cada grupo
function conCabeceras(list, html) {
  if ((store.settings.orden || 'recomendado') !== 'categoria') return list.map(html).join('');
  let ultima = null;
  return list.map((c, i) => {
    const cat = c.category || 'Sin categoría';
    const cab = cat !== ultima ? `<h3 class="grupo-cat">${esc(cat)}</h3>` : '';
    ultima = cat;
    return cab + html(c, i);
  }).join('');
}

function contarFiltros() {
  const counts = { all: 0, alive: 0, fav: 0, pending: 0, dead: 0 };
  for (const c of visibleChannelsBase()) {
    if (ui.category && c.category !== ui.category) continue;
    const st = statusOf(c);
    counts.all++;
    if (st === 'alive') counts.alive++;
    if (c.favorite) counts.fav++;
    if (st === 'pending') counts.pending++;
    if (['no_peers', 'not_found', 'error'].includes(st)) counts.dead++;
  }
  return counts;
}

function listasConCanales() {
  const out = store.sources.filter((f) => f.enabled !== false && store.channels.some((c) => c.listas.includes(f.id)))
    .map((f) => ({ id: f.id, name: f.name, n: store.channels.filter((c) => c.listas.includes(f.id)).length }));
  const sueltos = store.channels.filter((c) => !c.listas.length).length;
  if (sueltos) out.push({ id: '-', name: 'Sin lista', n: sueltos });
  return out;
}

// Menús de la barra de Canales
function abrirSelector(k) {
  if (k === 'ver') {
    const counts = contarFiltros();
    elegirDe('Mostrar', Object.entries(FILTROS).map(([v, l]) => ({ v, l, n: counts[v] })), ui.filter, (v) => { ui.filter = v; });
  }
  if (k === 'orden') {
    elegirDe('Ordenar canales', Object.entries(ORDENES).map(([v, l]) => ({ v, l, d: ORDEN_AYUDA[v] })), store.settings.orden || 'recomendado',
      (v) => store.setSettings({ orden: v }));
  }
  if (k === 'cat') {
    const base = visibleChannelsBase();
    const cats = [...new Set(base.map((c) => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const nOcultas = (store.settings.catOcultas || []).length;
    elegirDe('Categoría', [{ v: '', l: 'Todas', n: base.length }, ...cats.map((c) => ({ v: c, l: c, n: base.filter((x) => x.category === c).length })),
      { v: '\u0000ocultar', l: nOcultas ? `Ocultar categorías (${nOcultas} ocultas)…` : 'Ocultar categorías…' }],
    ui.category || '', (v) => { if (v === '\u0000ocultar') { setTimeout(elegirOcultas, 0); return; } ui.category = v || null; }, { cols: cats.length > 8 });
  }
  if (k === 'listas') elegirListas();
}

function elegirDe(titulo, opciones, actual, aplicar, { cols = false } = {}) {
  const layer = openLayer(`
    <h2>${esc(titulo)}</h2>
    <div class="vmenu${cols ? ' cols' : ''}">
      ${opciones.map((o) => `<button class="mbtn${o.v === actual ? ' check on' : ''}" data-v="${esc(o.v)}"${o.v === actual ? ' data-autofocus' : ''}>
        <span>${o.v === actual ? '✓ ' : ''}${esc(o.l)}${o.d ? `<small class="mdesc">${esc(o.d)}</small>` : ''}</span>${o.n != null ? `<b>${o.n}</b>` : ''}</button>`).join('')}
    </div>`, { cls: cols ? 'wide' : '' });
  layer.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    closeLayer(layer);
    aplicar(b.dataset.v);
    render();
    const primera = $('#grid .row-btn, #grid .card');
    if (primera) focusEl(primera);
  });
}

// Categorías que no se quieren ver nunca (se ocultan en toda la app, no se borran)
function elegirOcultas() {
  const layer = openLayer('<div class="vmenu"></div>', { cls: 'wide' });
  const dlg = $('.dialog', layer);
  const pintar = (foco) => {
    const ocultas = new Set((store.settings.catOcultas || []).map(claveCat));
    const cuenta = new Map();
    for (const c of store.channelsConOcultas) if (c.category) cuenta.set(c.category, (cuenta.get(c.category) || 0) + 1);
    const cats = [...cuenta.keys()].sort((a, b) => a.localeCompare(b, 'es'));
    dlg.innerHTML = `<h2>Ocultar categorías</h2>
      <p class="muted">Las categorías apagadas no salen en ninguna pantalla (ni en Inicio, ni en el zapping). Sus canales no se borran.</p>
      <div class="vmenu cols">
        ${cats.map((c) => { const on = !ocultas.has(claveCat(c)); return `<button class="mbtn check${on ? ' on' : ''}" data-oc="${esc(c)}"><span><i class="sw${on ? ' on' : ''}"></i>${esc(c)}</span><b>${cuenta.get(c)}</b></button>`; }).join('')}
      </div>
      <div class="vmenu" style="margin-top:.8rem"><button class="mbtn primary" data-listo>Listo</button></div>`;
    focusEl((foco && dlg.querySelector(`[data-oc="${CSS.escape(foco)}"]`)) || dlg.querySelector('[data-oc]') || dlg.querySelector('[data-listo]'));
  };
  pintar();
  layer.addEventListener('click', (e) => {
    if (e.target.closest('[data-listo]')) { closeLayer(layer); render(); return; }
    const b = e.target.closest('[data-oc]');
    if (!b) return;
    ocultarCategoria(b.dataset.oc, !(store.settings.catOcultas || []).some((x) => claveCat(x) === claveCat(b.dataset.oc)));
    pintar(b.dataset.oc);
  });
}

function ocultarCategoria(nombre, ocultar) {
  const k = claveCat(nombre);
  const lista = (store.settings.catOcultas || []).filter((x) => claveCat(x) !== k);
  if (ocultar) lista.push(nombre);
  if (ui.category && claveCat(ui.category) === k && ocultar) ui.category = null;
  store.setSettings({ catOcultas: lista });
}

// Listas: se pueden marcar varias; el menú sigue abierto hasta «Listo»
function elegirListas() {
  const layer = openLayer('<div class="vmenu"></div>');
  const dlg = $('.dialog', layer);
  const pintar = (foco) => {
    const ops = listasConCanales();
    const apagadas = store.sources.filter((f) => f.enabled === false);
    dlg.innerHTML = `<h2>Listas</h2>
      <p class="muted">Marca una o varias. Los canales repetidos entre listas se ven una sola vez.</p>
      <div class="vmenu">
        <button class="mbtn${!ui.listas.size ? ' check on' : ''}" data-l="">${!ui.listas.size ? '✓ ' : ''}Todas<b>${store.channels.length}</b></button>
        ${ops.map((o) => `<button class="mbtn check${ui.listas.has(o.id) ? ' on' : ''}" data-l="${esc(o.id)}"><span><i class="sw${ui.listas.has(o.id) ? ' on' : ''}"></i>${esc(o.name)}</span><b>${o.n}</b></button>`).join('')}
        ${apagadas.length ? `<div class="sep"></div><p class="muted">Apagadas: pulsa para encenderlas</p>
        ${apagadas.map((f) => `<button class="mbtn check" data-on="${esc(f.id)}"><span><i class="sw"></i>${esc(f.name)}</span><b>apagada</b></button>`).join('')}` : ''}
        <div class="sep"></div>
        <button class="mbtn primary" data-listo>Listo</button>
      </div>`;
    const el = (foco != null && dlg.querySelector(`[data-l="${CSS.escape(foco)}"]`)) || dlg.querySelector('[data-listo]');
    focusEl(el);
  };
  pintar('');
  layer.addEventListener('click', (e) => {
    if (e.target.closest('[data-listo]')) { closeLayer(layer); render(); const p = $('#grid .row-btn, #grid .card'); if (p) focusEl(p); return; }
    const on = e.target.closest('[data-on]');
    if (on) {
      activarLista(on.dataset.on);
      const sig = store.sources.find((f) => f.enabled === false);
      pintar(sig ? undefined : '');
      if (sig) focusEl(dlg.querySelector('[data-on]') || dlg.querySelector('[data-listo]'));
      return;
    }
    const b = e.target.closest('[data-l]');
    if (!b) return;
    const id = b.dataset.l;
    if (!id) ui.listas = new Set();
    else if (ui.listas.has(id)) ui.listas.delete(id);
    else ui.listas.add(id);
    ui.category = null;
    pintar(id);
  });
}

function cardHtml(c) {
  const st = statusOf(c);
  const chk = lastCheck(c);
  const busy = ui.checking.has(c.id);
  const meta = busy ? 'Comprobando…'
    : chk ? `${ago(chk.at)}${chk.peers != null ? ` · ${peersTxt(chk.peers)}` : ''}` : 'Sin comprobar';
  return `
    <button class="card ${STATUS[st].cls}${busy ? ' busy' : ''}" data-id="${c.id}">
      <span class="poster" style="--h:${hue(c.category || c.title)}">
        <span class="ini">${esc(initials(c.title))}</span>
        ${c.favorite ? '<span class="fav">★</span>' : ''}
        <span class="badge ${STATUS[st].cls}">${busy ? '…' : esc(STATUS[st].label)}</span>
      </span>
      <span class="title">${esc(c.title)}</span>
      <span class="meta">${esc(c.category || 'Sin categoría')} · ${esc(meta)}</span>
    </button>`;
}

// Junta los enlaces del mismo canal ("La Liga", "La_liga", "LALIGA FHD"…). La lista ya viene ordenada: el primero es el mejor.
const memoAgrupar = new WeakMap();
function agrupar(list) {
  const antes = memoAgrupar.get(list);
  if (antes && antes.v === store.version && antes.j === store.settings.juntar && antes.s === store.settings.separados) return antes.g;
  const g = agruparCalcular(list);
  memoAgrupar.set(list, { v: store.version, j: store.settings.juntar, s: store.settings.separados, g });
  return g;
}

function agruparCalcular(list) {
  const mapa = new Map();
  for (const c of list) {
    const k = claveDe(c);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(c);
  }
  // El que representa al grupo es el mejor enlace que funciona (y de más calidad)
  return [...mapa.entries()].map(([clave, canales]) => ({ clave, canales: canales.length > 1 ? canales.sort(cmpEnlace) : canales }));
}

// Lista para el zapping: con agrupación, el mejor enlace de cada canal
function listaZapping() {
  const list = visibleChannels();
  return store.settings.agrupar !== false ? agrupar(list).map((g) => g.canales[0]) : list;
}

// Qué echa ahora (o pronto) alguno de los enlaces del canal, según la agenda
function eventoDeFila(canales) {
  let mapa;
  try { mapa = agenda.eventoPorCanal(); } catch { return null; }
  let prox = null;
  for (const c of canales) {
    const x = mapa.get(c.id);
    if (x && x.vivo) return x;
    if (x && !prox) prox = x;
  }
  return prox;
}

function rowHtml(c, n = 1, clave = null, grupo = [c]) {
  const st = statusOf(c);
  const chk = lastCheck(c);
  const busy = ui.checking.has(c.id);
  const x = eventoDeFila(grupo);
  const titEv = x ? esc(x.ev.titulo.replace(' - ', ' – ')) : '';
  let prog = null;
  if (!x) {
    const conGuia = grupo.find((g) => g.epgId);
    prog = conGuia ? guia.ahora(conGuia.epgId) : null;
  }
  const ev = prog ? `<span class="row-ev prog"><span>${esc(prog.titulo)}</span><i class="pbar"><b style="width:${Math.round(prog.avance * 100)}%"></b></i></span>`
    : !x ? '<span class="row-ev"></span>'
    : x.vivo ? `<span class="row-ev"><span class="rec">●</span>${titEv}</span>`
      : `<span class="row-ev prox">${esc(agenda.hora(x.ev.inicio))} · ${titEv}</span>`;
  let estado;
  if (busy) estado = '<span class="none">Comprobando…</span>';
  else if (c.url && st !== 'error' && st !== 'not_found') estado = '<span class="ok">En abierto</span>';
  else if (st === 'alive') estado = `<span class="ok">Vivo${chk?.peers != null ? ` · ${chk.peers}` : ''}</span>`;
  else estado = `<span class="${STATUS[st].cls}">${esc(STATUS[st].label)}</span>`;
  return `
    <div class="row ${STATUS[st].cls}${busy ? ' busy' : ''}">
    <button class="row-btn" data-id="${c.id}">
      ${logoHtml(c, grupo)}
      <span class="row-main">
        <span class="title">${c.favorite ? '<span class="fav">★</span> ' : ''}${esc(c.title)}${n > 1 ? `<span class="tag-enl">${n} enlaces</span>` : ''}</span>
        <span class="meta">${esc(c.category || 'Sin categoría')}</span>
      </span>
      ${ev}
      <span class="row-est">${estado}<small>${chk && !busy ? esc(ago(chk.at)) : ''}</small></span>
    </button>
    <button class="row-opt" ${n > 1 ? `data-grupo="${esc(clave)}"` : `data-opt="${c.id}"`} aria-label="Opciones">⋮</button>
    </div>`;
}

// Franja de arriba de Canales: partidos en directo que se pueden ver con mis canales
function directoHtml() {
  let lista;
  try { lista = agenda.directoTodos().filter((x) => x.m || (x.ev.gratis || []).length).slice(0, 8); } catch { return ''; }
  if (!lista.length) return '';
  const tarjeta = ({ ev, m }) => {
    const eq = ev.titulo.split(' - ');
    const tit = eq.length === 2 ? `${esc(sigla(eq[0]))}<i>vs</i>${esc(sigla(eq[1]))}` : esc(ev.titulo);
    const extra = m ? (m.todos.length > 1 ? `<b>${m.todos.length} canales</b>` : esc(m.canal.title))
      : '<span class="ab">En abierto</span>';
    return `<button class="dcard" data-key="d:${esc(ev.id)}" data-dev="${esc(ev.id)}" title="${esc(ev.titulo)}">
      <span class="eq">${tit}</span><span class="info">${esc(ev.competicion || ev.deporte || '')} · ${extra}</span></button>`;
  };
  return `<h2>EN DIRECTO AHORA</h2><div class="directo-fila">${lista.map(tarjeta).join('')}
    <button class="dcard mas" data-key="d:agenda" data-dev="">Ver agenda ›</button></div>`;
}

function render() {
  const focusedId = document.activeElement?.dataset?.id;
  const focusedKey = document.activeElement?.dataset?.key;
  const focusedOpt = document.activeElement?.dataset?.opt;
  const focusedGrupo = document.activeElement?.dataset?.grupo;
  const wasInList = !!document.activeElement?.closest?.('#sec-canales');

  if (ui.vistaFav && ui.filter !== 'fav') ui.vistaFav = false;
  $('#titulo-canales').textContent = ui.vistaFav ? 'Favoritos' : 'Canales';
  document.querySelectorAll('.mi').forEach((x) => {
    if (ui.section === 'canales') x.classList.toggle('on', x.dataset.section === (ui.vistaFav ? 'favoritos' : 'canales'));
  });

  // Una sola barra: cada selector abre su menú
  const counts = contarFiltros();
  const nCat = ui.category ? visibleChannelsBase().filter((c) => c.category === ui.category).length : null;
  const sel = (k, label, valor, extra = '') => `<button class="sel${extra}" data-key="sel:${k}" data-sel="${k}"><span>${label}</span><b>${valor}</b></button>`;
  const fuentesVis = listasConCanales();
  const txtListas = !ui.listas.size ? 'Todas'
    : ui.listas.size === 1 ? esc(ui.listas.has('-') ? 'Sin lista' : (store.source([...ui.listas][0])?.name || '1 lista')) : `${ui.listas.size} listas`;
  $('#filters').innerHTML =
    sel('ver', 'Mostrar', `${esc(FILTROS[ui.filter])} <small>${counts[ui.filter]}</small>`, ui.filter !== 'all' ? ' on' : '')
    + (fuentesVis.length > 1 || ui.listas.size ? sel('listas', 'Listas', txtListas, ui.listas.size ? ' on' : '') : '')
    + sel('cat', 'Categoría', ui.category ? `${esc(ui.category)} <small>${nCat}</small>` : 'Todas', ui.category ? ' on' : '')
    + sel('orden', 'Orden', esc(ORDENES[store.settings.orden || 'recomendado']))
    + (ui.search ? `<button class="sel on" data-key="clear-search" id="clear-search"><span>Buscando</span><b>«${esc(ui.search)}» ✕</b></button>` : '');

  // En directo ahora
  const dHtml = directoHtml();
  if ($('#directo')._html !== dHtml) { $('#directo').innerHTML = dHtml; $('#directo')._html = dHtml; }

  // Progreso de verificación
  const b = ui.batch;
  $('#progress').innerHTML = b
    ? `<div class="bar"><span style="width:${Math.round((b.done / b.total) * 100)}%"></span></div>
       <span>${b.retry ? 'Reintentando los que fallaron · ' : 'Comprobando '}${b.done} de ${b.total} · ${b.alive} vivos</span>
       <button class="btn small" data-key="cancel" id="cancel">Cancelar</button>`
    : '';
  $('#progress').classList.toggle('show', !!b);
  $('#verify').disabled = !!b;

  // Rejilla
  const list = visibleChannels();
  const grid = $('#grid');
  if (!store.channels.length) {
    grid.innerHTML = `
      <div class="empty">
        <h2>Aún no hay canales</h2>
        <p>Importa la exportación de AceList (JSON), una lista M3U o enlaces acestream://.</p>
        <button class="btn primary" data-key="empty-import" id="empty-import">Importar canales</button>
      </div>`;
  } else if (!list.length && ui.filter === 'fav' && !ui.search && !ui.category && !ui.listas.size) {
    grid.innerHTML = `<div class="empty"><h2>Aún no tienes favoritos</h2>
      <p>En cualquier canal, mantén pulsado OK para añadirlo (o pulsa ⋮ y elige «☆ Añadir a favoritos»).<br>Aquí los tendrás juntos, y en el reproductor ▲▼ irá solo por ellos.</p></div>`;
  } else if (!list.length) {
    grid.innerHTML = '<div class="empty"><p>Ningún canal coincide con el filtro.</p></div>'
      + (ui.search ? `<button class="btn ver-mas" data-key="buscar-web" id="buscar-web">Buscar «${esc(ui.search)}» en tus listas de internet…</button>` : '');
  } else {
    const asList = store.settings.view !== 'grid';
    // Con muchos canales solo se pintan los primeros (la tele va más fluida); «Ver más» añade otros tantos
    const claveVista = [ui.filter, ui.category, [...ui.listas].join(','), ui.search, store.settings.orden].join('|');
    if (ui.claveVista !== claveVista) { ui.claveVista = claveVista; ui.limite = LIMITE_FILAS; }
    let filas;
    let total;
    if (store.settings.agrupar !== false) {
      const grupos = agrupar(list);
      ui.grupos = new Map(grupos.map((g) => [g.clave, g.canales]));
      total = grupos.length;
      const vis = grupos.slice(0, ui.limite);
      filas = conCabeceras(vis.map((g) => g.canales[0]),
        (c, i) => (asList ? rowHtml(c, vis[i].canales.length, vis[i].clave, vis[i].canales) : cardHtml(c)));
    } else {
      total = list.length;
      filas = conCabeceras(list.slice(0, ui.limite), (c) => (asList ? rowHtml(c) : cardHtml(c)));
    }
    const quedan = total - ui.limite;
    grid.innerHTML = filas + (quedan > 0 ? `<button class="btn ver-mas" data-key="ver-mas" id="ver-mas">Ver ${Math.min(quedan, LIMITE_FILAS)} más · quedan ${quedan}</button>` : '')
      + (ui.search ? `<button class="btn ver-mas" data-key="buscar-web" id="buscar-web">Buscar «${esc(ui.search)}» en tus listas de internet…</button>` : '');
  }
  grid.className = store.settings.view === 'grid' ? 'grid' : 'list';
  const nGrupos = store.settings.agrupar !== false ? agrupar(list).length : list.length;
  $('#count').textContent = store.channels.length
    ? (nGrupos !== list.length ? `${nGrupos} canales · ${list.length} enlaces` : `${list.length} de ${store.channels.length}`) : '';

  // Mantener el foco donde estaba
  if (activeLayer().id === 'app' && wasInList) {
    const el = (focusedId && grid.querySelector(`[data-id="${focusedId}"]`)) ||
      (focusedOpt && grid.querySelector(`[data-opt="${focusedOpt}"]`)) ||
      (focusedGrupo && grid.querySelector(`[data-grupo="${CSS.escape(focusedGrupo)}"]`)) ||
      (focusedKey && document.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`));
    if (el) el.focus({ preventScroll: true });
  }
}

// ---------- verificación ----------

// Comprobar un canal de dirección web (IPTV/HLS): que responda y sea una lista HLS
// Prueba la emisión principal y, si falla, las de reserva; la que funcione pasa a ser la principal
async function verificarUrl(c) {
  const urls = [c.url, ...(c.alts || [])];
  let primero = null;
  for (const url of urls) {
    const r = await probarUrl(url);
    if (!primero) primero = r;
    if (r.status === 'alive') {
      if (url !== c.url) {
        store.updateChannel(c.id, { url, alts: urls.filter((u) => u !== url) });
        r.diag = `${r.diag} · usando la emisión de reserva`;
      }
      return r;
    }
  }
  return primero;
}

async function probarUrl(url) {
  const c = { url };
  const t0 = Date.now();
  const seg = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  try {
    let status;
    let hls;
    if (NATIVE) {
      if (!/m3u8?(\?|$)|\.m3u8|format=m3u8/i.test(c.url)) return { status: 'alive', diag: 'emisión directa (no HLS): no se comprueba' };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(viaVpn(c.url), { cache: 'no-store', signal: ctrl.signal });
        status = res.status;
        hls = res.ok && (await res.text()).trimStart().startsWith('#EXTM3U');
      } finally { clearTimeout(timer); }
    } else {
      const res = await fetch(`/probe?url=${encodeURIComponent(c.url)}`, { cache: 'no-store' });
      const r = await res.json();
      status = r.status;
      hls = r.hls || r.bytes > 0;
    }
    if (status >= 200 && status < 300 && hls) return { status: 'alive', diag: `HTTP ${status} · emisión disponible · ${seg()}` };
    if (status === 404 || status === 410) return { status: 'not_found', diag: `HTTP ${status} · ${seg()}` };
    if (status === 403 || status === 451) return { status: 'error', error: 'Bloqueado (puede ser solo para España o requiere otra red)', diag: `HTTP ${status}` };
    return { status: 'error', error: `La emisión respondió ${status || 'sin datos'}`, diag: `HTTP ${status} · ${seg()}` };
  } catch (e) {
    return { status: 'error', error: 'No responde', diag: seg() };
  }
}

async function verifyOne(c, signal) {
  ui.checking.add(c.id);
  render();
  try {
    if (c.url) {
      const r = await verificarUrl(c);
      store.addCheck(c.id, r);
      return r;
    }
    const s = store.settings;
    const r = await engine.verify(c.id, {
      kind: c.kind,
      minPeers: Number(s.minPeers) || 0,
      timeout: (Number(s.timeoutSec) || 20) * 1000,
      signal,
    });
    if (r.status !== 'cancelled') store.addCheck(c.id, r);
    return r;
  } finally {
    ui.checking.delete(c.id);
    render();
  }
}

async function verifyMany(channels) {
  if (ui.batch || !channels.length) return;
  const controller = new AbortController();
  ui.batch = { total: channels.length, done: 0, alive: 0, controller };
  render();
  const queue = [...channels];
  const fallidos = [];
  let engineDown = false;
  // Si el motor no contesta, se espera un poco y se vuelve a preguntar antes de rendirse
  const motorVuelve = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try { await engine.version(); return true; } catch { /* sigue */ }
    }
    return false;
  };
  const worker = (lista, segunda) => async () => {
    while (lista.length && !controller.signal.aborted && !engineDown) {
      const c = lista.shift();
      try {
        const r = await verifyOne(c, controller.signal);
        if (r.status === 'alive') ui.batch.alive++;
        else if (!segunda && (r.status === 'no_peers' || r.status === 'error')) fallidos.push(c);
      } catch (e) {
        if (e instanceof EngineUnavailableError) {
          if (await motorVuelve()) { lista.unshift(c); continue; }
          engineDown = true;
        }
      }
      ui.batch.done++;
      render();
    }
  };
  // Con el motor del servidor se comprueban más a la vez (el PC aguanta más que la tele)
  const conf = Number(store.settings.concurrency) || 2;
  const n = Math.max(1, Math.min(6, usandoServidor() ? Math.max(conf, 3) : conf));
  await Promise.all(Array.from({ length: n }, worker(queue, false)));
  // Segunda pasada: en P2P es normal que un canal tarde en arrancar la primera vez
  if (store.settings.retryFailed !== false && fallidos.length && !controller.signal.aborted && !engineDown) {
    ui.batch.total += fallidos.length;
    ui.batch.retry = true;
    render();
    await Promise.all(Array.from({ length: n }, worker(fallidos, true)));
  }
  const { alive, done } = ui.batch;
  ui.batch = null;
  render();
  if (engineDown) { checkEngine(); engineHelp(); }
  else if (controller.signal.aborted) toast('Comprobación cancelada');
  else toast(`Comprobación terminada: ${alive} vivos de ${done}`, 'ok');
}

function autoVerify() {
  const s = store.settings;
  if (!s.autoVerify || !ui.engineOk) return;
  // Con el servidor de casa ya comprueba él los canales cada noche: la tele no lo repite (menos carga para todos)
  if (usandoServidor()) return;
  const limit = Date.now() - (Number(s.autoVerifyHours) || 12) * 3600 * 1000;
  const stale = store.channels.filter((c) => {
    const chk = lastCheck(c);
    return !chk || new Date(chk.at).getTime() < limit;
  });
  if (stale.length) {
    toast(`Comprobando ${stale.length} canales en segundo plano…`);
    verifyMany(stale);
  }
}

// Por defecto solo se preparan los partidos marcados con 🔔 (los demás no gastan motor ni red)
function modoPreparar() {
  const v = store.settings.preComprobar;
  if (v === false || v === 'no') return 'no';
  return v === 'todos' ? 'todos' : 'marcados';
}

// Unos minutos antes de cada partido se comprueban sus canales, para saber cuál va cuando empiece
ui.precomprobados = new Set();
const ANTES_MS = 15 * 60e3;
function comprobarAntesDePartidos() {
  const modo = modoPreparar();
  if (modo === 'no' || ui.batch || ui.engineOk === false || document.hidden) return;
  if ($('#playerlayer').classList.contains('open')) return;
  const ahora = Date.now();
  const reciente = ahora - 10 * 60e3;
  const evs = agenda.st.eventos.filter((ev) => !ev.aplazado && ev.inicio && !ui.precomprobados.has(ev.id)
    && ev.inicio - ANTES_MS <= ahora && ahora < ev.inicio + 5 * 60e3
    && (modo === 'todos' || tieneAviso(ev.id)));
  const lista = new Map();
  const titulos = [];
  for (const ev of evs) {
    ui.precomprobados.add(ev.id);
    const mios = agenda.canalesEvento(ev).filter((x) => !x.posible).map((x) => x.c);
    if (mios.length) titulos.push(ev.titulo.replace(' - ', ' – '));
    for (const c of mios) {
      const chk = lastCheck(c);
      if (!chk || new Date(chk.at).getTime() < reciente) lista.set(c.id, c);
    }
  }
  const canales = [...lista.values()].slice(0, 15);
  if (!canales.length) return;
  toast(`Preparando ${titulos.length === 1 ? `«${titulos[0]}»` : `${titulos.length} partidos`}: comprobando ${canales.length} canales…`);
  verifyMany(canales);
}

// ---------- servidor de casa ----------
// Un PC con Docker que lleva el motor de Ace Stream, guarda copias de la app y sirve sus actualizaciones.
const PUERTO_CASA = 8096;
ui.casa = null;
const urlCasa = (ruta = '') => `http://${store.settings.servidorCasa}:${PUERTO_CASA}${ruta}`;

function casaTexto() {
  const ip = store.settings.servidorCasa;
  if (!ip) return 'Sin configurar ›';
  if (!ui.casa) return `${ip} · comprobando…`;
  if (ui.casa.error) return `${ip} · no responde`;
  return `${ip} · ${ui.casa.motor ? 'motor ✓' : 'sin motor'}${ui.casa.vpn?.activa ? ' · VPN ✓' : ''}${ui.casa.copias ? ` · ${ui.casa.copias} copias` : ''}`;
}

function vpnCasaTexto() {
  const v = ui.casa?.vpn;
  if (!ui.casa || ui.casa.error) return '…';
  if (v?.activa) return `Activa · sale por ${[v.ciudad, v.pais].filter(Boolean).join(', ') || v.ip || (v.proveedor || 'VPN')} ›`;
  if (v?.configurada) return 'Configurada, pero no conecta ›';
  return 'Desactivada ›';
}

function ayudaVpnCasa() {
  const v = ui.casa?.vpn;
  openLayer(`
    <h2>VPN del motor</h2>
    ${v?.activa
      ? `<p>El motor del servidor sale a internet por <b>${esc(v.proveedor || 'Cloudflare WARP')}</b>${v.ip ? ` con la IP <b>${esc(v.ip)}</b>` : ''}${v.pais ? ` (${esc([v.ciudad, v.pais].filter(Boolean).join(', '))})` : ''}.
         Vale para todas las teles a la vez; no hace falta ninguna VPN en ellas.</p>`
      : v?.configurada
        ? '<p>La VPN está puesta en el servidor pero no conecta. En el servidor: <b>sh vpn.sh estado</b> y <b>docker compose logs gluetun</b>.</p>'
        : '<p>Ahora el motor sale directamente a internet.</p>'}
    <p class="muted">Se activa o se quita en el servidor, en la carpeta de HomeTV:<br>
      <b>sh vpn.sh activar</b> · <b>sh vpn.sh quitar</b> · <b>sh vpn.sh estado</b></p>
    <p class="muted">Con la VPN no se pueden abrir puertos: si notas menos peers que sin VPN, quítala.</p>
    ${v?.pasarela
      ? `<p class="muted">Canales de TV por dirección web (TDT, otros países): ${tvPorVpn()
          ? 'también salen por la VPN, a través del servidor.'
          : 'ahora los descarga la tele directamente. Actívalo en «Canales de TV por la VPN».'}
         La VPN sale casi siempre por España: salta los bloqueos de la operadora, pero no los canales que solo se ven desde otro país.</p>`
      : '<p class="muted">Los canales de TDT y de otros países los descarga la tele directamente, sin pasar por esta VPN (actualiza el servidor de casa para poder pasarlos por ella).</p>'}
    <div class="actions"><button class="btn primary" data-close data-autofocus>Entendido</button></div>`);
}

async function estadoCasa() {
  if (!store.settings.servidorCasa) { ui.casa = null; return null; }
  try {
    ui.casa = JSON.parse(await fetchText(`${urlCasa('/salud')}?${Date.now()}`));
  } catch (e) {
    ui.casa = { error: e.message };
  }
  if (ui.section === 'ajustes') renderSettings();
  return ui.casa;
}

async function configurarCasa() {
  const actual = store.settings.servidorCasa || '';
  const v = await promptText('IP del servidor de casa', actual, { placeholder: 'Por ejemplo 192.168.1.50 (vacío para no usarlo)', ok: 'Guardar' });
  if (v === null) return;
  const ip = v.trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  if (!ip) {
    const def = defaultSettings(NATIVE);
    store.setSettings({ servidorCasa: '', engineUrl: def.engineUrl, urlActualizaciones: def.urlActualizaciones });
    engine = makeEngine();
    checkEngine(true);
    toast('Servidor de casa quitado: se vuelve a usar el motor de la tele', 'ok');
    return;
  }
  store.setSettings({ servidorCasa: ip, sincroRev: 0 });
  ui.motorReserva = false;
  ui.sincro.huella = null;
  toast(`Probando ${ip}…`);
  const st = await estadoCasa();
  if (!st || st.error) { toast(`${ip} no responde en el puerto ${PUERTO_CASA}. ¿Está encendido y con «docker compose up -d»?`, 'bad'); return; }
  const cambios = { urlActualizaciones: `${urlCasa('/apk/')}` };
  // En la tele se usa el motor del servidor; en la versión web del PC el motor ya lo pone el servidor local
  if (NATIVE && st.motor) cambios.engineUrl = `http://${ip}:6878`;
  store.setSettings(cambios);
  engine = makeEngine();
  checkEngine(true);
  toast(`Servidor de casa listo${st.motor ? ` · motor ${st.motor}` : ' (el motor aún no responde)'}`, 'ok');
  subirCopia();
  traerSincro();
}

// Copia automática cuando cambian canales o ajustes: como mucho una cada 6 horas
// (el servidor además descarta las que no traen cambios y hace él una diaria)
let copiaTimer = null;
function programarCopia() {
  if (!store.settings.servidorCasa) return;
  if (ui.copiaHecha && Date.now() - ui.copiaHecha < 6 * 3600e3) return;
  clearTimeout(copiaTimer);
  copiaTimer = setTimeout(() => subirCopia(), 120000);
}

async function subirCopia(avisar = false) {
  if (!store.settings.servidorCasa) return;
  clearTimeout(copiaTimer);
  // Una tele sin canales (recién instalada) no sube copias vacías
  if (!store.data.channels.length) { if (avisar) toast('No hay canales que guardar', 'warn'); return; }
  try {
    const cuerpo = JSON.stringify({ ...store.data, app: VERSION, at: new Date().toISOString(), manual: avisar });
    const r = await fetch(urlCasa('/copia'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: cuerpo });
    if (r.status === 409) {
      // El servidor la rechaza por tener muchos menos canales que los compartidos
      if (avisar) toast((await r.json().catch(() => ({}))).error || 'El servidor no ha guardado la copia', 'warn');
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ui.copiaHecha = Date.now();   // también si el servidor la omite por no haber cambios
    if (avisar) toast('Copia guardada en el servidor de casa', 'ok');
    estadoCasa();
  } catch (e) {
    if (avisar) toast(`No se pudo guardar la copia: ${e.message}`, 'bad');
  }
}

async function recuperarCopia() {
  let lista;
  try { lista = JSON.parse(await fetchText(`${urlCasa('/copias')}?${Date.now()}`)); } catch (e) { toast(`El servidor no responde: ${e.message}`, 'bad'); return; }
  if (!lista.length) { toast('Aún no hay copias en el servidor'); return; }
  const fecha = (n) => n.replace(/^copia-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d).*$/, '$3/$2/$1 $4:$5');
  const layer = openLayer(`
    <h2>Recuperar una copia</h2>
    <p class="muted">Se sustituyen los canales, listas y ajustes de esta tele por los de la copia.</p>
    <div class="vmenu">
      ${lista.slice(0, 15).map((c, i) => `<button class="mbtn${i ? '' : ' primary'}" data-copia="${esc(c.nombre)}"${i ? '' : ' data-autofocus'}><span>${esc(fecha(c.nombre))}</span><b>${i ? '' : 'la más reciente'}</b></button>`).join('')}
      <button class="mbtn" data-close>Cancelar</button>
    </div>`);
  layer.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copia]');
    if (!b) return;
    closeLayer(layer);
    if (!await confirmBox(`¿Recuperar la copia del ${fecha(b.dataset.copia)}? Lo que hay ahora en la tele se sustituye.`, 'Recuperar')) return;
    try {
      const d = JSON.parse(await fetchText(urlCasa(`/copias/${b.dataset.copia}`)));
      if (!Array.isArray(d.channels)) throw new Error('copia no válida');
      const ip = store.settings.servidorCasa;
      store.data.channels = d.channels;
      store.data.sources = Array.isArray(d.sources) ? d.sources : [];
      store.data.vistos = d.vistos || [];
      store.data.recordatorios = d.recordatorios || [];
      store.data.settings = { ...store.data.settings, ...(d.settings || {}), servidorCasa: ip };
      store.save();
      toast(`Copia recuperada: ${d.channels.length} canales`, 'ok');
      setTimeout(() => { store.escribirPendiente(); location.reload(); }, 1200);
    } catch (err) {
      toast(`No se pudo recuperar: ${err.message}`, 'bad');
    }
  });
}

// ---------- teles sincronizadas (a través del servidor de casa) ----------
// Canales, listas, favoritos, categorías ocultas y avisos se comparten entre todas las teles que usan el servidor.
// Cada cambio se sube a los pocos segundos; cada minuto (y al volver a la app) se baja lo de las otras teles.
const COMPARTIDO = ['equipos', 'catOcultas', 'agendaMapa', 'mundoCats', 'reglas', 'juntar', 'separados', 'archivarCaidos'];
ui.sincro = { aplicando: false, huella: null, timer: null, enCurso: false };
const sincroActiva = () => !!store.settings.servidorCasa && store.settings.sincronizar !== false;

function datosCompartidos() {
  const ajustes = {};
  for (const k of COMPARTIDO) if (store.settings[k] !== undefined) ajustes[k] = store.settings[k];
  return { channels: store.data.channels, sources: store.data.sources, recordatorios: store.data.recordatorios || [], ajustes };
}

// Quién es esta tele, para que el panel del servidor sepa qué teles hay
function nombreTele() {
  const ua = navigator.userAgent || '';
  const m = ua.match(/Android [^;)]*;\s*([^;)]+?)(?:\s+Build|\))/);
  const modelo = m ? m[1].trim() : '';
  if (/^AFT/i.test(modelo) || /AFT\w+/.test(ua)) return `Fire TV${modelo ? ` (${modelo})` : ''}`;
  if (MOVIL) return modelo ? `Móvil ${modelo}` : 'Móvil';
  if (NATIVE) return modelo ? `Tele ${modelo}` : 'Tele Android';
  return 'Navegador del PC';
}

function quienSoy() {
  if (!store.settings.teleId) guardarSinSubir(() => { store.data.settings.teleId = Math.random().toString(36).slice(2, 12); });
  const movil = puente.activo ? puente.url(store.settings.movilToken) : '';
  return `tele=${encodeURIComponent(store.settings.teleId)}&nombre=${encodeURIComponent(nombreTele())}&v=${encodeURIComponent(VERSION)}&movil=${encodeURIComponent(movil)}`;
}

function huella(o) {
  const t = JSON.stringify(o);
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `${t.length}-${h}`;
}

// Tele ligera: sin los canales de listas apagadas (salvo favoritos). El servidor los conserva y los devuelve al encender la lista.
const sincroLigera = () => store.settings.sincroLigero !== false;
function canalActivoLocal(c) {
  if (c.favorite || !Array.isArray(c.listas) || !c.listas.length) return true;
  return c.listas.some((id) => { const f = store.data.sources.find((x) => x.id === id); return !f || f.enabled !== false; });
}
function podarLocal() {
  if (!sincroLigera()) return;
  const quedan = store.data.channels.filter(canalActivoLocal);
  if (quedan.length === store.data.channels.length) return;
  guardarSinSubir(() => { store.data.channels = quedan; });
  ui.sincro.huella = huella(datosCompartidos());
}

function guardarSinSubir(fn) {
  ui.sincro.aplicando = true;
  try { fn(); store.save(); } finally { ui.sincro.aplicando = false; }
}

function aplicarSincro(datos, rev) {
  guardarSinSubir(() => {
    store.data.channels = datos.channels;
    store.data.sources = Array.isArray(datos.sources) ? datos.sources : [];
    store.data.recordatorios = datos.recordatorios || [];
    Object.assign(store.data.settings, datos.ajustes || {});
    store.data.settings.sincroRev = rev;
    store.aplicarReglas(false);
  });
  ui.sincro.huella = huella(datosCompartidos());
}

// La primera vez que una tele se une, se juntan sus canales con los del servidor (no se pierde nada)
function juntar(remoto) {
  const porId = (lista) => new Map((lista || []).map((x) => [x.id, x]));
  const canales = porId(remoto.channels);
  for (const c of store.data.channels) if (!canales.has(c.id)) canales.set(c.id, c);
  const fuentes = porId(remoto.sources);
  for (const f of store.data.sources) if (!fuentes.has(f.id)) fuentes.set(f.id, f);
  const avisos = porId(remoto.recordatorios);
  for (const r of store.data.recordatorios || []) if (!avisos.has(r.id)) avisos.set(r.id, r);
  return { channels: [...canales.values()], sources: [...fuentes.values()], recordatorios: [...avisos.values()], ajustes: { ...(remoto.ajustes || {}) } };
}

async function traerSincro(forzar = false) {
  if (!sincroActiva() || ui.sincro.enCurso || ui.batch) return;
  ui.sincro.enCurso = true;
  try {
    const rev = store.settings.sincroRev || 0;
    const r = JSON.parse(await fetchText(`${urlCasa('/sincro')}?desde=${forzar ? 0 : rev}${sincroLigera() ? '&ligero=1' : ''}&${quienSoy()}&t=${Date.now()}`));
    if (r.sinCambios) return;
    if (!r.datos) { ui.sincro.enCurso = false; await empujarSincro(); return; }
    if (!rev) {
      const n = store.data.channels.length;
      aplicarSincro(juntar(r.datos), r.rev);
      ui.sincro.huella = null; // lo juntado se sube enseguida
      toast(`Teles sincronizadas: ${store.data.channels.length} canales${n ? '' : ' traídos del servidor'}`, 'ok');
      ui.sincro.enCurso = false;
      await empujarSincro();
      podarLocal();
      return;
    }
    if (r.rev > rev || forzar) {
      aplicarSincro(r.datos, r.rev);
      toast(forzar ? 'Canales cargados desde el servidor' : 'Cambios recibidos de otra tele', 'ok');
    }
  } catch { /* servidor apagado: ya se intentará */ } finally {
    ui.sincro.enCurso = false;
  }
}

async function empujarSincro() {
  if (!sincroActiva() || ui.sincro.enCurso) return;
  if (ui.batch) { programarSincro(); return; }
  const datos = datosCompartidos();
  const h = huella(datos);
  if (h === ui.sincro.huella) return;
  ui.sincro.enCurso = true;
  try {
    const res = await fetch(`${urlCasa('/sincro')}?${quienSoy()}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: store.settings.sincroRev || 0, datos, de: NATIVE ? 'tele' : 'web', parcial: sincroLigera() }),
    });
    const r = await res.json();
    if (res.status === 409) {
      // Otra tele (o la comprobación del servidor) guardó antes: se cargan sus datos sin perder
      // las comprobaciones hechas aquí, que se suben en el siguiente envío
      const local = new Map(store.data.channels.map((c) => [c.id, c.checks || []]));
      for (const c of r.datos.channels || []) {
        const mios = local.get(c.id);
        if (!mios || !mios.length) continue;
        const todas = [...(c.checks || []), ...mios].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        c.checks = todas.filter((x, i) => i === todas.findIndex((y) => y.at === x.at && y.status === x.status)).slice(0, 10);
      }
      aplicarSincro(r.datos, r.rev);
      ui.sincro.huella = '';
      programarSincro();
    } else if (res.ok) {
      guardarSinSubir(() => { store.data.settings.sincroRev = r.rev; });
      ui.sincro.huella = h;
      if (r.recargar) { ui.sincro.enCurso = false; toast('Cargando los canales de la lista…', 'ok'); traerSincro(true); }
      else podarLocal();
    }
  } catch { /* se reintentará con el próximo cambio */ } finally {
    ui.sincro.enCurso = false;
  }
}

function programarSincro() {
  if (ui.sincro.aplicando || !sincroActiva()) return;
  clearTimeout(ui.sincro.timer);
  ui.sincro.timer = setTimeout(empujarSincro, 8000);
}

// ---------- equipos favoritos ----------
// Los partidos de tus equipos se marcan solos con 🔔 (aviso al empezar y canales preparados 15 min antes)
const normEq = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function equiposFav() { return Array.isArray(store.settings.equipos) ? store.settings.equipos : []; }
function equiposDe(ev) {
  if (!ev?.titulo || !ev.titulo.includes(' - ')) return [];
  return ev.titulo.split(' - ').map((x) => x.trim()).filter(Boolean);
}
// «Real Madrid» sigue al Real Madrid (y a «Real Madrid Baloncesto»), pero no al Atlético de Madrid
function esDeMiEquipo(ev) {
  const favs = equiposFav().map(normEq).filter(Boolean);
  if (!favs.length) return false;
  return equiposDe(ev).some((eq) => {
    const n = ` ${normEq(eq)} `;
    return favs.some((f) => n.startsWith(` ${f} `) || n.trim() === f);
  });
}
function siguiendo(equipo) { return equiposFav().some((f) => normEq(f) === normEq(equipo)); }
function alternarEquipo(equipo) {
  const ya = siguiendo(equipo);
  const lista = ya ? equiposFav().filter((f) => normEq(f) !== normEq(equipo)) : [...equiposFav(), equipo];
  store.setSettings({ equipos: lista });
  toast(ya ? `Ya no sigues a ${equipo}` : `Sigues a ${equipo}: sus partidos se marcarán solos con 🔔`, 'ok');
  if (!ya) marcarPartidosFavoritos();
}
// Cada poco: marca con 🔔 los partidos de las próximas 48 h de tus equipos (salvo los que hayas desmarcado)
function marcarPartidosFavoritos() {
  if (!equiposFav().length) return;
  const ahora = Date.now();
  const quitados = new Set(store.data.avisosQuitados || []);
  const lista = store.data.recordatorios || [];
  let cambio = false;
  for (const ev of agenda.st.eventos) {
    if (!ev.inicio || ev.aplazado || ev.inicio < ahora || ev.inicio > ahora + 48 * 3600e3) continue;
    if (quitados.has(ev.id) || lista.some((r) => r.id === ev.id) || !esDeMiEquipo(ev)) continue;
    lista.push({ id: ev.id, inicio: ev.inicio, titulo: ev.titulo, avisado: false, auto: true });
    cambio = true;
  }
  if (cambio) { store.data.recordatorios = lista; store.save(); if (ui.section === 'agenda') agenda.refreshView(); if (ui.section === 'inicio') renderHome(); }
}
function ajustesEquipos() {
  const favs = equiposFav();
  const layer = openLayer(`
    <h2>Equipos favoritos</h2>
    <p class="muted">Sus partidos se marcan solos con 🔔: te aviso al empezar y preparo los canales 15 minutos antes.
      Para añadir uno, abre cualquier partido suyo en la Agenda y pulsa «★ Seguir a…».</p>
    <div class="vmenu">
      ${favs.map((f) => `<button class="mbtn" data-quitar="${esc(f)}"><span>★ ${esc(f)}</span><b>Dejar de seguir</b></button>`).join('') || '<p class="muted">Aún no sigues a ningún equipo.</p>'}
      ${NATIVE ? '' : '<button class="mbtn" data-escribir><span>Escribir un equipo…</span><b>+</b></button>'}
      <button class="mbtn" data-close data-autofocus>Volver</button>
    </div>`);
  layer.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quitar]');
    if (q) { alternarEquipo(q.dataset.quitar); closeLayer(layer); ajustesEquipos(); return; }
    if (e.target.closest('[data-escribir]')) {
      const t = (prompt('Nombre del equipo, tal como sale en la Agenda (p. ej. Real Madrid):') || '').trim();
      if (t && !siguiendo(t)) alternarEquipo(t);
      closeLayer(layer); ajustesEquipos();
    }
  });
}

// Al abrir la app (una vez al día): los partidos de hoy de tus equipos
function resumenDelDia() {
  if (!equiposFav().length || bloqueada()) return;
  const hoy = new Date().toDateString();
  try { if (localStorage.getItem('hometv:resumen') === hoy) return; } catch { /* nada */ }
  const ahora = Date.now();
  const fin = new Date(); fin.setHours(23, 59, 59, 999);
  const evs = agenda.st.eventos.filter((ev) => ev.inicio && !ev.aplazado && ev.inicio > ahora - 2 * 3600e3 && ev.inicio <= fin.getTime() && esDeMiEquipo(ev))
    .sort((a, b) => a.inicio - b.inicio);
  if (!evs.length) return;
  try { localStorage.setItem('hometv:resumen', hoy); } catch { /* nada */ }
  const linea = (ev) => `${ev.titulo.replace(' - ', ' – ')} ${ev.inicio <= ahora ? '(ya ha empezado)' : `a las ${agenda.hora(ev.inicio)}`}`;
  const el = $('#toast');
  el.textContent = `Hoy juegan los tuyos: ${evs.slice(0, 3).map(linea).join(' · ')}`;
  el.className = 'toast show ok';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 9000);
}

// ---------- recordatorios de partidos ----------
// Se avisa 2 minutos antes, con la app abierta (Android TV no muestra avisos de apps en segundo plano)

function tieneAviso(evId) {
  return (store.data.recordatorios || []).some((r) => r.id === evId);
}

function alternarAviso(ev) {
  const lista = (store.data.recordatorios || []).filter((r) => r.id !== ev.id);
  const poner = lista.length === (store.data.recordatorios || []).length;
  if (poner) lista.push({ id: ev.id, inicio: ev.inicio, titulo: ev.titulo, avisado: false });
  store.data.recordatorios = lista;
  // Si quitas el aviso de un partido de tu equipo, no se vuelve a poner solo
  const q = (store.data.avisosQuitados || []).filter((id) => id !== ev.id && Number(String(id).split('|')[0]) > Date.now() - 864e5);
  if (!poner && esDeMiEquipo(ev)) q.push(ev.id);
  store.data.avisosQuitados = q;
  store.save();
  toast(poner ? `Marcado: prepararé sus canales 15 min antes y te avisaré cuando empiece «${ev.titulo.replace(' - ', ' – ')}»` : 'Aviso quitado', 'ok');
  if (poner) setTimeout(comprobarAntesDePartidos, 1000);
  return poner;
}

function avisarRecordatorios() {
  const ahora = Date.now();
  const lista = store.data.recordatorios || [];
  const vigentes = lista.filter((r) => r.inicio + 3 * 3600e3 > ahora);
  let cambio = vigentes.length !== lista.length;
  for (const r of vigentes) {
    if (r.avisado || ahora < r.inicio - 2 * 60e3) continue;
    r.avisado = true;
    cambio = true;
    const ev = agenda.st.eventos.find((e) => e.id === r.id);
    const mios = ev ? agenda.canalesEvento(ev).filter((x) => !x.posible).map((x) => x.c).sort(cmpBase) : [];
    const mejor = mios.find((c) => agenda.jugable(c)) || mios[0];
    const layer = openLayer(`
      <p class="muted">🔔 Tu aviso</p>
      <h2>${esc(r.titulo.replace(' - ', ' – '))}</h2>
      <p>${ahora >= r.inicio ? 'Ya ha empezado.' : `Empieza a las ${esc(agenda.hora(r.inicio))}.`}</p>
      <div class="vmenu">
        ${mejor ? `<button class="mbtn primary" data-ver data-autofocus><span>▶ Ver ahora</span><b>${esc(mejor.title)}</b></button>` : ''}
        ${ev ? '<button class="mbtn" data-ficha>Ver todos los canales</button>' : ''}
        <button class="mbtn" data-close${mejor ? '' : ' data-autofocus'}>Cerrar</button>
      </div>`);
    layer.addEventListener('click', (e) => {
      if (e.target.closest('[data-ver]')) { closeLayer(layer); openWith(store.settings.player, mejor, mios); }
      if (e.target.closest('[data-ficha]')) { closeLayer(layer); agenda.abrirEvento(ev.id); }
    });
    break;
  }
  if (cambio) { store.data.recordatorios = vigentes; store.save(); }
}

// ---------- actualizaciones de la app ----------
// Dos formas: subir la APK desde el panel del móvil/PC (Copia → Actualizar la app), o una dirección web
// propia con version.txt y HomeTV.apk que la tele mira al abrirse.
ui.nueva = null;

function versionMayor(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function baseActualizaciones() {
  const u = String(store.settings.urlActualizaciones || '').trim();
  return u ? u.replace(/\/?$/, '/') : '';
}

function versionTexto() {
  if (ui.nueva) return `${VERSION} · nueva: ${ui.nueva} ›`;
  return VERSION;
}

async function buscarActualizacion(avisar = false) {
  const base = baseActualizaciones();
  if (!NATIVE || !base) return;
  try {
    const v = (await fetchText(`${base}version.txt?${Date.now()}`)).trim().split(/\s+/)[0];
    ui.nueva = versionMayor(v, VERSION) ? v : null;
    if (ui.nueva && (avisar || ui.ofrecida !== v)) {
      ui.ofrecida = v;
      ofrecerActualizacion(v);
    } else if (avisar && !ui.nueva) toast(`Tienes la última versión (${VERSION})`, 'ok');
  } catch (e) {
    if (avisar) toast(`No se pudo comprobar: ${e.message}`, 'bad');
  }
  if (ui.section === 'ajustes') renderSettings();
}

// Al abrir la app (o volver a ella) con versión nueva: se ofrece directamente, sin pasar por Ajustes
function ofrecerActualizacion(v) {
  if ($('#playerlayer').classList.contains('open') || document.querySelector('.layer.open[data-actualizar]')) return;
  const layer = openLayer(`
    <h2>Hay una versión nueva de HomeTV</h2>
    <p>Tienes la <b>${esc(VERSION)}</b> y ya está la <b>${esc(v)}</b>. Se descarga sola y luego confirmas la instalación con el mando.</p>
    <div class="vmenu">
      <button class="mbtn primary" data-ya data-autofocus><span>Actualizar ahora</span><b>${esc(v)}</b></button>
      <button class="mbtn" data-close>Más tarde</button>
    </div>`);
  layer.dataset.actualizar = '1';
  layer.addEventListener('click', (e) => { if (e.target.closest('[data-ya]')) { closeLayer(layer); ayudaActualizar(); } });
}

async function ayudaActualizar() {
  if (ui.nueva && NATIVE) {
    toast(`Descargando la versión ${ui.nueva}…`);
    try {
      await plugins.Nativo.actualizar({ url: `${baseActualizaciones()}HomeTV.apk` });
    } catch (e) {
      if ((e.code || e.message) === 'PERMISO') avisoPermisoInstalar();
      else toast(e.message || 'No se pudo actualizar', 'bad');
    }
    return;
  }
  openLayer(`
    <h2>Actualizar HomeTV</h2>
    <p>Tienes la versión <b>${esc(VERSION)}</b>.</p>
    <p>La forma más cómoda: abre el panel del móvil o del PC (menú <b>Móvil</b>), entra en <b>Copia</b> y en
      «Actualizar la app de la tele» elige la APK nueva. La tele abrirá el instalador sola.</p>
    ${NATIVE ? `<p class="muted">También puedes poner una dirección web propia con <b>version.txt</b> y <b>HomeTV.apk</b>
      en «Dirección de actualizaciones»: la tele la mirará al abrirse y avisará cuando haya una nueva.</p>` : ''}
    <div class="actions">
      ${NATIVE && baseActualizaciones() ? '<button class="btn" data-buscar>Buscar ahora</button>' : ''}
      <button class="btn primary" data-close data-autofocus>Entendido</button></div>`)
    .addEventListener('click', (e) => { if (e.target.closest('[data-buscar]')) { closeLayer(); buscarActualizacion(true); } });
}

function avisoPermisoInstalar() {
  openLayer(`
    <h2>Falta un permiso</h2>
    <p>Para instalar la versión nueva, Android pide permitir que <b>HomeTV</b> instale apps.
      Se ha abierto esa pantalla: activa el permiso, vuelve y repite la actualización.</p>
    <p class="muted">Si no se abrió: Ajustes de la tele → Apps → Acceso especial → Instalar apps desconocidas → HomeTV.</p>
    <div class="actions"><button class="btn primary" data-close data-autofocus>Entendido</button></div>`);
}

// ---------- detalle de canal ----------

function openDetail(id) {
  const c = store.find(id);
  if (!c) return;
  const st = statusOf(c);
  const proximos = agenda.eventosDeCanal(c).slice(0, 4);
  const history = (c.checks || []).slice(0, 5).map((k) => `
    <li><span class="badge ${STATUS[k.status]?.cls || 'none'}">${esc(STATUS[k.status]?.label || k.status)}</span>
      ${esc(new Date(k.at).toLocaleString('es-ES'))}
      ${k.peers != null ? ` · ${peersTxt(k.peers)}` : ''}${k.speed != null ? ` · ${speed(k.speed)}` : ''}
      ${k.error ? `<small class="muted"> · ${esc(k.error)}</small>` : ''}
      ${k.diag && k.status !== 'alive' ? `<br><small class="muted">Motor: ${esc(k.diag)}</small>` : ''}</li>`).join('');
  const layer = openLayer(`
    <div class="detail">
      <div class="detail-info">
        ${logoHtml(c, [c], 'logo grande')}
        <h2>${c.favorite ? '<span class="fav">★</span> ' : ''}${esc(c.title)}</h2>
        <p class="muted">${esc(c.category || 'Sin categoría')}${c.language ? ' · ' + esc(c.language.toUpperCase()) : ''}${c.resolution ? ' · ' + esc(c.resolution) : ''}</p>
        <p><span class="badge ${STATUS[st].cls}">${esc(STATUS[st].label)}</span></p>
        ${c.epgId && guia.proximos(c.epgId).length ? `<h3>Programación</h3><ul class="history">${guia.proximos(c.epgId).map((p) => `<li><b>${esc(new Date(p.hi).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}</b> ${esc(p.titulo)}</li>`).join('')}</ul>` : ''}
        ${proximos.length ? `<h3>En la agenda</h3><ul class="history">${proximos.map((ev) => `<li><b>${esc(new Date(ev.inicio).toLocaleString('es-ES', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</b> ${esc(ev.titulo)} <small class="muted">${esc(ev.competicion || ev.deporte)}</small></li>`).join('')}</ul>` : ''}
        <h3>Comprobaciones</h3>
        ${history ? `<ul class="history">${history}</ul>` : '<p class="muted">Todavía no se ha comprobado.</p>'}
        <p class="mono muted">${esc(c.url || c.id)}</p>
        ${c.listas.length ? `<p class="muted">Listas: ${c.listas.map((id) => esc(store.source(id)?.name || id)).join(', ')}</p>` : ''}
      </div>
      <div class="vmenu">
        ${playerOrder(c).map((k, i) => `<button class="mbtn${i === 0 ? ' primary' : ''}" data-player="${k}"${i === 0 ? ' data-autofocus' : ''}>${i === 0 ? '▶ ' : ''}${esc(PLAYERS[k])}</button>`).join('')}
        <div class="sep"></div>
        <button class="mbtn" data-act="verify">Comprobar ahora</button>
        <button class="mbtn" data-act="fav">${c.favorite ? '★ Quitar de favoritos' : '☆ Añadir a favoritos'}</button>
        <button class="mbtn" data-act="edit">Editar nombre y categoría</button>
        <button class="mbtn" data-act="juntar">Juntar con otro canal…</button>
        ${(store.settings.juntar || {})[c.id] ? '<button class="mbtn" data-act="desjuntar">Deshacer la unión</button>'
          : (store.settings.separados || {})[c.id] ? '<button class="mbtn" data-act="desseparar">Volver a juntar con los suyos</button>'
          : grupoDe(c).length > 1 ? `<button class="mbtn" data-act="separar">Separar de los otros ${grupoDe(c).length - 1} enlaces</button>` : ''}
        <button class="mbtn danger" data-act="delete">Eliminar</button>
        <div class="sep"></div>
        <button class="mbtn" data-close>Volver</button>
      </div>
    </div>`, { cls: 'wide' });

  layer.addEventListener('click', async (e) => {
    const pl = e.target.closest('[data-player]')?.dataset.player;
    if (pl) {
      if (pl === 'interno') closeLayer(layer);
      openWith(pl, c);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'verify') {
      closeLayer(layer);
      try {
        const r = await verifyOne(c);
        toast(`${c.title}: ${STATUS[r.status]?.label || r.status}${r.peers != null ? ` (${peersTxt(r.peers)})` : ''}`, STATUS[r.status]?.cls);
      } catch (err) {
        checkEngine();
        engineHelp();
      }
    }
    if (act === 'fav') { store.updateChannel(c.id, { favorite: !c.favorite }); closeLayer(layer); openDetail(c.id); }
    if (act === 'edit') { closeLayer(layer); openEdit(c.id); }
    if (act === 'juntar') { closeLayer(layer); elegirJuntar(c); }
    if (act === 'desjuntar' || act === 'separar' || act === 'desseparar') {
      const juntar = { ...(store.settings.juntar || {}) };
      const separados = { ...(store.settings.separados || {}) };
      if (act === 'desjuntar') delete juntar[c.id];
      if (act === 'separar') separados[c.id] = 1;
      if (act === 'desseparar') delete separados[c.id];
      store.setSettings({ juntar, separados });
      closeLayer(layer);
      render();
      toast(act === 'separar' ? `«${c.title}» va ahora por separado` : 'Hecho', 'ok');
    }
    if (act === 'delete') {
      if (await confirmBox(`¿Eliminar «${c.title}»?`, 'Eliminar')) { closeLayer(layer); store.removeChannel(c.id); }
    }
  });
}

// Enlaces que van juntos con este canal (incluido él)
function grupoDe(c) {
  const k = claveDe(c);
  return store.channels.filter((x) => claveDe(x) === k);
}

// «Juntar con…»: propone los canales que más se parecen (palabras en común) y deja buscar por nombre
async function elegirJuntar(c, filtro = '') {
  const mias = new Set(claveCanal(c.title).split(' '));
  const kc = claveDe(c);
  const vistos = new Set();
  const candidatos = [];
  for (const x of store.channels) {
    const k = claveDe(x);
    if (k === kc || vistos.has(k)) continue;
    const comunes = claveCanal(x.title).split(' ').filter((w) => mias.has(w)).length;
    const coincide = filtro ? x.title.toLowerCase().includes(filtro.toLowerCase()) : comunes > 0;
    if (!coincide) continue;
    vistos.add(k);
    candidatos.push({ x, comunes });
  }
  candidatos.sort((a, b) => b.comunes - a.comunes || a.x.title.localeCompare(b.x.title, 'es'));
  const lista = candidatos.slice(0, 24);
  const layer = openLayer(`
    <h2>Juntar «${esc(c.title)}» con…</h2>
    <p class="muted">Sus enlaces pasarán a ser enlaces del canal que elijas (y se probarán uno detrás de otro).</p>
    <div class="vmenu cols">
      <button class="mbtn" data-buscar data-autofocus>🔍 Buscar por nombre…</button>
      ${lista.map((y) => `<button class="mbtn" data-con="${esc(y.x.id)}">${esc(y.x.title)}<b>${grupoDe(y.x).length > 1 ? `${grupoDe(y.x).length} enlaces` : ''}</b></button>`).join('')
        || '<p class="muted">No hay canales parecidos: busca por nombre.</p>'}
    </div>
    <div class="actions"><button class="btn" data-close>Cancelar</button></div>`, { cls: 'wide' });
  layer.addEventListener('click', async (e) => {
    if (e.target.closest('[data-buscar]')) {
      closeLayer(layer);
      const q = await promptText('Buscar el canal con el que juntarlo', '', { placeholder: 'Nombre del canal', ok: 'Buscar' });
      if (q) elegirJuntar(c, q.trim());
      return;
    }
    const b = e.target.closest('[data-con]');
    if (!b) return;
    const destino = store.find(b.dataset.con);
    if (!destino) return;
    const juntar = { ...(store.settings.juntar || {}) };
    const separados = { ...(store.settings.separados || {}) };
    delete separados[c.id];
    juntar[c.id] = claveDe(destino);
    store.setSettings({ juntar, separados });
    closeLayer(layer);
    render();
    toast(`«${c.title}» va ahora junto a «${destino.title}» (${grupoDe(destino).length} enlaces)`, 'ok');
  });
}

// Pide un texto (en la tele abre el teclado en pantalla).
function promptText(title, value = '', { placeholder = '', ok = 'Aceptar' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const layer = openLayer(`
      <h2>${esc(title)}</h2>
      <input type="text" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" data-autofocus>
      <div class="actions">
        <button class="btn primary" data-ok>${esc(ok)}</button>
        <button class="btn" data-close>Cancelar</button>
      </div>`, { onClose: () => { if (!done) resolve(null); } });
    const input = $('[name=v]', layer);
    const accept = () => { done = true; const v = input.value; closeLayer(layer); resolve(v); };
    $('[data-ok]', layer).onclick = accept;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); accept(); } });
  });
}

// Elegir una categoría de la lista (sin escribir) o crear una nueva.
function chooseCategory(current) {
  return new Promise((resolve) => {
    let done = false;
    const cats = store.categories();
    const layer = openLayer(`
      <h2>Categoría</h2>
      <div class="chips-grid">
        <button class="chip${!current ? ' on' : ''}" data-cat=""${!current ? ' data-autofocus' : ''}>Sin categoría</button>
        ${cats.map((c) => `<button class="chip${c === current ? ' on' : ''}" data-cat="${esc(c)}"${c === current ? ' data-autofocus' : ''}>${esc(c)}</button>`).join('')}
        <button class="chip" data-new>＋ Nueva…</button>
      </div>
      <div class="actions"><button class="btn" data-close>Cancelar</button></div>`, { onClose: () => { if (!done) resolve(undefined); } });
    layer.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cat]');
      if (b) { done = true; closeLayer(layer); resolve(b.dataset.cat || null); }
      if (e.target.closest('[data-new]')) {
        done = true;
        closeLayer(layer);
        const v = await promptText('Nueva categoría', '', { placeholder: 'Deportes, Fútbol, Motor…' });
        resolve(v && v.trim() ? v.trim() : undefined);
      }
    });
  });
}

// Todos los enlaces de un mismo canal
function openGrupo(clave) {
  const canales = ui.grupos?.get(clave);
  if (!canales || !canales.length) return;
  const filas = canales.map((c, i) => {
    const s = statusOf(c);
    const chk = lastCheck(c);
    return `<div class="enlace">
      <button class="mbtn${i === 0 ? ' primary' : ''}" data-gplay="${c.id}"${i === 0 ? ' data-autofocus' : ''}>
        <span><i class="dot ${STATUS[s].cls}"></i> ▶ ${esc(c.title)}</span>
        <b>${c.url ? 'En abierto' : esc(STATUS[s].label)}${chk?.peers != null ? ` · ${esc(peersTxt(chk.peers))}` : ''}</b></button>
      <button class="mbtn opt" data-gopt="${c.id}" aria-label="Opciones de ${esc(c.title)}">⋮</button></div>`;
  }).join('');
  const layer = openLayer(`
    <h2>${esc(canales[0].title)}</h2>
    <p class="muted">${canales.length} enlaces del mismo canal, el mejor primero. ⋮ para las opciones de cada uno.</p>
    <div class="vmenu">
      ${filas}
      <div class="sep"></div>
      <button class="mbtn" data-gfav>${canales.some((c) => c.favorite) ? '★ Quitar de favoritos' : '☆ Añadir a favoritos'}</button>
      <button class="mbtn" data-gcheck>Comprobar los ${canales.length} enlaces</button>
      <button class="mbtn" data-close>Volver</button>
    </div>`, { cls: 'wide' });
  layer.addEventListener('click', (e) => {
    const p = e.target.closest('[data-gplay]');
    if (p) { closeLayer(layer); openWith(store.settings.player, store.find(p.dataset.gplay), canales); return; }
    const o = e.target.closest('[data-gopt]');
    if (o) { closeLayer(layer); openDetail(o.dataset.gopt); return; }
    if (e.target.closest('[data-gcheck]')) { closeLayer(layer); verifyMany(canales); }
    if (e.target.closest('[data-gfav]')) {
      const poner = !canales.some((c) => c.favorite);
      for (const c of canales) c.favorite = poner;
      store.save();
      toast(poner ? `«${canales[0].title}» en favoritos` : `«${canales[0].title}» fuera de favoritos`, 'ok');
      closeLayer(layer);
    }
  });
}

function openEdit(id) {
  const c = store.find(id);
  if (!c) return;
  const layer = openLayer(`
    <h2>Editar canal</h2>
    <div class="vmenu">
      <button class="mbtn" data-e="title" data-autofocus><span>Nombre</span><b>${esc(c.title)}</b></button>
      <button class="mbtn" data-e="category"><span>Categoría</span><b>${esc(c.category || 'Sin categoría')}</b></button>
      <div class="sep"></div>
      <button class="mbtn" data-close>Volver</button>
    </div>`);
  layer.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-e]')?.dataset.e;
    if (f === 'title') {
      const v = await promptText('Nombre del canal', c.title);
      if (v && v.trim()) { store.updateChannel(c.id, { title: v.trim().slice(0, 200), titlePending: false }); toast('Nombre guardado', 'ok'); }
    }
    if (f === 'category') {
      const v = await chooseCategory(c.category);
      if (v !== undefined) { store.updateChannel(c.id, { category: v }); toast('Categoría guardada', 'ok'); }
    }
    if (f) { closeLayer(layer); openEdit(c.id); }
  });
}

// ---------- reproductor ----------

const player = new Player({
  engine,
  onStats: (s) => {
    const labels = { idle: 'Conectando', prebuf: 'Cargando', dl: 'Reproduciendo', buf: 'Cargando' };
    $('#hud-stats').textContent = s.abierto ? 'Emisión en abierto'
      : `${labels[s.status] || s.status}${s.peers != null ? ` · ${peersTxt(s.peers)}` : ''}${s.speedDown != null ? ` · ${speed(s.speedDown)}` : ''}`;
  },
  onError: (msg) => {
    // Si hay otro enlace del mismo canal, se prueba solo
    if (zap.fuente + 1 < zap.fuentes.length) {
      zap.fuente++;
      const f = zap.fuentes[zap.fuente];
      const c = $('#playerlayer')._channel;
      $('#hud-stats').textContent = `Ese enlace falla: probando el enlace ${zap.fuente + 1} de ${zap.fuentes.length}…`;
      showHud();
      const t = ++zap.intento;
      setTimeout(() => { if (t === zap.intento) player.play({ ...(store.find(f.id) || c), id: f.id, url: f.url || undefined }); }, 1200);
      return;
    }
    $('#hud-stats').textContent = zap.fuentes.length > 1 ? `${msg} (probados los ${zap.fuentes.length} enlaces)` : msg;
    $('#playerlayer').classList.add('error');
    showHud();
  },
  onClosed: () => {},
  onEstado: ({ cargando, texto }) => {
    const pl = $('#playerlayer');
    pl.classList.toggle('cargando', !!cargando);
    if (texto) $('#pc-carga-txt').textContent = texto;
  },
  onAviso: (msg) => pcAviso(msg),
});

// ---------- controles del reproductor en el navegador ----------
let pcTimer;
let pcAvisoTimer;
function pcControles() {
  if (!WEBPC) return;
  const pl = $('#playerlayer');
  pl.classList.add('controles');
  clearTimeout(pcTimer);
  pcTimer = setTimeout(() => {
    // No se esconden con el ratón encima de la barra
    if (pl.querySelector('.pc-barra:hover, .pc-arriba:hover')) { pcControles(); return; }
    pl.classList.remove('controles');
  }, 3000);
}
function pcAviso(msg) {
  const a = $('#pc-aviso');
  a.textContent = msg;
  a.classList.add('ver');
  clearTimeout(pcAvisoTimer);
  pcAvisoTimer = setTimeout(() => a.classList.remove('ver'), 8000);
}
function pcPlayPausa() {
  const v = $('#video');
  if (v.paused) v.play().catch(() => {}); else v.pause();
  pcControles();
}
function pcPantallaCompleta() {
  const pl = $('#playerlayer');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else (pl.requestFullscreen || pl.webkitRequestFullscreen || (() => Promise.reject()))
    .call(pl).catch(() => { const v = $('#video'); if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); });
}
async function pcPip() {
  const v = $('#video');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    else toast('Este navegador no tiene ventana flotante');
  } catch { toast('No se pudo abrir la ventana flotante'); }
}
function pcVolumen(val) {
  const v = $('#video');
  if (val != null) { v.volume = Math.max(0, Math.min(1, val)); v.muted = v.volume === 0; }
  $('#pc-volumen').value = v.muted ? 0 : v.volume;
  $('#playerlayer').classList.toggle('mudo', v.muted || v.volume === 0);
  try { localStorage.setItem('hometv:volumen', JSON.stringify({ v: v.volume, m: v.muted })); } catch { /* nada */ }
}
function pcCopiar(texto, ok = 'Enlace copiado: en VLC, Medio → Abrir ubicación de red y pégalo') {
  if (!texto) { toast('Este canal no tiene enlace para abrir fuera'); return; }
  const hecho = () => toast(ok, 'ok');
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(texto).then(hecho, () => toast(texto)); return; }
  const ta = document.createElement('textarea');
  ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); hecho(); } catch { toast(texto); }
  ta.remove();
}
function pcLista(abrir) {
  const pl = $('#playerlayer');
  const ver = abrir ?? !pl.classList.contains('lista');
  pl.classList.toggle('lista', ver);
  if (!ver) { if (pl.querySelector('.pc-lista').contains(document.activeElement)) $('#pc-volver').focus({ preventScroll: true }); return; }
  $('#pc-lista-cuerpo').innerHTML = zap.list.map((id, i) => {
    const c = store.find(id);
    if (!c) return '';
    return `<button class="pc-canal${i === zap.index ? ' actual' : ''}" data-zi="${i}"><span class="n">${i + 1}</span><span class="t">${esc(c.title)}</span><span class="d ${STATUS[statusOf(c)].cls}"></span></button>`;
  }).join('') || '<p class="muted">No hay más canales en esta lista.</p>';
  const actual = $('#pc-lista-cuerpo .actual');
  if (actual) { actual.scrollIntoView({ block: 'center' }); actual.focus({ preventScroll: true }); }
}
function pcIrA(i) {
  if (i === zap.index) { pcLista(false); return; }
  zapTo(i - zap.index);
  pcLista(false);
}
function pcPintarCanal() {
  const pl = $('#playerlayer');
  const c = pl._channel;
  if (!c) return;
  $('#pc-titulo').textContent = c.title;
  $('#pc-num').textContent = zap.list.length > 1 ? `${zap.index + 1} / ${zap.list.length}` : '';
  pl.classList.toggle('uno', zap.list.length < 2);
}
function instalarPcControles() {
  if (!WEBPC) return;
  const pl = $('#playerlayer');
  const v = $('#video');
  // Lo que se escribe en el estado del HUD de siempre se copia arriba y en el error
  new MutationObserver(() => {
    const t = $('#hud-stats').textContent;
    $('#pc-estado').textContent = t;
    $('#pc-error-txt').textContent = t;
  }).observe($('#hud-stats'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(pcPintarCanal).observe($('#hud-title'), { childList: true, characterData: true, subtree: true });
  ['mousemove', 'pointerdown', 'touchstart'].forEach((ev) => pl.addEventListener(ev, pcControles, { passive: true }));
  v.addEventListener('pause', () => pl.classList.add('pausa'));
  v.addEventListener('play', () => pl.classList.remove('pausa'));
  v.addEventListener('volumechange', () => { $('#pc-volumen').value = v.muted ? 0 : v.volume; pl.classList.toggle('mudo', v.muted || v.volume === 0); });
  // Clic en la imagen: pausa; doble clic: pantalla completa (en el móvil, un toque solo enseña los controles)
  let clicTimer;
  v.addEventListener('click', () => {
    if (MOVIL) { if (pl.classList.contains('controles')) pl.classList.remove('controles'); else pcControles(); return; }
    clearTimeout(clicTimer);
    clicTimer = setTimeout(pcPlayPausa, 220);
  });
  v.addEventListener('dblclick', () => { clearTimeout(clicTimer); pcPantallaCompleta(); });
  const on = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  on('#pc-volver', () => closePlayer());
  on('#pc-salir-err', () => closePlayer());
  on('#pc-play', pcPlayPausa);
  on('#pc-play-grande', pcPlayPausa);
  on('#pc-ant', () => zapTo(-1));
  on('#pc-sig', () => zapTo(1));
  on('#pc-sig-canal', () => zapTo(1));
  on('#pc-mute', () => { v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = .5; pcVolumen(); });
  on('#pc-full', pcPantallaCompleta);
  on('#pc-pip', pcPip);
  on('#pc-canales', () => pcLista());
  on('#pc-lista-cerrar', () => pcLista(false));
  on('#pc-vlc', () => pcCopiar(player.enlaceExterno));
  on('#pc-copiar-err', () => pcCopiar(player.enlaceExterno));
  on('#pc-reintentar', () => { pl.classList.remove('error'); empezarFuentes(pl._channel); player.reintentar(); });
  $('#pc-lista-cuerpo').addEventListener('click', (e) => { const b = e.target.closest('[data-zi]'); if (b) pcIrA(Number(b.dataset.zi)); });
  $('#pc-volumen').addEventListener('input', (e) => pcVolumen(Number(e.target.value)));
  if (!document.pictureInPictureEnabled) $('#pc-pip').hidden = true;
  try { const g = JSON.parse(localStorage.getItem('hometv:volumen') || 'null'); if (g) { v.volume = g.v; v.muted = !!g.m; } } catch { /* nada */ }
  pcVolumen();
}

// Teclado en el navegador: espacio pausa, F pantalla completa, M silencio, P ventana flotante, C canales, ←→ volumen
function pcTeclas(e) {
  const pl = $('#playerlayer');
  if (!WEBPC || !pl.classList.contains('open') || activeLayer() !== pl) return false;
  if (e.target.closest && e.target.closest('input, textarea')) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const v = $('#video');
  const hecho = () => { e.preventDefault(); e.stopPropagation(); pcControles(); return true; };
  if (pl.classList.contains('lista') && (k === 'Escape' || k === 'c')) { pcLista(false); return hecho(); }
  if (pl.classList.contains('lista')) return false;   // dentro de la lista, las flechas mueven por ella
  if (k === ' ' || k === 'k') { pcPlayPausa(); return hecho(); }
  if (k === 'f') { pcPantallaCompleta(); return hecho(); }
  if (k === 'm') { v.muted = !v.muted; pcVolumen(); return hecho(); }
  if (k === 'p') { pcPip(); return hecho(); }
  if (k === 'c') { pcLista(true); return hecho(); }
  if (k === 'ArrowRight') { pcVolumen((v.muted ? 0 : v.volume) + 0.1); return hecho(); }
  if (k === 'ArrowLeft') { pcVolumen((v.muted ? 0 : v.volume) - 0.1); return hecho(); }
  if (k === 'ArrowUp') { zapTo(-1); return hecho(); }
  if (k === 'ArrowDown') { zapTo(1); return hecho(); }
  return false;
}

let hudTimer;
function hudVisible() {
  return $('#playerlayer').classList.contains('hud');
}

function showHud(focus = false) {
  const pl = $('#playerlayer');
  pl.classList.add('hud');
  if (focus && !pl.contains(document.activeElement)) $('#hud-close').focus();
  clearTimeout(hudTimer);
  if (!pl.classList.contains('error')) hudTimer = setTimeout(hideHud, 6000);
}

function hideHud() {
  const pl = $('#playerlayer');
  if (pl.classList.contains('error')) return;
  pl.classList.remove('hud');
}

// Zapping: lista de canales por la que se mueve el reproductor con ▲▼
const zap = { list: [], index: 0, timer: null, fuentes: [], fuente: 0, intento: 0 };

function hudChannel(c) {
  $('#hud-title').textContent = c.title;
  $('#hud-num').textContent = zap.list.length > 1 ? `${zap.index + 1} / ${zap.list.length}` : '';
  $('#hud-stats').textContent = 'Pidiendo el canal al motor…';
}

function play(c, list) {
  player.engine = engine;
  const pl = $('#playerlayer');
  const opening = !pl.classList.contains('open');
  zap.list = (list || listaZapping()).map((x) => x.id);
  if (!zap.list.includes(c.id)) zap.list.unshift(c.id);
  zap.index = zap.list.indexOf(c.id);
  pl.classList.add('open');
  pl.classList.remove('error');
  pl._channel = c;
  if (opening) focusStack.push(document.activeElement);
  hudChannel(c);
  showHud();
  if (WEBPC) { pl.classList.remove('lista', 'pausa'); pcControles(); $('#pc-volver').focus({ preventScroll: true }); }
  else $('#hud-close').focus();
  empezarFuentes(c);
  player.play(c);
}

function empezarFuentes(c) {
  zap.fuentes = enlacesDe(c);
  zap.fuente = 0;
  zap.intento++;
}

function zapTo(step) {
  if (zap.list.length < 2) return;
  zap.index = (zap.index + step + zap.list.length) % zap.list.length;
  const c = store.find(zap.list[zap.index]);
  if (!c) return;
  const pl = $('#playerlayer');
  pl._channel = c;
  pl.classList.remove('error');
  hudChannel(c);
  const z = $('#zap');
  z.innerHTML = `<b>${zap.index + 1}</b><span>${esc(c.title)}</span><small class="badge ${STATUS[statusOf(c)].cls}">${esc(STATUS[statusOf(c)].label)}</small>`;
  z.classList.add('show');
  // Espera un momento por si se pulsan varias veces seguidas
  clearTimeout(zap.timer);
  zap.timer = setTimeout(() => {
    z.classList.remove('show');
    empezarFuentes(c);
    apuntarVisto(c);
    player.play(c);
  }, 700);
}

function playerKeys(e) {
  const pl = $('#playerlayer');
  if (!pl.classList.contains('open') || activeLayer() !== pl) return;
  if (pcTeclas(e)) return;
  const k = e.key;
  if (k === 'ChannelUp' || k === 'PageUp' || k === 'MediaTrackPrevious') { e.preventDefault(); zapTo(-1); return; }
  if (k === 'ChannelDown' || k === 'PageDown' || k === 'MediaTrackNext') { e.preventDefault(); zapTo(1); return; }
  if (k === 'MediaPlayPause' || k === ' ') {
    e.preventDefault();
    const v = $('#video');
    if (v.paused) v.play().catch(() => {}); else v.pause();
    return;
  }
  if (!hudVisible()) {
    if (k === 'ArrowUp') { e.preventDefault(); zapTo(-1); return; }
    if (k === 'ArrowDown') { e.preventDefault(); zapTo(1); return; }
    if (k === 'Enter' || k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); showHud(true); return; }
  } else if (k !== 'Escape' && k !== 'GoBack' && k !== 'BrowserBack' && k !== 'Backspace') {
    showHud();
  }
}

// Los cambios seguidos (p. ej. al comprobar muchos canales) se juntan en un solo repintado, y mientras se ve un canal no se repinta la lista
function repintarCambio() {
  if ($('#playerlayer').classList.contains('open')) { ui.repintarAlSalir = true; return; }
  if (ui.tRepintar) return;   // ya hay un repintado en camino: recogerá este cambio también
  ui.tRepintar = setTimeout(() => { ui.tRepintar = null; if ($('#playerlayer').classList.contains('open')) ui.repintarAlSalir = true; else render(); }, 80);
}

function closePlayer() {
  const pl = $('#playerlayer');
  if (!pl.classList.contains('open')) return false;
  clearTimeout(zap.timer);
  $('#zap').classList.remove('show');
  pl.classList.remove('open', 'hud', 'error', 'lista', 'cargando', 'pausa', 'controles');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  player.close();
  if (ui.repintarAlSalir) { ui.repintarAlSalir = false; render(); }
  const prev = focusStack.pop();
  if (prev && document.contains(prev)) prev.focus();
  else focusFirst();
  return true;
}

// ---------- importar ----------

function importFinish(result, label, lista = null, quiet = false) {
  const { created, repeated } = store.addChannels(result.entries, lista);
  if (!quiet) {
    let msg = `${label}: ${created} canales nuevos`;
    if (repeated) msg += `, ${repeated} ya estaban`;
    if (result.invalid) msg += `, ${result.invalid} líneas no válidas`;
    toast(msg, created ? 'ok' : '');
  }
  return created;
}

// Descarga una lista con dirección e importa sus canales en ella
async function cargarFuente(src, { quiet = false } = {}) {
  if (!src.url) return { created: 0, total: store.channelsOf(src.id).length };
  const result = parseText(await fetchText(src.url));
  if (src.url.startsWith(IPTV_ORG)) {
    // iptv-org: «News;General» → «News» traducida; fuera lo de adultos; y solo las categorías elegidas
    const quiero = new Set(src.filtroCats || []);
    const nombres = Object.fromEntries(CATS_MUNDO);
    result.entries = result.entries.filter((x) => {
      const partes = String(x.category || '').split(';').map((t) => t.trim()).filter(Boolean);
      if (partes.some((t) => /^(xxx|adult)$/i.test(t))) return false;
      if (quiero.size && !partes.some((t) => quiero.has(t))) return false;
      const principal = partes.find((t) => !quiero.size || quiero.has(t)) || partes[0];
      x.category = principal ? (nombres[principal] || principal) : 'Otros';
      return true;
    });
  }
  const created = importFinish(result, src.name, src.id, quiet);
  src.fetchedAt = new Date().toISOString();
  src.count = result.entries.length;
  src.error = null;
  store.save();
  return { created, total: result.entries.length };
}

const sinExtension = (nombre) => String(nombre || '').replace(/\.(m3u8?|txt|json)$/i, '').replace(/[_]+/g, ' ').trim();

// Archivos: con uno se pregunta el nombre de la lista; con varios, cada uno es una lista con su nombre de archivo
async function importarArchivos(files) {
  let total = 0;
  for (const f of files) {
    let nombre = sinExtension(f.name);
    if (files.length === 1) {
      const v = await promptText('Nombre de la lista', nombre, { placeholder: 'Por ejemplo: Fútbol, Mis canales…', ok: 'Importar' });
      if (v === null) return;
      nombre = v.trim() || nombre;
    }
    try {
      const lista = store.localList(nombre);
      total += importFinish(parseText(await f.text()), lista.name, lista.id);
    } catch (err) { toast(`${f.name}: ${err.message}`, 'bad'); }
  }
  if (files.length > 1) toast(`${files.length} listas: ${total} canales nuevos`, total ? 'ok' : '');
}

async function anadirListaWeb() {
  const url = await promptText('Dirección de la lista', '', { placeholder: 'https://…/lista.m3u', ok: 'Siguiente' });
  if (!url) return;
  if (!/^https?:\/\//i.test(url.trim())) { toast('La dirección debe empezar por http:// o https://', 'bad'); return; }
  let u;
  try { u = new URL(url.trim()); } catch { toast('Dirección no válida', 'bad'); return; }
  const def = sinExtension(decodeURIComponent(u.pathname.split('/').pop() || '')) || u.hostname;
  const nombre = await promptText('Nombre de la lista', def, { ok: 'Importar' });
  if (nombre === null) return;
  try {
    const f = store.saveSource(nombre.trim() || def, u.href);
    await cargarFuente(f);
    renderListas();
  } catch (err) { toast(err.message, 'bad'); }
}

// ---------- pantalla Listas ----------

const canalesTxt = (n) => (n === 1 ? '1 canal' : `${n} canales`);

function listaFila(f) {
  const n = store.channelsOf(f.id).length;
  const tipo = f.builtin ? 'incluida' : f.url ? 'web' : 'archivo';
  const info = f.enabled === false ? 'desactivada' : f.url && !f.fetchedAt ? 'sin descargar' : `${canalesTxt(n)}${f.url && f.fetchedAt ? ` · ${ago(f.fetchedAt)}` : ''}`;
  return `<button class="srow lista${f.enabled === false ? ' apagada' : ''}" data-skey="l:${esc(f.id)}" data-lista="${esc(f.id)}">
    <span><i class="sw${f.enabled === false ? '' : ' on'}"></i>${esc(f.name)} <small class="muted">· ${tipo}</small>
      ${f.nota && f.enabled === false ? `<br><small class="muted">${esc(f.nota)}</small>` : ''}</span>
    <b>${esc(info)}</b></button>`;
}

function renderListas() {
  const sec = $('#sec-listas');
  if (!sec) return;
  const prevKey = document.activeElement?.dataset?.skey;
  const sueltos = store.allChannels.filter((c) => !c.listas.length).length;
  sec.innerHTML = `
    <div class="sec-head"><h1>Listas <small>${store.sources.length} listas · ${store.allChannels.length} canales</small></h1></div>
    <div class="settings">
      <h3>Añadir canales</h3>
      <button class="srow" data-skey="a:movil" data-add="movil" data-autofocus><span>Desde el móvil u ordenador</span><b>lo más cómodo ›</b></button>
      <button class="srow" data-skey="a:web" data-add="web"><span>Lista desde una dirección web…</span><b>›</b></button>
      <button class="srow" data-skey="a:file" data-add="file"><span>Lista desde archivos (uno o varios)…</span><b>›</b></button>
      <button class="srow" data-skey="a:one" data-add="one"><span>Un canal suelto…</span><b>›</b></button>
      <button class="srow" data-skey="a:mundo" data-add="mundo"><span>Canales en abierto de otros países (iptv-org)…</span><b>elige países ›</b></button>
      <h3>Tus listas · OK para ver, activar o desactivar</h3>
      ${store.sources.map(listaFila).join('')}
      ${sueltos ? `<button class="srow" data-skey="l:sueltos" data-sueltos><span>Canales sin lista</span><b>${canalesTxt(sueltos)}</b></button>` : ''}
      <button class="srow" data-skey="a:all" data-add="all"><span>Actualizar las listas web activas</span><b>⟳</b></button>
    </div>
    <input type="file" name="file" multiple accept=".json,.m3u,.m3u8,.txt,application/json,text/plain" hidden>`;
  $('[name=file]', sec).onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) { await importarArchivos(files); renderListas(); }
  };
  if (ui.section === 'listas' && prevKey) {
    const el = sec.querySelector(`[data-skey="${CSS.escape(prevKey)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

async function listasClick(e) {
  const add = e.target.closest('[data-add]')?.dataset.add;
  if (add === 'movil') openPhone();
  if (add === 'web') anadirListaWeb();
  if (add === 'file') $('#sec-listas [name=file]').click();
  if (add === 'one') openAdd();
  if (add === 'mundo') elegirPaises();
  if (add === 'all') { toast('Actualizando listas…'); await refreshSources(); renderListas(); }
  const l = e.target.closest('[data-lista]');
  if (l) openSource(l.dataset.lista);
  if (e.target.closest('[data-sueltos]')) { ui.listas = new Set(['-']); ui.category = null; showSection('canales'); render(); }
}

// ---------- canales en abierto del mundo (iptv-org) ----------
// Cada país elegido es una lista web aparte (se puede apagar o quitar), y se puede quedar solo con algunas categorías.
const IPTV_ORG = 'https://iptv-org.github.io/iptv/countries/';
const PAISES = [
  ['es', 'España'], ['pt', 'Portugal'], ['fr', 'Francia'], ['it', 'Italia'], ['de', 'Alemania'], ['uk', 'Reino Unido'],
  ['ie', 'Irlanda'], ['nl', 'Países Bajos'], ['be', 'Bélgica'], ['ch', 'Suiza'], ['at', 'Austria'], ['ad', 'Andorra'],
  ['us', 'Estados Unidos'], ['ca', 'Canadá'], ['mx', 'México'], ['ar', 'Argentina'], ['co', 'Colombia'], ['cl', 'Chile'],
  ['pe', 'Perú'], ['ve', 'Venezuela'], ['uy', 'Uruguay'], ['br', 'Brasil'], ['ma', 'Marruecos'], ['ro', 'Rumanía'],
];
const CATS_MUNDO = [
  ['News', 'Noticias'], ['Sports', 'Deportes'], ['Music', 'Música'], ['Documentary', 'Documentales'], ['Movies', 'Cine'],
  ['Series', 'Series'], ['Entertainment', 'Entretenimiento'], ['General', 'Generalistas'], ['Kids', 'Infantil'],
  ['Culture', 'Cultura'], ['Travel', 'Viajes'], ['Cooking', 'Cocina'], ['Weather', 'Tiempo'],
];
const fuentePais = (code) => store.sources.find((f) => f.url === `${IPTV_ORG}${code}.m3u`);

function elegirPaises() {
  const layer = openLayer('<div class="vmenu"></div>', { cls: 'wide' });
  const dlg = $('.dialog', layer);
  const cats = new Set(store.settings.mundoCats || []);
  const pintar = (foco) => {
    dlg.innerHTML = `<h2>Canales en abierto de otros países</h2>
      <p class="muted">De iptv-org, un proyecto público con canales de TV que emiten gratis por internet. Cada país se añade como una lista
        que luego puedes apagar o quitar en Listas. Para que la tele vaya ligera, elige solo los países que vayas a ver
        y, si quieres, solo algunas categorías.</p>
      <h3>Solo estas categorías <small class="muted">(ninguna marcada = todas)</small></h3>
      <div class="vmenu cols">${CATS_MUNDO.map(([k, l]) => `<button class="mbtn check${cats.has(k) ? ' on' : ''}" data-cm="${k}"><span><i class="sw${cats.has(k) ? ' on' : ''}"></i>${esc(l)}</span></button>`).join('')}</div>
      <h3>Países <small class="muted">OK para añadir o quitar</small></h3>
      <div class="vmenu cols">${PAISES.map(([k, l]) => { const f = fuentePais(k); return `<button class="mbtn check${f ? ' on' : ''}" data-pais="${k}"><span><i class="sw${f ? ' on' : ''}"></i>${esc(l)}</span><b>${f ? `${store.channelsOf(f.id).length}` : ''}</b></button>`; }).join('')}</div>
      <div class="vmenu" style="margin-top:.8rem"><button class="mbtn primary" data-close>Listo</button></div>`;
    focusEl((foco && dlg.querySelector(foco)) || dlg.querySelector('[data-pais]'));
  };
  pintar();
  layer.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cm]');
    if (c) {
      if (cats.has(c.dataset.cm)) cats.delete(c.dataset.cm); else cats.add(c.dataset.cm);
      store.setSettings({ mundoCats: [...cats] });
      pintar(`[data-cm="${c.dataset.cm}"]`);
      return;
    }
    const b = e.target.closest('[data-pais]');
    if (!b || b.disabled) return;
    const code = b.dataset.pais;
    const nombre = PAISES.find((x) => x[0] === code)[1];
    const f = fuentePais(code);
    if (f) {
      store.removeSource(f.id, { borrarCanales: true });
      toast(`${nombre} quitado`);
      pintar(`[data-pais="${code}"]`);
      return;
    }
    b.disabled = true;
    b.querySelector('b').textContent = 'cargando…';
    const nueva = store.saveSource(`Abierto · ${nombre}`, `${IPTV_ORG}${code}.m3u`);
    nueva.filtroCats = [...cats];
    nueva.nota = 'Canales en abierto de iptv-org (github.com/iptv-org/iptv). Algunos pueden no ir o estar limitados a su país.';
    try {
      const r = await cargarFuente(nueva, { quiet: true });
      toast(`${nombre}: ${r.created} canales`, 'ok');
    } catch (err) {
      store.removeSource(nueva.id);
      toast(`${nombre}: no se pudo descargar (${err.message})`, 'bad');
    }
    if (layer.isConnected) pintar(`[data-pais="${code}"]`);
  });
}

// Compatibilidad: «Importar» abre la pantalla de listas
function openImport() { showSection('listas'); }

function openSource(id) {
  const s = store.source(id);
  if (!s) return;
  const n = store.channelsOf(s.id).length;
  const layer = openLayer(`
    <h2>${esc(s.name)}</h2>
    ${s.nota ? `<p>${esc(s.nota)}</p>` : ''}
    ${s.url ? `<p class="mono muted">${esc(s.url)}</p>` : '<p class="muted">Lista cargada desde archivo o texto.</p>'}
    <p class="muted">${s.enabled === false ? 'Desactivada: sus canales no se muestran.' : `Activa · ${n} canales${s.url && s.fetchedAt ? ` · actualizada ${esc(ago(s.fetchedAt))}` : ''}`}</p>
    <div class="vmenu">
      ${s.enabled !== false && n ? '<button class="mbtn primary" data-s="ver" data-autofocus>Ver sus canales</button>' : ''}
      <button class="mbtn${s.enabled === false || !n ? ' primary' : ''}" data-s="toggle"${s.enabled === false || !n ? ' data-autofocus' : ''}>${s.enabled === false ? 'Activar lista' : 'Desactivar lista'}</button>
      ${s.enabled !== false && s.url ? '<button class="mbtn" data-s="load">Actualizar ahora</button>' : ''}
      ${s.builtin ? '' : '<button class="mbtn" data-s="rename">Cambiar el nombre</button>'}
      ${s.builtin ? '' : '<button class="mbtn danger" data-s="del">Quitar la lista</button>'}
      ${n ? '<button class="mbtn danger" data-s="delall">Quitar la lista y sus canales</button>' : ''}
      <div class="sep"></div>
      <button class="mbtn" data-close>Volver</button>
    </div>`);
  layer.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-s]')?.dataset.s;
    if (a === 'ver') { closeLayer(layer); ui.listas = new Set([s.id]); ui.category = null; ui.filter = 'all'; showSection('canales'); render(); return; }
    if (a === 'toggle') {
      const activar = s.enabled === false;
      store.setSourceEnabled(s.id, activar);
      closeLayer(layer);
      if (activar && s.url && !s.fetchedAt) {
        toast(`Descargando ${s.name}…`);
        try { await cargarFuente(s); } catch (err) { toast(`${s.name}: ${err.message}`, 'bad'); }
      } else {
        toast(activar ? `${s.name} activada` : `${s.name} desactivada`, 'ok');
      }
      renderListas();
    }
    if (a === 'load') {
      try { await cargarFuente(s); closeLayer(layer); renderListas(); }
      catch (err) { toast(`${s.name}: ${err.message}`, 'bad'); }
    }
    if (a === 'rename') {
      const v = await promptText('Nombre de la lista', s.name);
      if (v && v.trim()) { store.renameSource(s.id, v); closeLayer(layer); renderListas(); }
    }
    if (a === 'del' && await confirmBox(`¿Quitar la lista «${s.name}»? Sus canales se quedan, sin lista.`, 'Quitar')) {
      store.removeSource(s.id);
      closeLayer(layer);
      renderListas();
    }
    if (a === 'delall' && await confirmBox(`¿Quitar «${s.name}» y los canales que solo están en ella?`, 'Quitar todo')) {
      store.removeSource(s.id, { borrarCanales: true });
      closeLayer(layer);
      renderListas();
    }
  });
}

async function fetchText(url, charset) {
  // En la web el servidor local hace de intermediario (evita bloqueos CORS);
  // en la APK la petición sale directamente desde la tele.
  // Lo del propio servidor de casa (sincronizar, copias…) va directo: el servidor contesta con CORS
  const delServidor = store.settings.servidorCasa && url.startsWith(urlCasa(''));
  const target = NATIVE || delServidor ? url : `/proxy?url=${encodeURIComponent(url)}`;
  let res;
  try {
    res = await fetch(target, { cache: 'no-store' });
  } catch {
    throw new Error('No se pudo descargar la lista');
  }
  if (!res.ok) throw new Error(`La dirección respondió ${res.status}`);
  // Algunas webs (Marca) no están en UTF-8: se decodifica con su codificación para no romper los acentos
  if (charset) return new TextDecoder(charset).decode(await res.arrayBuffer());
  return res.text();
}

// Vuelve a descargar las fuentes activas
async function refreshSources(quiet = false) {
  let created = 0;
  for (const s of store.sources.filter((f) => f.enabled !== false && f.url)) {
    try { created += (await cargarFuente(s, { quiet })).created; }
    catch (err) { s.error = err.message; if (!quiet) toast(`${s.name}: ${err.message}`, 'bad'); }
  }
  return created;
}

// ---------- mantenimiento: liberar memoria, limpiar cachés y quitar lo que sobra ----------

const kb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function datosLocalesBytes() {
  let t = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('acelist-tv:')) t += k.length + (localStorage.getItem(k) || '').length; } } catch { /* nada */ }
  return t * 2;   // en memoria cada carácter ocupa 2 bytes
}

function abrirMantenimiento() {
  const apagadas = () => store.sources.filter((f) => f.enabled === false);
  const caidosLocal = () => store.data.channels.filter((c) => !c.favorite && (c.oculto === 'caido' || statusOf(c) === 'not_found')).length;
  let srv = null;   // lo que dice el servidor de casa (tiene todos los canales, también los de listas apagadas)
  const conServidor = () => !!store.settings.servidorCasa && store.settings.sincronizar !== false;
  const cuerpo = () => {
    const nApag = srv ? srv.listas.filter((l) => !l.activa).length : apagadas().length;
    const canApag = srv ? srv.listas.filter((l) => !l.activa).reduce((a, l) => a + l.solo, 0) : null;
    const nCaidos = srv ? srv.caidos : caidosLocal();
    return `
      <h2>Mantenimiento</h2>
      <p class="muted">En esta tele: ${plural(store.data.channels.length, 'canal', 'canales')} guardados · ${kb(datosLocalesBytes())} de datos en memoria${srv ? ` · en el servidor: ${plural(srv.canales, 'canal', 'canales')}` : ''}.</p>
      <div class="vmenu">
        <button class="mbtn primary" data-m="ram" data-autofocus><span>Liberar memoria y limpiar cachés</span><b>reinicia HomeTV</b></button>
        <p class="muted small">Borra las cachés de la agenda y de la guía y los archivos temporales, y vuelve a abrir la app: es lo que más libera si la tele va lenta tras varios días encendida. No pierdes canales ni favoritos.</p>
        <button class="mbtn danger" data-m="apagadas"${nApag ? '' : ' disabled'}><span>Quitar las listas apagadas${canApag != null ? ` y sus ${plural(canApag, 'canal', 'canales')}` : ' y sus canales'}</span><b>${nApag ? plural(nApag, 'lista', 'listas') : 'ninguna'}</b></button>
        <p class="muted small">${conServidor() ? 'Se quitan del servidor, así que también de las demás teles. ' : ''}Los favoritos y los canales que estén también en otra lista se quedan. Antes se guarda una copia de seguridad${conServidor() ? '' : ' (recupérala desde Ajustes)'}.</p>
        <button class="mbtn danger" data-m="caidos"${nCaidos ? '' : ' disabled'}><span>Borrar los canales que ya no existen</span><b>${nCaidos}</b></button>
        <div class="sep"></div>
        <button class="mbtn" data-close>Volver</button>
      </div>`;
  };
  const layer = openLayer(cuerpo(), { cls: 'wide' });
  const repintar = () => { const v = layer.querySelector('.dialog'); if (v) { const foco = document.activeElement?.dataset?.m; v.innerHTML = cuerpo(); focusEl(v.querySelector(`[data-m="${foco}"]`) || v.querySelector('[data-autofocus]')); } };
  if (conServidor()) {
    fetchText(`${urlCasa('/api/mantenimiento')}?${Date.now()}`).then((t) => { const r = JSON.parse(t); if (!r.vacio && layer.isConnected) { srv = r; repintar(); } }).catch(() => { /* sin servidor: se usan los datos de esta tele */ });
  }
  layer.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    if (m === 'ram') {
      let n = 0;
      try { localStorage.removeItem('acelist-tv:agenda2'); localStorage.removeItem('acelist-tv:guia'); } catch { /* nada */ }
      if (NATIVE && plugins.Nativo.limpiarCache) { try { n = (await plugins.Nativo.limpiarCache()).bytes || 0; } catch { /* nada */ } }
      toast(`Cachés limpias${n ? ` (${kb(n)} de archivos temporales)` : ''}. Reiniciando…`, 'ok');
      store.escribirPendiente();
      setTimeout(() => location.reload(), 900);
      return;
    }
    const caidos = m === 'caidos';
    const texto = caidos
      ? 'Se borran los canales que el motor da por inexistentes o que se archivaron solos por llevar días caídos (no los favoritos).'
      : `Se quitan las listas apagadas y los canales que solo estaban en ellas${conServidor() ? ', en el servidor y en todas las teles' : ''}. Los favoritos se quedan.`;
    if (!await confirmBox(texto, caidos ? 'Borrar canales' : 'Quitar listas')) return;
    closeLayer(layer);
    try {
      if (conServidor() && srv) {
        const res = await fetch(urlCasa('/api/mantenimiento'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(caidos ? { caidos: true } : { apagadas: true }) });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || `Error ${res.status}`);
        await traerSincro(true);
        toast(caidos ? `${plural(r.caidos, 'canal borrado', 'canales borrados')}` : `${plural(r.listas, 'lista quitada', 'listas quitadas')} y ${plural(r.canales, 'canal', 'canales')}`, 'ok');
      } else if (caidos) {
        const fuera = store.data.channels.filter((c) => !c.favorite && (c.oculto === 'caido' || statusOf(c) === 'not_found'));
        const ids = new Set(fuera.map((c) => c.id));
        store.data.channels = store.data.channels.filter((c) => !ids.has(c.id));
        store.save();
        toast(`${plural(ids.size, 'canal borrado', 'canales borrados')}`, 'ok');
      } else {
        const antes = store.data.channels.length;
        for (const f of apagadas()) store.removeSource(f.id, { borrarCanales: true });
        toast(`Listas apagadas quitadas (${plural(antes - store.data.channels.length, 'canal', 'canales')})`, 'ok');
      }
      render();
      if (ui.section === 'ajustes') renderSettings();
    } catch (err) { toast(err.message || 'No se pudo hacer', 'bad'); }
  });
}

// ---------- ajustes ----------

// Ajustes: cada fila es un botón; OK pasa al siguiente valor (nada de desplegables ni teclado).
const SETTING_ROWS = [
  { title: 'Canales y móvil' },
  { action: 'listas', label: 'Mis listas de canales (añadir, apagar, borrar)', value: () => `${store.sources.length} ›` },
  { action: 'movil', label: 'Controlar HomeTV desde el móvil', si: () => !(!NATIVE && location.pathname.startsWith('/tv')) },
  { title: 'Pantalla' },
  { key: 'diseno', label: 'Diseño', values: () => (TACTIL ? ['auto', 'tele', 'movil'] : ['auto', 'tele']),
    show: (v) => (v === 'tele' ? 'Tele (mando)' : v === 'movil' ? 'Móvil (táctil)' : `Automático · ${MOVIL ? 'móvil' : 'tele'}`) },
  { title: 'Reproducción' },
  { key: 'player', label: 'Reproductor preferido', values: () => Object.keys(PLAYERS), show: (v) => PLAYERS[v] },
  { key: 'intro', label: 'Vídeo de entrada al abrir la app', values: () => [true, false], show: (v) => (v !== false ? 'Sí' : 'No') },
  { key: 'filasCategorias', label: 'Filas por categoría en Inicio', values: () => [true, false], show: (v) => (v !== false ? 'Sí' : 'No') },
  { key: 'inicioLista', label: 'Inicio en modo lista (más limpio)', values: () => [false, true], show: (v) => (v ? 'Sí' : 'No') },
  { key: 'formatoStream', label: 'Formato de Ace Stream (reproductor interno)', values: () => ['ts', 'hls'],
    show: (v) => (v === 'hls' ? 'HLS troceado (si se congela la imagen)' : 'Normal (TS)') },
  { key: 'okAction', label: MOVIL ? 'Al tocar un canal' : NATIVE ? 'Al pulsar OK en un canal' : 'Al hacer clic en un canal', values: () => ['ficha', 'reproducir'], show: (v) => (v === 'reproducir' ? 'Reproducir' : 'Abrir su ficha') },
  { key: 'view', label: 'Vista de canales', values: () => ['list', 'grid'], show: (v) => (v === 'grid' ? 'Cuadrícula' : 'Lista') },
  { key: 'agrupar', label: 'Juntar enlaces del mismo canal', values: () => [true, false], show: (v) => (v ? 'Sí' : 'No') },
  { key: 'logos', label: 'Logos de los canales', values: () => [true, false], show: (v) => (v !== false ? 'Sí' : 'No (más ligero)') },
  { key: 'orden', label: 'Orden de los canales', values: () => Object.keys(ORDENES), show: (v) => ORDENES[v] },
  { title: 'Comprobación de canales' },
  { key: 'minPeers', label: 'Peers mínimos para «vivo»', values: () => [0, 1, 2, 3, 5, 10] },
  { key: 'timeoutSec', label: 'Tiempo máximo por canal', values: () => [10, 15, 20, 30, 45, 60], show: (v) => `${v} s` },
  { key: 'concurrency', label: 'Canales a la vez', values: () => [1, 2, 3, 4] },
  { key: 'retryFailed', label: 'Reintentar los que fallen', values: () => [true, false], show: (v) => (v ? 'Sí' : 'No') },
  ...(!NATIVE && location.pathname.startsWith('/tv') ? [{ key: 'calidadWeb', label: 'Calidad de imagen en esta web', values: () => ['auto', 'original', 'baja'], show: (v) => ({ original: 'Original (en casa)', baja: 'Ligera 720p (fuera de casa)' })[v] || 'Automática' }] : []),
  { key: 'okLargo', label: 'Mantener pulsado OK en un canal', values: () => ['fav', 'opciones'], show: (v) => (v === 'opciones' ? 'Abre sus opciones' : 'Lo añade o quita de favoritos') },
  { key: 'preComprobar', label: 'Preparar canales 15 min antes de los partidos', values: () => ['marcados', 'todos', 'no'], show: (v) => ({ todos: 'Todos los partidos', no: 'No', marcados: 'Solo los marcados 🔔' })[v === false ? 'no' : v === true ? 'marcados' : v] || 'Solo los marcados 🔔' },
  { action: 'equipos', label: 'Equipos favoritos (sus partidos se marcan solos con 🔔)', value: () => (equiposFav().length ? `${equiposFav().join(', ')} ›` : 'Ninguno ›') },
  { key: 'autoVerify', label: 'Comprobar al abrir la app', values: () => [false, true], show: (v) => (v ? 'Sí' : 'No') },
  { key: 'autoVerifyHours', label: 'Recomprobar si han pasado', values: () => [1, 3, 6, 12, 24, 48], show: (v) => `${v} h` },
  { key: 'hideDead', label: 'Ocultar no encontrados en «Todos»', values: () => [false, true], show: (v) => (v ? 'Sí' : 'No') },
  { title: 'Listas' },
  { action: 'unificar', label: 'Juntar categorías repetidas («MOTOR» y «Motor»)' },
  { action: 'ocultas', label: 'Ocultar categorías', value: () => { const n = (store.settings.catOcultas || []).length; return n ? `${n} ocultas ›` : 'Ninguna ›'; } },
  { key: 'refreshSources', label: 'Actualizar fuentes al abrir la app', values: () => [false, true], show: (v) => (v ? 'Sí' : 'No') },
  { title: 'VPN' },
  { action: 'warp', label: 'Estado de la conexión', value: () => warpTexto() },
  { action: 'vpn:warp', label: 'Cloudflare WARP (app 1.1.1.1) · gratis', value: () => vpnAppTexto('warp') },
  { action: 'vpn:proton', label: 'Proton VPN · gratis', value: () => vpnAppTexto('proton') },
  { action: 'vpnayuda', label: '¿Cuál uso?' },
  { title: 'Servidor de casa' },
  { action: 'casa', label: 'Servidor de casa (motor, copias y actualizaciones)', value: () => casaTexto() },
  { action: 'vpncasa', label: 'VPN del motor (Cloudflare WARP en el servidor)', value: () => vpnCasaTexto(), si: () => !!store.settings.servidorCasa },
  { key: 'tvPorVpn', label: 'Canales de TV (IPTV/HLS) por la VPN del servidor', values: () => [true, false],
    show: (v) => (v !== false ? (ui.casa?.vpn?.activa ? 'Sí' : 'Sí (cuando la VPN esté activa)') : 'No'),
    si: () => !!store.settings.servidorCasa && !!ui.casa?.vpn?.pasarela },
  { action: 'copiaya', label: 'Hacer una copia ahora', value: () => (ui.casa?.ultimaCopia ? `última: ${ui.casa.ultimaCopia.replace(/^copia-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d).*$/, '$3/$2 $4:$5')} ›` : '›'), si: () => !!store.settings.servidorCasa },
  { action: 'restaurar', label: 'Recuperar una copia del servidor…', si: () => !!store.settings.servidorCasa },
  { key: 'sincroLigero', label: 'Tele ligera: no guardar aquí los canales de listas apagadas (van más rápido)', values: () => [true, false], show: (v) => (v !== false ? 'Sí' : 'No'), si: () => !!store.settings.servidorCasa && store.settings.sincronizar !== false },
  { key: 'sincronizar', label: 'Compartir canales y favoritos con las otras teles', values: () => [true, false], show: (v) => (v !== false ? 'Sí' : 'No'), si: () => !!store.settings.servidorCasa },
  { title: 'Mantenimiento' },
  { action: 'mant', label: 'Mantenimiento: liberar memoria y aligerar la app', value: () => '›' },
  { title: 'Actualizaciones de la app' },
  { action: 'version', label: 'Actualizar HomeTV', value: () => versionTexto() },
  { key: 'urlActualizaciones', label: 'Dirección de actualizaciones', text: true, native: true },
  { title: 'Motor de Ace Stream' },
  { key: 'engineUrl', label: 'Dirección del motor', text: true },
  { action: 'test', label: 'Probar el motor' },
  { title: 'Copia de seguridad' },
  { action: 'export', label: 'Exportar canales (JSON de AceList)', web: true },
  { action: 'm3u', label: 'Exportar lista M3U', web: true },
  { action: 'wipe', label: 'Borrar todos los canales', danger: true },
];

// Lo de todos los días va a la vista; el resto, en «Ajustes avanzados»
const AJUSTES_BASICOS = new Set(['a:listas', 'a:movil', 'player', 'okAction', 'view', 'orden', 'agrupar', 'preComprobar', 'a:equipos', 'a:casa', 'a:vpncasa', 'a:copiaya', 'a:restaurar', 'a:mant', 'a:version']);
const TITULOS_BASICOS = { 'Comprobación de canales': 'Partidos' };
const idFila = (r) => (r.action ? `a:${r.action}` : r.key);

function filasAjustes() {
  const av = !!ui.ajustesAv;
  const out = [];
  if (av) out.push({ action: 'basicos', label: '‹ Volver a Ajustes' });
  let titulo = null;
  let puesto = true;
  for (const r of SETTING_ROWS) {
    if (r.title) { titulo = av ? r : { title: TITULOS_BASICOS[r.title] || r.title }; puesto = false; continue; }
    if ((r.web && NATIVE) || (r.native && !NATIVE) || (r.si && !r.si())) continue;
    if (AJUSTES_BASICOS.has(idFila(r)) === av) continue;
    if (titulo && !puesto) { out.push(titulo); puesto = true; }   // el título solo sale si le sigue alguna fila
    out.push(r);
  }
  if (!av) out.push({ title: 'Más' }, { action: 'avanzado', label: 'Ajustes avanzados', value: () => 'comprobación, VPN, motor, copias… ›' });
  return out;
}

function renderSettings() {
  const s = store.settings;
  const sec = $('#sec-ajustes');
  const focusedKey = document.activeElement?.dataset?.skey;
  sec.innerHTML = `
    <div class="sec-head"><h1>${ui.ajustesAv ? 'Ajustes avanzados' : 'Ajustes'}</h1></div>
    <div class="settings">
      ${filasAjustes().map((r) => {
        if (r.title) return `<h3>${esc(r.title)}</h3>`;
        if (r.web && NATIVE) return '';
        if (r.native && !NATIVE) return '';
        if (r.si && !r.si()) return '';
        if (r.action) return `<button class="srow${r.danger ? ' danger' : ''}" data-skey="a:${r.action}" data-action="${r.action}"><span>${esc(r.label)}</span><b>${r.value ? esc(r.value()) : '›'}</b></button>`;
        const v = s[r.key];
        const shown = r.text ? v : r.show ? r.show(v) : String(v);
        const vals = r.values ? r.values() : [];
        return `<button class="srow" data-skey="${r.key}" data-setting="${r.key}"><span>${esc(r.label)}</span>
          <b>${esc(shown)}${vals.length ? ` <small>${vals.indexOf(v) + 1}/${vals.length}</small>` : ''}</b></button>`;
      }).join('')}
    </div>
    <p class="muted small">HomeTV ${VERSION}${NATIVE ? '' : ' · versión web'}</p>`;
  if (focusedKey) {
    const el = sec.querySelector(`[data-skey="${CSS.escape(focusedKey)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

async function settingClick(e) {
  const row = e.target.closest('[data-setting]');
  if (row) {
    const def = SETTING_ROWS.find((r) => r.key === row.dataset.setting);
    const cur = store.settings[def.key];
    if (def.key === 'urlActualizaciones') {
      const v = await promptText(def.label, cur || '', { placeholder: 'https://…/ (carpeta con version.txt y HomeTV.apk)' });
      if (v === null) return;
      store.setSettings({ urlActualizaciones: v.trim() });
      buscarActualizacion(true);
      return;
    }
    if (def.text) {
      const v = await promptText(def.label, cur, { placeholder: NATIVE ? 'http://127.0.0.1:6878' : '/engine' });
      if (v === null) return;
      store.setSettings({ [def.key]: v.trim() || (NATIVE ? 'http://127.0.0.1:6878' : '/engine') });
      engine = makeEngine();
      checkEngine(true);
      return;
    }
    const vals = def.values();
    const next = vals[(vals.indexOf(cur) + 1) % vals.length];
    store.setSettings({ [def.key]: next });
    if (def.key === 'diseno') { store.escribirPendiente(); setTimeout(() => location.reload(), 150); return; }
    if (def.key === 'sincroLigero') { ui.sincro.huella = null; if (next === false) traerSincro(true); else empujarSincro(); }   // apagada: se piden todos los canales; encendida: se suben los cambios y se quitan los de listas apagadas
    if (def.key === 'filasCategorias' || def.key === 'inicioLista') renderHome();
    if (def.key === 'view' || def.key === 'agrupar') render();
    return;
  }
  const act = e.target.closest('[data-action]')?.dataset.action;
  if (act === 'test') checkEngine(true);
  if (act === 'version') { if (!NATIVE || ui.nueva) ayudaActualizar(); else buscarActualizacion(true); }   // un solo botón: busca, y si hay versión nueva la instala
  if (act === 'mant') abrirMantenimiento();
  if (act === 'listas') showSection('listas');
  if (act === 'movil') openPhone();
  if (act === 'avanzado' || act === 'basicos') {
    ui.ajustesAv = act === 'avanzado';
    renderSettings();
    focusEl(act === 'basicos' ? $('#sec-ajustes [data-skey="a:avanzado"]') : $('#sec-ajustes .srow'));
    return;
  }
  if (act === 'casa') configurarCasa();
  if (act === 'copiaya') subirCopia(true);
  if (act === 'equipos') ajustesEquipos();
  if (act === 'vpncasa') { estadoCasa(); ayudaVpnCasa(); }
  if (act === 'restaurar') recuperarCopia();
  if (act === 'ocultas') elegirOcultas();
  if (act === 'unificar') { const n = store.unificarCategorias(); store.save(); toast(n ? `${n} canales cambiados de categoría` : 'No había categorías repetidas', 'ok'); }
  if (act === 'warp') { await checkWarp(); toast(warpTexto(), ui.warp?.on || ui.warp?.vpn ? 'ok' : ''); }
  if (act && act.startsWith('vpn:')) abrirVpn(act.slice(4));
  if (act === 'vpnayuda') vpnAyuda();
  if (act === 'export') download('acelist-tv.json', store.exportJson(), 'application/json');
  if (act === 'm3u') download('acelist-tv.m3u', toM3U(visibleChannels(), 'http://127.0.0.1:6878'), 'audio/x-mpegurl');
  if (act === 'wipe' && await confirmBox(`¿Borrar los ${store.channels.length} canales? No se puede deshacer.`, 'Borrar todo')) {
    store.data.channels = [];
    store.save();
    toast('Canales borrados');
  }
}

function download(name, text, type) {
  if (NATIVE) {
    toast('Exportar desde la tele aún no está disponible: hazlo desde la versión web', 'bad');
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- añadir canal a mano ----------

async function openAdd() {
  const raw = await promptText('Enlace acestream:// o Content ID', '', { placeholder: 'acestream://…', ok: 'Siguiente' });
  if (raw === null) return;
  const id = parseContentId(raw);
  if (!id) { toast('No es un enlace válido (40 caracteres hexadecimales)', 'bad'); return; }
  if (store.find(id)) { toast('Ese canal ya estaba'); return; }
  const title = await promptText('Nombre del canal', '', { ok: 'Siguiente' });
  if (title === null) return;
  const category = await chooseCategory(null);
  store.addChannels([{ id, title, category: category || null }]);
  toast('Canal añadido', 'ok');
}

// ---------- panel del móvil ----------

function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function channelDto(c) {
  const chk = lastCheck(c);
  return {
    id: c.id,
    title: c.title,
    category: c.category,
    favorite: !!c.favorite,
    status: statusOf(c),
    peers: chk?.peers ?? null,
    checkedAt: chk?.at ?? null,
    checking: ui.checking.has(c.id),
    listas: c.listas,
    abierto: !!c.url,
  };
}

function ajustesDto() {
  const out = [];
  for (const r of SETTING_ROWS) {
    if (r.title) out.push({ titulo: r.title });
    else if (r.key) {
      out.push({
        key: r.key, label: r.label, texto: !!r.text, valor: String(store.settings[r.key]),
        opciones: r.values ? r.values().map((v) => ({ v: String(v), l: r.show ? r.show(v) : String(v) })) : null,
      });
    }
  }
  // Fuera los títulos sin ajustes debajo (VPN, copia… son acciones de la tele)
  return out.filter((r, i) => !r.titulo || (out[i + 1] && !out[i + 1].titulo));
}

function fromPhone(msg) {
  toast(`Desde el móvil: ${msg}`, 'ok');
}

async function api(method, path, body) {
  const route = `${method} ${path}`;
  switch (route) {
    case 'GET /api/estado':
      return {
        app: VERSION,
        motor: ui.engineOk,
        canales: store.channels.length,
        vivos: store.channels.filter((c) => statusOf(c) === 'alive').length,
        categorias: store.categories(),
        ocultas: (store.settings.catOcultas || []).map((nombre) => ({
          nombre, n: store.channelsConOcultas.filter((c) => c.category && claveCat(c.category) === claveCat(nombre)).length })),
        fuentes: store.sources.map((x) => ({ id: x.id, name: x.name, url: x.url, fetchedAt: x.fetchedAt, count: x.count, activa: x.enabled !== false, incluida: !!x.builtin, nota: x.nota || null })),
        comprobando: ui.batch ? { total: ui.batch.total, hechos: ui.batch.done, vivos: ui.batch.alive } : null,
        reproductores: PLAYERS,
        reproductor: store.settings.player,
        vpn: warpTexto(),
        nativa: NATIVE,
        ordenes: ORDENES,
        servidorCasa: store.settings.servidorCasa ? urlCasa('/') : '',
        orden: store.settings.orden || 'recomendado',
        ajustes: ajustesDto(),
      };
    case 'POST /api/ajustes': {
      const cambios = {};
      for (const [k, v] of Object.entries(body || {})) {
        const def = SETTING_ROWS.find((r) => r.key === k);
        if (!def) throw apiError(400, `Ajuste desconocido: ${k}`);
        if (def.text) cambios[k] = String(v || '').trim() || defaultSettings(NATIVE)[k];
        else {
          const val = def.values().find((x) => String(x) === String(v));
          if (val === undefined) throw apiError(400, `Valor no válido para ${def.label}`);
          cambios[k] = val;
        }
      }
      store.setSettings(cambios);
      if ('engineUrl' in cambios) { engine = makeEngine(); checkEngine(); }
      render();
      fromPhone('ajustes cambiados');
      return { ajustes: ajustesDto() };
    }
    case 'POST /api/lote': {
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const lista = store.data.channels.filter((c) => ids.has(c.id));
      if (!lista.length) throw apiError(400, 'No hay canales seleccionados');
      const a = body.accion;
      if (a === 'fav') for (const c of lista) c.favorite = !!body.valor;
      else if (a === 'categoria') { const cat = limpiarTitulo(String(body.valor || '')) || null; for (const c of lista) c.category = cat; }
      else if (a === 'lista') { const l = store.localList(String(body.valor || '')); for (const c of lista) if (!c.listas.includes(l.id)) c.listas.push(l.id); }
      else if (a === 'quitar-lista') for (const c of lista) c.listas = c.listas.filter((id) => id !== body.valor);
      else if (a === 'borrar') store.data.channels = store.data.channels.filter((c) => !ids.has(c.id));
      else if (a === 'comprobar') {
        if (ui.batch) throw apiError(409, 'Ya hay una comprobación en marcha');
        verifyMany(lista);
        return { total: lista.length };
      } else throw apiError(400, 'Acción desconocida');
      store.save();
      fromPhone(`${lista.length} canales cambiados`);
      return { total: lista.length };
    }
    case 'POST /api/categoria-ocultar':
      ocultarCategoria(String(body.nombre || ''), !!body.oculta);
      render();
      return { ok: true };
    case 'POST /api/unificar': {
      const n = store.unificarCategorias();
      store.save();
      return { total: n };
    }
    case 'POST /api/categoria': {
      const de = String(body.de || '');
      const a = limpiarTitulo(String(body.a || '')) || null;
      let n = 0;
      for (const c of store.data.channels) if ((c.category || '') === de) { c.category = a; n++; }
      store.save();
      if (ui.category === de) ui.category = a;
      fromPhone(a ? `categoría «${de}» ahora es «${a}»` : `categoría «${de}» quitada`);
      return { total: n };
    }
    case 'POST /api/fuente-renombrar': {
      const f = store.source(String(body.id || ''));
      if (!f) throw apiError(404, 'Esa lista no existe');
      if (f.builtin) throw apiError(400, 'La lista incluida no se puede renombrar');
      store.renameSource(f.id, String(body.nombre || ''));
      return { ok: true };
    }
    case 'POST /api/fuente-actualizar': {
      const f = store.source(String(body.id || ''));
      if (!f) throw apiError(404, 'Esa lista no existe');
      if (!f.url) throw apiError(400, 'Esta lista no tiene dirección web: se añadió con un archivo o texto');
      try {
        const r = await cargarFuente(f, { quiet: true });
        return { created: r.created };
      } catch (e) {
        throw apiError(502, `No se pudo descargar: ${e.message}`);
      }
    }
    case 'POST /api/exportar': {
      if (body.formato === 'm3u') return { nombre: 'acelist-tv.m3u', texto: toM3U(store.channels, 'http://127.0.0.1:6878') };
      return { nombre: 'acelist-tv.json', texto: store.exportJson() };
    }
    case 'POST /api/borrar-todo':
      store.data.channels = [];
      store.save();
      fromPhone('canales borrados');
      return { ok: true };
    case 'GET /api/canales':
      return store.channels.map(channelDto);
    case 'POST /api/importar': {
      const r = parseText(String(body.texto || ''));
      const lista = String(body.lista || '').trim() ? store.localList(body.lista) : null;
      const { created, repeated } = store.addChannels(r.entries, lista ? lista.id : null);
      if (created) fromPhone(`${created} canales nuevos`);
      return { created, repeated, invalid: r.invalid };
    }
    case 'POST /api/importar-url': {
      const url = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw apiError(400, 'La URL debe empezar por http:// o https://');
      const r = parseText(await fetchText(url));
      let fuente = null;
      if (body.guardar) {
        const u = new URL(url);
        fuente = store.saveSource(String(body.nombre || '').trim() || u.hostname + u.pathname, url);
        fuente.fetchedAt = new Date().toISOString();
        fuente.count = r.entries.length;
      }
      const { created, repeated } = store.addChannels(r.entries, fuente ? fuente.id : null);
      if (created) fromPhone(`${created} canales nuevos`);
      return { created, repeated, invalid: r.invalid };
    }
    case 'POST /api/fuentes': {
      const created = await refreshSources(true);
      if (created) fromPhone(`fuentes actualizadas, ${created} canales nuevos`);
      return { created };
    }
    case 'POST /api/fuente-borrar':
      store.removeSource(String(body.id || body.url || ''), { borrarCanales: !!body.borrarCanales });
      return { ok: true };
    case 'POST /api/fuente-activar': {
      const f = store.source(String(body.id || ''));
      if (!f) throw apiError(404, 'Esa fuente no existe');
      store.setSourceEnabled(f.id, !!body.activa);
      if (body.activa && !f.fetchedAt) await cargarFuente(f, { quiet: true });
      fromPhone(`${f.name} ${body.activa ? 'activada' : 'desactivada'}`);
      return { ok: true };
    }
    case 'POST /api/canal': {
      const c = store.find(body.id);
      if (!c) throw apiError(404, 'Ese canal ya no existe');
      const patch = {};
      if (typeof body.title === 'string' && body.title.trim()) { patch.title = body.title.trim().slice(0, 200); patch.titlePending = false; }
      if ('category' in body) patch.category = String(body.category || '').trim() || null;
      if ('favorite' in body) patch.favorite = !!body.favorite;
      store.updateChannel(c.id, patch);
      return channelDto(c);
    }
    case 'POST /api/borrar': {
      const ids = new Set(Array.isArray(body.ids) ? body.ids : [body.id]);
      const before = store.channels.length;
      store.data.channels = store.data.channels.filter((c) => !ids.has(c.id));
      store.save();
      const n = before - store.channels.length;
      if (n) fromPhone(n === 1 ? 'canal eliminado' : `${n} canales eliminados`);
      return { borrados: n };
    }
    case 'POST /api/comprobar': {
      if (ui.batch) throw apiError(409, 'Ya hay una comprobación en marcha');
      if (ui.engineOk === false) await checkEngine();
      if (ui.engineOk === false) throw apiError(503, 'El motor de Ace Stream de la tele no responde');
      const ids = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids) : null;
      const list = ids ? store.channels.filter((c) => ids.has(c.id)) : store.channels;
      verifyMany(list);
      return { total: list.length };
    }
    case 'GET /api/agenda':
      return agenda.resumen();
    case 'POST /api/reproducir': {
      const c = store.find(body.id);
      if (!c) throw apiError(404, 'Ese canal ya no existe');
      const app = body.app in PLAYERS ? body.app : store.settings.player;
      const lista = Array.isArray(body.lista) ? body.lista.map((id) => store.find(id)).filter(Boolean) : undefined;
      closePlayer();
      while (closeLayer()) { /* cierra los diálogos abiertos */ }
      await openWith(app, c, lista);
      return { ok: true };
    }
    default:
      throw apiError(404, `No existe ${route}`);
  }
}

const puente = new Puente({ native: NATIVE, plugin: plugins.Nativo, handler: api });

async function startPhone() {
  const s = store.settings;
  // Claves antiguas (largas) se cambian por una corta de 6 caracteres
  if (!/^[a-z0-9]{6}$/.test(s.movilToken || '')) store.setSettings({ movilToken: newToken() });
  return puente.iniciar(store.settings.movilToken, Number(store.settings.movilPuerto) || 8095);
}

function qrSvg(text) {
  /* global qrcode */
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

async function openPhone() {
  const layer = openLayer('<h2>Controlar desde el móvil</h2><p class="muted">Preparando…</p>', { cls: 'wide' });
  const dialog = $('.dialog', layer);
  const draw = (error) => {
    const s = store.settings;
    const url = puente.activo ? puente.url(s.movilToken) : '';
    dialog.innerHTML = `
      <h2>Controlar desde el móvil</h2>
      ${puente.activo ? `
        <div class="phone">
          <div class="qr">${qrSvg(url)}</div>
          <div>
            <p>Escanea el código con la cámara del móvil, o escribe esta dirección en el navegador del móvil o del ordenador (en la misma red):</p>
            <p class="url">${esc(url.replace(/^http:\/\//, ''))}</p>
            <p class="muted small">Desde el móvil puedes importar listas, renombrar y ordenar canales por categoría, borrar, comprobar
              y mandar un canal a reproducir en la tele. Funciona mientras HomeTV esté abierta.</p>
          </div>
        </div>` : `<p>${error ? `<span class="bad-text">${esc(error)}</span>` : 'El panel del móvil está apagado.'}</p>`}
      <div class="actions">
        ${puente.activo
          ? '<button class="btn" data-off>Apagar</button><button class="btn" data-newtoken>Cambiar la clave</button>'
          : '<button class="btn primary" data-on data-autofocus>Encender</button>'}
        <button class="btn${puente.activo ? ' primary' : ''}" data-close${puente.activo ? ' data-autofocus' : ''}>Cerrar</button>
      </div>`;
    focusFirst(layer);
  };
  const turnOn = async () => {
    try {
      await startPhone();
      store.setSettings({ movilActivo: true });
      draw();
    } catch (e) {
      draw(`No se pudo encender: ${e.message || e}`);
    }
  };
  dialog.addEventListener('click', async (e) => {
    if (e.target.closest('[data-on]')) await turnOn();
    if (e.target.closest('[data-off]')) { await puente.detener(); store.setSettings({ movilActivo: false }); draw(); }
    if (e.target.closest('[data-newtoken]')) { store.setSettings({ movilToken: newToken() }); await turnOn(); }
  });
  if (puente.activo) draw();
  else await turnOn();
}

// ---------- arranque ----------

// ---------- Cloudflare WARP ----------
// Se comprueba con la página de diagnóstico de Cloudflare (warp=on / off / plus).

ui.warp = null;

// VPN gratuitas que funcionan en Google TV. HomeTV no hace de VPN: abre la app y comprueba si la conexión pasa por ella.
const VPNS = {
  warp: {
    nombre: 'Cloudflare WARP', paquete: 'com.cloudflare.onedotonedotonedotone',
    texto: `<p>Es la app <b>1.1.1.1</b> de Cloudflare. Gratis, sin cuenta y sin límite de datos. Al activar «WARP» todo el tráfico de la tele
      sale por Cloudflare, normalmente desde un servidor cercano (no cambia de país).</p>
      <p>En algunas teles no aparece en la Play Store; entonces se instala su APK con <b>Downloader</b> o <b>Send Files to TV</b>.</p>`,
  },
  proton: {
    nombre: 'Proton VPN', paquete: 'ch.protonvpn.android',
    texto: `<p>Tiene app para Android TV / Google TV en la Play Store. El plan gratuito no tiene límite de datos ni anuncios,
      pero necesita una cuenta gratuita de Proton y elige el servidor por ti entre unos pocos países.</p>
      <p>Al abrirla por primera vez muestra un código: entra en <b>protonvpn.com/tv</b> desde el móvil, inicia sesión y escribe el código.</p>`,
  },
};

function warpTexto() {
  const w = ui.warp;
  if (!w) return 'Comprobando…';
  if (w.error) return 'No se pudo comprobar';
  const donde = w.loc ? ` · salida ${w.loc}` : '';
  if (w.on) return `WARP activado${w.colo ? ` · ${w.colo}` : ''}`;
  if (ui.casa?.vpn?.activa && usandoServidor()) return `Motor por la VPN del servidor (WARP)${donde ? ` · tele${donde}` : ''}`;
  if (w.vpn) return `VPN activa${donde}`;
  return `${NATIVE ? 'Sin VPN' : 'Sin WARP'}${donde}`;
}

function vpnAppTexto(k) {
  if (!NATIVE) return 'Cómo instalarla ›';
  const inst = ui.warp?.apps?.[k];
  return inst == null ? '›' : inst ? 'Abrir ›' : 'Instalar ›';
}

async function checkWarp() {
  const w = { apps: {} };
  try {
    const t = await fetchText('https://www.cloudflare.com/cdn-cgi/trace');
    const val = (k) => (t.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
    w.warp = val('warp');
    w.on = w.warp === 'on' || w.warp === 'plus';
    w.colo = val('colo'); w.ip = val('ip'); w.loc = val('loc');
  } catch (e) {
    w.error = true;
  }
  if (NATIVE && plugins.Nativo) {
    try { w.vpn = (await plugins.Nativo.vpn()).activa; if (w.vpn) w.error = false; } catch { /* APK antigua */ }
    for (const [k, v] of Object.entries(VPNS)) {
      try { w.apps[k] = (await plugins.Nativo.instalada({ paquete: v.paquete })).instalada; } catch { /* nada */ }
    }
  }
  ui.warp = w;
  const el = $('#warp');
  el.textContent = w.on ? 'WARP activado' : w.vpn ? 'VPN activa' : '';
  el.style.display = w.on || w.vpn ? '' : 'none';
  if (ui.section === 'ajustes') renderSettings();
}

async function abrirVpn(k) {
  const v = VPNS[k];
  if (NATIVE && ui.warp?.apps?.[k]) {
    try { await plugins.Nativo.abrirApp({ paquete: v.paquete }); return; } catch { /* sigue con la ayuda */ }
  }
  const lay = openLayer(`
    <h2>${esc(v.nombre)}</h2>${v.texto}
    <p class="muted">Cuando la actives, vuelve a HomeTV: en Ajustes y en el menú verás «${k === 'warp' ? 'WARP activado' : 'VPN activa'}».</p>
    <div class="actions">
      ${NATIVE ? '<button class="btn primary" data-tienda data-autofocus>Buscar en la Play Store</button>' : ''}
      <button class="btn${NATIVE ? '' : ' primary'}" data-close${NATIVE ? '' : ' data-autofocus'}>Entendido</button>
    </div>`);
  const b = lay.querySelector('[data-tienda]');
  if (b) b.onclick = async () => {
    try { await plugins.Nativo.tienda({ paquete: v.paquete }); closeLayer(); } catch { toast('No se pudo abrir la Play Store', 'bad'); }
  };
}

function vpnAyuda() {
  openLayer(`
    <h2>¿Qué VPN uso?</h2>
    <p><b>Cloudflare WARP</b>: lo más sencillo. Sin cuenta, gratis y rápida. Sales a internet por Cloudflare, sin cambiar de país.</p>
    <p><b>Proton VPN</b>: gratis con cuenta de Proton, sin límite de datos. Sales por otro país (lo elige ella) y suele ir algo más lenta.</p>
    <p class="muted">Ace Stream reparte el vídeo entre usuarios (P2P): con VPN algunos canales pueden tener menos peers.
      Si un canal ya va bien sin VPN, no hace falta. En algunas teles con cable de red, la conexión se corta al activar
      cualquier VPN (fallo conocido de Android TV): si te pasa, usa la wifi o actualiza la tele.</p>
    <div class="actions"><button class="btn primary" data-close data-autofocus>Entendido</button></div>`);
}

// ---------- portada (Inicio) ----------

function sinAcentos(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function sigla(equipo) {
  const palabras = sinAcentos(equipo).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(CF|FC|CD|UD|SD|RC|SC|AZ|Real|Club|Deportivo)$/i.test(w));
  const base = palabras[0] || sinAcentos(equipo).replace(/\s+/g, '');
  return base.slice(0, 3).toUpperCase();
}

function tarjetaEvento({ ev, m }, tipo) {
  const vivo = agenda.enCurso(ev);
  const hora = vivo ? '<span class="livebadge">EN DIRECTO</span>' : `<b>${esc(agenda.hora(ev.inicio))}</b>`;
  let pie;
  if (m) {
    const s = statusOf(m.canal);
    const chk = lastCheck(m.canal);
    const estado = m.canal.url ? 'ok' : STATUS[s].cls;
    pie = `<span class="punto ${estado}"></span> ${esc(m.canal.title)}${m.canal.url ? ' · <span class="libre">En abierto</span>' : s === 'alive' && chk?.peers != null ? ` · ${esc(peersTxt(chk.peers))}` : ''}`;
  } else if ((ev.gratis || []).length) {
    pie = `<span class="libre">En abierto</span> ${esc(ev.gratis.slice(0, 2).join(' · '))}`;
  } else {
    pie = `<span class="muted">${esc(ev.canales.slice(0, 2).join(' · ') || 'Sin canal anunciado')}</span>`;
  }
  return `<button class="tarjeta${m ? '' : ' sin-canal'}" data-hkey="${tipo}:${esc(ev.id)}" data-hev="${esc(ev.id)}">
    <span class="t-caja"><span class="t-comp">${hora}<span>${esc(ev.competicion || ev.deporte)}</span>${tieneAviso(ev.id) ? '<span class="campana">🔔</span>' : ''}</span>
      <span class="t-tit">${esc(ev.titulo.replace(' - ', ' – '))}</span></span>
    <span class="t-pie">${pie}</span></button>`;
}

function tarjetaCanal(c, pref = '') {
  const s = statusOf(c);
  const chk = lastCheck(c);
  return `<button class="tarjeta canal" data-hkey="${pref}c:${c.id}" data-hcanal="${c.id}">
    <span class="t-caja con-logo">${logoHtml(c, [c], 'logo pq')}<span class="t-txt"><span class="t-tit">${esc(c.title)}</span>
      <span class="t-comp"><span class="punto ${STATUS[s].cls}"></span>${c.url && s !== 'error' ? 'En abierto' : esc(STATUS[s].label)}${chk?.peers != null && s === 'alive' ? ` · ${esc(peersTxt(chk.peers))}` : ''}</span></span></span></button>`;
}

function mejoresCanales() {
  const rank = { alive: 0, no_peers: 1, pending: 2, error: 3, not_found: 4 };
  return [...store.channels].sort((a, b) => (b.favorite - a.favorite) || (rank[statusOf(a)] - rank[statusOf(b)])
    || ((lastCheck(b)?.peers || 0) - (lastCheck(a)?.peers || 0)));
}

// Portada: una fila por categoría (las que más ves y con más canales vivos), sin repetir enlaces del mismo canal
function filasPorCategoria(max = 6) {
  if (store.settings.filasCategorias === false) return [];
  const vistosCat = new Map();
  for (const v of vistosRecientes()) if (v.c.category) vistosCat.set(v.c.category, (vistosCat.get(v.c.category) || 0) + 1);
  const porCat = new Map();
  for (const c of store.channels) {
    if (!c.category) continue;
    if (!porCat.has(c.category)) porCat.set(c.category, []);
    porCat.get(c.category).push(c);
  }
  const filas = [];
  for (const [cat, lista] of porCat) {
    const canales = agrupar(lista).map((g) => g.canales[0])
      .filter((c) => ['alive', 'no_peers', 'pending'].includes(statusOf(c)))
      .sort(cmpEnlace);
    const vivos = canales.filter((c) => statusOf(c) === 'alive').length;
    if (canales.length < 3) continue;
    filas.push({ cat, canales: canales.slice(0, 20), nota: (vistosCat.get(cat) || 0) * 50 + vivos });
  }
  return filas.sort((a, b) => b.nota - a.nota).slice(0, max);
}

function lineaEvento({ ev, m }, tipo) {
  const vivo = agenda.enCurso(ev);
  const hora = vivo ? '<span class="livebadge">DIRECTO</span>' : `<b class="l-hora">${esc(agenda.hora(ev.inicio))}</b>`;
  let donde;
  if (m) donde = `<span class="punto ${m.canal.url ? 'ok' : STATUS[statusOf(m.canal)].cls}"></span> ${esc(m.canal.title)}`;
  else if ((ev.gratis || []).length) donde = `<span class="libre">En abierto</span> ${esc(ev.gratis.slice(0, 2).join(' · '))}`;
  else donde = `<span class="muted">${esc(ev.canales.slice(0, 2).join(' · ') || 'Sin canal anunciado')}</span>`;
  return `<button class="linea${m ? '' : ' sin-canal'}" data-hkey="${tipo}:${esc(ev.id)}" data-hev="${esc(ev.id)}">${hora}
    <span class="l-txt"><span class="l-tit">${esc(ev.titulo.replace(' - ', ' – '))}</span><span class="l-sub">${esc(ev.competicion || ev.deporte)} · ${donde}</span></span></button>`;
}

function lineaCanal(c) {
  const s = statusOf(c);
  return `<button class="linea" data-hkey="vc:${c.id}" data-hcanal="${c.id}"><span class="punto ${STATUS[s].cls}"></span>
    <span class="l-txt"><span class="l-tit">${esc(c.title)}</span><span class="l-sub">${esc(c.category || '')}</span></span></button>`;
}

// Inicio en modo lista: todo en filas, sin tarjetas ni hero
function renderHomeLista() {
  const sec = $('#sec-inicio');
  const prevKey = document.activeElement?.dataset?.hkey;
  const wasIn = !!document.activeElement?.closest?.('#sec-inicio');
  ui.destacado = null;
  const bloque = (titulo, filas, vacio) => `<section class="lista-bloque" aria-label="${esc(titulo)}"><h2>${esc(titulo)} <small>${filas.length}</small></h2>${filas.length ? filas.join('') : `<p class="muted l-vacio">${esc(vacio)}</p>`}</section>`;
  const vistos = vistosRecientes().slice(0, 15).map((x) => lineaCanal(x.c));
  sec.innerHTML = `<div class="lista-cab"><button class="hbtn" data-hkey="h:modo" data-h="modo" data-autofocus>▦ Ver en tarjetas</button></div>`
    + bloque('En directo', agenda.directoTodos().map((x) => lineaEvento(x, 'directo')), agenda.st.cargando ? 'Cargando la agenda…' : 'Ahora no hay eventos en directo')
    + bloque('Vistos recientemente', vistos, 'Aún no has visto ningún canal')
    + bloque('A continuación', agenda.siguientes(24).map((x) => lineaEvento(x, 'sigue')), 'No hay más eventos en las próximas horas');
  if (ui.section === 'inicio' && (wasIn || document.activeElement === document.body)) {
    const el = (prevKey && sec.querySelector(`[data-hkey="${CSS.escape(prevKey)}"]`)) || sec.querySelector('[data-autofocus]');
    if (el) el.focus({ preventScroll: true });
  }
}

function renderHome() {
  if (store.settings.inicioLista) return renderHomeLista();
  const sec = $('#sec-inicio');
  const prev = document.activeElement;
  const prevKey = prev?.dataset?.hkey;
  const wasIn = !!prev?.closest?.('#sec-inicio');
  const directo = agenda.directoTodos();
  // Destacado: el evento en directo que mejor se puede ver ahora
  const dest = directo.find((x) => x.m && x.m.vivo) || directo.find((x) => x.m) || null;
  let hero;
  if (dest) {
    const { ev, m } = dest;
    const equipos = ev.titulo.split(' - ');
    const arte = equipos.length === 2
      ? `<div class="hero-art" aria-hidden="true"><i class="campo"></i><i class="medio"></i><i class="circulo"></i><i class="area1"></i><i class="area2"></i>
          <b class="l">${esc(sigla(equipos[0]))}</b><b class="r">${esc(sigla(equipos[1]))}</b></div>` : '';
    const chk = lastCheck(m.canal);
    const detalle = m.canal.url ? ' · en abierto' : chk?.peers != null && m.vivo ? ` con ${peersTxt(chk.peers)}` : m.vivo ? '' : ' (sin comprobar si está vivo)';
    hero = `<section class="hero" aria-label="Destacado">
      <div class="hero-main">
        <div class="hero-kicker"><span class="livebadge big">EN DIRECTO</span>${esc(ev.deporte)}${ev.competicion ? ' · ' + esc(ev.competicion) : ''}</div>
        <h1>${equipos.map((x) => esc(x)).join(' – ')}</h1>
        <p>${m.todos.length > 1 ? `En ${m.todos.length} de tus canales · el mejor ahora: ` : 'En '}${esc(m.canal.title)}${esc(detalle)}</p>
        <div class="hero-actions">
          <button class="hbtn primary" data-hkey="h:ver" data-h="ver" data-autofocus>▶ Ver ahora</button>
          ${m.todos.length > 1 ? `<button class="hbtn" data-hkey="h:otros" data-h="otros">Otros canales (${m.todos.length - 1})</button>` : ''}
          ${m.canal.url ? '' : '<button class="hbtn" data-hkey="h:ace" data-h="ace">Abrir en Ace Player</button>'}
        </div>
      </div>${arte}</section>`;
    ui.destacado = { ev, m };
  } else {
    ui.destacado = null;
    const ultimo = vistosRecientes()[0];
    const c = ultimo ? ultimo.c : mejoresCanales()[0];
    if (c) {
      const s = statusOf(c);
      const chk = lastCheck(c);
      hero = `<section class="hero" aria-label="Destacado"><div class="hero-main">
        <div class="hero-kicker">${ultimo ? `Seguir viendo · lo viste ${esc(ago(ultimo.at))}` : c.favorite ? 'Tu favorito' : 'Tu mejor canal ahora'} · ${esc(c.category || 'Sin categoría')}</div>
        <h1>${esc(c.title)}</h1>
        <p><span class="punto ${STATUS[s].cls}"></span> ${esc(STATUS[s].label)}${chk?.peers != null ? ` · ${esc(peersTxt(chk.peers))}` : ''}${chk ? ` · comprobado ${esc(ago(chk.at))}` : ''}</p>
        <div class="hero-actions">
          <button class="hbtn primary" data-hkey="h:canal" data-h="canal" data-id="${c.id}" data-autofocus>▶ Ver ahora</button>
          <button class="hbtn" data-hkey="h:agenda" data-h="agenda">Ver la agenda</button>
          <button class="hbtn" data-hkey="h:comprobar" data-h="comprobar">Comprobar canales</button>
        </div></div></section>`;
    } else {
      hero = `<section class="hero vacio" aria-label="Bienvenida"><div class="hero-main">
        <div class="hero-kicker">Bienvenido</div>
        <h1>Añade tus canales</h1>
        ${MOVIL
          ? `<p>Pon la dirección de tu servidor de casa en Ajustes y tendrás los mismos canales que en la tele. También puedes activar la lista de TV en abierto (TDTChannels) en Listas.</p>
        <div class="hero-actions">
          <button class="hbtn primary" data-hkey="h:importar" data-h="importar">Ver las listas</button>
          <button class="hbtn" data-hkey="h:ajustes" data-h="ajustes">Ajustes</button>
        </div>`
          : `<p>Desde el móvil es lo más cómodo: escanea el código y sube tu lista. También puedes activar la lista incluida de TV en abierto (TDTChannels) en Listas.</p>
        <div class="hero-actions">
          <button class="hbtn primary" data-hkey="h:movil" data-h="movil" data-autofocus>Usar el móvil</button>
          <button class="hbtn" data-hkey="h:importar" data-h="importar">Ver las listas</button>
        </div>`}</div></section>`;
    }
  }
  const destId = ui.destacado?.ev.id;
  const enDirecto = directo.filter((x) => x.ev.id !== destId).slice(0, 24);
  const siguen = agenda.siguientes(8).slice(0, 24);
  const porDeporte = agenda.hoyPorDeporte().filter((g) => g.items.length >= 2).slice(0, 5);
  const favs = store.channels.filter((c) => c.favorite);
  const canales = (favs.length ? favs : mejoresCanales().filter((c) => statusOf(c) === 'alive')).slice(0, 15);
  const fila = (titulo, html) => (html ? `<section class="fila" aria-label="${esc(titulo)}"><h2>${esc(titulo)}</h2><div class="fila-scroll">${html}</div></section>` : '');
  const vistos = vistosRecientes().slice(0, 12);
  sec.innerHTML = `<div class="lista-cab"><button class="hbtn" data-hkey="h:modo" data-h="modo">☰ Ver en lista</button></div>` + hero
    + fila('En directo ahora', enDirecto.map((x) => tarjetaEvento(x, 'directo')).join(''))
    + fila('Vistos recientemente', vistos.map((x) => tarjetaCanal(x.c, 'v')).join(''))
    + fila('A continuación', siguen.map((x) => tarjetaEvento(x, 'sigue')).join(''))
    + fila(favs.length ? 'Tus favoritos' : 'Canales vivos', canales.map(tarjetaCanal).join(''))
    + filasPorCategoria().map((g, i) => fila(g.cat, g.canales.map((c) => tarjetaCanal(c, `k${i}`)).join(''))).join('')
    + porDeporte.map((g) => fila(`${g.deporte} · hoy`, g.items.slice(0, 20).map((x) => tarjetaEvento(x, 'dep-' + g.deporte)).join(''))).join('')
    + (agenda.st.eventos.length ? '' : `<p class="inicio-vacio">${agenda.st.cargando ? 'Cargando la agenda deportiva…' : agenda.st.error ? `No se pudo cargar la agenda: ${esc(agenda.st.error)}` : 'Cargando la agenda deportiva…'}</p>`);
  if (ui.section === 'inicio' && (wasIn || prev === document.body)) {
    const el = (prevKey && sec.querySelector(`[data-hkey="${CSS.escape(prevKey)}"]`)) || sec.querySelector('[data-autofocus]');
    if (el) el.focus({ preventScroll: true });
  }
}

function homeClick(e) {
  const h = e.target.closest('[data-h]');
  if (h) {
    const d = ui.destacado;
    const a = h.dataset.h;
    if (a === 'ver' && d) openWith(store.settings.player, d.m.canal, d.m.todos);
    if (a === 'otros' && d) agenda.abrirEvento(d.ev.id);
    if (a === 'ace' && d) openWith('aceplayer', d.m.canal);
    if (a === 'canal') openWith(store.settings.player, store.find(h.dataset.id), mejoresCanales());
    if (a === 'modo') { store.setSettings({ inicioLista: !store.settings.inicioLista }); renderHome(); return; }
    if (a === 'agenda') showSection('agenda');
    if (a === 'comprobar') { showSection('canales'); verifyMany(visibleChannels()); }
    if (a === 'movil') openPhone();
    if (a === 'importar') openImport();
    if (a === 'ajustes') showSection('ajustes');
    return;
  }
  const t = e.target.closest('[data-hev]');
  if (t) {
    const ev = agenda.st.eventos.find((x) => x.id === t.dataset.hev);
    if (!ev) return;
    // En directo y con canal que se puede ver: a reproducir. Si no, la ficha del evento.
    const x = agenda.enCurso(ev) ? agenda.directoTodos().find((y) => y.ev.id === ev.id) : null;
    if (x && x.m && x.m.vivo) openWith(store.settings.player, x.m.canal, x.m.todos);
    else agenda.abrirEvento(ev.id);
    return;
  }
  const c = e.target.closest('[data-hcanal]');
  if (c) okOnChannel(c.dataset.hcanal);
}

// ---------- bloqueo de la tele desde el servidor de casa ----------
// El panel del servidor puede bloquear esta tele: sale un mensaje a pantalla completa y no se puede hacer nada
// hasta que se desbloquee. Se guarda aquí también, así sigue bloqueada aunque se reinicie la app sin servidor.

function bloqueada() { return !!store.settings.bloqueo; }

function pintarBloqueo() {
  let el = document.getElementById('bloqueo');
  const b = store.settings.bloqueo;
  if (!b) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'bloqueo';
    el.setAttribute('role', 'alertdialog');
    el.tabIndex = -1;
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="bloqueo-caja"><div class="bloqueo-icono">🔒</div>
    <p class="bloqueo-msg">${esc(b.mensaje || 'La tele está bloqueada.')}</p>
    <p class="bloqueo-pie">HomeTV · bloqueada desde el servidor de casa</p></div>`;
  try { el.focus({ preventScroll: true }); } catch { /* nada */ }
}

async function mirarBloqueo() {
  if (!store.settings.servidorCasa) { if (bloqueada()) { store.setSettings({ bloqueo: null }); pintarBloqueo(); } return; }
  try {
    // (sin AbortSignal.timeout: las Fire TV antiguas no lo tienen)
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${urlCasa('/bloqueo')}?${quienSoy()}`, { cache: 'no-store', signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return;   // servidor antiguo o caído: se deja como estaba
    const j = await r.json();
    // «Actualizar ya» pedido desde el panel del servidor
    if (j.actualizar) buscarActualizacion(true);
    const antes = store.settings.bloqueo;
    const ahora = j.bloqueada ? { mensaje: j.mensaje || '' } : null;
    if (JSON.stringify(antes || null) === JSON.stringify(ahora)) return;
    guardarSinSubir(() => { store.data.settings.bloqueo = ahora; });
    if (ahora) { closePlayer(); while (closeLayer()) { /* cerrar todo */ } }
    pintarBloqueo();
  } catch { /* sin conexión: se mantiene el último estado conocido */ }
}

// Mientras está bloqueada no llega ninguna tecla a la app (el botón Inicio del mando sigue saliendo de ella)
window.addEventListener('keydown', (e) => {
  if (!bloqueada()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// ---------- vídeo de entrada (prueba) ----------
// Si el servidor de casa tiene intro/intro.mp4, se pone al abrir la app: fondo negro, el vídeo en el centro con
// los bordes difuminados. Cualquier tecla, Atrás o un toque lo saltan. Sin servidor o sin vídeo, no sale nada.
function videoEntrada() {
  if (store.settings.intro === false || bloqueada()) return;
  try { if (sessionStorage.getItem('introVista')) return; sessionStorage.setItem('introVista', '1'); } catch { /* sin sessionStorage */ }
  const capa = document.createElement('div');
  capa.id = 'intro';
  capa.innerHTML = `<div class="marco"><video src="intro.mp4" autoplay playsinline preload="auto"></video></div>`;
  document.body.appendChild(capa);
  const v = capa.querySelector('video');
  let fuera = false;
  // El navegador no deja empezar con sonido sin un clic: entonces empieza en silencio y el primer clic
  // (o tecla) lo activa; el siguiente, o Esc / Atrás, lo salta
  const SALIR = ['Escape', 'GoBack', 'BrowserBack', 'Backspace'];
  const saltar = (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (v.muted && !SALIR.includes(e.key)) activarSonido(); else quitar();
  };
  let sonidoEn = 0;
  function activarSonido() {
    sonidoEn = Date.now();
    v.muted = false;
    v.volume = 1;
    capa.classList.remove('mudo');
    v.play().catch(() => {});
  }
  function quitar() {
    if (fuera) return;
    fuera = true;
    window.removeEventListener('keydown', saltar, true);
    document.removeEventListener('pointerdown', primerToque, true);
    capa.classList.add('fuera');
    try { v.pause(); } catch { /* nada */ }
    setTimeout(() => capa.remove(), 600);
  }
  window.addEventListener('keydown', saltar, true);
  capa.addEventListener('click', () => {
    if (v.muted) activarSonido();
    else if (Date.now() - sonidoEn > 600) quitar();   // el mismo clic que activó el sonido no lo salta
  });
  capa._quitar = quitar;
  // Un toque en cualquier sitio (también el primero) cuenta como el clic que pide el navegador
  const primerToque = () => { if (v.muted) activarSonido(); };
  document.addEventListener('pointerdown', primerToque, true);
  v.addEventListener('loadedmetadata', () => {
    if (v.videoWidth && v.videoHeight && v.videoWidth < v.videoHeight) {
      const m = capa.querySelector('.marco');
      m.classList.add('vertical');
      m.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
    }
  });
  v.addEventListener('ended', quitar);
  v.addEventListener('error', quitar);
  setTimeout(() => { if (v.readyState < 2) quitar(); }, 8000);   // si no carga enseguida, no se espera
  setTimeout(quitar, 45000);   // por si se queda colgado (el vídeo dura 31 s)
  // Con sonido si la tele lo deja; si no, sin sonido
  v.play().catch(() => {
    v.muted = true;
    capa.classList.add('mudo');
    capa.insertAdjacentHTML('beforeend', '<div class="intro-sonido"><b>🔊 Pulsa cualquier tecla o haz clic para activar el sonido</b><span>Esc para saltar</span></div>');
    v.play().catch(quitar);
  });
}
function quitarIntro() {
  const c = document.getElementById('intro');
  if (!c) return false;
  if (c._quitar) c._quitar(); else c.remove();
  return true;
}

// ---------- guía de programación (cuadrícula) ----------
// Una fila por canal con guía (TDTChannels), de media hora antes a 8 horas después. OK en lo que se emite
// ahora: a verlo. En lo que viene: su ficha. La línea marca la hora actual.

const GUIA_ANTES = 30 * 60e3;
const GUIA_DESPUES = 8 * 3600e3;
const REM_POR_HORA = 15;   // ancho de una hora en la cuadrícula

function canalesDeGuia() {
  const vistos = new Set();
  const out = [];
  const lista = store.settings.agrupar !== false ? agrupar(store.channels).map((g) => g.canales.find((c) => c.epgId) || g.canales[0]) : store.channels;
  for (const c of lista) {
    if (!c.epgId || vistos.has(c.epgId) || !guia.programas(c.epgId).length) continue;
    vistos.add(c.epgId);
    out.push(c);
  }
  // Favoritos primero; el resto en el orden de la lista (el de los números de la TDT)
  return out.sort((a, b) => b.favorite - a.favorite);
}

function renderGuia(enfocar = true) {
  const sec = $('#sec-guia');
  const prevKey = document.activeElement?.closest?.('#sec-guia') ? document.activeElement.dataset.gkey : null;
  const prevScroll = $('#sec-guia .guia-scroll')?.scrollLeft;
  const ahora = Date.now();
  const t0 = Math.floor((ahora - GUIA_ANTES) / 1800e3) * 1800e3;
  const t1 = ahora + GUIA_DESPUES;
  const rem = (ms) => ((ms - t0) / 3600e3) * REM_POR_HORA;
  const hora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const canales = canalesDeGuia();
  if (!canales.length) {
    sec.innerHTML = `<div class="sec-head"><h1>Guía</h1></div><div class="empty"><p>${guia.tiene
      ? 'Ninguno de tus canales tiene guía de programación.'
      : 'Aún no hay guía descargada.'}</p><p class="muted">La guía es la de TDTChannels: activa su lista «TV en abierto» en Listas y aquí saldrá lo que echan en cada canal.</p>
      <button class="btn primary" data-gaccion="listas" data-autofocus>Ir a Listas</button></div>`;
    if (!guia.tiene) guia.descargar(true);
    return;
  }
  const marcas = [];
  for (let t = t0; t <= t1; t += 1800e3) marcas.push(`<span style="left:${rem(t)}rem">${hora(t)}</span>`);
  const ancho = rem(t1);
  let enCurso = null;
  const filas = canales.map((c, i) => {
    const progs = guia.programas(c.epgId).filter((p) => p.hf > t0 && p.hi < t1);
    const celdas = progs.map((p) => {
      const ini = Math.max(p.hi, t0);
      const fin = Math.min(p.hf, t1);
      const ya = p.hi <= ahora && ahora < p.hf;
      const key = `g:${c.epgId}:${p.hi}`;
      if (ya && i === 0) enCurso = key;
      return `<button class="gp${ya ? ' ya' : p.hf <= ahora ? ' pasado' : ''}" style="left:${rem(ini)}rem;width:${Math.max(rem(fin) - rem(ini) - 0.25, 1.2)}rem"
        data-gkey="${key}" data-gid="${esc(c.id)}" data-ghi="${p.hi}"><b>${esc(p.titulo)}</b><small>${hora(p.hi)}–${hora(p.hf)}</small></button>`;
    }).join('');
    return `<div class="g-fila"><div class="g-canal">${logoHtml(c, [c], 'logo pq')}<span>${c.favorite ? '★ ' : ''}${esc(c.title)}</span></div>
      <div class="g-progs" style="width:${ancho}rem">${celdas}</div></div>`;
  }).join('');
  sec.innerHTML = `<div class="sec-head"><h1>Guía</h1><span class="muted">${canales.length} canales · de ${hora(t0)} a ${hora(t1)}</span></div>
    <div class="guia-scroll"><div class="guia" style="width:calc(${ancho}rem + var(--g-col))">
      <div class="g-fila g-cab"><div class="g-canal"></div><div class="g-horas" style="width:${ancho}rem">${marcas.join('')}</div></div>
      <div class="g-ahora" style="left:calc(${rem(ahora)}rem + var(--g-col))"></div>
      ${filas}
    </div></div>`;
  const sc = $('.guia-scroll', sec);
  // Se empieza un poco antes de la hora actual, para ver de qué va lo que se está emitiendo
  sc.scrollLeft = prevScroll ?? Math.max(0, (rem(ahora) - REM_POR_HORA * 0.4) * parseFloat(getComputedStyle(document.documentElement).fontSize));
  if (!enfocar && !prevKey) return;
  const el = (prevKey && sec.querySelector(`[data-gkey="${CSS.escape(prevKey)}"]`)) || (enCurso && sec.querySelector(`[data-gkey="${CSS.escape(enCurso)}"]`)) || sec.querySelector('.gp.ya, .gp');
  if (el && (enfocar || prevKey)) focusEl(el);
}

function guiaClick(e) {
  if (e.target.closest('[data-gaccion="listas"]')) { showSection('listas'); return; }
  const b = e.target.closest('.gp');
  if (!b) return;
  const c = store.find(b.dataset.gid);
  if (!c) return;
  const p = guia.programas(c.epgId).find((x) => String(x.hi) === b.dataset.ghi);
  const zapping = canalesDeGuia();
  if (p && p.hi <= Date.now() && Date.now() < p.hf) { openWith(store.settings.player, c, zapping); return; }
  const hora = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const dia = p ? new Date(p.hi).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' }) : '';
  const layer = openLayer(`
    <h2>${esc(p ? p.titulo : c.title)}</h2>
    <p class="muted">${esc(c.title)}${p ? ` · ${esc(dia)}, de ${hora(p.hi)} a ${hora(p.hf)}` : ''}</p>
    <div class="vmenu">
      <button class="mbtn primary" data-ver data-autofocus>▶ Ver ${esc(c.title)} ahora</button>
      <button class="mbtn" data-close>Volver</button>
    </div>`);
  layer.addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-ver]')) return;
    closeLayer(layer);
    openWith(store.settings.player, c, zapping);
  });
}

// ---------- secciones ----------

ui.section = 'inicio';

function showSection(name, { focus = true } = {}) {
  if (name === 'importar') name = 'listas';
  if (name === 'movil') { openPhone(); return; }
  if (name === 'buscar') { showSection('canales', { focus: false }); openSearch(); return; }
  // Favoritos es la pantalla de Canales con solo los favoritos (y el zapping va solo por ellos)
  let marcar = name === 'listas' ? 'ajustes' : name;   // Listas vive dentro de Ajustes
  if (name === 'favoritos') {
    ui.vistaFav = true;
    ui.filter = 'fav'; ui.category = null; ui.listas = new Set(); ui.search = '';
    name = 'canales';
    render();
  } else if (name === 'canales' && ui.vistaFav) {
    ui.vistaFav = false;
    ui.filter = 'all';
    render();
  }
  ui.section = name;
  document.querySelectorAll('.sec').forEach((x) => x.classList.toggle('on', x.id === `sec-${name}`));
  document.querySelectorAll('.mi').forEach((x) => x.classList.toggle('on', x.dataset.section === (ui.vistaFav && name === 'canales' ? 'favoritos' : marcar)));
  if (name === 'ajustes') renderSettings();
  if (name === 'listas') renderListas();
  if (name === 'agenda') agenda.show();
  if (name === 'guia') renderGuia(focus);
  if (name === 'inicio') renderHome();
  window.scrollTo(0, 0);
  if (focus && name !== 'agenda') {
    const sec = $(`#sec-${name}`);
    const first = sec.querySelector('[data-autofocus], .row-btn, .ev-btn, .srow, .card, button');
    if (first) focusEl(first);
  }
}

// Busca en tus listas de internet (también las apagadas) canales que aún no tienes, para añadir solo esos
const cacheListas = new Map();
async function buscarEnListas(q) {
  const texto = sinAcentos(String(q || '')).toLowerCase().trim();
  if (!texto) return;
  const fuentes = store.sources.filter((f) => f.url);
  if (!fuentes.length) { toast('No tienes listas de internet guardadas'); return; }
  const layer = openLayer(`<h2>Buscando «${esc(q)}»…</h2><p class="muted">En ${fuentes.length} listas de internet.</p>
    <div class="actions"><button class="btn" data-close data-autofocus>Cancelar</button></div>`, { cls: 'wide' });
  const dlg = $('.dialog', layer);
  const tengo = new Set(store.allChannels.map((c) => c.id));
  const res = [];
  for (const f of fuentes) {
    if (!layer.isConnected) return;
    try {
      let entradas = cacheListas.get(f.url);
      if (!entradas) { entradas = parseText(await fetchText(f.url)).entries; cacheListas.set(f.url, entradas); }
      for (const x of entradas) {
        if (tengo.has(x.id) || res.some((r) => r.x.id === x.id)) continue;
        if (sinAcentos(`${x.title} ${x.category || ''}`).toLowerCase().includes(texto)) res.push({ x, f });
      }
    } catch { /* esa lista no responde */ }
  }
  if (!layer.isConnected) return;
  const lista = res.slice(0, 60);
  dlg.innerHTML = `<h2>«${esc(q)}» en tus listas de internet</h2>
    <p class="muted">${res.length ? `${res.length === 1 ? '1 canal' : `${res.length} canales`} que aún no tienes${res.length > 60 ? ' (se ven los 60 primeros)' : ''}. OK para añadirlo a la lista «Añadidos».` : 'No hay canales nuevos con ese nombre.'}</p>
    <div class="vmenu">
      ${lista.map((r, i) => `<button class="mbtn" data-r="${i}"${i ? '' : ' data-autofocus'}><span>${esc(limpiarTitulo(r.x.title) || r.x.id.slice(0, 12))}</span><b>${esc(r.f.name)}</b></button>`).join('')}
      <button class="mbtn" data-close${lista.length ? '' : ' data-autofocus'}>Volver</button>
    </div>`;
  focusFirst(layer);
  layer.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b || b.disabled) return;
    const r = lista[Number(b.dataset.r)];
    const destino = store.localList('Añadidos');
    store.addChannels([r.x], destino.id);
    b.disabled = true;
    b.querySelector('b').textContent = '✓ añadido';
    toast(`«${limpiarTitulo(r.x.title)}» añadido`, 'ok');
  });
}

async function openSearch() {
  const v = await promptText('Buscar canal', ui.search, { placeholder: 'Nombre o categoría', ok: 'Buscar' });
  if (v === null) return;
  ui.search = v.trim();
  render();
  const first = $('#grid .row-btn, #grid .card');
  if (first) focusEl(first);
}

function back() {
  if (quitarIntro()) return;
  if (bloqueada()) return;
  if (WEBPC && $('#playerlayer').classList.contains('lista')) { pcLista(false); return; }
  if (closePlayer()) return;
  if (closeLayer()) return;
  const inSide = !!document.activeElement?.closest?.('.side');
  if (ui.section === 'canales' && !ui.vistaFav && (ui.search || ui.filter !== 'all' || ui.category || ui.listas.size)) {
    ui.search = ''; ui.filter = 'all'; ui.category = null; ui.listas = new Set();
    render();
    return;
  }
  if (ui.section === 'ajustes' && ui.ajustesAv) { ui.ajustesAv = false; renderSettings(); focusEl($('#sec-ajustes [data-skey="a:avanzado"]') || $('#sec-ajustes .srow')); return; }
  if (ui.section === 'listas' && !MOVIL) { showSection('ajustes', { focus: false }); focusEl($('#sec-ajustes [data-skey="a:listas"]') || document.querySelector('.mi[data-section="ajustes"]')); return; }
  if (!inSide && !MOVIL) {
    // Primero al menú lateral; desde ahí, a Canales; desde Canales, salir
    const item = document.querySelector(`.mi[data-section="${ui.section}"]`);
    if (item) { focusEl(item); return; }
  }
  if (ui.section !== 'inicio') { showSection('inicio', { focus: false }); focusEl(document.querySelector('.mi[data-section="inicio"]')); return; }
  if (NATIVE && plugins.App) plugins.App.exitApp();
}

// Pulsación larga de OK en un canal: abre sus opciones.
// OK corto hace la acción normal (reproducir o abrir la ficha, según Ajustes).
function installLongPress() {
  let pressed = null;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target.closest?.('.row-btn, .card, .tarjeta.canal');
    if (!t) return;
    const inicio = t.classList.contains('tarjeta');
    const id = inicio ? t.dataset.hcanal : t.dataset.id;
    if (!id) return;
    e.preventDefault();
    if (pressed) return; // repeticiones de la tecla mantenida
    pressed = { id, inicio, el: t, long: false, timer: null };
    pressed.timer = setTimeout(() => {
      if (!pressed) return;
      pressed.long = true;
      // OK largo: a favoritos (o las opciones del canal, según Ajustes)
      if (store.settings.okLargo === 'opciones') openDetail(pressed.id);
      else alternarFavorito(pressed.id);
    }, 650);
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Enter' || !pressed) return;
    clearTimeout(pressed.timer);
    const p = pressed;
    pressed = null;
    if (!p.long) { if (p.inicio) p.el.click(); else okOnChannel(p.id); }
  }, true);
}

function alternarFavorito(id) {
  const c = store.find(id);
  if (!c) return;
  const poner = !c.favorite;
  store.updateChannel(c.id, { favorite: poner });
  toast(poner ? `★ ${c.title}: añadido a favoritos` : `☆ ${c.title}: quitado de favoritos`, 'ok');
}

function wire() {
  $('#sec-canales').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-opt]');
    if (opt) return openDetail(opt.dataset.opt);
    const grp = e.target.closest('[data-grupo]');
    if (grp) return openGrupo(grp.dataset.grupo);
    const card = e.target.closest('.row-btn, .card');
    if (card) return okOnChannel(card.dataset.id);
    const d = e.target.closest('[data-dev]');
    if (d) {
      if (!d.dataset.dev) { showSection('agenda'); return; }
      const x = agenda.directoTodos().find((y) => y.ev.id === d.dataset.dev);
      if (x && x.m && x.m.vivo) openWith(store.settings.player, x.m.canal, x.m.todos);
      else agenda.abrirEvento(d.dataset.dev);
      return;
    }
    const sl = e.target.closest('[data-sel]');
    if (sl) { abrirSelector(sl.dataset.sel); return; }
    const cat = e.target.closest('[data-cat]');
    if (cat) { ui.category = cat.dataset.cat || null; render(); return; }
    const fl = e.target.closest('[data-flista]');
    // OK sobre una lista la añade o la quita de la selección; «Todas» la vacía
    if (fl) {
      const id = fl.dataset.flista;
      if (!id) ui.listas = new Set();
      else if (ui.listas.has(id)) ui.listas.delete(id);
      else ui.listas.add(id);
      ui.category = null;
      render();
      return;
    }
    if (e.target.closest('#clear-search')) { ui.search = ''; render(); focusEl($('#search')); return; }
    if (e.target.closest('#cancel')) { ui.batch?.controller.abort(); return; }
    if (e.target.closest('#ver-mas')) {
      const n = $('#grid').querySelectorAll('.row-btn, .card').length;
      ui.limite += LIMITE_FILAS;
      render();
      const sig = $('#grid').querySelectorAll('.row-btn, .card')[n];
      if (sig) focusEl(sig);
      return;
    }
    if (e.target.closest('#buscar-web')) { buscarEnListas(ui.search); return; }
    if (e.target.closest('#empty-import')) openImport();
  });
  // Con el dedo: mantener pulsado un canal abre sus opciones (como OK largo con el mando)
  $('#sec-canales').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.row-btn, .card');
    if (!card) return;
    e.preventDefault();
    openDetail(card.dataset.id);
  });
  // Elegir una sección con OK no mueve el foco: sigues en el menú hasta que pulses ▶
  document.querySelectorAll('.mi').forEach((b) => { b.onclick = () => showSection(b.dataset.section, { focus: false }); });
  $('#sec-guia').addEventListener('click', guiaClick);
  // La guía se redibuja cada 5 minutos para mover la línea de «ahora»
  setInterval(() => { if (ui.section === 'guia' && activeLayer().id === 'app') renderGuia(false); }, 300000);
  $('#sec-ajustes').addEventListener('click', settingClick);
  $('#sec-agenda').addEventListener('click', (e) => agenda.click(e));
  $('#sec-inicio').addEventListener('click', homeClick);
  $('#sec-listas').addEventListener('click', listasClick);
  $('#search').onclick = openSearch;
  $('#engine').onclick = () => checkEngine(true);
  $('#verify').onclick = () => {
    const lista = visibleChannels();
    if (ui.engineOk === false) {
      // Sin motor solo se pueden comprobar los canales de dirección web
      const web = lista.filter((c) => c.url);
      if (!web.length) { engineHelp(); return; }
      toast('El motor de Ace Stream no responde: solo se comprueban los canales de TV en abierto');
      verifyMany(web);
      return;
    }
    verifyMany(lista);
  };

  $('#hud-close').onclick = () => closePlayer();
  $('#hud-prev').onclick = () => zapTo(-1);
  $('#hud-next').onclick = () => zapTo(1);
  $('#hud-ace').onclick = () => { const c = $('#playerlayer')._channel; closePlayer(); if (c) openWith('aceplayer', c); };
  $('#hud-vlc').onclick = () => { const c = $('#playerlayer')._channel; closePlayer(); if (c) openWith('vlc', c); };
  $('#playerlayer').addEventListener('mousemove', () => showHud());
  $('#playerlayer').addEventListener('click', (e) => { if (e.target.id === 'video') showHud(true); });

  document.addEventListener('keydown', playerKeys, true);
  instalarPcControles();
  installLongPress();
  installNav(back);
  if (NATIVE && plugins.App) plugins.App.addListener('backButton', back);
  store.onChange(() => {
    programarCopia();
    programarSincro();
    repintarCambio();
    if (ui.section === 'ajustes') renderSettings();
    if (ui.section === 'agenda') agenda.refreshView();
    if (ui.section === 'inicio') renderHome();
    if (ui.section === 'listas') renderListas();
  });

  const clock = () => { $('#clock').textContent = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); };
  clock();
  setInterval(clock, 15000);
  // La franja «En directo» y lo que echa cada canal cambian con la hora
  setInterval(() => { if (ui.section === 'canales' && activeLayer().id === 'app' && !ui.batch) render(); }, 60000);
  setInterval(() => { marcarPartidosFavoritos(); comprobarAntesDePartidos(); avisarRecordatorios(); }, 30000);
  setTimeout(() => { marcarPartidosFavoritos(); resumenDelDia(); }, 4000);
  // Con servidor de casa: vigilar el motor (cambio automático al de la tele y vuelta) y sincronizar las teles
  setInterval(() => {
    if (!store.settings.servidorCasa || document.hidden) return;
    if (!ui.batch) checkEngine();
    traerSincro();
  }, 60000);
  setInterval(() => { if (!document.hidden) { ui.ultimaBusqueda = Date.now(); buscarActualizacion(); } }, 6 * 3600e3);
}

const agendaApp = {
  store, ui, $, esc, toast, openLayer, closeLayer, focusEl, statusOf, lastCheck, STATUS, peersTxt,
  fetchText, urlCasa, openWith, abrirWeb, activarLista, verifyMany, tieneAviso, alternarAviso, promptText, equiposDe, siguiendo, alternarEquipo, esDeMiEquipo,
};
const agenda = crearAgenda(agendaApp);
const guia = crearGuia({ fetchText, onCambio: () => { if (ui.section === 'canales') render(); if (ui.section === 'guia') renderGuia(false); } });
agendaApp.onAgenda = () => { marcarPartidosFavoritos(); setTimeout(resumenDelDia, 3000); if (ui.section === 'inicio') renderHome(); if (ui.section === 'canales') render(); };

wire();
render();
showSection('inicio');
// La web abierta desde el servidor de casa (http://servidor:8096/tv): ese servidor es su motor y su sitio de sincronizar
const WEB_EN_SERVIDOR = !NATIVE && location.pathname.startsWith('/tv');
player.usarAac = WEB_EN_SERVIDOR;
// Calidad en la web: por Tailscale (100.x) o con datos móviles, la imagen original (8-10 Mb/s) no cabe por la subida de casa
function calidadWeb() {
  const v = store.settings.calidadWeb || 'auto';
  if (v !== 'auto') return v;
  return /^100\./.test(location.hostname) || /\.ts\.net$/.test(location.hostname) ? 'baja' : 'original';
}
Object.defineProperty(player, 'calidad', { get: calidadWeb, set() {} });
if (WEB_EN_SERVIDOR && store.settings.servidorCasa !== location.hostname) {
  store.setSettings({ servidorCasa: location.hostname, engineUrl: '/engine', sincronizar: true });
}

async function startup() {
  pintarBloqueo();
  videoEntrada();
  if (store.settings.movilActivo) startPhone().catch(() => {});
  checkWarp();
  await checkEngine();
  if (store.settings.refreshSources && store.sources.length) {
    let nuevos = 0;
    nuevos = await refreshSources(true);
    if (nuevos) toast(`Fuentes actualizadas: ${nuevos} canales nuevos`, 'ok');
  }
  ui.ultimaBusqueda = Date.now();
  buscarActualizacion();
  if (store.settings.servidorCasa) { estadoCasa(); traerSincro(); setTimeout(() => subirCopia(), 30000); }
  // 0.12: la lista de TDTChannels se vuelve a leer una vez para tener el código de guía de cada canal
  const tdt = store.source('tdtchannels');
  if (tdt && tdt.enabled !== false && !store.settings.epg12 && store.channelsOf('tdtchannels').some((c) => !c.epgId)) {
    try { await cargarFuente(tdt, { quiet: true }); } catch { /* otra vez será */ }
  }
  store.setSettings({ epg12: true });
  if (store.channels.some((c) => c.epgId)) guia.descargar();
  await agenda.descargar();
  aprenderDelReproductor();
  mirarBloqueo();
  setInterval(mirarBloqueo, 10000);
  autoVerify();
  comprobarAntesDePartidos();
}
startup();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  mirarBloqueo();
  aprenderDelReproductor();
  checkEngine(); checkWarp(); avisarRecordatorios(); traerSincro();
  if (Date.now() - (ui.ultimaBusqueda || 0) > 3600e3) { ui.ultimaBusqueda = Date.now(); buscarActualizacion(); }
  if (store.channels.some((c) => c.epgId)) guia.descargar();
});
