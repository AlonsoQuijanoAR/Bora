/* Bitácora del Auto — interfaz y almacenamiento (IndexedDB). */
'use strict';

const APP_VERSION = '1.0.0';
const {
  parseNum, fmtInt, fmtNum, fmtMoney, fmtPrice, toInput, todayISO, fmtDate, monthLabel, daysBetween,
  MESES_C, TIPOS, USOS, sortFuel, computeSegments, agg, groupStats, buildWorkbook,
} = window.Core;

// =====================================================================
// Base de datos local
// =====================================================================
const DB_NAME = 'bitacora-auto';
const DB_VERSION = 1;
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('vehicles')) db.createObjectStore('vehicles', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('fuel')) db.createObjectStore('fuel', { keyPath: 'id' }).createIndex('vehicleId', 'vehicleId');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

async function dbAll(store) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).getAll()); }
async function dbPut(store, obj) { const db = await openDB(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(obj); return txDone(t); }
async function dbDelete(store, id) { const db = await openDB(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(id); return txDone(t); }
async function getMeta(key) { const db = await openDB(); const r = await reqP(db.transaction('meta').objectStore('meta').get(key)); return r ? r.value : undefined; }
const setMeta = (key, value) => dbPut('meta', { key, value });

async function replaceAll({ vehicles, fuel, meta }) {
  const db = await openDB();
  const t = db.transaction(['vehicles', 'fuel', 'meta'], 'readwrite');
  ['vehicles', 'fuel', 'meta'].forEach(s => t.objectStore(s).clear());
  (vehicles || []).forEach(v => t.objectStore('vehicles').put(v));
  (fuel || []).forEach(f => t.objectStore('fuel').put(f));
  (meta || []).forEach(m => t.objectStore('meta').put(m));
  return txDone(t);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// =====================================================================
// Estado
// =====================================================================
const state = { vehicle: null, fuel: [], segs: [], prefs: { unidad: 'l100' }, lastBackup: null };

async function loadState() {
  const vehicles = await dbAll('vehicles');
  vehicles.sort((a, b) => (a.creado || 0) - (b.creado || 0));
  const activeId = await getMeta('activeVehicle');
  state.vehicle = vehicles.find(v => v.id === activeId) || vehicles[0] || null;
  const fuel = await dbAll('fuel');
  state.fuel = state.vehicle ? fuel.filter(f => f.vehicleId === state.vehicle.id) : [];
  state.segs = computeSegments(state.fuel);
  state.prefs = Object.assign({ unidad: 'l100' }, await getMeta('prefs'));
  state.lastBackup = (await getMeta('lastBackup')) || null;
  renderHeader();
}

function currentKm() {
  const odos = state.fuel.map(f => f.odo).filter(n => n != null);
  if (state.vehicle?.odoInicial != null) odos.push(state.vehicle.odoInicial);
  return odos.length ? Math.max(...odos) : null;
}
function lastFuel(filter = () => true) { const s = sortFuel(state.fuel.filter(filter)); return s[s.length - 1] || null; }
function lastPrice(tipo) { return lastFuel(f => f.tipo === tipo && f.precio > 0)?.precio ?? null; }

// =====================================================================
// Utilidades de interfaz
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.fn(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 9000 : 2600);
}

// Consumo en la unidad elegida
function cons(a) {
  if (!a || a.l100 == null) return { v: '—', u: state.prefs.unidad === 'kml' ? 'km/L' : 'L/100 km', alt: '' };
  return state.prefs.unidad === 'kml'
    ? { v: fmtNum(a.kml, 1), u: 'km/L', alt: `${fmtNum(a.l100, 1)} L/100 km` }
    : { v: fmtNum(a.l100, 1), u: 'L/100 km', alt: `${fmtNum(a.kml, 1)} km/L` };
}
const consVal = a => state.prefs.unidad === 'kml' ? a.kml : a.l100;

function renderHeader() {
  const v = state.vehicle;
  $('#carName').textContent = v ? v.nombre : 'Bitácora del Auto';
  $('#carSub').textContent = v ? [v.modelo, v.patente].filter(Boolean).join(' · ') : '';
}

function setActiveTab(name) {
  $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
  $('#tabbar').classList.toggle('hidden', !state.vehicle);
}

function segmented(name, options, value) {
  return `<div class="segmented" role="radiogroup">${Object.entries(options).map(([k, label]) => `
    <input type="radio" name="${name}" id="${name}-${k}" value="${k}" ${k === value ? 'checked' : ''}>
    <label for="${name}-${k}">${esc(label)}</label>`).join('')}</div>`;
}
function switchRow(id, title, desc, checked) {
  return `<label class="switch-row" for="${id}">
    <div><div class="t">${esc(title)}</div>${desc ? `<div class="d">${esc(desc)}</div>` : ''}</div>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span>
  </label>`;
}
const radioVal = (form, name) => form.querySelector(`input[name="${name}"]:checked`)?.value ?? null;

// =====================================================================
// Rutas
// =====================================================================
// Pila de navegación propia, para que "Cancelar" y "Guardar" vuelvan a la pantalla anterior
// y el botón atrás de Android siga funcionando como se espera.
const navStack = [location.hash || '#/'];
let replacing = false;
function navTo(hash) {
  if ((location.hash || '#/') === hash) { navStack[navStack.length - 1] = hash; route(); return; }
  replacing = true;
  location.replace(hash);
}
window.addEventListener('hashchange', () => {
  const h = location.hash || '#/';
  if (replacing) { replacing = false; navStack[navStack.length - 1] = h; }
  else if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else navStack.push(h);
  route();
});
function goBack(fallback = '#/') {
  if (navStack.length > 1) history.back(); else navTo(fallback);
}

function route() {
  const [name = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
  window.scrollTo(0, 0);
  if (!state.vehicle) return renderVehicleForm(true);
  switch (name) {
    case 'historial': return renderHistory();
    case 'stats': return renderStats();
    case 'ajustes': return renderSettings();
    case 'auto': return renderVehicleForm(false);
    case 'carga': return renderFuelForm(arg === 'nueva' ? null : decodeURIComponent(arg || ''));
    default: return renderHome();
  }
}

// =====================================================================
// Inicio
// =====================================================================
function renderHome() {
  setActiveTab('inicio');
  const { fuel, segs } = state;
  if (!fuel.length) {
    view().innerHTML = `
      <div class="card empty">
        <h3>Todavía no hay cargas</h3>
        <p>Registrá la primera para empezar. Si tenés datos viejos, cargalos con su fecha original.</p>
        <a class="btn btn-primary" href="#/carga/nueva">+ Nueva carga</a>
      </div>`;
    return;
  }

  const valid = segs.filter(s => !s.dudoso);
  const recent = agg(valid.slice(-5)), all = agg(valid);
  const c = cons(recent), cAll = cons(all);
  const hoy = todayISO();
  const ym = hoy.slice(0, 7);
  const mes = fuel.filter(f => f.fecha.startsWith(ym));
  const gastoMes = mes.reduce((a, f) => a + (f.total || 0), 0);
  const litrosMes = mes.reduce((a, f) => a + (f.litros || 0), 0);
  const last = lastFuel();
  const pc = lastPrice('comun'), pp = lastPrice('premium');

  let backupCard = '';
  const sinBackup = state.lastBackup ? daysBetween(state.lastBackup.slice(0, 10), hoy) : null;
  if (fuel.length >= 3 && (sinBackup == null || sinBackup > 30)) {
    backupCard = `<div class="card notice">
      <p>${sinBackup == null ? 'Todavía no hiciste ninguna copia de seguridad.' : `Hace ${sinBackup} días que no hacés una copia de seguridad.`}</p>
      <button class="btn btn-sm btn-primary" id="quickBackup" type="button">Hacer copia</button>
    </div>`;
  }

  view().innerHTML = `
    ${backupCard}
    <div class="card hero" ${backupCard ? 'style="margin-top:12px"' : ''}>
      <p class="card-title">Consumo · últimos ${recent.n || 0} tanques</p>
      ${recent.n ? `
        <div class="hero-row">
          <div><span class="big">${c.v}</span><span class="big-unit">${c.u}</span></div>
          <div class="hero-side"><span class="muted">Histórico</span><strong class="num">${cAll.v}</strong></div>
        </div>
        <div class="muted small" style="margin-top:8px">${c.alt} · ${fmtInt(recent.km)} km</div>`
      : `<p style="margin:6px 0 0">Necesito dos cargas con <b>tanque lleno</b> y km para calcular el consumo.</p>`}
    </div>

    <div class="grid2">
      <div class="card"><p class="card-title">Km actuales</p><div class="stat-val">${fmtInt(currentKm())}</div></div>
      <div class="card"><p class="card-title">Este mes</p><div class="stat-val">${fmtMoney(gastoMes)}</div>
        <div class="stat-sub">${fmtNum(litrosMes, 1)} L en ${mes.length} ${mes.length === 1 ? 'carga' : 'cargas'}</div></div>
      <div class="card"><p class="card-title">Costo por km</p><div class="stat-val">${all.costoKm != null ? fmtPrice(Math.round(all.costoKm * 10) / 10) : '—'}</div>
        <div class="stat-sub">solo combustible</div></div>
      <div class="card"><p class="card-title">Último precio</p>
        <div class="stat-sub" style="margin-top:0">Común <b class="num">${fmtPrice(pc)}</b></div>
        <div class="stat-sub">Premium <b class="num">${fmtPrice(pp)}</b></div></div>
    </div>

    <h2>Última carga</h2>
    <div class="list">${fuelItem(last)}</div>
    <a class="btn btn-block" href="#/historial" style="margin-top:12px">Ver historial completo</a>`;

  $('#quickBackup')?.addEventListener('click', downloadBackup);
}

// =====================================================================
// Historial
// =====================================================================
function fuelItem(f) {
  if (!f) return '';
  const seg = state.segs.find(s => s.endId === f.id);
  const [, m, d] = f.fecha.split('-');
  const tags = [
    `<span class="tag ${f.tipo}">${TIPOS[f.tipo]}</span>`,
    f.lleno ? '<span class="tag">Lleno</span>' : '<span class="tag">Parcial</span>',
    f.uso ? `<span class="tag">${USOS[f.uso]}</span>` : '',
    f.aditivo ? '<span class="tag">Limpiainyectores</span>' : '',
    seg ? `<span class="tag ${seg.dudoso ? 'dudoso' : 'cons'}">${cons(seg).v} ${cons(seg).u}${seg.dudoso ? ' · revisar' : ''}</span>` : '',
  ].join('');
  return `<a class="item" href="#/carga/${encodeURIComponent(f.id)}">
    <div class="item-date"><b>${+d}</b><small>${MESES_C[+m - 1]}</small></div>
    <div class="item-main">
      <div class="item-top"><span class="num">${fmtNum(f.litros, 2)} L</span><span class="num">${fmtMoney(f.total)}</span></div>
      <div class="item-sub">${f.odo != null ? fmtInt(f.odo) + ' km' : 'sin km'} · ${fmtPrice(f.precio)}/L${f.estacion ? ' · ' + esc(f.estacion) : ''}</div>
      <div class="tags">${tags}</div>
    </div>
  </a>`;
}

function renderHistory() {
  setActiveTab('historial');
  const list = sortFuel(state.fuel).reverse();
  if (!list.length) {
    view().innerHTML = `<div class="card empty"><h3>Sin cargas</h3><p>Cuando registres cargas, aparecen acá.</p>
      <a class="btn btn-primary" href="#/carga/nueva">+ Nueva carga</a></div>`;
    return;
  }
  const groups = new Map();
  list.forEach(f => { const k = f.fecha.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); });
  view().innerHTML = [...groups].map(([ym, items]) => `
    <div class="month"><h3>${monthLabel(ym)}</h3>
      <span>${fmtMoney(items.reduce((a, f) => a + (f.total || 0), 0))} · ${fmtNum(items.reduce((a, f) => a + (f.litros || 0), 0), 1)} L</span></div>
    <div class="list">${items.map(fuelItem).join('')}</div>`).join('');
}

// =====================================================================
// Formulario de carga
// =====================================================================
function renderFuelForm(id) {
  setActiveTab(id ? 'historial' : 'carga');
  const editing = id ? state.fuel.find(f => f.id === id) : null;
  if (id && !editing) { location.replace('#/historial'); return; }

  const last = lastFuel();
  const f = editing || {
    fecha: todayISO(), odo: null, litros: null,
    tipo: last?.tipo || 'comun', precio: null, total: null,
    lleno: true, aditivo: false, uso: last?.uso || 'mixto', estacion: last?.estacion || '', notas: '',
  };
  if (!editing) f.precio = lastPrice(f.tipo);
  const estaciones = [...new Set(state.fuel.map(x => x.estacion).filter(Boolean))];

  view().innerHTML = `
    <h2 style="margin-top:4px">${editing ? 'Editar carga' : 'Nueva carga'}</h2>
    <form class="form" id="fuelForm" novalidate autocomplete="off">
      <div class="row2">
        <div class="field"><label for="fecha">Fecha</label><input class="input" type="date" id="fecha" value="${f.fecha}" max="${todayISO()}" required></div>
        <div class="field"><label for="odo">Odómetro</label>
          <div class="with-unit"><input class="input num" id="odo" inputmode="numeric" placeholder="${last?.odo != null && !editing ? fmtInt(last.odo) : ''}" value="${f.odo != null ? fmtInt(f.odo) : ''}"><span class="unit">km</span></div>
        </div>
      </div>
      <div class="hint" id="odoHint"></div>

      <div class="field"><span class="label">Combustible</span>${segmented('tipo', { comun: 'Común', premium: 'Premium' }, f.tipo)}</div>

      <div class="row3">
        <div class="field"><label for="litros">Litros</label>
          <div class="with-unit"><input class="input num" id="litros" inputmode="decimal" value="${toInput(f.litros)}"><span class="unit">L</span></div></div>
        <div class="field"><label for="precio">Precio/L</label>
          <div class="with-unit pre"><input class="input num" id="precio" inputmode="decimal" value="${toInput(f.precio)}"><span class="unit">$</span></div></div>
        <div class="field"><label for="total">Total</label>
          <div class="with-unit pre"><input class="input num" id="total" inputmode="decimal" value="${toInput(f.total, 0)}"><span class="unit">$</span></div></div>
      </div>
      <div class="hint">Completá dos de los tres y el otro se calcula solo.</div>

      ${switchRow('lleno', 'Tanque lleno', 'Necesario para calcular el consumo', f.lleno)}
      ${switchRow('aditivo', 'Limpiainyectores', 'Le pusiste aditivo en esta carga', f.aditivo)}

      <div class="field"><span class="label">¿Cómo manejaste desde la carga anterior?</span>${segmented('uso', USOS, f.uso)}</div>

      <div class="field"><label for="estacion">Estación</label>
        <input class="input" id="estacion" list="estacionesList" value="${esc(f.estacion)}" placeholder="YPF Panamericana, Shell…" autocapitalize="sentences">
        <datalist id="estacionesList">${estaciones.map(e => `<option value="${esc(e)}">`).join('')}</datalist></div>

      <div class="field"><label for="notas">Notas</label>
        <textarea class="input" id="notas" rows="2" placeholder="Opcional">${esc(f.notas)}</textarea></div>

      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        ${editing ? '<button class="btn btn-danger btn-block" type="button" id="delBtn">Eliminar carga</button>' : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;

  const form = $('#fuelForm');
  const el = { odo: $('#odo'), litros: $('#litros'), precio: $('#precio'), total: $('#total'), fecha: $('#fecha') };

  // --- Cálculo automático entre litros, precio y total ---
  // Se recalcula el campo que el usuario tocó hace más tiempo.
  const order = editing ? ['total', 'litros'] : (f.precio != null ? ['precio'] : []);
  let precioPrefilled = !editing && f.precio != null;
  const read = () => ({ litros: parseNum(el.litros.value, 'dec'), precio: parseNum(el.precio.value, 'money'), total: parseNum(el.total.value, 'money') });
  function recalc() {
    Object.values(el).forEach(i => i.classList.remove('calc'));
    if (order.length < 2) return;
    const [a, b] = order;
    const target = ['litros', 'precio', 'total'].find(k => k !== a && k !== b);
    const v = read();
    if (v[a] == null || v[b] == null) return;
    let out = null;
    if (target === 'total') out = v.litros * v.precio;
    else if (target === 'litros' && v.precio) out = v.total / v.precio;
    else if (target === 'precio' && v.litros) out = v.total / v.litros;
    if (out == null || !Number.isFinite(out)) return;
    el[target].value = toInput(out, target === 'total' ? 0 : 2);
    el[target].classList.add('calc');
  }
  ['litros', 'precio', 'total'].forEach(k => el[k].addEventListener('input', () => {
    if (k === 'precio') precioPrefilled = false;
    const i = order.indexOf(k); if (i >= 0) order.splice(i, 1); order.unshift(k);
    recalc();
  }));

  // Al cambiar de combustible, sugerir el último precio de ese tipo (si no lo escribiste vos)
  $$('input[name="tipo"]', form).forEach(r => r.addEventListener('change', () => {
    if (!precioPrefilled) return;
    const p = lastPrice(r.value);
    el.precio.value = toInput(p);
    if (p == null) { const i = order.indexOf('precio'); if (i >= 0) order.splice(i, 1); }
    recalc();
  }));

  // --- Ayuda del odómetro ---
  function odoHint() {
    const odo = parseNum(el.odo.value, 'int');
    const fecha = el.fecha.value;
    const hint = $('#odoHint');
    hint.className = 'hint';
    const prev = sortFuel(state.fuel.filter(x => x.id !== id && x.odo != null && x.fecha <= fecha)).pop();
    if (odo == null) { hint.textContent = prev ? `Anterior: ${fmtInt(prev.odo)} km (${fmtDate(prev.fecha)})` : ''; return; }
    if (prev) {
      const d = odo - prev.odo;
      if (d < 0) { hint.className = 'hint warn'; hint.textContent = `Es menor que la carga del ${fmtDate(prev.fecha)} (${fmtInt(prev.odo)} km).`; }
      else hint.textContent = `+${fmtInt(d)} km desde la carga del ${fmtDate(prev.fecha)}`;
    } else hint.textContent = '';
  }
  el.odo.addEventListener('input', () => {
    // Formatea con puntos de miles mientras escribís
    const n = parseNum(el.odo.value, 'int');
    el.odo.value = n == null ? '' : fmtInt(n);
    odoHint();
  });
  el.fecha.addEventListener('change', odoHint);
  odoHint();

  $('#cancelBtn').onclick = () => goBack(editing ? '#/historial' : '#/');
  $('#delBtn')?.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar la carga del ${fmtDate(editing.fecha, true)}?`)) return;
    await dbDelete('fuel', editing.id);
    await loadState();
    toast('Carga eliminada');
    goBack('#/historial');
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = read();
    const obj = {
      id: editing?.id || uid(),
      vehicleId: state.vehicle.id,
      fecha: el.fecha.value,
      odo: parseNum(el.odo.value, 'int'),
      litros: v.litros,
      tipo: radioVal(form, 'tipo') || 'comun',
      precio: v.precio,
      total: v.total,
      lleno: $('#lleno').checked,
      aditivo: $('#aditivo').checked,
      uso: radioVal(form, 'uso'),
      estacion: $('#estacion').value.trim(),
      notas: $('#notas').value.trim(),
      creado: editing?.creado || Date.now(),
      modificado: Date.now(),
    };
    // Completar lo que falte si se puede
    if (obj.total == null && obj.litros && obj.precio) obj.total = Math.round(obj.litros * obj.precio);
    if (obj.precio == null && obj.litros && obj.total) obj.precio = Math.round(obj.total / obj.litros * 100) / 100;

    if (!obj.fecha) return toast('Falta la fecha');
    if (obj.fecha > todayISO()) return toast('La fecha no puede ser futura');
    if (!(obj.litros > 0)) { el.litros.focus(); return toast('Faltan los litros'); }
    if (obj.litros > 200 && !confirm(`¿${fmtNum(obj.litros, 2)} litros en una sola carga? ¿Guardar igual?`)) return;

    if (obj.odo != null) {
      const others = state.fuel.filter(x => x.id !== obj.id && x.odo != null);
      const bad = others.find(o => (o.fecha < obj.fecha && o.odo > obj.odo) || (o.fecha > obj.fecha && o.odo < obj.odo));
      if (bad && !confirm(`Ojo: el ${fmtDate(bad.fecha, true)} anotaste ${fmtInt(bad.odo)} km, y eso no cierra con ${fmtInt(obj.odo)} km el ${fmtDate(obj.fecha, true)}.\n\n¿Guardar igual?`)) return;
      const prev = sortFuel(others.filter(o => o.fecha <= obj.fecha)).pop();
      const maxJump = Math.max(1500, (state.vehicle.tanque || 0) * 35);
      if (!bad && prev && obj.odo - prev.odo > maxJump &&
        !confirm(`Son ${fmtInt(obj.odo - prev.odo)} km desde la carga anterior. ¿Está bien el odómetro?`)) return;
    } else if (obj.lleno && !confirm('Sin el odómetro esta carga no sirve para calcular el consumo. ¿Guardar igual?')) return;

    await dbPut('fuel', obj);
    requestPersistence();
    await loadState();
    toast(editing ? 'Cambios guardados' : 'Carga guardada');
    goBack(editing ? '#/historial' : '#/');
  });
}

// =====================================================================
// Estadísticas
// =====================================================================
function renderStats() {
  setActiveTab('stats');
  const { segs, fuel } = state;
  const valid = segs.filter(s => !s.dudoso);
  if (!valid.length) {
    view().innerHTML = `<div class="card empty"><h3>Faltan datos</h3>
      <p>Las estadísticas aparecen cuando hay al menos dos cargas con tanque lleno y odómetro.</p></div>`;
    return;
  }
  const all = agg(valid);
  const unit = cons(all).u;
  const dudosos = segs.length - valid.length;

  const groups = [
    { title: 'Común vs Premium', rows: groupStats(valid, 'tipo', ['comun', 'premium']).map(g => ({ ...g, label: TIPOS[g.key] })) },
    { title: 'Según el uso', rows: groupStats(valid, 'uso', ['ruta', 'mixto', 'urbano']).map(g => ({ ...g, label: USOS[g.key] })) },
    { title: 'Limpiainyectores', rows: [{ label: 'Con', ...agg(valid.filter(s => s.aditivo)) }, { label: 'Sin', ...agg(valid.filter(s => !s.aditivo)) }] },
  ];
  const maxV = Math.max(...groups.flatMap(g => g.rows.map(r => r.n ? consVal(r) : 0)));
  const cmpHtml = g => `
    <div class="card"><p class="card-title">${g.title}</p><div class="cmp">
      ${g.rows.map(r => `<div class="cmp-row ${r.n < 3 ? 'few' : ''}">
        <div class="cmp-label">${r.label}<small>${r.n} ${r.n === 1 ? 'tanque' : 'tanques'} · ${fmtInt(r.km)} km</small></div>
        <div class="bar"><i style="width:${r.n ? Math.max(4, consVal(r) / maxV * 100) : 0}%"></i></div>
        <div class="cmp-val num">${r.n ? cons(r).v : '—'}</div>
      </div>`).join('')}
    </div></div>`;

  // Gasto por mes, últimos 12 meses
  const months = [];
  const d = new Date(); d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  const gastoMes = months.map(m => fuel.filter(f => f.fecha.startsWith(m)).reduce((a, f) => a + (f.total || 0), 0));
  const gasto12 = gastoMes.reduce((a, b) => a + b, 0);

  view().innerHTML = `
    <div class="card hero">
      <p class="card-title">Promedio histórico</p>
      <div class="hero-row">
        <div><span class="big">${cons(all).v}</span><span class="big-unit">${unit}</span></div>
        <div class="hero-side"><span class="muted">${all.n} tanques</span><strong class="num">${fmtInt(all.km)} km</strong></div>
      </div>
      <div class="muted small" style="margin-top:8px">${cons(all).alt}${all.costoKm != null ? ` · ${fmtPrice(Math.round(all.costoKm * 10) / 10)} por km` : ''}</div>
    </div>
    ${dudosos ? `<p class="small muted" style="margin:10px 4px 0">${dudosos} ${dudosos === 1 ? 'tramo quedó' : 'tramos quedaron'} afuera por valores raros (probablemente un error de km o litros). Están marcados con “revisar” en el historial.</p>` : ''}

    <h2>Consumo por tanque</h2>
    <div class="card">${consChart(valid, all)}
      <div class="legend"><span><i style="background:var(--comun)"></i>Común</span><span><i style="background:var(--premium)"></i>Premium</span><span><i style="background:var(--muted)"></i>Mezcla</span></div></div>

    <h2>Comparativas</h2>
    ${groups.map(cmpHtml).join('')}
    <p class="tiny muted" style="margin:8px 4px 0">Con menos de 3 tanques la comparación todavía no es confiable (se ve más tenue). ${state.prefs.unidad === 'kml' ? 'Barra más larga = más km por litro.' : 'Barra más larga = más consumo.'}</p>

    <h2>Precio por litro</h2>
    <div class="card">${priceChart()}
      <div class="legend"><span><i style="background:var(--comun)"></i>Común</span><span><i style="background:var(--premium)"></i>Premium</span></div></div>

    <h2>Gasto por mes</h2>
    <div class="card">${barChart(months, gastoMes)}
      <p class="small muted" style="margin:8px 0 0">Últimos 12 meses: <b class="num">${fmtMoney(gasto12)}</b></p></div>`;
}

// ---------- Gráficos SVG simples ----------
const W = 320, H = 150, PAD = { l: 38, r: 8, t: 10, b: 22 };
function scaleY(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min; min -= span * 0.1; max += span * 0.1;
  return { min, max, y: v => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - min) / (max - min)) };
}
function gridLines(sc, fmt) {
  return [0, 0.5, 1].map(t => {
    const v = sc.min + (sc.max - sc.min) * t, y = sc.y(v);
    return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/><text x="${PAD.l - 5}" y="${y + 3}" text-anchor="end">${fmt(v)}</text>`;
  }).join('');
}
const tsOf = iso => Date.UTC(...iso.split('-').map((v, i) => i === 1 ? v - 1 : +v));
function xScale(isoList) {
  const ts = isoList.map(tsOf), a = Math.min(...ts), b = Math.max(...ts);
  return iso => b === a ? (PAD.l + W - PAD.r) / 2 : PAD.l + (W - PAD.l - PAD.r) * (tsOf(iso) - a) / (b - a);
}
function xLabels(first, last) {
  return `<text x="${PAD.l}" y="${H - 5}">${fmtDate(first)}</text>${first !== last ? `<text x="${W - PAD.r}" y="${H - 5}" text-anchor="end">${fmtDate(last)}</text>` : ''}`;
}
const colorOf = t => t === 'premium' ? 'var(--premium)' : t === 'comun' ? 'var(--comun)' : 'var(--muted)';

function consChart(segs, all) {
  const vals = segs.map(consVal);
  const sc = scaleY(Math.min(...vals), Math.max(...vals));
  const x = xScale(segs.map(s => s.hasta));
  const avgY = sc.y(consVal(all));
  const line = segs.length > 1 ? `<polyline fill="none" stroke="var(--line)" stroke-width="1.5" points="${segs.map(s => `${x(s.hasta)},${sc.y(consVal(s))}`).join(' ')}"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumo por tanque">
    ${gridLines(sc, v => fmtNum(v, 1))}
    <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${avgY}" y2="${avgY}" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="4 3"/>
    ${line}
    ${segs.map(s => `<circle cx="${x(s.hasta)}" cy="${sc.y(consVal(s))}" r="4" fill="${colorOf(s.tipo)}"${s.aditivo ? ' stroke="var(--text)" stroke-width="1.5"' : ''}/>`).join('')}
    ${xLabels(segs[0].hasta, segs[segs.length - 1].hasta)}
  </svg><p class="tiny muted" style="margin:4px 0 0">Línea punteada: promedio. Punto con borde: tanque con limpiainyectores.</p>`;
}

function priceChart() {
  const pts = sortFuel(state.fuel.filter(f => f.precio > 0));
  if (!pts.length) return '<p class="muted small">Sin precios cargados.</p>';
  const sc = scaleY(Math.min(...pts.map(p => p.precio)), Math.max(...pts.map(p => p.precio)));
  const x = xScale(pts.map(p => p.fecha));
  const series = ['comun', 'premium'].map(t => {
    const s = pts.filter(p => p.tipo === t);
    if (!s.length) return '';
    return `${s.length > 1 ? `<polyline fill="none" stroke="${colorOf(t)}" stroke-width="2" stroke-linejoin="round" points="${s.map(p => `${x(p.fecha)},${sc.y(p.precio)}`).join(' ')}"/>` : ''}
      ${s.map(p => `<circle cx="${x(p.fecha)}" cy="${sc.y(p.precio)}" r="2.6" fill="${colorOf(t)}"/>`).join('')}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Precio por litro">
    ${gridLines(sc, v => fmtInt(v))}${series}${xLabels(pts[0].fecha, pts[pts.length - 1].fecha)}</svg>`;
}

function barChart(months, vals) {
  const max = Math.max(...vals, 1);
  const sc = { min: 0, max, y: v => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max) };
  const bw = (W - PAD.l - PAD.r) / months.length;
  const short = v => v >= 1e6 ? fmtNum(v / 1e6, 1) + 'M' : v >= 1e3 ? fmtInt(v / 1e3) + 'k' : fmtInt(v);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gasto por mes">
    ${[0, 0.5, 1].map(t => { const v = max * t, y = sc.y(v); return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/><text x="${PAD.l - 5}" y="${y + 3}" text-anchor="end">${short(v)}</text>`; }).join('')}
    ${vals.map((v, i) => v > 0 ? `<rect x="${PAD.l + i * bw + bw * 0.18}" y="${sc.y(v)}" width="${bw * 0.64}" height="${H - PAD.b - sc.y(v)}" rx="2" fill="var(--accent)"/>` : '').join('')}
    ${months.map((m, i) => i % 2 === 1 ? `<text x="${PAD.l + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${MESES_C[+m.slice(5) - 1]}</text>` : '').join('')}
  </svg>`;
}

// =====================================================================
// Ajustes
// =====================================================================
async function renderSettings() {
  setActiveTab('ajustes');
  const v = state.vehicle;
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* sin soporte */ }
  const canShare = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));

  view().innerHTML = `
    <h2>Auto</h2>
    <div class="card">
      <div class="kv"><span>Nombre</span><b>${esc(v.nombre)}</b></div>
      ${v.modelo ? `<div class="kv"><span>Marca y modelo</span><span>${esc(v.modelo)}</span></div>` : ''}
      ${v.patente ? `<div class="kv"><span>Patente</span><span>${esc(v.patente)}</span></div>` : ''}
      ${v.tanque ? `<div class="kv"><span>Tanque</span><span>${fmtInt(v.tanque)} L</span></div>` : ''}
      <a class="btn btn-block" href="#/auto" style="margin-top:8px">Editar datos del auto</a>
    </div>

    <h2>Preferencias</h2>
    <div class="card"><div class="field"><span class="label">Mostrar el consumo en</span>${segmented('unidad', { l100: 'L/100 km', kml: 'km/L' }, state.prefs.unidad)}</div></div>

    <h2>Exportar a Excel</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Una planilla con todas las cargas, el consumo de cada tramo, un resumen con comparativas y los datos del auto.</p>
      <div class="btn-row">
        <button class="btn btn-primary" id="xlsxDl" type="button">Descargar</button>
        ${canShare ? '<button class="btn" id="xlsxShare" type="button">Compartir</button>' : ''}
      </div>
    </div>

    <h2>Copia de seguridad</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 4px">Los datos viven solo en este teléfono. Si borrás los datos del navegador o cambiás de celular, se pierden. La copia es un archivo que podés guardar en Drive o mandarte por WhatsApp, y sirve para restaurar todo.</p>
      <div class="kv"><span>Última copia</span><span>${state.lastBackup ? fmtDate(state.lastBackup.slice(0, 10), true) : 'nunca'}</span></div>
      <div class="kv"><span>Almacenamiento protegido</span><span>${persisted == null ? '—' : persisted ? 'Sí' : 'No'}</span></div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn btn-primary" id="bkDl" type="button">Descargar copia</button>
        ${canShare ? '<button class="btn" id="bkShare" type="button">Compartir copia</button>' : ''}
      </div>
      <label class="btn btn-block file-btn" style="margin-top:10px">Restaurar desde una copia…<input type="file" id="bkRestore" accept=".json,application/json"></label>
    </div>

    <h2>Zona peligrosa</h2>
    <div class="card"><button class="btn btn-danger btn-block" id="wipe" type="button">Borrar todos los datos</button></div>

    <p class="tiny muted" style="text-align:center;margin-top:20px">Bitácora del Auto · versión ${APP_VERSION}</p>`;

  $$('input[name="unidad"]').forEach(r => r.addEventListener('change', async () => {
    state.prefs.unidad = r.value; await setMeta('prefs', state.prefs); toast('Listo');
  }));
  $('#xlsxDl').onclick = () => exportExcel(false);
  $('#xlsxShare')?.addEventListener('click', () => exportExcel(true));
  $('#bkDl').onclick = () => downloadBackup(false);
  $('#bkShare')?.addEventListener('click', () => downloadBackup(true));
  $('#bkRestore').onchange = e => restoreBackup(e.target.files[0]);
  $('#wipe').onclick = wipeAll;
}

function renderVehicleForm(first) {
  setActiveTab(first ? '' : 'ajustes');
  const v = state.vehicle || {};
  view().innerHTML = `
    ${first ? `<div class="card hero" style="margin-bottom:16px"><p class="card-title">Bienvenido</p>
      <p style="margin:0">Empecemos con los datos del auto. Solo el nombre es obligatorio; el resto lo podés completar después.</p></div>`
      : '<h2 style="margin-top:4px">Datos del auto</h2>'}
    <form class="form" id="vForm" novalidate autocomplete="off">
      <div class="field"><label for="vNombre">Nombre</label><input class="input" id="vNombre" value="${esc(v.nombre)}" placeholder="Ej.: La Amarok" autocapitalize="sentences" required></div>
      <div class="field"><label for="vModelo">Marca y modelo</label><input class="input" id="vModelo" value="${esc(v.modelo)}" placeholder="Ej.: Volkswagen Amarok 2.0 TDI" autocapitalize="words"></div>
      <div class="row2">
        <div class="field"><label for="vAnio">Año</label><input class="input num" id="vAnio" inputmode="numeric" value="${v.anio ?? ''}"></div>
        <div class="field"><label for="vPatente">Patente</label><input class="input" id="vPatente" value="${esc(v.patente)}" autocapitalize="characters"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="vTanque">Capacidad del tanque</label><div class="with-unit"><input class="input num" id="vTanque" inputmode="decimal" value="${toInput(v.tanque, 1)}"><span class="unit">L</span></div></div>
        <div class="field"><label for="vOdo">Km actuales</label><div class="with-unit"><input class="input num" id="vOdo" inputmode="numeric" value="${v.odoInicial != null ? fmtInt(v.odoInicial) : ''}"><span class="unit">km</span></div></div>
      </div>
      <div class="field"><label for="vNotas">Notas</label><textarea class="input" id="vNotas" rows="2">${esc(v.notas)}</textarea></div>
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">${first ? 'Empezar' : 'Guardar'}</button>
        ${first ? `<label class="btn btn-block file-btn">Ya tengo una copia de seguridad…<input type="file" id="firstRestore" accept=".json,application/json"></label>`
          : '<button class="btn btn-block" type="button" id="vCancel">Cancelar</button>'}
      </div>
    </form>`;

  $('#vOdo').addEventListener('input', e => { const n = parseNum(e.target.value, 'int'); e.target.value = n == null ? '' : fmtInt(n); });
  $('#vCancel')?.addEventListener('click', () => goBack('#/ajustes'));
  $('#firstRestore')?.addEventListener('change', e => restoreBackup(e.target.files[0]));
  $('#vForm').addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = $('#vNombre').value.trim();
    if (!nombre) { $('#vNombre').focus(); return toast('Ponele un nombre al auto'); }
    const obj = {
      ...v,
      id: v.id || uid(),
      nombre,
      modelo: $('#vModelo').value.trim(),
      anio: parseNum($('#vAnio').value, 'int'),
      patente: $('#vPatente').value.trim().toUpperCase(),
      tanque: parseNum($('#vTanque').value, 'dec'),
      odoInicial: parseNum($('#vOdo').value, 'int'),
      notas: $('#vNotas').value.trim(),
      creado: v.creado || Date.now(),
    };
    await dbPut('vehicles', obj);
    await setMeta('activeVehicle', obj.id);
    await loadState();
    toast(first ? '¡Listo! Ya podés registrar cargas' : 'Datos guardados');
    if (first) navTo('#/'); else goBack('#/ajustes');
  });
}

// =====================================================================
// Archivos: Excel y copia de seguridad
// =====================================================================
async function deliverFile(data, filename, type, share) {
  const blob = new Blob([data], { type });
  if (share) {
    const file = new File([blob], filename, { type });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return true; }
    } catch (err) {
      if (err.name === 'AbortError') return false; // el usuario canceló
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
const slug = s => (s || 'auto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'auto';

async function exportExcel(share) {
  if (!state.fuel.length) return toast('Todavía no hay cargas para exportar');
  const bytes = buildWorkbook({ vehicle: state.vehicle, fuel: state.fuel, exportDate: todayISO() });
  const ok = await deliverFile(bytes, `bitacora-${slug(state.vehicle.nombre)}-${todayISO()}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', share);
  if (ok && !share) toast('Excel descargado');
}

async function downloadBackup(share) {
  const data = {
    app: 'bitacora-auto', formato: 1, version: APP_VERSION, exportado: new Date().toISOString(),
    vehicles: await dbAll('vehicles'), fuel: await dbAll('fuel'),
    meta: (await dbAll('meta')).filter(m => m.key !== 'lastBackup'),
  };
  const ok = await deliverFile(JSON.stringify(data, null, 1), `bitacora-copia-${todayISO()}.json`, 'application/json', share === true);
  if (!ok) return;
  state.lastBackup = new Date().toISOString();
  await setMeta('lastBackup', state.lastBackup);
  toast('Copia guardada');
  route();
}

async function restoreBackup(file) {
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('Ese archivo no es una copia válida'); }
  if (data?.app !== 'bitacora-auto' || !Array.isArray(data.fuel) || !Array.isArray(data.vehicles)) return toast('Ese archivo no es una copia de la Bitácora');
  const msg = `La copia es del ${fmtDate((data.exportado || '').slice(0, 10), true)} y tiene ${data.fuel.length} cargas.\n\n` +
    (state.fuel.length ? `Va a REEMPLAZAR los datos actuales (${state.fuel.length} cargas). ¿Seguir?` : '¿Restaurar?');
  if (!confirm(msg)) return;
  await replaceAll({ vehicles: data.vehicles, fuel: data.fuel, meta: [...(data.meta || []), { key: 'lastBackup', value: data.exportado || new Date().toISOString() }] });
  await loadState();
  toast('Datos restaurados');
  navTo('#/');
}

async function wipeAll() {
  if (!confirm('¿Borrar TODOS los datos de la app? Esto no se puede deshacer.')) return;
  if (!confirm('Última confirmación: ¿hiciste una copia de seguridad? Si seguís, se borra todo.')) return;
  await replaceAll({});
  await loadState();
  toast('Datos borrados');
  navTo('#/');
}

// Pide al navegador que no borre los datos cuando falta espacio.
async function requestPersistence() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* sin soporte */ }
}

// =====================================================================
// Arranque
// =====================================================================
(async function init() {
  try {
    await loadState();
  } catch (err) {
    view().innerHTML = `<div class="card empty"><h3>No se pudo abrir la base de datos</h3><p>${esc(err.message || err)}</p></div>`;
    return;
  }
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Hay una versión nueva de la app', { label: 'Actualizar', fn: () => location.reload() });
    });
  }
})();
