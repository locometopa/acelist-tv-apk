// Lectura de canales: exportación JSON de AceList, listas M3U o texto con enlaces.

import { parseContentId } from './engine.js';

const HEX40 = /(?:acestream:\/\/)?([0-9a-f]{40})(?![0-9a-f])/i;
const GROUP = /group-title="([^"]*)"/i;
const TVGID = /tvg-id="([^"]*)"/i;
const LOGO = /tvg-logo="([^"]*)"/i;
const URL_RE = /^https?:\/\/\S+$/i;

// Identificador estable para un canal que es una dirección web (IPTV/HLS)
export function urlId(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `url-${h.toString(16).padStart(8, '0')}${(url.length % 4096).toString(16)}`;
}

// Solo se aceptan direcciones de vídeo que el reproductor sabe abrir
export function esStream(url) {
  return URL_RE.test(url) && !/youtube\.com|youtu\.be|twitch\.tv|facebook\.com/i.test(url);
}

export function parseText(text) {
  const t = String(text || '').replace(/^﻿/, '');
  if (t.trimStart().startsWith('{')) {
    let doc = null;
    try { doc = JSON.parse(t); } catch { /* lo dice parseAceListExport */ }
    if (esW3u(doc)) {
      const { out, invalid } = entradasW3u(doc, esStream);
      for (const e of out) if (!e.id) e.id = urlId(e.url);
      if (!out.length) throw new Error('La lista W3U no trae canales que se puedan abrir');
      return { entries: dedupe(out), invalid };
    }
    return parseAceListExport(t);
  }
  return parseLinks(t);
}

// Listas W3U (formato JSON de Wiseplay): { groups: [{ name, stations: [{ name, url, image }], groups: [...] }], stations: [...] }
function esW3u(doc) { return doc && typeof doc === 'object' && (Array.isArray(doc.groups) || Array.isArray(doc.stations)); }
function entradasW3u(doc, conUrl) {
  const out = [];
  let invalid = 0;
  const vistos = new Set();
  const recorrer = (nodo, grupo, prof) => {
    if (!nodo || prof > 6) return;
    for (const st of Array.isArray(nodo.stations) ? nodo.stations : []) {
      const enlace = String((st && (st.url || st.link)) || '').trim();
      const titulo = String((st && (st.name || st.title)) || '').trim();
      const logo = st && /^https?:\/\//i.test(st.image || st.logo || '') ? (st.image || st.logo) : null;
      const m = enlace.match(/([0-9a-f]{40})/i);
      if (m && (!/^https?:\/\//i.test(enlace) || /\/ace\/|acestream|btih/i.test(enlace))) out.push({ id: m[1].toLowerCase(), title: titulo, category: grupo, logo });
      else if (conUrl(enlace)) out.push({ id: null, url: enlace, alts: [], title: titulo, category: grupo, logo });
      else invalid++;
    }
    for (const g of Array.isArray(nodo.groups) ? nodo.groups : []) {
      const n = String((g && (g.name || g.title)) || '').trim();
      recorrer(g, n || grupo, prof + 1);
    }
  };
  recorrer(doc, null, 0);
  return { out: out.filter((e) => { const k = e.id || e.url; return vistos.has(k) ? false : (vistos.add(k), true); }), invalid };
}


function parseAceListExport(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error('El archivo no es un JSON válido');
  }
  if (!doc || doc.format !== 'acelist' || !Array.isArray(doc.channels)) {
    throw new Error('No es una exportación de AceList (falta "format": "acelist")');
  }
  const out = [];
  let invalid = 0;
  for (const e of doc.channels) {
    const url = typeof e?.url === 'string' && esStream(e.url) ? e.url : null;
    const id = url ? urlId(url) : parseContentId(e?.content_id || e?.link);
    if (!id) { invalid++; continue; }
    out.push({
      id,
      url,
      logo: e.logo || null,
      title: e.title_pending ? '' : e.title,
      category: e.category || null,
      language: e.language || null,
      country: e.country || null,
      resolution: e.resolution || null,
      createdAt: e.created_at || null,
    });
  }
  return { entries: dedupe(out), invalid };
}

// Un enlace por línea; en una M3U, la línea #EXTINF da nombre y grupo al enlace de debajo.
function parseLinks(text) {
  const out = [];
  let invalid = 0;
  let title = null;
  let group = null;
  let logo = null;
  let epgId = null;
  let ultimaUrl = null; // para juntar emisiones de reserva del mismo canal
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const g = line.match(GROUP);
      group = g ? g[1].trim() || null : null;
      const l = line.match(LOGO);
      logo = l && /^https?:\/\//i.test(l[1]) ? l[1] : null;
      const t = line.match(TVGID);
      epgId = t && t[1].trim() ? t[1].trim() : null;
      title = extinfTitle(line);
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = line.match(HEX40);
    // Es Acestream si lleva el ID y no es una dirección web normal (o es la de un motor / magnet)
    const esAce = m && (!/^https?:\/\//i.test(line) || /\/ace\/|acestream|btih/i.test(line));
    if (esAce) {
      out.push({ id: m[1].toLowerCase(), title: title || '', category: group, logo, epgId });
    } else if (esStream(line)) {
      // Canal normal de IPTV (HLS, etc.). Si repite nombre y grupo con el anterior, es su emisión de reserva.
      if (ultimaUrl && title && ultimaUrl.title === title && ultimaUrl.category === group) {
        ultimaUrl.alts.push(line);
      } else {
        ultimaUrl = { id: urlId(line), url: line, alts: [], title: title || '', category: group, logo, epgId };
        out.push(ultimaUrl);
      }
    } else {
      invalid++;
    }
    title = group = logo = epgId = null;
  }
  return { entries: dedupe(out), invalid };
}

function extinfTitle(line) {
  // '#EXTINF:-1 tvg-name="a,b" group-title="Deportes",Título': el título va tras la
  // primera coma que no esté entre comillas (igual que AceList).
  let inQuotes = false;
  let cut = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { cut = i; break; }
  }
  const t = cut >= 0 ? line.slice(cut + 1).trim() : '';
  return t || null;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

// Lista M3U con los canales, apuntando al motor (para VLC u otros reproductores).
export function toM3U(channels, engineBase) {
  const lines = ['#EXTM3U'];
  for (const c of channels) {
    const group = c.category ? ` group-title="${c.category.replace(/"/g, "'")}"` : '';
    const logo = c.logo ? ` tvg-logo="${c.logo}"` : '';
    lines.push(`#EXTINF:-1${logo}${group},${c.title}`);
    lines.push(c.url || `${engineBase.replace(/\/+$/, '')}/ace/getstream?id=${c.id}`);
  }
  return lines.join('\n') + '\n';
}
