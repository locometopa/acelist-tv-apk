// Panel de administración de HomeTV (móvil y PC): habla con la tele por /api/... usando la clave del código QR.
(function () {
  'use strict';

  const KEY = 'acelist-movil-token';
  const params = new URLSearchParams(location.search);
  // La clave va en la dirección: /k7m2qd (o ?t=… en enlaces antiguos)
  const enRuta = location.pathname.match(/^\/([a-z0-9]{6,16})\/?$/i);
  let token = params.get('t') || (enRuta ? enRuta[1].toLowerCase() : '');
  try {
    if (token) localStorage.setItem(KEY, token);
    else token = localStorage.getItem(KEY) || '';
  } catch (e) { /* sin almacenamiento */ }

  const $ = (s) => document.querySelector(s);
  const STATUS = {
    alive: ['Vivo', 'ok'], no_peers: ['Sin peers', 'warn'], not_found: ['No encontrado', 'bad'],
    error: ['Error', 'bad'], pending: ['Sin comprobar', 'none'],
  };
  const POR_PAGINA = 150;
  const state = { canales: [], estado: null, abierto: null, editando: null, sel: new Set(), mostrar: POR_PAGINA, tab: 'canales' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ago(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
  }

  let toastTimer;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'X-Token': token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('No se puede conectar con la tele. ¿Está HomeTV abierta y en la misma wifi?');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  // ---------- diálogo propio (pedir un texto o confirmar) ----------

  function dialogo({ titulo, texto = '', valor = null, placeholder = '', lista = null, ok = 'Aceptar', peligro = false, extra = '' }) {
    return new Promise((resolve) => {
      const dlg = $('#dlg');
      const form = $('#dlgForm');
      form.innerHTML = `<h2>${esc(titulo)}</h2>${texto ? `<p class="muted">${texto}</p>` : ''}
        ${valor !== null ? `<input type="text" name="v" value="${esc(valor)}" placeholder="${esc(placeholder)}"${lista ? ` list="${lista}"` : ''} autocomplete="off">` : ''}
        ${extra}
        <div class="acciones"><button class="btn ${peligro ? 'danger' : 'primary'}" value="si">${esc(ok)}</button><button class="btn" value="no" formnovalidate>Cancelar</button></div>`;
      dlg.onclose = () => {
        if (dlg.returnValue !== 'si') return resolve(null);
        const datos = Object.fromEntries(new FormData(form).entries());
        resolve(valor !== null ? { v: String(datos.v || '').trim(), ...datos } : { ...datos, ok: true });
      };
      dlg.returnValue = '';
      dlg.showModal();
      const inp = form.querySelector('input[name=v]');
      if (inp) { inp.focus(); inp.select(); }
    });
  }

  // ---------- estado y lista ----------

  async function cargar() {
    try {
      const [estado, canales] = await Promise.all([api('GET', '/api/estado'), api('GET', '/api/canales')]);
      state.estado = estado;
      state.canales = canales;
      const ids = new Set(canales.map((c) => c.id));
      for (const id of [...state.sel]) if (!ids.has(id)) state.sel.delete(id);
      pintarEstado();
      pintarListas();
      pintarCategorias();
      pintarOrden();
      if (!document.activeElement || !document.activeElement.closest('#lista input')) pintarLista();
      pintarFuentes();
      pintarTablaCategorias();
      if (!document.activeElement || !document.activeElement.closest('#ajustes')) pintarAjustes();
    } catch (e) {
      $('#estado').className = 'estado bad';
      $('#estado').textContent = e.message;
    }
  }

  function pintarEstado() {
    const e = state.estado;
    const av = $('#avisoServidor');
    if (av) { av.hidden = !e.servidorCasa; if (e.servidorCasa) $('#enlaceServidor').href = e.servidorCasa; }
    const el = $('#estado');
    el.className = `estado ${e.motor === false ? 'bad' : 'ok'}`;
    el.textContent = e.motor === false ? 'Motor apagado' : 'Tele conectada';
    $('#estadoMas').innerHTML = `<span>${e.canales} canales · ${e.vivos} vivos</span>${e.vpn ? `<span>${esc(e.vpn)}</span>` : ''}<span>HomeTV ${esc(e.app)}</span>`;
    const p = $('#progreso');
    if (e.comprobando) {
      const c = e.comprobando;
      p.innerHTML = `Comprobando ${c.hechos} de ${c.total} · ${c.vivos} vivos<div class="barra"><span style="width:${Math.round((c.hechos / c.total) * 100)}%"></span></div>`;
    } else {
      p.innerHTML = '';
    }
    $('#comprobar').disabled = !!e.comprobando;
    $('#actualizarApp').hidden = !e.nativa;
  }

  // Filtro de listas: se pueden marcar varias; cada canal sale una vez aunque esté en varias
  const elegidas = new Set();

  function nombreLista(id) {
    const f = (state.estado.fuentes || []).find((x) => x.id === id);
    return f ? f.name : '';
  }

  function pintarListas() {
    const fs = (state.estado.fuentes || []).filter((f) => f.activa);
    const n = (id) => state.canales.filter((c) => (c.listas || []).includes(id)).length;
    const sueltos = state.canales.filter((c) => !(c.listas || []).length).length;
    const opciones = fs.filter((f) => n(f.id)).map((f) => ({ id: f.id, name: f.name, n: n(f.id) }));
    if (sueltos) opciones.push({ id: '-', name: 'Sin lista', n: sueltos });
    for (const id of [...elegidas]) if (!opciones.some((o) => o.id === id)) elegidas.delete(id);
    const rep = elegidas.size > 1
      ? state.canales.filter((c) => (c.listas || []).filter((id) => elegidas.has(id)).length > 1).length : 0;
    $('#flista').innerHTML = opciones.length > 1
      ? '<span class="muted">Listas:</span>'
        + `<button class="chip${elegidas.size ? '' : ' on'}" data-fl="">Todas</button>`
        + opciones.map((o) => `<button class="chip${elegidas.has(o.id) ? ' on' : ''}" data-fl="${esc(o.id)}">${elegidas.has(o.id) ? '✓ ' : ''}${esc(o.name)} <small>${o.n}</small></button>`).join('')
        + (rep ? `<span class="muted">${rep} repetidos entre listas, se ven una vez</span>` : '')
      : '';
    $('#listasDl').innerHTML = (state.estado.fuentes || []).filter((f) => !f.incluida).map((f) => `<option value="${esc(f.name)}">`).join('');
  }

  function pintarCategorias() {
    const sel = $('#categoria');
    const actual = sel.value;
    const cats = state.estado.categorias || [];
    sel.innerHTML = '<option value="">Todas</option><option value="-">Sin categoría</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    sel.value = actual === '-' || cats.includes(actual) ? actual : '';
    $('#cats').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
  }

  function pintarOrden() {
    const sel = $('#orden');
    const ord = state.estado.ordenes || {};
    if (sel.options.length !== Object.keys(ord).length) {
      sel.innerHTML = Object.entries(ord).filter(([k]) => k !== 'evento').map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
      sel.value = ord[state.estado.orden] && state.estado.orden !== 'evento' ? state.estado.orden : 'recomendado';
    }
  }

  function visibles() {
    const q = $('#buscar').value.trim().toLowerCase();
    const cat = $('#categoria').value;
    const f = $('#filtro').value;
    const orden = $('#orden').value || 'recomendado';
    const rank = { alive: 0, no_peers: 1, pending: 2, error: 3, not_found: 4 };
    const base = (a, b) => (b.favorite - a.favorite) || (rank[a.status] - rank[b.status]) || ((b.peers || 0) - (a.peers || 0)) || a.title.localeCompare(b.title, 'es');
    const cmp = {
      recomendado: base,
      nombre: (a, b) => a.title.localeCompare(b.title, 'es'),
      peers: (a, b) => ((b.peers || 0) - (a.peers || 0)) || base(a, b),
      categoria: (a, b) => (a.category || '~').localeCompare(b.category || '~', 'es') || base(a, b),
    }[orden] || base;
    return state.canales.filter((c) => {
      if (cat === '-' ? c.category : cat && c.category !== cat) return false;
      if (elegidas.size && !((elegidas.has('-') && !(c.listas || []).length) || (c.listas || []).some((id) => elegidas.has(id)))) return false;
      if (f === 'alive' && c.status !== 'alive') return false;
      if (f === 'fav' && !c.favorite) return false;
      if (f === 'pending' && c.status !== 'pending') return false;
      if (f === 'dead' && !['no_peers', 'not_found', 'error'].includes(c.status)) return false;
      if (f === 'abierto' && !c.abierto) return false;
      if (q && !`${c.title} ${c.category || ''} ${c.id}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort(cmp);
  }

  function estadoHtml(c) {
    const [label, cls] = STATUS[c.status] || STATUS.pending;
    if (c.checking) return '<span class="est-none">Comprobando…</span>';
    const txt = c.abierto && c.status !== 'error' && c.status !== 'not_found' ? 'En abierto'
      : c.status === 'alive' && c.peers != null ? `Vivo · ${c.peers}` : label;
    return `<span class="est-${c.abierto && txt === 'En abierto' ? 'ok' : cls}">${esc(txt)}</span><small>${c.checkedAt ? esc(ago(c.checkedAt)) : ''}</small>`;
  }

  function pintarLista() {
    const list = visibles();
    const ul = $('#lista');
    $('#cuenta').textContent = state.canales.length ? (list.length === state.canales.length ? `${list.length}` : `${list.length} de ${state.canales.length}`) : '';
    pintarLote(list);
    if (!state.canales.length) {
      ul.innerHTML = '<li class="vacio">No hay canales. Añádelos en «Añadir».</li>';
      $('#mas').hidden = true;
      return;
    }
    if (!list.length) {
      ul.innerHTML = '<li class="vacio">Ningún canal coincide.</li>';
      $('#mas').hidden = true;
      return;
    }
    const players = (state.estado && state.estado.reproductores) || {};
    const pref = state.estado && state.estado.reproductor;
    const orden = [pref, ...Object.keys(players).filter((k) => k !== pref)].filter((k) => k in players);
    const porCat = $('#orden').value === 'categoria';
    let ultima = null;
    ul.innerHTML = list.slice(0, state.mostrar).map((c) => {
      const open = state.abierto === c.id;
      const edit = state.editando === c.id;
      const sel = state.sel.has(c.id);
      const listas = (c.listas || []).map(nombreLista).filter(Boolean);
      let cab = '';
      if (porCat && (c.category || 'Sin categoría') !== ultima) {
        ultima = c.category || 'Sin categoría';
        cab = `<li class="vacio" style="text-align:left;padding:.8rem .3rem .2rem;color:var(--accent);font-size:.8rem;letter-spacing:.08em;text-transform:uppercase">${esc(ultima)}</li>`;
      }
      return `${cab}<li data-id="${c.id}" class="${sel ? 'sel' : ''}${open ? ' abierto' : ''}${c.checking ? ' busy' : ''}">
        <div class="fila">
          <input type="checkbox" data-sel${sel ? ' checked' : ''} aria-label="Seleccionar ${esc(c.title)}">
          <span class="nombre" data-toggle><span class="t">${c.favorite ? '<span class="fav">★</span> ' : ''}${esc(c.title)}${c.abierto ? '<span class="etq ab">abierto</span>' : ''}</span>
            <span class="m">${listas.length ? esc(listas.join(' · ')) : 'Sin lista'}</span></span>
          <span class="c-cat">${esc(c.category || '—')}</span>
          <span class="c-est">${estadoHtml(c)}</span>
          <span class="acc"><button class="ico play" data-play="${esc(pref || '')}" title="Ver en la tele">▶</button><button class="ico" data-toggle title="Más opciones">⋯</button></span>
        </div>
        ${open ? `<div class="panel">
          ${edit ? `
            <div class="edit">
              <input type="text" data-f="title" value="${esc(c.title)}" placeholder="Nombre">
              <input type="text" data-f="category" value="${esc(c.category || '')}" placeholder="Categoría" list="cats">
            </div>
            <div class="row"><button class="btn primary small" data-a="guardar">Guardar</button><button class="btn small" data-a="cancelar">Cancelar</button></div>`
          : `
            <div class="row"><span class="muted">Ver en la tele con:</span>${orden.map((k, i) => `<button class="btn${i === 0 ? ' primary' : ''} small" data-play="${k}">${i === 0 ? '▶ ' : ''}${esc(players[k])}</button>`).join('')}</div>
            <div class="row">
              <button class="btn small" data-a="comprobar">Comprobar</button>
              <button class="btn small" data-a="fav">${c.favorite ? '★ Quitar de favoritos' : '☆ Favorito'}</button>
              <button class="btn small" data-a="editar">Renombrar / categoría</button>
              <button class="btn small" data-a="lista">Añadir a lista…</button>
              <button class="btn small danger" data-a="borrar">Borrar</button>
            </div>
            <div class="info">ID ${esc(c.id)}${listas.length ? ` · Listas: ${esc(listas.join(', '))}` : ''}</div>`}
        </div>` : ''}
      </li>`;
    }).join('');
    $('#mas').hidden = list.length <= state.mostrar;
    $('#mas').textContent = `Ver más (${list.length - state.mostrar} restantes)`;
  }

  function pintarLote(list) {
    const n = state.sel.size;
    $('#lote').hidden = !n;
    $('#loteN').textContent = n === 1 ? '1 seleccionado' : `${n} seleccionados`;
    const vis = (list || visibles()).map((c) => c.id);
    const todos = vis.length && vis.every((id) => state.sel.has(id));
    $('#selTodos').checked = !!todos;
    $('#selTodos').indeterminate = !todos && vis.some((id) => state.sel.has(id));
  }

  function pintarFuentes() {
    const f = state.estado.fuentes || [];
    const n = (id) => state.canales.filter((c) => (c.listas || []).includes(id)).length;
    $('#fuentes').innerHTML = f.length
      ? f.map((s) => `<li class="fuente${s.activa ? '' : ' off'}" data-id="${esc(s.id)}">
          <button class="sw${s.activa ? ' on' : ''}" data-activar="${s.activa ? '0' : '1'}" title="${s.activa ? 'Desactivar' : 'Activar'}"></button>
          <span class="txt"><span class="t">${esc(s.name)}</span>
            <span class="muted">${s.url ? 'De internet' : 'Archivo o texto'}${s.fetchedAt ? ` · ${esc(ago(s.fetchedAt))}` : s.url ? ' · sin descargar' : ''}${s.nota ? ` · ${esc(s.nota)}` : ''}</span></span>
          <span class="num">${s.activa ? `${n(s.id)} canales` : 'desactivada'}</span>
          ${s.activa && n(s.id) ? '<button class="btn small" data-ver>Ver canales</button>' : ''}
          ${s.url ? '<button class="btn small" data-actualizar>Actualizar</button>' : ''}
          ${s.incluida ? '' : '<button class="btn small" data-renombrar>Renombrar</button><button class="btn small danger" data-quitar>Quitar</button>'}</li>`).join('')
      : '<li class="vacio">No hay listas. Añade canales en «Añadir».</li>';
  }

  function pintarTablaCategorias() {
    const cuenta = new Map();
    for (const c of state.canales) {
      const k = c.category || '';
      cuenta.set(k, (cuenta.get(k) || 0) + 1);
    }
    const cats = [...cuenta.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0], 'es'));
    $('#categorias').innerHTML = cats.length
      ? cats.map(([k, n]) => `<li class="fuente" data-cat="${esc(k)}"><span class="txt"><span class="t">${k ? esc(k) : '<i>Sin categoría</i>'}</span></span>
          <span class="num">${n} canales</span>
          <button class="btn small" data-vercat>Ver canales</button>
          ${k ? '<button class="btn small" data-rencat>Renombrar / unir</button><button class="btn small" data-ocultar>Ocultar</button><button class="btn small danger" data-quitcat>Quitar</button>' : ''}</li>`).join('')
      : '<li class="vacio">No hay canales.</li>';
    const oc = state.estado.ocultas || [];
    $('#ocultasTit').hidden = !oc.length;
    $('#ocultas').innerHTML = oc.map((o) => `<li class="fuente off" data-cat="${esc(o.nombre)}"><span class="txt"><span class="t">${esc(o.nombre)}</span></span>
      <span class="num">${o.n} canales</span><button class="btn small primary" data-mostrar>Mostrar</button></li>`).join('');
  }

  function pintarAjustes() {
    const filas = state.estado.ajustes || [];
    $('#ajustes').innerHTML = filas.map((r) => {
      if (r.titulo) return `<h3>${esc(r.titulo)}</h3>`;
      if (r.texto) return `<label>${esc(r.label)}<input type="text" data-aj="${esc(r.key)}" value="${esc(r.valor)}"></label>`;
      return `<label>${esc(r.label)}<select data-aj="${esc(r.key)}">${r.opciones.map((o) => `<option value="${esc(o.v)}"${o.v === r.valor ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</select></label>`;
    }).join('');
  }

  // ---------- acciones ----------

  async function accion(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
      await cargar();
      return r;
    } catch (e) {
      toast(e.message, 'bad');
      return null;
    }
  }

  const resumen = (r) => {
    let m = `${r.created} canales nuevos`;
    if (r.repeated) m += `, ${r.repeated} ya estaban`;
    if (r.invalid) m += `, ${r.invalid} líneas no válidas`;
    return m;
  };

  async function pedirLista() {
    const r = await dialogo({ titulo: 'Añadir a una lista', texto: 'Escribe el nombre de una lista tuya o uno nuevo para crearla. Los canales siguen en sus otras listas.', valor: '', placeholder: 'Nombre de la lista', lista: 'listasDl', ok: 'Añadir' });
    return r && r.v ? r.v : null;
  }

  $('#lista').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const id = li.dataset.id;
    const c = state.canales.find((x) => x.id === id);
    if (e.target.closest('[data-sel]')) {
      if (e.target.checked) state.sel.add(id); else state.sel.delete(id);
      li.classList.toggle('sel', e.target.checked);
      return pintarLote();
    }
    if (e.target.closest('[data-toggle]')) {
      state.abierto = state.abierto === id ? null : id;
      state.editando = null;
      return pintarLista();
    }
    const play = e.target.closest('[data-play]');
    if (play) return accion(() => api('POST', '/api/reproducir', { id, app: play.dataset.play || undefined }), `Abriendo «${c.title}» en la tele`);
    const a = e.target.closest('[data-a]') && e.target.closest('[data-a]').dataset.a;
    if (a === 'comprobar') return accion(() => api('POST', '/api/comprobar', { ids: [id] }), 'Comprobando en la tele…');
    if (a === 'fav') return accion(() => api('POST', '/api/canal', { id, favorite: !c.favorite }));
    if (a === 'editar') { state.editando = id; pintarLista(); const i = li.querySelector('[data-f=title]'); if (i) i.focus(); return; }
    if (a === 'cancelar') { state.editando = null; return pintarLista(); }
    if (a === 'guardar') {
      const title = li.querySelector('[data-f=title]').value;
      const category = li.querySelector('[data-f=category]').value;
      state.editando = null;
      return accion(() => api('POST', '/api/canal', { id, title, category }), 'Guardado');
    }
    if (a === 'lista') {
      const nombre = await pedirLista();
      if (nombre) accion(() => api('POST', '/api/lote', { ids: [id], accion: 'lista', valor: nombre }), `Añadido a «${nombre}»`);
      return;
    }
    if (a === 'borrar') {
      const ok = await dialogo({ titulo: 'Borrar canal', texto: `¿Borrar «${esc(c.title)}» de la tele?`, ok: 'Borrar', peligro: true });
      if (!ok) return;
      state.abierto = null;
      return accion(() => api('POST', '/api/borrar', { id }), 'Canal borrado');
    }
  });

  $('#lista').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-f]')) e.target.closest('li').querySelector('[data-a=guardar]').click();
    if (e.key === 'Escape' && e.target.matches('[data-f]')) { state.editando = null; pintarLista(); }
  });

  $('#selTodos').addEventListener('change', (e) => {
    const vis = visibles().map((c) => c.id);
    for (const id of vis) { if (e.target.checked) state.sel.add(id); else state.sel.delete(id); }
    pintarLista();
  });

  $('#lote').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-lote]') && e.target.closest('[data-lote]').dataset.lote;
    if (!a) return;
    const ids = [...state.sel];
    const n = ids.length;
    if (a === 'ninguno') { state.sel.clear(); return pintarLista(); }
    if (a === 'comprobar') return accion(() => api('POST', '/api/lote', { ids, accion: 'comprobar' }), `Comprobando ${n} canales en la tele…`);
    if (a === 'fav' || a === 'nofav') return accion(() => api('POST', '/api/lote', { ids, accion: 'fav', valor: a === 'fav' }), a === 'fav' ? `${n} canales en favoritos` : `${n} canales fuera de favoritos`);
    if (a === 'categoria') {
      const r = await dialogo({ titulo: `Categoría de ${n} canales`, texto: 'Elige una categoría o escribe una nueva. Vacío = sin categoría.', valor: '', placeholder: 'Categoría', lista: 'cats', ok: 'Cambiar' });
      if (r) accion(() => api('POST', '/api/lote', { ids, accion: 'categoria', valor: r.v }), 'Categoría cambiada');
      return;
    }
    if (a === 'lista') {
      const nombre = await pedirLista();
      if (nombre) accion(() => api('POST', '/api/lote', { ids, accion: 'lista', valor: nombre }), `${n} canales añadidos a «${nombre}»`);
      return;
    }
    if (a === 'borrar') {
      const ok = await dialogo({ titulo: `Borrar ${n} canales`, texto: 'Se quitan de la tele. No se puede deshacer.', ok: `Borrar ${n}`, peligro: true });
      if (!ok) return;
      state.sel.clear();
      return accion(() => api('POST', '/api/lote', { ids, accion: 'borrar' }), `${n} canales borrados`);
    }
  });

  ['#buscar', '#categoria', '#filtro', '#orden'].forEach((s) => $(s).addEventListener('input', () => { state.mostrar = POR_PAGINA; pintarLista(); }));
  $('#mas').onclick = () => { state.mostrar += POR_PAGINA; pintarLista(); };
  $('#flista').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fl]');
    if (!b) return;
    const id = b.dataset.fl;
    if (!id) elegidas.clear();
    else if (elegidas.has(id)) elegidas.delete(id);
    else elegidas.add(id);
    state.mostrar = POR_PAGINA;
    pintarListas();
    pintarLista();
  });

  $('#comprobar').onclick = () => {
    const ids = visibles().map((c) => c.id);
    accion(() => api('POST', '/api/comprobar', { ids }), (r) => `Comprobando ${r.total} canales en la tele…`);
  };

  $('#importarTexto').onclick = async () => {
    const texto = $('#texto').value;
    if (!texto.trim()) return toast('Pega antes algún enlace', 'bad');
    const r = await accion(() => api('POST', '/api/importar', { texto, lista: $('#nombreLista').value.trim() || 'Lista del móvil' }), resumen);
    if (r && r.created) $('#texto').value = '';
  };

  $('#importarArchivo').onclick = async () => {
    const files = [...$('#archivo').files];
    if (!files.length) return toast('Elige antes uno o varios archivos', 'bad');
    let nuevos = 0;
    const nombre = $('#nombreLista').value.trim();
    for (const f of files) {
      const texto = await f.text();
      const lista = nombre || f.name.replace(/\.(m3u8?|txt|json)$/i, '').replace(/_+/g, ' ');
      const r = await accion(() => api('POST', '/api/importar', { texto, lista }), files.length === 1 ? (x) => `${f.name}: ${resumen(x)}` : null);
      if (r) nuevos += r.created;
    }
    if (files.length > 1) toast(`${files.length} archivos: ${nuevos} canales nuevos`, 'ok');
    $('#archivo').value = '';
  };

  $('#importarUrl').onclick = async () => {
    const url = $('#url').value.trim();
    if (!url) return toast('Escribe la URL', 'bad');
    $('#importarUrl').disabled = true;
    const r = await accion(() => api('POST', '/api/importar-url', { url, nombre: $('#urlNombre').value || $('#nombreLista').value, guardar: $('#urlGuardar').checked }), resumen);
    $('#importarUrl').disabled = false;
    if (r) { $('#url').value = ''; $('#urlNombre').value = ''; }
  };

  $('#anadirUno').onclick = async () => {
    const id = $('#unId').value.trim();
    if (!id) return toast('Pega el enlace del canal', 'bad');
    const nombre = $('#unNombre').value.trim();
    const cat = $('#unCategoria').value.trim().replace(/"/g, "'");
    const texto = `#EXTINF:-1${cat ? ` group-title="${cat}"` : ''},${nombre}\n${id}`;
    const r = await accion(() => api('POST', '/api/importar', { texto, lista: $('#nombreLista').value.trim() || undefined }), (x) => (x.created ? 'Canal añadido' : x.repeated ? 'Ese canal ya estaba' : 'Enlace no válido'));
    if (r && r.created) { $('#unId').value = ''; $('#unNombre').value = ''; }
  };

  // Listas
  $('#fuentes').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    const id = li.dataset.id;
    const f = (state.estado.fuentes || []).find((x) => x.id === id);
    const act = e.target.closest('[data-activar]');
    if (act) {
      const activa = act.dataset.activar === '1';
      act.disabled = true;
      return accion(() => api('POST', '/api/fuente-activar', { id, activa }), activa ? 'Lista activada' : 'Lista desactivada');
    }
    if (e.target.closest('[data-ver]')) {
      elegidas.clear(); elegidas.add(id);
      $('#categoria').value = ''; $('#filtro').value = ''; $('#buscar').value = '';
      irA('canales');
      pintarListas(); pintarLista();
      return;
    }
    if (e.target.closest('[data-actualizar]')) {
      const b = e.target.closest('[data-actualizar]');
      b.disabled = true; b.textContent = 'Descargando…';
      return accion(() => api('POST', '/api/fuente-actualizar', { id }), (r) => `${f.name}: ${r.created} canales nuevos`);
    }
    if (e.target.closest('[data-renombrar]')) {
      const r = await dialogo({ titulo: 'Renombrar lista', valor: f.name, ok: 'Guardar' });
      if (r && r.v) accion(() => api('POST', '/api/fuente-renombrar', { id, nombre: r.v }), 'Lista renombrada');
      return;
    }
    if (e.target.closest('[data-quitar]')) {
      const r = await dialogo({
        titulo: `Quitar «${f.name}»`, ok: 'Quitar', peligro: true,
        extra: '<label class="check"><input type="checkbox" name="borrar" value="1"> Borrar también sus canales (los que no estén en otra lista)</label>',
      });
      if (r) accion(() => api('POST', '/api/fuente-borrar', { id, borrarCanales: !!r.borrar }), 'Lista quitada');
    }
  });

  $('#actualizarFuentes').onclick = async () => {
    $('#actualizarFuentes').disabled = true;
    await accion(() => api('POST', '/api/fuentes'), (r) => `Listas actualizadas: ${r.created} canales nuevos`);
    $('#actualizarFuentes').disabled = false;
  };

  // Categorías
  $('#unificar').onclick = () => accion(() => api('POST', '/api/unificar'), (r) => (r.total ? `${r.total} canales juntados en su categoría` : 'No había categorías repetidas'));
  $('#ocultas').addEventListener('click', (e) => {
    const li = e.target.closest('[data-cat]');
    if (li && e.target.closest('[data-mostrar]')) accion(() => api('POST', '/api/categoria-ocultar', { nombre: li.dataset.cat, oculta: false }), 'Categoría visible otra vez');
  });
  $('#categorias').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-cat]');
    if (!li) return;
    const cat = li.dataset.cat;
    if (e.target.closest('[data-ocultar]')) return accion(() => api('POST', '/api/categoria-ocultar', { nombre: cat, oculta: true }), `«${cat}» ya no sale en la tele`);
    if (e.target.closest('[data-vercat]')) {
      elegidas.clear();
      pintarListas();
      $('#categoria').value = cat || '-'; $('#filtro').value = ''; $('#buscar').value = '';
      irA('canales');
      pintarLista();
      return;
    }
    if (e.target.closest('[data-rencat]')) {
      const r = await dialogo({ titulo: 'Renombrar categoría', texto: 'Si escribes una que ya existe, se juntan.', valor: cat, lista: 'cats', ok: 'Guardar' });
      if (r && r.v && r.v !== cat) accion(() => api('POST', '/api/categoria', { de: cat, a: r.v }), (x) => `${x.total} canales ahora en «${r.v}»`);
      return;
    }
    if (e.target.closest('[data-quitcat]')) {
      const ok = await dialogo({ titulo: `Quitar «${cat}»`, texto: 'Sus canales se quedan sin categoría (no se borran).', ok: 'Quitar', peligro: true });
      if (ok) accion(() => api('POST', '/api/categoria', { de: cat, a: '' }), 'Categoría quitada');
    }
  });

  // Ajustes
  $('#ajustes').addEventListener('change', (e) => {
    const el = e.target.closest('[data-aj]');
    if (!el) return;
    accion(() => api('POST', '/api/ajustes', { [el.dataset.aj]: el.value }), 'Ajuste guardado en la tele');
  });

  // Copia
  document.querySelectorAll('[data-exportar]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api('POST', '/api/exportar', { formato: b.dataset.exportar });
        const blob = new Blob([r.texto], { type: b.dataset.exportar === 'm3u' ? 'audio/x-mpegurl' : 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = r.nombre;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast(`Descargado ${r.nombre}`, 'ok');
      } catch (err) { toast(err.message, 'bad'); }
    };
  });
  // Subir una APK nueva: va directa a la tele (sin pasar por la app web) y se abre el instalador
  $('#subirApk').onclick = () => {
    const f = $('#apk').files[0];
    if (!f) return toast('Elige antes el archivo .apk', 'bad');
    if (!/\.apk$/i.test(f.name)) return toast('Tiene que ser un archivo .apk', 'bad');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/apk');
    xhr.setRequestHeader('X-Token', token);
    xhr.setRequestHeader('Content-Type', 'application/vnd.android.package-archive');
    $('#subirApk').disabled = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $('#apkProgreso').innerHTML = `Enviando ${Math.round((e.loaded / e.total) * 100)} %<div class="barra"><span style="width:${(e.loaded / e.total) * 100}%"></span></div>`;
    };
    xhr.onloadend = () => {
      $('#subirApk').disabled = false;
      $('#apkProgreso').innerHTML = '';
      let r = {};
      try { r = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* sin cuerpo */ }
      if (xhr.status === 200) return toast('Listo: confirma la instalación en la tele con el mando', 'ok');
      if (r.error === 'PERMISO') {
        return dialogo({ titulo: 'Falta un permiso en la tele', ok: 'Entendido',
          texto: 'En la tele se ha abierto la pantalla «Instalar apps desconocidas». Activa el permiso para HomeTV y vuelve a enviar la APK.' });
      }
      toast(r.error || (xhr.status ? `Error ${xhr.status}` : 'No se pudo enviar'), 'bad');
    };
    xhr.send(f);
  };

  $('#borrarTodo').onclick = async () => {
    const n = state.canales.length;
    const r = await dialogo({ titulo: 'Borrar todos los canales', texto: `Se borran los ${n} canales de la tele. Escribe <b>BORRAR</b> para confirmar.`, valor: '', placeholder: 'BORRAR', ok: 'Borrar todo', peligro: true });
    if (!r) return;
    if (r.v.toUpperCase() !== 'BORRAR') return toast('No se ha borrado nada', 'bad');
    accion(() => api('POST', '/api/borrar-todo'), 'Canales borrados');
  };

  // ---------- agenda ----------

  const ag = { eventos: null, cargando: false };

  async function cargarAgenda() {
    if (ag.cargando) return;
    ag.cargando = true;
    if (!ag.eventos) $('#agenda').innerHTML = '<li class="vacio">Cargando la agenda…</li>';
    try {
      ag.eventos = await api('GET', '/api/agenda');
      pintarAgenda();
    } catch (e) {
      $('#agenda').innerHTML = `<li class="vacio">${esc(e.message)}</li>`;
    } finally {
      ag.cargando = false;
    }
  }

  function diaDe(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function pintarAgenda() {
    const evs = ag.eventos || [];
    const sel = $('#agDia');
    const dias = [];
    for (const ev of evs) { const k = diaDe(ev.inicio); if (!dias.some((d) => d.k === k)) dias.push({ k, ms: ev.inicio }); }
    const actual = sel.value;
    const hoy = new Date().toDateString();
    sel.innerHTML = dias.map((d) => {
      const f = new Date(d.ms);
      const label = f.toDateString() === hoy ? 'Hoy' : f.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric' });
      return `<option value="${d.k}">${esc(label)}</option>`;
    }).join('');
    if (dias.some((d) => d.k === actual)) sel.value = actual;
    const filtro = $('#agFiltro').value;
    const ahora = Date.now();
    const lista = evs.filter((ev) => diaDe(ev.inicio) === sel.value
      && (filtro !== 'con' || ev.canales.length)
      && (filtro !== 'abierto' || (ev.gratis || []).length));
    $('#agenda').innerHTML = lista.length ? lista.map((ev) => {
      const vivo = ev.inicio <= ahora;
      const hora = new Date(ev.inicio).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      const ids = ev.canales.map((c) => c.id);
      return `<li class="evento">
        <div class="ev-cab"><span class="ev-hora${vivo ? ' vivo' : ''}">${vivo ? 'EN DIRECTO' : esc(hora)}</span>
          <span class="m">${esc(ev.deporte)}${ev.competicion ? ' · ' + esc(ev.competicion) : ''}</span></div>
        <div class="t">${esc(ev.titulo)}</div>
        ${(ev.gratis || []).length ? `<div class="gratis"><b>En abierto</b> ${ev.gratis.map((n) => esc(n)).join(' · ')}</div>` : ''}
        ${ev.canales.length ? `<div class="row">${ev.canales.map((c) => {
          const cls = (STATUS[c.status] || STATUS.pending)[1];
          return `<button class="btn small" data-agplay="${c.id}" data-lista="${ids.join(',')}"><span class="dot ${cls}"></span>▶ ${c.posible ? '¿' : ''}${esc(c.title)}${c.posible ? '?' : ''}</button>`;
        }).join('')}</div>` : filtro === 'abierto' ? '' : '<div class="m">Sin canales tuyos</div>'}
      </li>`;
    }).join('') : '<li class="vacio">No hay eventos con estos filtros.</li>';
  }

  $('#agDia').addEventListener('input', pintarAgenda);
  $('#agFiltro').addEventListener('input', pintarAgenda);
  $('#agenda').addEventListener('click', (e) => {
    const b = e.target.closest('[data-agplay]');
    if (!b) return;
    const lista = b.dataset.lista.split(',').filter(Boolean);
    accion(() => api('POST', '/api/reproducir', { id: b.dataset.agplay, lista }), 'Abriendo en la tele…');
  });

  // ---------- pestañas ----------

  function irA(tab) {
    state.tab = tab;
    if (tab === 'agenda') cargarAgenda();
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${tab}`));
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => irA(b.dataset.tab); });

  if (!token) {
    $('#estado').className = 'estado bad';
    $('#estado').textContent = 'Falta la clave: escanea el código QR de la tele';
  } else {
    cargar();
    // Refresco periódico (más rápido mientras la tele comprueba canales); no se refresca con un diálogo abierto
    (function tick() {
      const rapido = state.estado && state.estado.comprobando;
      setTimeout(async () => {
        if (!document.hidden && !state.editando && !$('#dlg').open) await cargar();
        tick();
      }, rapido ? 2000 : 10000);
    })();
  }
})();
