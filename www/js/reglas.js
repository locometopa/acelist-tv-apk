// Reglas de las listas: se aplican a todos los canales cada vez que se importa o actualiza una lista,
// así los canales nuevos quedan ordenados sin tocarlos a mano. Se editan en el panel del servidor.
//   { tipo: 'ocultar',   patron: 'xxx|adult', en: 'nombre' | 'categoria' }   → no sale en las teles
//   { tipo: 'categoria', patron: 'dazn|laliga', valor: 'Deportes', en: ... } → se pone en esa categoría
//   { tipo: 'quitar',    patron: 'FHD|1080p' }                               → se borra ese texto del nombre
// El patrón es texto (sin distinguir mayúsculas ni acentos); con «|» se ponen varias opciones.
// Lo que una regla cambia se puede deshacer: el nombre y la categoría originales quedan en c.orig.
//
// OJO: servidor-casa/panel/reglas.js es una copia de este archivo para el panel del servidor.

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const opciones = (patron) => String(patron || '').split('|').map((p) => norm(p).trim()).filter(Boolean);

export const TIPOS_REGLA = { ocultar: 'Ocultar', categoria: 'Poner en la categoría', quitar: 'Quitar del nombre' };

export function coincide(texto, patron) {
  const t = norm(texto);
  return opciones(patron).some((p) => t.includes(p));
}

// Quita del nombre cada opción del patrón (sin distinguir mayúsculas) y arregla los espacios que quedan
export function quitarTexto(nombre, patron) {
  let t = String(nombre || '');
  for (const p of String(patron || '').split('|').map((x) => x.trim()).filter(Boolean)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    t = t.replace(re, '$1');
  }
  return t.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s\-–|·:>]+|[\s\-–|·:>]+$/g, '').trim() || String(nombre || '');
}

// Aplica las reglas a los canales (los cambia en el sitio). Devuelve cuántos han cambiado.
export function aplicarReglas(canales, reglas, categoriaDe = (x) => x) {
  const lista = (reglas || []).filter((r) => r && r.tipo && String(r.patron || '').trim());
  let cambios = 0;
  for (const c of canales) {
    const base = c.orig || { title: c.title, category: c.category };
    let title = base.title;
    let category = base.category;
    let oculto = false;
    for (const r of lista) {
      if (r.tipo === 'quitar') { title = quitarTexto(title, r.patron); continue; }
      if (!coincide(r.en === 'categoria' ? category : title, r.patron)) continue;
      if (r.tipo === 'ocultar') oculto = true;
      else if (r.tipo === 'categoria' && String(r.valor || '').trim() && !c.catManual) category = categoriaDe(String(r.valor).trim());   // la categoría puesta a mano manda sobre las reglas
    }
    // Lo ocultado a mano se respeta; lo ocultado por una regla vuelve si la regla ya no le toca
    const nuevoOculto = oculto ? (c.oculto === 'manual' ? 'manual' : 'regla') : (c.oculto === 'regla' ? undefined : c.oculto);
    const cambiado = title !== base.title || category !== base.category;
    if (title === c.title && category === c.category && nuevoOculto === c.oculto && (cambiado ? !!c.orig : !c.orig)) continue;
    c.title = title;
    c.category = category;
    if (nuevoOculto) c.oculto = nuevoOculto; else delete c.oculto;
    if (cambiado) c.orig = base; else delete c.orig;
    cambios++;
  }
  return cambios;
}

// Calidad que se lee del nombre (o de la resolución de la lista): 4 = 4K, 3 = 1080, 2 = 720/HD, 1 = SD, 0 = no se sabe
const cacheCalidad = new Map();
export function calidad(c) {
  const clave = `${(c.orig && c.orig.title) || c.title || ''}|${c.resolution || ''}`;
  const ya = cacheCalidad.get(clave);
  if (ya !== undefined) return ya;
  const q = calidadDe(clave);
  if (cacheCalidad.size > 20000) cacheCalidad.clear();
  cacheCalidad.set(clave, q);
  return q;
}
function calidadDe(texto) {
  const t = norm(texto.replace('|', ' '));
  if (/\b(4k|uhd|2160p?)\b/.test(t)) return 4;
  if (/\b(fhd|1080p?|1080i)\b/.test(t)) return 3;
  if (/\b(hd|720p?)\b/.test(t)) return 2;
  if (/\b(sd|480p?|576p?|360p?)\b/.test(t)) return 1;
  return 0;
}
