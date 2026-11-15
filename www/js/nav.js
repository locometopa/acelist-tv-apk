// Navegación con el mando de la tele (flechas + OK + Atrás), también con teclado.
// - Se mueve al elemento más cercano en la dirección pulsada.
// - Recuerda el último elemento de cada zona (menú lateral / contenido): al volver
//   a una zona, el foco cae donde estaba.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
const lastInZone = new Map();
let usoMando = false;   // la última interacción fue con flechas (no con ratón o dedo)
let ultimo = null;   // dónde estaba el foco: { zona, clave, idx }, para recuperarlo si la pantalla se repinta
let ultimaTecla = 0;
// ¿Se está moviendo ahora mismo con el mando? Los repintados automáticos esperan a que pare (así no salta el foco)
export function tecleando() { return Date.now() - ultimaTecla < 1500; }
const enEspera = new Map();
export function enCalma(clave, fn) {
  if (!tecleando()) { clearTimeout(enEspera.get(clave)); enEspera.delete(clave); fn(); return; }
  if (enEspera.has(clave)) return;
  enEspera.set(clave, setTimeout(function otra() {
    if (tecleando()) { enEspera.set(clave, setTimeout(otra, 400)); return; }
    enEspera.delete(clave);
    fn();
  }, 400));
}

// Cambia el contenido de un bloque sin que salte nada: si no ha cambiado no lo toca; si cambia, guarda y repone el
// desplazamiento de las filas horizontales, el de la página y el foco (el mismo elemento o el que ocupa su sitio).
const claveFoco = (el) => el.dataset.hkey || el.dataset.key || el.dataset.id || el.dataset.opt || el.dataset.grupo || el.id || '';
export function ponerHtml(raiz, html) {
  if (raiz._html === html) return false;
  const a = document.activeElement;
  const dentro = !!(a && a !== document.body && raiz.contains(a));
  const filas = new Map();
  raiz.querySelectorAll('.fila-scroll, .directo-fila').forEach((f, i) => {
    const k = f.closest('[aria-label]')?.getAttribute('aria-label') || `#${i}`;
    if (f.scrollLeft) filas.set(k, f.scrollLeft);
  });
  let clave = '', idxSec = -1, sec = '', idxTotal = -1;
  if (dentro) {
    clave = claveFoco(a);
    const s = a.closest('section[aria-label], [data-zona-foco]');
    sec = s ? (s.getAttribute('aria-label') || s.dataset.zonaFoco) : '';
    if (s) idxSec = [...s.querySelectorAll(FOCUSABLE)].indexOf(a);
    idxTotal = [...raiz.querySelectorAll(FOCUSABLE)].indexOf(a);
  }
  const y = window.scrollY;
  raiz.innerHTML = html;
  raiz._html = html;
  raiz.querySelectorAll('.fila-scroll, .directo-fila').forEach((f, i) => {
    const k = f.closest('[aria-label]')?.getAttribute('aria-label') || `#${i}`;
    if (filas.has(k)) f.scrollLeft = filas.get(k);
  });
  if (dentro) {
    let el = clave ? [...raiz.querySelectorAll(FOCUSABLE)].find((x) => claveFoco(x) === clave) : null;
    if (!el && sec) {
      const s = [...raiz.querySelectorAll('section[aria-label], [data-zona-foco]')].find((x) => (x.getAttribute('aria-label') || x.dataset.zonaFoco) === sec);
      const l = s ? [...s.querySelectorAll(FOCUSABLE)].filter(visible) : [];
      if (l.length) el = l[Math.max(0, Math.min(idxSec, l.length - 1))];
    }
    if (!el) { const l = [...raiz.querySelectorAll(FOCUSABLE)].filter(visible); if (l.length) el = l[Math.max(0, Math.min(idxTotal, l.length - 1))]; }
    if (el) { el.focus({ preventScroll: true }); anotarFoco(el); }
  }
  if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  return true;
}

// En el móvil se maneja con el dedo: el foco (el recuadro del mando) solo se usa si se está usando un teclado
let tactil = false;
let usandoTeclas = false;
export function modoTactil(v) {
  tactil = v;
  if (!v) return;
  document.addEventListener('keydown', (e) => { if (e.key in DIRS || e.key === 'Tab') usandoTeclas = true; }, true);
  document.addEventListener('pointerdown', () => { usandoTeclas = false; }, true);
  // Un botón tocado no se queda marcado como si tuviera el foco del mando
  document.addEventListener('focusin', (e) => {
    if (!usandoTeclas && e.target.matches?.('button, [tabindex]')) e.target.blur();
  });
}
function sinFoco(el) {
  return tactil && !usandoTeclas && !el.matches('input, textarea, select');
}

function visible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// La capa activa es el último diálogo abierto, o el reproductor; si no hay, la app.
export function activeLayer() {
  const layers = [...document.querySelectorAll('.layer.open')];
  if (layers.length) return layers[layers.length - 1];
  const player = document.querySelector('.playerlayer.open');
  if (player) return player;
  return document.getElementById('app');
}

export function focusables(root = activeLayer()) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(visible);
}

export function focusFirst(root = activeLayer()) {
  const preferred = root.querySelector('[data-autofocus]');
  const el = preferred && visible(preferred) ? preferred : focusables(root)[0];
  if (el) focusEl(el);
}

function zoneOf(el) {
  const z = el && el.closest('[data-zone]');
  return z ? z.dataset.zone : null;
}

const claveDe = (el) => el.dataset.key || el.dataset.id || el.dataset.opt || el.dataset.grupo || el.id || '';
function anotarFoco(el) {
  const zona = zoneOf(el);
  if (!zona || !el.closest('#app')) { return; }
  const raiz = document.querySelector(`[data-zone="${zona}"]`);
  const idx = raiz ? [...raiz.querySelectorAll(FOCUSABLE)].indexOf(el) : -1;
  ultimo = { zona, clave: claveDe(el), idx };
}

// Si al repintar la pantalla el elemento con el foco desaparece, el foco vuelve a la misma zona (al mismo elemento o al
// que ocupa su sitio), en vez de caer al primero de la pantalla (que era el menú lateral).
function recuperarFoco() {
  if (!ultimo || !usoMando || activeLayer().id !== 'app') return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const raiz = document.querySelector(`[data-zone="${ultimo.zona}"]`);
  if (!raiz) return;
  const lista = focusables(raiz);
  if (!lista.length) return;
  const mismo = ultimo.clave && lista.find((x) => claveDe(x) === ultimo.clave);
  focusEl(mismo || lista[Math.max(0, Math.min(ultimo.idx, lista.length - 1))], false);
}

export function focusEl(el, center = true) {
  if (sinFoco(el)) return;
  el.focus({ preventScroll: true });
  const z = zoneOf(el);
  if (z) lastInZone.set(z, el);
  anotarFoco(el);
  // El menú lateral está fijo: solo se desplaza el contenido. Desplazamiento instantáneo y solo si hace falta
  // (el suave se atasca en las teles); scroll-margin en el CSS deja ver lo que hay alrededor.
  if (center && !el.closest('.side')) {
    const r = el.getBoundingClientRect();
    // Se desplaza lo justo para que el elemento quede dentro con un margen (sin centrar de golpe: no da saltos)
    const cont = contenedorScroll(el);
    const zona = cont ? cont.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, height: window.innerHeight };
    const margen = Math.min(zona.height * 0.2, Math.max(r.height * 0.8, 60));
    let dy = 0;
    if (r.height > zona.height - 2 * margen) dy = r.top - zona.top - margen;
    else if (r.top < zona.top + margen) dy = r.top - (zona.top + margen);
    else if (r.bottom > zona.bottom - margen) dy = r.bottom - (zona.bottom - margen);
    if (dy) { if (cont) cont.scrollTop += dy; else window.scrollBy(0, dy); }
    const fila = el.closest('.fila-scroll, .directo-fila, .guia-scroll');
    if (fila) {
      const rf = fila.getBoundingClientRect();
      if (r.left < rf.left || r.right > rf.right) fila.scrollLeft += r.left - rf.left - (rf.width - r.width) / 2;
    }
  }
}

// ¿Está el elemento dentro de lo que se ve ahora (de su zona con desplazamiento o de la ventana)?
function enPantalla(el) {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const cont = contenedorScroll(el);
  const z = cont ? cont.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  return r.top >= z.top - 2 && r.bottom <= z.bottom + 2;
}

function contenedorScroll(el) {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

export function rememberedIn(zone) {
  const el = lastInZone.get(zone);
  return visible(el) ? el : null;
}

function center(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function move(dir) {
  const root = activeLayer();
  const current = document.activeElement;
  const items = focusables(root);
  if (!items.length) return;
  if (!current || !root.contains(current) || current === document.body) {
    // Sin foco (p. ej. tras repintar la pantalla): se vuelve a la zona en la que se estaba, no al primer elemento
    if (root.id === 'app' && ultimo) { recuperarFoco(); if (document.activeElement && document.activeElement !== document.body) return; }
    focusFirst(root);
    return;
  }
  const from = current.getBoundingClientRect();
  const c = center(from);
  const zonaActual = zoneOf(current);
  let best = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current) continue;
    // Dentro de una zona (menú lateral o contenido) las flechas no se salen de ella; para cambiar de zona hay que
    // pulsar ▶ en el menú o ◀ en el borde izquierdo del contenido
    if (zonaActual && zoneOf(el) !== zonaActual) continue;
    const r = el.getBoundingClientRect();
    const p = center(r);
    let primary;
    let secondary;
    // Lo lateral se mide por el hueco entre los dos elementos (0 si se solapan), no entre sus centros: así una fila
    // ancha justo debajo gana a una tarjeta estrecha que esté más lejos (antes se saltaba la agenda entera)
    const hueco = (a1, a2, b1, b2) => Math.max(0, b1 - a2, a1 - b2);
    if (dir === 'left') { if (r.right > from.left + 1) continue; primary = from.left - r.right; secondary = hueco(from.top, from.bottom, r.top, r.bottom) * 2 + Math.abs(p.y - c.y) * 0.1; }
    if (dir === 'right') { if (r.left < from.right - 1) continue; primary = r.left - from.right; secondary = hueco(from.top, from.bottom, r.top, r.bottom) * 2 + Math.abs(p.y - c.y) * 0.1; }
    if (dir === 'up') { if (r.bottom > from.top + 1) continue; primary = from.top - r.bottom; secondary = hueco(from.left, from.right, r.left, r.right) * 2 + Math.abs(p.x - c.x) * 0.1; }
    if (dir === 'down') { if (r.top < from.bottom - 1) continue; primary = r.top - from.bottom; secondary = hueco(from.left, from.right, r.left, r.right) * 2 + Math.abs(p.x - c.x) * 0.1; }
    const score = Math.max(primary, 0) + secondary;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) { focusEl(best); return; }
  // Nada más en esta dirección dentro de la zona: ▶ en el menú entra al contenido, ◀ en el contenido vuelve al menú
  if (root.id !== 'app') return;
  if (zonaActual === 'nav' && dir === 'right') {
    const main = document.querySelector('[data-zone="main"]');
    const dentro = main ? focusables(main) : [];
    // Se vuelve al último elemento solo si sigue a la vista; si no (p. ej. una tarjeta de «Vistos recientemente» que quedó
    // abajo), se entra por lo primero que se ve en pantalla, sin que la página baje de golpe
    const recordado = rememberedIn('main');
    const aLaVista = dentro.filter(enPantalla);
    const destino = (recordado && enPantalla(recordado) ? recordado : null)
      || aLaVista.find((x) => x.matches('[data-autofocus]'))
      || aLaVista.find((x) => x.matches('.hbtn, .row-btn, .ev-btn, .srow, .card'))
      || aLaVista[0] || dentro.find((x) => x.matches('[data-autofocus], .row-btn, .ev-btn, .srow, .card')) || dentro[0];
    if (destino) focusEl(destino);
  } else if (zonaActual === 'main' && dir === 'left') {
    const destino = document.querySelector('.mi.on') || rememberedIn('nav');
    if (destino) focusEl(destino);
  }
}

const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

export function installNav(onBack) {
  document.addEventListener('keydown', (e) => { if (e.key in DIRS || e.key === 'Enter') usoMando = true; if (e.key in DIRS) ultimaTecla = Date.now(); }, true);
  document.addEventListener('pointerdown', () => { usoMando = false; }, true);
  // Tras cualquier repintado de la pantalla, si el foco se ha perdido se recupera en su zona
  let pendiente = false;
  new MutationObserver(() => {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; recuperarFoco(); });
  }).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  document.addEventListener('focusin', (e) => {
    const z = zoneOf(e.target);
    if (z) lastInZone.set(z, e.target);
    anotarFoco(e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'checkbox' && t.type !== 'range';
    if (e.key in DIRS) {
      if (typing) {
        const atStart = t.selectionStart === 0 && t.selectionEnd === 0;
        const atEnd = t.selectionStart === t.value.length;
        if (e.key === 'ArrowLeft' && !atStart) return;
        if (e.key === 'ArrowRight' && !atEnd) return;
        if (t.tagName === 'TEXTAREA' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
      }
      e.preventDefault();
      move(DIRS[e.key]);
      return;
    }
    if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
      e.preventDefault();
      onBack();
    }
  });
}
