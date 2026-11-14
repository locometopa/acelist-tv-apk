// Agenda deportiva: lee la programación de futbolenlatv.es y la cruza con tus canales.

const FUENTES = {
  deportes: { url: 'https://www.futbolenlatv.es/deporte', label: 'Todos los deportes (3 días)' },
  futbol: { url: 'https://www.futbolenlatv.es/', label: 'Solo fútbol (15 días)' },
  marca: { url: 'https://www.marca.com/programacion-tv.html', label: 'Guía de Marca (5 días)', charset: 'iso-8859-15', leer: 'leerMarca' },
  ciriaco: { url: 'https://ciriaco.netlify.app/', label: 'Agenda Ciriaco (3 días, con enlaces Ace)', leer: 'leerCiriaco' },
};
const CACHE_KEY = 'acelist-tv:agenda2';
const CADUCA_MS = 60 * 60 * 1000; // se vuelve a descargar pasada una hora
const DURACION_MS = 2 * 60 * 60 * 1000; // un evento se considera en directo durante 2 h

// ---------- lectura de la página ----------

function texto(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

// "(M54 O110)", "(Ver en directo)", ": VER PARTIDO"… fuera
export function limpiarCanal(nombre) {
  return String(nombre || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/:.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fechaCabecera(t) {
  const m = t.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? { y: +m[3], mo: +m[2], d: +m[1] } : null;
}

export function leerAgenda(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const eventos = [];
  let fecha = null;
  for (const tr of doc.querySelectorAll('table.tablaPrincipal tr')) {
    if (tr.classList.contains('cabeceraTabla')) {
      fecha = fechaCabecera(texto(tr));
      continue;
    }
    const horaTd = tr.querySelector('td.hora');
    if (!horaTd || !fecha) continue;
    const hm = texto(horaTd).match(/(\d{1,2}):(\d{2})/);
    const inicio = hm ? new Date(fecha.y, fecha.mo - 1, fecha.d, +hm[1], +hm[2]).getTime() : null;
    const det = tr.querySelector('td.detalles');
    const deporte = det?.querySelector('.contenedorImgCompeticion img')?.getAttribute('alt') || '';
    const competicion = det?.querySelector('label')?.getAttribute('title') || texto(det?.querySelector('label'));
    const extra = [...(det?.querySelectorAll('.ajusteDoslineas > span[title]') || [])].map((x) => x.getAttribute('title')).join(' · ');
    let titulo;
    const local = tr.querySelector('td.local span[title]');
    const visitante = tr.querySelector('td.visitante span[title]');
    if (local || visitante) {
      titulo = [local?.getAttribute('title'), visitante?.getAttribute('title')].filter(Boolean).join(' - ');
    } else {
      const unico = tr.querySelector('td.eventoUnaColumna, .eventoUnico');
      titulo = unico ? unico.innerHTML.split(/<br\s*\/?>/i).map((x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ') : '';
    }
    const canales = [];
    const gratis = [];
    const enlaces = [];
    let aplazado = false;
    for (const li of tr.querySelectorAll('ul.listaCanales li')) {
      const nombre = limpiarCanal(li.getAttribute('title') || texto(li));
      if (!nombre) continue;
      // Si la web da el enlace directo de YouTube de ese evento, se guarda
      const href = li.querySelector('a[href*="youtu"]')?.getAttribute('href') || (li.getAttribute('href') || '').match(/youtu/) && li.getAttribute('href');
      if (href && /^https?:\/\//i.test(href) && !enlaces.includes(href)) enlaces.push(href);
      if (/^aplazado$/i.test(nombre)) { aplazado = true; continue; }
      if (/^(canal por confirmar|web directo)$/i.test(nombre)) continue;
      if (!canales.includes(nombre)) canales.push(nombre);
      // La web marca en rojo (colorRojo) los canales que se pueden ver gratis
      if (li.classList.contains('colorRojo') && !gratis.includes(nombre)) gratis.push(nombre);
    }
    if (!titulo && !competicion) continue;
    eventos.push({
      id: `${inicio}|${titulo}|${competicion}`,
      inicio,
      deporte,
      competicion,
      extra,
      titulo: titulo || competicion,
      canales,
      gratis,
      enlaces,
      aplazado,
    });
  }
  return eventos;
}

// Guía de Marca (marca.com/programacion-tv.html): días en .title-section-widget y, debajo, un <li class="dailyevent">
// por evento con hora, deporte, competición, equipos y canal.
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function leerMarca(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const eventos = [];
  const vistos = new Set();
  for (const dia of doc.querySelectorAll('li.content-item')) {
    const m = texto(dia.querySelector(':scope > .title-section-widget')).match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
    const mo = m ? MESES.indexOf(m[2].toLowerCase()) : -1;
    if (mo < 0) continue;
    for (const li of dia.querySelectorAll(':scope > ol > li.dailyevent')) {
      const hm = texto(li.querySelector('.dailyhour')).match(/(\d{1,2}):(\d{2})/);
      const inicio = hm ? new Date(+m[3], mo, +m[1], +hm[1], +hm[2]).getTime() : null;
      const deporte = texto(li.querySelector('.dailyday'));
      const competicion = texto(li.querySelector('.dailycompetition'));
      const titulo = texto(li.querySelector('.dailyteams'));
      const canales = [];
      for (const c of li.querySelectorAll('.dailychannel')) {
        // Un mismo evento puede traer varios canales separados por coma o barra
        for (const parte of texto(c).split(/\s*[,/]\s*/)) {
          const nombre = limpiarCanal(parte);
          if (nombre && !/^(aplazado|canal por confirmar|web directo)$/i.test(nombre) && !canales.includes(nombre)) canales.push(nombre);
        }
      }
      if (!titulo && !competicion) continue;
      const id = `${inicio}|${titulo}|${competicion}`;
      if (vistos.has(id)) continue;   // la página repite bloques: cada evento una sola vez
      vistos.add(id);
      eventos.push({
        id,
        inicio,
        deporte,
        competicion,
        extra: '',
        titulo: titulo || competicion,
        canales,
        gratis: [],
        aplazado: /aplazad/i.test(texto(li)),
      });
    }
  }
  return eventos;
}

// Agenda Ciriaco (ciriaco.netlify.app): una tabla por día (h2.fecha + table) y, en algunas filas, enlaces acestream://
// del evento dentro de un popup. Esos enlaces se guardan en `ace` para abrirlos sin buscar el canal por nombre.
export function leerCiriaco(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const eventos = [];
  const vistos = new Set();
  for (const h of doc.querySelectorAll('h2.fecha')) {
    const m = texto(h).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) continue;
    let tabla = h.nextElementSibling;
    while (tabla && tabla.tagName !== 'TABLE' && tabla.tagName !== 'H2') tabla = tabla.nextElementSibling;
    if (!tabla || tabla.tagName !== 'TABLE') continue;
    for (const tr of tabla.querySelectorAll('tbody tr')) {
      const td = (k) => tr.querySelector(`td[data-label="${k}"]`);
      const hm = texto(td('Hora')).match(/(\d{1,2}):(\d{2})/);
      const inicio = hm ? new Date(+m[3], +m[2] - 1, +m[1], +hm[1], +hm[2]).getTime() : null;
      const deporte = texto(td('Deporte')?.querySelector('.deporte')) || texto(td('Deporte'));
      const competicion = texto(td('Competición'));
      const titulo = texto(td('Evento')).replace(/\s+vs\s+/gi, ' - ');
      const celdaCanales = td('Canales');
      const canales = [];
      const ace = [];
      if (celdaCanales) {
        const limpia = celdaCanales.cloneNode(true);
        limpia.querySelectorAll('.popup, a, br').forEach((x) => x.remove());
        for (const parte of texto(limpia).split(/\s*,\s*/)) {
          const nombre = limpiarCanal(parte);
          if (nombre && !/^(aplazado|canal por confirmar|web directo)$/i.test(nombre) && !canales.includes(nombre)) canales.push(nombre);
        }
        for (const a of celdaCanales.querySelectorAll('a[href^="acestream://"]')) {
          const id = a.getAttribute('href').slice(12).trim().toLowerCase();
          if (/^[0-9a-f]{40}$/.test(id) && !ace.some((x) => x.id === id)) ace.push({ id, label: texto(a) });
        }
      }
      if (!titulo && !competicion) continue;
      const id = `${inicio}|${titulo}|${competicion}`;
      if (vistos.has(id)) continue;
      vistos.add(id);
      eventos.push({ id, inicio, deporte, competicion, extra: '', titulo: titulo || competicion, canales, gratis: [], enlaces: [], ace, aplazado: false });
    }
  }
  return eventos;
}

// ---------- cruce de nombres de canal ----------

const QUITAR = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', 'hdr', 'tv', 'bar', 'canal', 'channel', 'de', 'tve', 'directo',
  'ver', 'en', 'directo', 'gratis', 'app', 'live', 'es', 'esp', 'spain', 'españa', 'espana', 'by', 'the', 'plus', 'y', 'multi', 'feed', 'backup', 'opcion', 'op']);

// Nombres de plataforma que, solos, no identifican un canal concreto
const MARCAS = new Set(['dazn', 'm+', 'laliga', 'eurosport', 'espn', 'bein', 'sky', 'gol', 'rtve', 'mediaset', 'atresmedia', 'nba', 'f1']);

// Clave para reconocer el mismo canal con nombres distintos ("La_Liga FHD" = "LaLiga 1080" y
// "DAZN LaLiga" = "LaLiga DAZN"): sin calidades ni relleno, con equivalencias y sin importar el orden
const cacheClaves = new Map();
export function claveCanal(nombre) {
  const n = String(nombre || '');
  let k = cacheClaves.get(n);
  if (k !== undefined) return k;
  const t = [...new Set(tokens(n))].sort();
  k = t.length ? t.join(' ') : n.trim().toLowerCase();
  if (cacheClaves.size > 150000) cacheClaves.clear();
  cacheClaves.set(n, k);
  return k;
}

// Nombres distintos para el mismo canal (se aplican antes de partir en palabras)
const EQUIVALENCIAS = [
  [/liga\s*de\s*campeones|champions\s*league|\buefa\s*champions|\bchampions\b/g, ' champions '],
  [/laliga\s*(hypermotion|smartbank)\b|\bhypermotion\b/g, ' hypermotion '],
  [/\b(formula\s*1|formula\s*uno|f\s*1)\b/g, ' f1 '],
  [/\bmoto\s*gp\b/g, ' motogp '],
  [/\b(la|tve)\s*1\b|\bla1\b/g, ' la1 '],
  [/\b(la|tve)\s*2\b|\bla2\b/g, ' la2 '],
  [/\bantena\s*3\b|\ba\s*3\b/g, ' antena3 '],
  [/\bgol\s*play\b/g, ' golplay '],
  [/\bm\+\s*vamos\b/g, ' m+ vamos '],
  [/\bla\s*sexta\b|\bla\s*6\b/g, ' lasexta '],
  [/\btele\s*5\b|\btele\s*cinco\b/g, ' telecinco '],
  [/\bteledeporte\b|\btdp\b/g, ' teledeporte '],
  [/\bbein\s*sports?\b/g, ' bein '],
  [/\beuro\s*sport\b/g, ' eurosport '],
  [/\breal\s*madrid\s*tv\b|\brmtv\b/g, ' realmadridtv '],
  [/\bm\+\s*deportes?\b/g, ' m+ deportes '],
  [/\b(primera\s*federacion|1\s*rfef)\b/g, ' rfef '],
];

const cacheTokens = new Map();
export function tokens(nombre) {
  const clave = String(nombre || '');
  const hecho = cacheTokens.get(clave);
  if (hecho) return hecho;
  const r = calcularTokens(clave);
  if (cacheTokens.size > 150000) cacheTokens.clear();
  cacheTokens.set(clave, r);
  return r;
}

function calcularTokens(nombre) {
  let t = String(nombre || '').replace(/_+/g, ' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    // Coletillas con las que las listas marcan de qué fuente viene el enlace («DAZN 1 NEW LOOP», «DAZN 1 SPORT TV»,
    // «HYPERMOTION VI»): no son parte del nombre del canal, así esos enlaces se juntan con el suyo
    .replace(/\s+(new\s*loop|sport\s*tv|vi)\s*$/, ' ')
    .replace(/\s+(new\s*loop|sport\s*tv|vi)\s*$/, ' ')
    .replace(/movistar\s*plus\s*\+?|movistar\s*\+|movistar/g, ' m+ ')
    .replace(/\bm\s*\+/g, ' m+ ')
    .replace(/#/g, ' ')
    .replace(/la\s*liga/g, 'laliga')
    .replace(/\b(1080|720|2160|1080p|720p|2160p|1080i|50fps|60fps|h264|h265|hevc)\b/g, ' ')
    // «DAZN1» = «DAZN 1»
    .replace(/([a-zñ])(\d)/g, '$1 $2');
  for (const [re, por] of EQUIVALENCIAS) t = t.replace(re, por);
  t = t.replace(/[^a-z0-9+ñ]+/g, ' ');
  return t.split(' ').filter((w) => w && !QUITAR.has(w));
}

// ¿El canal de la agenda (a) corresponde a uno de mis canales (b)?
// Devuelve una puntuación (0 = no). Todas las palabras de a deben estar en b,
// y si a lleva número, b debe llevar el mismo.
export function puntuar(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  if (!ta.every((w) => setB.has(w))) return 0;
  const numA = ta.filter((w) => /^\d+$/.test(w));
  const numB = tb.filter((w) => /^\d+$/.test(w));
  // Un nombre genérico de una palabra ("DAZN") solo vale para canales que no añaden
  // otra cosa que un número ("DAZN 1"), no para "DAZN LaLiga" o "DAZN F1".
  if (ta.length === 1 && MARCAS.has(ta[0]) && tb.some((w) => !ta.includes(w) && !/^\d+$/.test(w))) return 0;
  // Si la agenda dice un número ("DAZN 1"), el canal debe llevar ese número y no otro.
  if (numA.length && numB.some((n) => !numA.includes(n))) return 0;
  let score = 10 * ta.length - (tb.length - ta.length);
  if (!numA.length && numB.length) score -= 3; // "DAZN" frente a "DAZN 2": vale, pero peor
  return Math.max(score, 1);
}

// ---------- YouTube ----------

const esYoutube = (nombre) => /youtube|youtu\.be/i.test(nombre || '');

// Enlace para ver el evento en YouTube: el directo que dé la agenda o, si no, una búsqueda con el título
function enlaceYoutube(ev) {
  const directo = (ev.enlaces || []).find((u) => /youtu/i.test(u));
  if (directo) return { url: directo, directo: true };
  const q = encodeURIComponent(`${ev.titulo} ${ev.competicion || ''} directo`.replace(/\s+/g, ' ').trim());
  return { url: `https://www.youtube.com/results?search_query=${q}&sp=EgJAAQ%3D%3D`, directo: false };
}

// ---------- módulo ----------

const URLS_MOTOR = ['https://www.futbolenlatv.es/deporte/automovilismo', 'https://www.futbolenlatv.es/deporte/motociclismo'];
const ES_MOTOR = /f[oó]rmula|\bf[12]\b|motor|moto ?gp|moto ?[23]\b|motociclismo|automovilismo|rally|dakar|nascar|indycar|superbike|\bwec\b|le mans|karting|\bdtm\b/i;
const OTRO_DEPORTE = /f[uú]tbol|balonc|tenis|balonm|rugby|hockey|golf|ciclismo|boxeo|mma|voley|vóley|p[aá]del|b[eé]isbol|atletismo/i;

export function crearAgenda(app) {
  const { store, $, esc, toast, openLayer, closeLayer, focusEl, statusOf, lastCheck, STATUS, peersTxt } = app;
  const st = { eventos: [], fetchedAt: null, cargando: false, error: null, dia: null, filtro: 'con', deporte: null, busqueda: '' };

  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && Array.isArray(c.eventos)) { st.eventos = c.eventos; st.fetchedAt = c.fetchedAt; }
  } catch { /* sin caché */ }

  const fuente = () => FUENTES[store.settings.agendaFuente] || FUENTES.deportes;
  const mapa = () => store.settings.agendaMapa || {};

  // Mis canales que corresponden a un nombre de canal de la agenda, mejores primero.
  // El resultado se guarda mientras no cambien los datos (store.version): la agenda lo pide muchas veces seguidas
  let memoPara = { v: -1, mapa: new Map() };
  function canalesPara(nombre) {
    if (memoPara.v !== store.version) memoPara = { v: store.version, mapa: new Map() };
    let r = memoPara.mapa.get(nombre);
    if (!r) { r = calcularCanalesPara(nombre); memoPara.mapa.set(nombre, r); }
    return r;
  }

  function calcularCanalesPara(nombre) {
    const fijos = mapa()[nombre];
    if (Array.isArray(fijos) && fijos.length) return fijos.map((id) => store.find(id)).filter(Boolean);
    const rank = { alive: 0, no_peers: 2, pending: 1, error: 3, not_found: 4 };
    return store.channels
      .map((c) => ({ c, s: puntuar(nombre, c.title) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => (rank[statusOf(x.c)] - rank[statusOf(y.c)]) || (y.s - x.s) || ((lastCheck(y.c)?.peers || 0) - (lastCheck(x.c)?.peers || 0)))
      .map((x) => x.c);
  }

  // "DAZN" a secas (la app) es un nombre genérico: sus coincidencias son solo posibles
  function generico(nombre) {
    const t = tokens(nombre);
    return t.length === 1 && MARCAS.has(t[0]) && !mapa()[nombre];
  }

  function canalesEvento(ev) {
    const vistos = new Set();
    const out = [];
    const concretos = ev.canales.filter((n) => !generico(n));
    for (const nombre of concretos) {
      for (const c of canalesPara(nombre)) {
        if (!vistos.has(c.id)) { vistos.add(c.id); out.push({ c, nombre }); }
      }
    }
    if (!out.length) {
      for (const nombre of ev.canales.filter(generico)) {
        for (const c of canalesPara(nombre)) {
          if (!vistos.has(c.id)) { vistos.add(c.id); out.push({ c, nombre, posible: true }); }
        }
      }
    }
    return out;
  }

  // Próximos eventos de un canal mío (para su ficha)
  function eventosDeCanal(canal, horas = 24) {
    const ahora = Date.now();
    return st.eventos.filter((ev) => ev.inicio && ev.inicio + DURACION_MS > ahora && ev.inicio < ahora + horas * 3600e3
      && ev.canales.some((n) => canalesPara(n).some((c) => c.id === canal.id)));
  }

  async function descargar(forzar = false) {
    if (st.cargando) return;
    if (!forzar && st.fetchedAt && Date.now() - new Date(st.fetchedAt).getTime() < CADUCA_MS && st.eventos.length) return;
    st.cargando = true;
    st.error = null;
    refreshView();
    try {
      const f = fuente();
      const html = await app.fetchText(f.url, f.charset);
      let eventos = f.leer === 'leerMarca' ? leerMarca(html) : f.leer === 'leerCiriaco' ? leerCiriaco(html) : leerAgenda(html);
      eventos = await conMotor(eventos);
      if (!eventos.length) throw new Error('La página no trae eventos o ha cambiado de formato');
      st.eventos = eventos;
      st.fetchedAt = new Date().toISOString();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ eventos, fetchedAt: st.fetchedAt })); } catch { /* sin espacio */ }
    } catch (e) {
      st.error = e.message || String(e);
    } finally {
      st.cargando = false;
      refreshView();
    }
  }

  // Motor (F1, MotoGP, rally…): la agenda general casi nunca lo trae; se leen aparte sus páginas de futbolenlatv
  // (próximos 15 días) y todo va bajo el deporte «Motor». Si fallan, la agenda sigue sin ellas.
  async function conMotor(eventos) {
    const ahora = Date.now();
    const extra = await Promise.all(URLS_MOTOR.map((u) => app.fetchText(u).then(leerAgenda).catch(() => [])));
    const ids = new Set(eventos.map((e) => e.id));
    const nuevos = extra.flat().filter((e) => e.inicio && e.inicio > ahora - 6 * 3600e3 && e.inicio < ahora + 15 * 864e5 && !ids.has(e.id))
      .map((e) => ({ ...e, deporte: 'Motor' }));
    const todos = [...eventos, ...nuevos];
    for (const e of todos) {
      if (ES_MOTOR.test(e.deporte || '') || (!OTRO_DEPORTE.test(e.deporte || '') && ES_MOTOR.test(e.competicion || ''))) e.deporte = 'Motor';
    }
    return todos.sort((a, b) => (a.inicio || 0) - (b.inicio || 0));
  }

  function dias() {
    const set = new Map();
    for (const ev of st.eventos) {
      if (!ev.inicio) continue;
      const d = new Date(ev.inicio);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!set.has(key)) set.set(key, d);
    }
    const hoy = new Date();
    const manana = new Date(Date.now() + 864e5);
    return [...set.entries()].map(([key, d]) => {
      let label = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' });
      if (d.toDateString() === hoy.toDateString()) label = 'Hoy';
      else if (d.toDateString() === manana.toDateString()) label = 'Mañana';
      return { key, label: label[0].toUpperCase() + label.slice(1) };
    });
  }

  function claveDia(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  const plano = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function visibles() {
    const ahora = Date.now();
    const palabras = plano(st.busqueda).split(/\s+/).filter(Boolean);
    return st.eventos.filter((ev) => {
      if (!ev.inicio || ev.inicio + DURACION_MS < ahora) return false;
      // Buscando se mira en todos los días (si no, un partido de pasado mañana no aparece)
      if (palabras.length) {
        const txt = plano(`${ev.titulo} ${ev.competicion} ${ev.deporte} ${ev.extra || ''} ${(ev.canales || []).join(' ')}`);
        if (!palabras.every((p) => txt.includes(p))) return false;
      } else if (st.dia && claveDia(ev.inicio) !== st.dia) return false;
      if (st.deporte && ev.deporte !== st.deporte) return false;
      if (st.filtro === 'con' && !canalesEvento(ev).length && !(ev.ace || []).length) return false;
      if (st.filtro === 'abierto' && !(ev.gratis || []).length) return false;
      return true;
    }).sort((a, b) => a.inicio - b.inicio);
  }

  function hora(ms) {
    return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  function filaEvento(ev) {
    const ahora = Date.now();
    const vivo = !ev.aplazado && ev.inicio <= ahora && ahora < ev.inicio + DURACION_MS;
    const mios = canalesEvento(ev);
    const vivos = mios.filter((x) => statusOf(x.c) === 'alive');
    const gr = ev.gratis || [];
    const gratisHtml = gr.length
      ? `<span class="ev-free"><b>En abierto</b> ${gr.slice(0, 4).map((n) => esc(n)).join(' · ')}${gr.length > 4 ? ` +${gr.length - 4}` : ''}</span>`
      : '';
    const aceHtml = (ev.ace || []).length ? `<span class="ev-free"><b>Enlace directo</b> ${esc(String(ev.ace.length))} Ace</span>` : '';
    const chips = mios.slice(0, 3).map(({ c, posible }) => {
      const s = statusOf(c);
      const chk = lastCheck(c);
      return `<span class="evch ${STATUS[s].cls}${posible ? ' posible' : ''}"><i></i>${posible ? '¿' : ''}${esc(c.title)}${posible ? '?' : ''}${chk?.peers != null && s === 'alive' ? ` · ${esc(peersTxt(chk.peers))}` : ''}</span>`;
    }).join('') + (mios.length > 3 ? `<span class="evch more">+${mios.length - 3}</span>` : '');
    return `
      <button class="ev-btn${vivo ? ' live' : ''}${mios.length || gr.length || (ev.ace || []).length ? '' : ' sin'}" data-ev="${esc(ev.id)}">
        <span class="ev-time">${ev.aplazado ? '<b class="livebadge gris">APLAZADO</b>' : vivo ? '<b class="livebadge">EN DIRECTO</b>' : esc(hora(ev.inicio))}${app.tieneAviso(ev.id) ? '<small class="campana"> ★</small>' : ''}</span>
        <span class="ev-main">
          <span class="ev-comp">${esc(ev.deporte)}${ev.competicion ? ' · ' + esc(ev.competicion) : ''}${ev.extra ? ' · ' + esc(ev.extra) : ''}</span>
          <span class="ev-title">${esc(ev.titulo)}</span>
          ${gratisHtml}${aceHtml}
          <span class="ev-chs">${st.filtro === 'abierto' && !mios.length ? '' : mios.length ? chips + (mios[0].posible ? '<span class="muted">· la agenda solo dice «' + esc(mios[0].nombre) + '»</span>' : '') : `<span class="muted">${esc(ev.canales.join(' · ') || 'Sin canal anunciado')}</span>`}</span>
        </span>
        <span class="ev-state">${vivos.length ? `<span class="badge ok">${vivos.length} vivo${vivos.length > 1 ? 's' : ''}</span>` : mios.length ? `<span class="badge none">${mios.length} canal${mios.length > 1 ? 'es' : ''}</span>` : ''}</span>
      </button>`;
  }

  function render() {
    const sec = $('#sec-agenda');
    const prev = document.activeElement;
    const prevEv = prev?.dataset?.ev;
    const prevKey = prev?.dataset?.akey;
    const wasIn = !!prev?.closest?.('#sec-agenda');
    const ds = dias();
    if (st.dia && !ds.some((d) => d.key === st.dia)) st.dia = null;
    if (!st.dia && ds.length) st.dia = ds[0].key;
    const deportes = [...new Set(st.eventos.filter((e) => !st.dia || claveDia(e.inicio) === st.dia).map((e) => e.deporte).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const lista = visibles();
    sec.innerHTML = `
      <div class="sec-head">
        <h1>Agenda <small>${st.cargando ? 'actualizando…' : st.fetchedAt ? `actualizada ${esc(new Date(st.fetchedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}` : ''}</small></h1>
        <div class="tools">
          <button class="btn" data-akey="refresh" data-a="refresh">Actualizar</button>
          <button class="btn" data-akey="fuente" data-a="fuente">${esc(fuente().label)}</button>
        </div>
      </div>
      <div class="filters">${ds.map((d) => `<button class="chip${st.dia === d.key ? ' on' : ''}" data-akey="d:${d.key}" data-dia="${d.key}">${esc(d.label)}</button>`).join('')}</div>
      <div class="filters">
        <button class="chip${st.filtro === 'con' ? ' on' : ''}" data-akey="f:con" data-filtro="con">Con mis canales</button>
        <button class="chip${st.filtro === 'abierto' ? ' on' : ''}" data-akey="f:abierto" data-filtro="abierto">En abierto</button>
        <button class="chip${st.filtro === 'todos' ? ' on' : ''}" data-akey="f:todos" data-filtro="todos">Todos los eventos</button>
        <span class="chip-sep"></span>
        <button class="chip${st.busqueda ? ' on' : ''}" data-akey="buscar" data-a="buscar">🔍 ${st.busqueda ? esc(st.busqueda) + ' ✕' : 'Buscar evento'}</button>
        <span class="chip-sep"></span>
        <button class="chip${!st.deporte ? ' on' : ''}" data-akey="s:" data-dep="">Todos</button>
        ${deportes.map((d) => `<button class="chip${st.deporte === d ? ' on' : ''}" data-akey="s:${esc(d)}" data-dep="${esc(d)}">${esc(d)}</button>`).join('')}
      </div>
      ${st.error ? `<p class="bad-text">No se pudo actualizar la agenda: ${esc(st.error)}</p>` : ''}
      <div class="evlist">
        ${lista.length ? lista.map(filaEvento).join('') : `<div class="empty"><p>${st.cargando ? 'Cargando la agenda…' : st.filtro === 'con'
          ? 'Ningún evento de este día coincide con tus canales. Prueba «Todos los eventos» para ver la agenda completa.'
          : st.filtro === 'abierto' ? 'No hay eventos en abierto este día.' : 'No hay eventos.'}</p></div>`}
      </div>
      <p class="muted small">Agenda de futbolenlatv.es. «En abierto» son los canales que esa web marca como gratuitos (TDT, RTVE Play, autonómicas, YouTube…). Los canales se enlazan por nombre; si alguno no cuadra, ábrelo y usa «Asignar canal».</p>`;
    // Solo se salta a la lista si seguías en «Agenda» del menú (si ya te moviste por el menú, no se te quita el foco)
    if (st.focoInicial && lista.length && (wasIn || prev === document.body || prev?.dataset?.section === 'agenda')) {
      st.focoInicial = false;
      focusEl(sec.querySelector('.ev-btn'));
    } else if (wasIn) {
      const el = (prevEv && sec.querySelector(`[data-ev="${CSS.escape(prevEv)}"]`)) || (prevKey && sec.querySelector(`[data-akey="${CSS.escape(prevKey)}"]`));
      if (el) el.focus({ preventScroll: true });
      else focusEl(sec.querySelector('.ev-btn') || sec.querySelector('button'));
    }
  }

  function refreshView() {
    if (app.ui.section === 'agenda') render();
    if (app.onAgenda) app.onAgenda();
  }

  // ---------- para la portada ----------

  function enCurso(ev, ahora = Date.now()) {
    return !ev.aplazado && ev.inicio && ev.inicio <= ahora && ahora < ev.inicio + DURACION_MS;
  }

  // ¿Se puede ver ya? Acestream comprobado vivo, o canal de TV en abierto que no haya fallado
  function jugable(c) {
    const s = statusOf(c);
    return s === 'alive' || (!!c.url && s === 'pending');
  }

  // Mejor canal mío para un evento: vivo y con más peers primero (los de TV en abierto cuentan como vivos)
  function mejor(ev) {
    const mios = canalesEvento(ev);
    if (!mios.length) return null;
    const vivos = mios.filter((x) => jugable(x.c) && !x.posible);
    const lista = (vivos.length ? vivos : mios).slice().sort((a, b) => (lastCheck(b.c)?.peers || 0) - (lastCheck(a.c)?.peers || 0));
    return { canal: lista[0].c, vivo: jugable(lista[0].c), posible: !!lista[0].posible, todos: mios.map((x) => x.c) };
  }

  // Todos los eventos (con o sin canal mío); m = mejor canal seguro o null
  function conCanal(ev) {
    const m = mejor(ev);
    return { ev, m: m && !m.posible ? m : null };
  }

  // Para la lista de canales: qué echa ahora (o pronto) cada canal mío. Se calcula una vez por minuto.
  let cacheCanal = { k: '', mapa: new Map() };
  function eventoPorCanal(horas = 4) {
    const ahora = Date.now();
    const k = [st.fetchedAt, store.channels.length, Math.floor(ahora / 60e3), JSON.stringify(mapa())].join('|');
    if (cacheCanal.k === k) return cacheCanal.mapa;
    const m = new Map();
    const evs = st.eventos.filter((ev) => !ev.aplazado && ev.inicio && ev.inicio + DURACION_MS > ahora && ev.inicio < ahora + horas * 3600e3)
      .sort((a, b) => (enCurso(b, ahora) - enCurso(a, ahora)) || (a.inicio - b.inicio));
    for (const ev of evs) {
      for (const x of canalesEvento(ev)) {
        if (!x.posible && !m.has(x.c.id)) m.set(x.c.id, { ev, vivo: enCurso(ev, ahora) });
      }
    }
    cacheCanal = { k, mapa: m };
    return m;
  }

  const prioridad = (x) => (x.m && x.m.vivo ? 0 : x.m ? 1 : (x.ev.gratis || []).length ? 2 : 3);

  function directoTodos() {
    const ahora = Date.now();
    return st.eventos.filter((ev) => enCurso(ev, ahora)).map(conCanal)
      .sort((a, b) => (prioridad(a) - prioridad(b)) || ((lastCheck(b.m?.canal || {})?.peers || 0) - (lastCheck(a.m?.canal || {})?.peers || 0)) || (a.ev.inicio - b.ev.inicio));
  }

  function siguientes(horas = 8) {
    const ahora = Date.now();
    return st.eventos.filter((ev) => !ev.aplazado && ev.inicio > ahora && ev.inicio < ahora + horas * 3600e3)
      .sort((a, b) => (a.inicio - b.inicio)).map(conCanal);
  }

  // Eventos de hoy aún por ver o en curso, agrupados por deporte (los deportes con más eventos primero)
  function hoyPorDeporte() {
    const ahora = Date.now();
    const fin = new Date(); fin.setHours(23, 59, 59, 999);
    const grupos = new Map();
    for (const ev of st.eventos) {
      if (ev.aplazado || !ev.inicio || ev.inicio + DURACION_MS < ahora || ev.inicio > fin.getTime()) continue;
      const k = ev.deporte || 'Otros';
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(conCanal(ev));
    }
    return [...grupos.entries()].map(([deporte, items]) => ({
      deporte,
      items: items.sort((a, b) => (prioridad(a) - prioridad(b)) || (a.ev.inicio - b.ev.inicio)),
    })).sort((a, b) => b.items.length - a.items.length);
  }

  // Eventos en directo con alguno de mis canales, mejores primero
  function enDirecto() {
    return st.eventos.filter((ev) => enCurso(ev) && canalesEvento(ev).length)
      .map((ev) => ({ ev, m: mejor(ev) }))
      .filter((x) => !x.m.posible)
      .sort((a, b) => (b.m.vivo - a.m.vivo) || (b.m.posible ? -1 : 0) - (a.m.posible ? -1 : 0)
        || ((lastCheck(b.m.canal)?.peers || 0) - (lastCheck(a.m.canal)?.peers || 0)));
  }

  function proximos(horas = 12) {
    const ahora = Date.now();
    return st.eventos.filter((ev) => !ev.aplazado && ev.inicio > ahora && ev.inicio < ahora + horas * 3600e3 && canalesEvento(ev).length)
      .sort((a, b) => a.inicio - b.inicio)
      .map((ev) => ({ ev, m: mejor(ev) }))
      .filter((x) => !x.m.posible);
  }

  function abiertoAhora() {
    const ahora = Date.now();
    return st.eventos.filter((ev) => (ev.gratis || []).length && !ev.aplazado && ev.inicio && ev.inicio + DURACION_MS > ahora && ev.inicio < ahora + 3 * 3600e3)
      .sort((a, b) => a.inicio - b.inicio);
  }

  function show() {
    st.focoInicial = true;
    render();
    descargar();
  }

  // ---------- ficha del evento ----------

  function abrirEvento(id) {
    const ev = st.eventos.find((e) => e.id === id);
    if (!ev) return;
    const mios = canalesEvento(ev);
    const yt = ev.canales.some(esYoutube) || (ev.enlaces || []).some((u) => /youtu/i.test(u)) ? enlaceYoutube(ev) : null;
    const grupos = ev.canales.filter((n) => !(yt && esYoutube(n))).map((nombre) => {
      const cs = canalesPara(nombre);
      return `
        <h3>${esc(nombre)}${mapa()[nombre] ? ' <small class="muted">(asignado a mano)</small>' : ''}</h3>
        ${cs.map((c) => {
          const s = statusOf(c);
          const chk = lastCheck(c);
          return `<button class="mbtn" data-play="${c.id}"><span><i class="dot ${STATUS[s].cls}"></i> ▶ ${esc(c.title)}</span>
            <b>${esc(STATUS[s].label)}${chk?.peers != null ? ` · ${esc(peersTxt(chk.peers))}` : ''}</b></button>`;
        }).join('') || '<p class="muted">Ninguno de tus canales coincide con este nombre.</p>'}
        ${cs.length ? '' : `<button class="mbtn" data-buscar="${esc(nombre)}"><span>🔍 Buscar «${esc(nombre)}» en mis listas</span><b>también apagadas</b></button>`}
        <button class="mbtn small" data-asignar="${esc(nombre)}"><span>Asignar canal a «${esc(nombre)}»…</span><b>›</b></button>`;
    }).join('');
    const layer = openLayer(`
      <p class="muted">${esc(ev.deporte)}${ev.competicion ? ' · ' + esc(ev.competicion) : ''}${ev.extra ? ' · ' + esc(ev.extra) : ''}</p>
      <h2>${esc(ev.titulo)}</h2>
      <p>${esc(new Date(ev.inicio).toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }))}</p>
      ${(ev.gratis || []).length ? `<div class="free-box"><b>Gratis y en abierto:</b> ${ev.gratis.map((n) => esc(n)).join(' · ')}</div>` : ''}
      <div class="vmenu">
        ${mios.length ? `<button class="mbtn primary" data-mejor data-autofocus><span>▶ Ver en el mejor canal</span><b>${esc(mios[0].c.title)}</b></button>
          <button class="mbtn" data-comprobar><span>Comprobar estos ${mios.length} canales</span><b>⟳</b></button>` : ''}
        ${yt ? `<button class="mbtn${mios.length ? '' : ' primary'}" data-yt><span>▶ Ver en YouTube</span><b>${yt.directo ? 'enlace directo' : 'búsqueda del directo'}</b></button>` : ''}
        ${(ev.ace || []).length ? `<h3>Enlaces directos de la agenda</h3>${ev.ace.map((a) => `<div class="mrow"><button class="mbtn${mios.length || yt ? '' : ' primary'}" data-ace="${esc(a.id)}" data-t="${esc(a.label)}"><span>▶ ${esc(a.label || 'Enlace Ace Stream')}</span><b>sin buscar en tus listas</b></button>
          <button class="mbtn small" data-acesave="${esc(a.id)}" data-t="${esc(a.label)}"><span>＋ Guardar en mis canales (lista «Agenda»)</span><b>${store.find(a.id) ? 'ya lo tienes' : ''}</b></button></div>`).join('')}` : ''}
        ${grupos || (yt || (ev.ace || []).length ? '' : '<p class="muted">El evento no anuncia canales.</p>')}
        <div class="sep"></div>
        ${ev.inicio > Date.now() ? `<button class="mbtn${app.tieneAviso(ev.id) ? ' check on' : ''}" data-aviso><span>${app.tieneAviso(ev.id) ? '★ Evento favorito · te avisaré al empezar (quitar)' : '☆ Marcar como favorito y avisarme al empezar'}</span><b>${esc(hora(ev.inicio))}</b></button>` : ''}
        ${app.equiposDe(ev).map((eq) => `<button class="mbtn${app.siguiendo(eq) ? ' check on' : ''}" data-equipo="${esc(eq)}"><span>${app.siguiendo(eq) ? `★ Sigues a ${esc(eq)} · dejar de seguir` : `☆ Seguir a ${esc(eq)}`}</span><b>sus partidos con 🔔</b></button>`).join('')}
        <button class="mbtn" data-close${mios.length ? '' : ' data-autofocus'}>Volver</button>
      </div>`, { cls: 'wide' });
    const lista = mios.map((x) => x.c);
    layer.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-play]');
      if (p) { closeLayer(layer); app.openWith(store.settings.player, store.find(p.dataset.play), lista); return; }
      if (e.target.closest('[data-mejor]')) { closeLayer(layer); app.openWith(store.settings.player, lista[0], lista); return; }
      if (e.target.closest('[data-comprobar]')) { closeLayer(layer); app.verifyMany(lista); toast('Comprobando los canales del evento…'); return; }
      const eqb = e.target.closest('[data-equipo]');
      if (eqb) { app.alternarEquipo(eqb.dataset.equipo); closeLayer(layer); abrirEvento(id); refreshView(); return; }
      if (e.target.closest('[data-aviso]')) { app.alternarAviso(ev); closeLayer(layer); abrirEvento(id); refreshView(); return; }
      const ba = e.target.closest('[data-ace]');
      if (ba) {
        const c = store.find(ba.dataset.ace) || { id: ba.dataset.ace, title: ba.dataset.t || 'Enlace de la agenda', listas: [], checks: [], category: null };
        closeLayer(layer); app.openWith(store.settings.player, c, [c]); return;
      }
      const bs = e.target.closest('[data-acesave]');
      if (bs) {
        if (store.find(bs.dataset.acesave)) { toast('Ya lo tienes en tus canales', 'ok'); return; }
        store.addChannels([{ id: bs.dataset.acesave, title: (bs.dataset.t || 'Enlace de la agenda').replace(/\s*-->.*$/, '') }], store.localList('Agenda').id);
        toast('Guardado en la lista «Agenda»', 'ok'); closeLayer(layer); abrirEvento(id); refreshView(); return;
      }
      if (e.target.closest('[data-yt]')) { app.abrirWeb(enlaceYoutube(ev).url); return; }
      const bq = e.target.closest('[data-buscar]');
      if (bq) { closeLayer(layer); buscarEnListas(bq.dataset.buscar, () => abrirEvento(id)); return; }
      const a = e.target.closest('[data-asignar]');
      if (a) { closeLayer(layer); asignar(a.dataset.asignar, () => abrirEvento(id)); }
    });
  }

  // Busca un canal de la agenda entre mis listas, también las apagadas (en la tele ligera esas las guarda el servidor),
  // y ofrece activar la lista donde está
  async function buscarEnListas(nombre, volver) {
    toast(`Buscando «${nombre}» en tus listas…`);
    const visibles = new Set(store.channels.map((c) => c.id));
    const nombres = new Map(store.data.sources.map((f) => [f.id, f.name]));
    const halladas = new Map();   // id de lista → { name, canales: [títulos] }
    const anotar = (lista, titulo) => {
      const l = halladas.get(lista.id) || { id: lista.id, name: lista.name, canales: [] };
      if (!l.canales.includes(titulo)) l.canales.push(titulo);
      halladas.set(lista.id, l);
    };
    for (const c of store.data.channels) {
      if (visibles.has(c.id) || c.oculto || puntuar(nombre, c.title) <= 0) continue;
      for (const id of c.listas || []) if (store.source(id)?.enabled === false) anotar({ id, name: nombres.get(id) || id }, c.title);
    }
    let sinServidor = false;
    if (store.settings.servidorCasa) {
      try {
        const r = JSON.parse(await app.fetchText(app.urlCasa(`/api/buscar-canal?q=${encodeURIComponent(nombre)}`)));
        for (const it of r.items || []) for (const l of it.listas || []) anotar(l, it.title);
      } catch { sinServidor = true; }
    }
    const listas = [...halladas.values()].sort((a, b) => b.canales.length - a.canales.length);
    const layer = openLayer(`
      <h2>«${esc(nombre)}» en tus listas</h2>
      ${listas.length
        ? '<p class="muted">Estos canales están en listas que tienes apagadas. Activa la lista y aparecerán en la agenda.</p>'
        : `<p class="muted">No lo encuentro en ninguna de tus listas${sinServidor ? ' (el servidor de casa no ha respondido, así que solo he mirado en esta tele)' : ''}. Puedes añadir una lista nueva o asignar a mano un canal parecido.</p>`}
      <div class="vmenu">
        ${listas.map((l, i) => `<button class="mbtn${i ? '' : ' primary'}" data-act="${esc(l.id)}"${i ? '' : ' data-autofocus'}><span>Activar la lista «${esc(l.name)}»</span><b>${l.canales.length} canal${l.canales.length > 1 ? 'es' : ''}</b></button>
          <p class="muted small">${esc(l.canales.slice(0, 4).join(' · '))}${l.canales.length > 4 ? ` · +${l.canales.length - 4}` : ''}</p>`).join('')}
        <div class="sep"></div>
        <button class="mbtn" data-close${listas.length ? '' : ' data-autofocus'}>Volver</button>
      </div>`, { cls: 'wide', onClose: () => volver && volver() });
    layer.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      app.activarLista(b.dataset.act);
      closeLayer(layer);
    });
  }

  // Asignar a mano qué canales míos corresponden a un nombre de la agenda
  function asignar(nombre, despues) {
    const actuales = new Set(mapa()[nombre] || []);
    const sugeridos = new Set(canalesPara(nombre).map((c) => c.id));
    const orden = [...store.channels].sort((a, b) => (sugeridos.has(b.id) - sugeridos.has(a.id)) || a.title.localeCompare(b.title, 'es'));
    const layer = openLayer(`
      <h2>Canales para «${esc(nombre)}»</h2>
      <p class="muted">Marca los canales que emiten «${esc(nombre)}». Si no marcas ninguno, se buscan por nombre.</p>
      <div class="vmenu">
        <button class="mbtn primary" data-ok data-autofocus>Guardar</button>
        <button class="mbtn" data-auto>Volver a buscar por nombre</button>
        <div class="sep"></div>
        ${orden.map((c) => `<button class="mbtn check${actuales.has(c.id) ? ' on' : ''}" data-c="${c.id}"><span>${actuales.has(c.id) ? '☑' : '☐'} ${esc(c.title)}</span><b>${esc(c.category || '')}</b></button>`).join('')}
      </div>`, { cls: 'wide', onClose: () => despues && despues() });
    layer.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (b) {
        const id = b.dataset.c;
        if (actuales.has(id)) actuales.delete(id); else actuales.add(id);
        b.classList.toggle('on', actuales.has(id));
        b.querySelector('span').textContent = `${actuales.has(id) ? '☑' : '☐'} ${store.find(id)?.title || ''}`;
        return;
      }
      if (e.target.closest('[data-ok]') || e.target.closest('[data-auto]')) {
        const m = { ...mapa() };
        if (e.target.closest('[data-auto]') || !actuales.size) delete m[nombre];
        else m[nombre] = [...actuales];
        store.setSettings({ agendaMapa: m });
        toast('Guardado', 'ok');
        closeLayer(layer);
      }
    });
  }

  function click(e) {
    const ev = e.target.closest('[data-ev]');
    if (ev) return abrirEvento(ev.dataset.ev);
    const d = e.target.closest('[data-dia]');
    if (d) { st.dia = d.dataset.dia; st.deporte = null; return render(); }
    const f = e.target.closest('[data-filtro]');
    if (f) { st.filtro = f.dataset.filtro; return render(); }
    const s = e.target.closest('[data-dep]');
    if (s) { st.deporte = s.dataset.dep || null; return render(); }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'buscar') {
      if (st.busqueda) { st.busqueda = ''; return render(); }
      return Promise.resolve(app.promptText('Buscar evento', '', { placeholder: 'Equipo, competición, deporte o canal', ok: 'Buscar' })).then((v) => { if (v == null) return; st.busqueda = String(v).trim(); render(); });
    }
    if (a === 'refresh') descargar(true);
    if (a === 'fuente') {
      const keys = Object.keys(FUENTES);
      const next = keys[(keys.indexOf(store.settings.agendaFuente || 'deportes') + 1) % keys.length];
      store.setSettings({ agendaFuente: next });
      st.fetchedAt = null;
      descargar(true);
    }
  }

  // Para el móvil
  async function resumen() {
    await descargar();
    const ahora = Date.now();
    return st.eventos
      .filter((ev) => ev.inicio && ev.inicio + DURACION_MS > ahora)
      .sort((x, y) => x.inicio - y.inicio)
      .slice(0, 400)
      .map((ev) => ({
      id: ev.id, inicio: ev.inicio, deporte: ev.deporte, competicion: ev.competicion, titulo: ev.titulo, gratis: ev.gratis || [],
      canales: canalesEvento(ev).map(({ c, nombre, posible }) => ({ id: c.id, title: c.title, status: statusOf(c), agenda: nombre, posible: !!posible })),
    }));
  }

  return { show, refreshView, click, descargar, eventosDeCanal, resumen, st,
    enCurso, enDirecto, proximos, abiertoAhora, abrirEvento, canalesEvento, hora,
    directoTodos, siguientes, hoyPorDeporte, jugable, eventoPorCanal };
}
