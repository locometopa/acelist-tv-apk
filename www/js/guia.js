// Guía de programación de los canales de TDTChannels (TV en abierto).
// TDTChannels publica la guía en JSON; se cruza con el tvg-id de cada canal de su lista («La1.TV»…).
// Se guarda solo lo que hace falta (de hace 3 h a dentro de 30 h) y se renueva cada 6 h.

const URL_GUIA = 'https://www.tdtchannels.com/epg/TV.json';
const KEY = 'acelist-tv:guia';
const CADUCA_MS = 6 * 3600e3;

export function crearGuia({ fetchText, onCambio }) {
  let datos = { at: 0, canales: {} };
  let cargando = false;
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && d.canales) datos = d;
  } catch { /* sin caché */ }

  async function descargar(forzar = false) {
    if (cargando || (!forzar && Date.now() - datos.at < CADUCA_MS)) return;
    cargando = true;
    try {
      const lista = JSON.parse(await fetchText(URL_GUIA));
      const desde = Date.now() / 1000 - 3 * 3600;
      const hasta = Date.now() / 1000 + 30 * 3600;
      const canales = {};
      for (const c of Array.isArray(lista) ? lista : []) {
        if (!c || !c.name || !Array.isArray(c.events)) continue;
        const evs = c.events.filter((e) => e.hf > desde && e.hi < hasta).map((e) => [e.hi, e.hf, String(e.t || '').slice(0, 90)]);
        if (evs.length) canales[c.name] = evs;
      }
      datos = { at: Date.now(), canales };
      try { localStorage.setItem(KEY, JSON.stringify(datos)); } catch { /* sin espacio */ }
      if (onCambio) onCambio();
    } catch { /* sin guía: se intenta en la siguiente */ } finally {
      cargando = false;
    }
  }

  // Programa que se emite ahora y el siguiente
  function ahora(epgId) {
    const evs = epgId && datos.canales[epgId];
    if (!evs) return null;
    const t = Date.now() / 1000;
    const i = evs.findIndex((e) => e[0] <= t && t < e[1]);
    if (i < 0) return null;
    const [hi, hf, titulo] = evs[i];
    const sig = evs[i + 1];
    return { titulo, hi: hi * 1000, hf: hf * 1000, avance: (t - hi) / (hf - hi), sig: sig ? { titulo: sig[2], hi: sig[0] * 1000 } : null };
  }

  // Programas de las próximas horas (para la ficha del canal)
  function proximos(epgId, n = 5) {
    const evs = epgId && datos.canales[epgId];
    if (!evs) return [];
    const t = Date.now() / 1000;
    return evs.filter((e) => e[1] > t).slice(0, n).map((e) => ({ titulo: e[2], hi: e[0] * 1000, hf: e[1] * 1000 }));
  }

  // Todos los programas guardados del canal (para la cuadrícula de la Guía)
  function programas(epgId) {
    const evs = epgId && datos.canales[epgId];
    return evs ? evs.map((e) => ({ titulo: e[2], hi: e[0] * 1000, hf: e[1] * 1000 })) : [];
  }

  return { descargar, ahora, proximos, programas, get tiene() { return Object.keys(datos.canales).length > 0; } };
}
