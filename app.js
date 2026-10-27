/* Bitácora del Auto — interfaz y almacenamiento (IndexedDB). */
'use strict';

const APP_VERSION = '1.1.0';
const CHANGELOG = [
  ['1.1.0', '2026-10-27', [
    'Colores grafito.',
    'Marca del combustible para elegir con un toque, y comparativa de consumo por marca.',
    'El combustible repite el de la última carga (Premium si no hay ninguna).',
    'Services con plan de mantenimiento por km y por fecha, incluidos matafuego y VTV. Los vencimientos se ven en Inicio.',
    'Novedades: pinchazos, reparaciones, cambios de cubiertas, con posición.',
    'Otros gastos (seguro, patente, peajes…) y costo total por km.',
    'Cubiertas, incluido el auxilio, con aviso por antigüedad.',
    'Hoja técnica del auto.',
    'Historial con cargas, services, novedades y gastos, con filtro.',
    'Botón + con menú para elegir qué registrar.',
    'Excel con hojas nuevas: Services, Plan, Novedades, Gastos, Cubiertas y hoja técnica.',
    'Archivos sin carpetas, para subir todo de una vez.',
  ]],
  ['1.0.0', '2026-10-26', ['Primera versión: cargas, consumo, estadísticas, Excel y copia de seguridad.']],
];

const {
  parseNum, fmtInt, fmtNum, fmtMoney, fmtPrice, toInput, todayISO, fmtDate, monthLabel, daysBetween,
  MESES_C, TIPOS, USOS, sortFuel, computeSegments, agg, groupStats, buildWorkbook,
  planStatus, sortStatuses, defaultPlan, POSICIONES, dotDate, tireAge, tireNivel, RUBROS, allCosts, totalCostPerKm, FICHA,
} = window.Core;

const DEFAULT_LISTAS = {
  marcas: ['YPF', 'Shell', 'Axion', 'Puma', 'Gulf', 'Otra'],
  catNovedad: ['Cubiertas', 'Mecánica', 'Eléctrico', 'Carrocería', 'Otros'],
  catGasto: ['Seguro', 'Patente', 'VTV', 'Peajes', 'Lavado', 'Estacionamiento', 'Otros'],
};

// =====================================================================
// Base de datos local
// =====================================================================
const DB_NAME = 'bitacora-auto';
const DB_VERSION = 2;
const STORES = ['vehicles', 'fuel', 'services', 'notes', 'expenses', 'tires', 'plan'];
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
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
async function dbPut(store, ...objs) { const db = await openDB(); const t = db.transaction(store, 'readwrite'); objs.forEach(o => t.objectStore(store).put(o)); return txDone(t); }
async function dbDelete(store, id) { const db = await openDB(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(id); return txDone(t); }
async function getMeta(key) { const db = await openDB(); const r = await reqP(db.transaction('meta').objectStore('meta').get(key)); return r ? r.value : undefined; }
const setMeta = (key, value) => dbPut('meta', { key, value });

async function replaceAll(data) {
  const db = await openDB();
  const all = [...STORES, 'meta'];
  const t = db.transaction(all, 'readwrite');
  all.forEach(s => t.objectStore(s).clear());
  all.forEach(s => (data[s] || []).forEach(o => t.objectStore(s).put(o)));
  return txDone(t);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// =====================================================================
// Estado
// =====================================================================
const state = {
  vehicle: null, fuel: [], services: [], notes: [], expenses: [], tires: [], plan: [], segs: [],
  prefs: { unidad: 'l100' }, listas: DEFAULT_LISTAS, lastBackup: null,
};

async function loadState() {
  const vehicles = (await dbAll('vehicles')).sort((a, b) => (a.creado || 0) - (b.creado || 0));
  const activeId = await getMeta('activeVehicle');
  state.vehicle = vehicles.find(v => v.id === activeId) || vehicles[0] || null;
  const vid = state.vehicle?.id;
  for (const s of ['fuel', 'services', 'notes', 'expenses', 'tires', 'plan']) {
    state[s] = vid ? (await dbAll(s)).filter(x => x.vehicleId === vid) : [];
  }
  state.plan.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  state.segs = computeSegments(state.fuel);
  state.prefs = Object.assign({ unidad: 'l100' }, await getMeta('prefs'));
  state.listas = Object.assign({}, DEFAULT_LISTAS, await getMeta('listas'));
  state.lastBackup = (await getMeta('lastBackup')) || null;
  if (await migrate()) return loadState();
  renderHeader();
}

// Ajusta datos de versiones anteriores. Devuelve true si cambió algo.
async function migrate() {
  const v = state.vehicle;
  if (!v) return false;
  let changed = false;
  // 1.0 → 1.1: separar la marca del nombre de la estación ("YPF BV" → YPF + "BV")
  const marcas = state.listas.marcas.filter(m => m !== 'Otra');
  const fix = state.fuel.filter(f => !('marca' in f)).map(f => {
    const m = marcas.find(m => new RegExp(`^${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(f.estacion || ''));
    return { ...f, marca: m || '', estacion: m ? (f.estacion || '').slice(m.length).trim() : (f.estacion || '') };
  });
  if (fix.length) { await dbPut('fuel', ...fix); changed = true; }
  // Plan de mantenimiento de ejemplo, una sola vez por auto
  if (!v.planSeeded) {
    if (!state.plan.length) await dbPut('plan', ...defaultPlan().map(p => ({ ...p, id: uid(), vehicleId: v.id, ejemplo: true })));
    await dbPut('vehicles', { ...v, planSeeded: true });
    changed = true;
  }
  return changed;
}

function currentKm() {
  const odos = [...state.fuel, ...state.services, ...state.notes].map(f => f.odo).filter(n => n != null);
  if (state.vehicle?.odoInicial != null) odos.push(state.vehicle.odoInicial);
  return odos.length ? Math.max(...odos) : null;
}
function lastFuel(filter = () => true) { const s = sortFuel(state.fuel.filter(filter)); return s[s.length - 1] || null; }
function lastPrice(tipo) { return lastFuel(f => f.tipo === tipo && f.precio > 0)?.precio ?? null; }
const statuses = () => sortStatuses(state.plan.map(p => planStatus(p, state.services, currentKm(), todayISO())));
const activeTires = () => state.tires.filter(t => t.activa);

// =====================================================================
// Utilidades de interfaz
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');
const plural = (n, s, p) => `${fmtInt(n)} ${n === 1 ? s : p}`;

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.fn(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 9000 : 2600);
}

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
  $('#gear').classList.toggle('active', name === 'ajustes');
  $('#tabbar').classList.toggle('hidden', !state.vehicle);
  $('#gear').hidden = !state.vehicle;
}

// ---------- Piezas de formulario ----------
function segmented(name, options, value) {
  return `<div class="segmented" role="radiogroup">${Object.entries(options).map(([k, label]) => `
    <input type="radio" name="${name}" id="${name}-${k}" value="${esc(k)}" ${k === value ? 'checked' : ''}>
    <label for="${name}-${k}">${esc(label)}</label>`).join('')}</div>`;
}
function chips(name, list, value, allowNone = true) {
  return `<div class="chips" role="radiogroup">${list.map((label, i) => `
    <input type="radio" name="${name}" id="${name}-${i}" value="${esc(label)}" ${label === value ? 'checked' : ''} ${allowNone ? 'data-toggle' : ''}>
    <label for="${name}-${i}">${esc(label)}</label>`).join('')}</div>`;
}
// Tocar una opción ya elegida la desmarca (para campos opcionales)
function wireToggleChips(root) {
  $$('input[data-toggle]', root).forEach(r => {
    let was = false;
    r.nextElementSibling.addEventListener('pointerdown', () => { was = r.checked; });
    r.addEventListener('click', () => { if (was) { r.checked = false; was = false; r.dispatchEvent(new Event('change', { bubbles: true })); } });
  });
}
function switchRow(id, title, desc, checked) {
  return `<label class="switch-row" for="${id}">
    <div><div class="t">${esc(title)}</div>${desc ? `<div class="d">${esc(desc)}</div>` : ''}</div>
    <span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span>
  </label>`;
}
const radioVal = (form, name) => form.querySelector(`input[name="${name}"]:checked`)?.value ?? null;

const fieldDate = (id, value, label = 'Fecha') =>
  `<div class="field"><label for="${id}">${label}</label><input class="input" type="date" id="${id}" value="${value || ''}" max="${todayISO()}"></div>`;
const fieldOdo = (id, value, label = 'Odómetro') =>
  `<div class="field"><label for="${id}">${label}</label><div class="with-unit"><input class="input num" id="${id}" inputmode="numeric" value="${value != null ? fmtInt(value) : ''}"><span class="unit">km</span></div></div>`;
const fieldMoney = (id, value, label) =>
  `<div class="field"><label for="${id}">${label}</label><div class="with-unit pre"><input class="input num" id="${id}" inputmode="decimal" value="${toInput(value, 0)}"><span class="unit">$</span></div></div>`;
const fieldText = (id, value, label, ph = '', extra = '') =>
  `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" value="${esc(value)}" placeholder="${esc(ph)}" autocapitalize="sentences" ${extra}></div>`;
const fieldArea = (id, value, label, ph = 'Opcional') =>
  `<div class="field"><label for="${id}">${label}</label><textarea class="input" id="${id}" rows="2" placeholder="${esc(ph)}">${esc(value)}</textarea></div>`;

// Odómetro: puntos de miles mientras escribís y una ayuda con el último km registrado
function odoRecords(excludeId) {
  return [...state.fuel, ...state.services, ...state.notes].filter(x => x.id !== excludeId && x.odo != null);
}
function wireOdo(odoId, dateId, hintId, excludeId) {
  const el = $('#' + odoId), dEl = $('#' + dateId), hint = $('#' + hintId);
  const update = () => {
    if (!hint) return;
    const odo = parseNum(el.value, 'int'), fecha = dEl.value;
    const prev = odoRecords(excludeId).filter(x => x.fecha <= fecha).sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.odo - b.odo).pop();
    hint.className = 'hint';
    if (!prev) { hint.textContent = ''; return; }
    if (odo == null) { hint.textContent = `Último registrado: ${fmtInt(prev.odo)} km (${fmtDate(prev.fecha)})`; return; }
    const d = odo - prev.odo;
    if (d < 0) { hint.className = 'hint warn'; hint.textContent = `Es menor que lo registrado el ${fmtDate(prev.fecha)} (${fmtInt(prev.odo)} km).`; }
    else hint.textContent = `+${fmtInt(d)} km desde el ${fmtDate(prev.fecha)}`;
  };
  el.addEventListener('input', () => { const n = parseNum(el.value, 'int'); el.value = n == null ? '' : fmtInt(n); update(); });
  dEl?.addEventListener('change', update);
  update();
}
// Avisa si el odómetro no cierra con otros registros. Devuelve false si el usuario cancela.
function confirmOdo(odo, fecha, excludeId) {
  if (odo == null) return true;
  const bad = odoRecords(excludeId).find(o => (o.fecha < fecha && o.odo > odo) || (o.fecha > fecha && o.odo < odo));
  return !bad || confirm(`Ojo: el ${fmtDate(bad.fecha, true)} anotaste ${fmtInt(bad.odo)} km, y eso no cierra con ${fmtInt(odo)} km el ${fmtDate(fecha, true)}.\n\n¿Guardar igual?`);
}
function checkDate(fecha) {
  if (!fecha) { toast('Falta la fecha'); return false; }
  if (fecha > todayISO()) { toast('La fecha no puede ser futura'); return false; }
  return true;
}

// =====================================================================
// Navegación
// =====================================================================
const navStack = [location.hash || '#/'];
let replacing = false;
function navTo(hash) {
  if ((location.hash || '#/') === hash) { navStack[navStack.length - 1] = hash; route(); return; }
  replacing = true;
  location.replace(hash);
}
window.addEventListener('hashchange', () => {
  closeSheet();
  const h = location.hash || '#/';
  if (replacing) { replacing = false; navStack[navStack.length - 1] = h; }
  else if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack.length > 2 && navStack[navStack.length - 3] === h) navStack.splice(-2);
  else navStack.push(h);
  route();
});
function goBack(fallback = '#/') {
  if (navStack.length > 1) history.back(); else navTo(fallback);
}

function route() {
  const [name = '', arg, arg2] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (!state.vehicle) return renderVehicleForm(true);
  switch (name) {
    case 'historial': return renderHistory();
    case 'stats': return renderStats();
    case 'auto': return arg === 'datos' ? renderVehicleForm(false) : renderAuto();
    case 'ajustes': return renderSettings();
    case 'carga': return renderFuelForm(arg === 'nueva' ? null : arg);
    case 'service': return renderServiceForm(arg === 'nuevo' ? null : arg);
    case 'novedad': return renderNoteForm(arg === 'nueva' ? null : arg);
    case 'gasto': return renderExpenseForm(arg === 'nuevo' ? null : arg);
    case 'plan': return renderPlanForm(arg === 'nuevo' ? null : arg);
    case 'cubierta': return renderTireForm(arg, arg2 === 'nueva');
    case 'ficha': return renderFichaForm();
    default: return renderHome();
  }
}

// Menú "+"
function openSheet() { $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
$('#addBtn').addEventListener('click', e => { e.preventDefault(); openSheet(); });
$$('#sheet [data-close]').forEach(el => el.addEventListener('click', closeSheet));

// =====================================================================
// Inicio
// =====================================================================
function alertsList() {
  const today = todayISO();
  const items = statuses().map(st => ({ nivel: st.nivel, title: st.item.nombre, sub: statusText(st), href: `#/plan/${encodeURIComponent(st.item.id)}` }));
  activeTires().forEach(t => {
    const age = tireAge(t.dot, today), nivel = tireNivel(age);
    if (nivel === 'vencido' || nivel === 'pronto') {
      items.push({ nivel, title: `Cubierta ${POSICIONES[t.posicion].toLowerCase()}`, sub: `${fmtNum(age, 1)} años de fabricación${nivel === 'vencido' ? ' · conviene cambiarla' : ''}`, href: `#/cubierta/${t.posicion}` });
    }
  });
  const order = { vencido: 0, pronto: 1, ok: 2, 'sin-datos': 3 };
  return items.sort((a, b) => order[a.nivel] - order[b.nivel]);
}

function statusText(st) {
  if (st.nivel === 'sin-datos') return st.last ? 'Sin intervalo' : 'Falta cargar cuándo se hizo por última vez';
  const parts = [];
  if (st.kmRest != null) parts.push(st.kmRest <= 0 ? `pasado por ${fmtInt(-st.kmRest)} km` : `faltan ${fmtInt(st.kmRest)} km`);
  if (st.diasRest != null) {
    const d = st.diasRest;
    if (d <= 0) parts.push(d === 0 ? 'vence hoy' : `vencido hace ${plural(-d, 'día', 'días')}`);
    else parts.push(d > 60 ? `faltan ${Math.round(d / 30.4)} meses` : `faltan ${plural(d, 'día', 'días')}`);
  }
  return parts.join(' · ');
}
const NIVEL_TXT = { vencido: 'Vencido', pronto: 'Próximo', ok: 'Al día', 'sin-datos': 'Sin datos' };

function renderHome() {
  setActiveTab('inicio');
  const { fuel, segs } = state;
  const hoy = todayISO(), ym = hoy.slice(0, 7);

  // Vencimientos
  const alerts = alertsList();
  const urgent = alerts.filter(a => a.nivel === 'vencido' || a.nivel === 'pronto');
  const sinDatos = alerts.filter(a => a.nivel === 'sin-datos').length;
  const nextOk = alerts.find(a => a.nivel === 'ok');
  const alertRows = (urgent.length ? urgent.slice(0, 5) : nextOk ? [nextOk] : []).map(a => `
    <a class="row" href="${a.href}"><span class="dot ${a.nivel}"></span>
      <div class="row-main"><div class="row-title">${esc(a.title)}</div><div class="row-sub">${esc(a.sub)}</div></div>
      <span class="pill ${a.nivel}">${NIVEL_TXT[a.nivel]}</span></a>`).join('');
  const vencHtml = `
    <div class="section-head"><h2>${urgent.length ? 'Vencimientos' : 'Mantenimiento'}</h2><a href="#/auto">Ver todo</a></div>
    ${alertRows ? `<div class="rows">${alertRows}</div>` : ''}
    ${!urgent.length && nextOk ? '<p class="small muted" style="margin:8px 4px 0">Todo al día. Arriba, lo próximo que viene.</p>' : ''}
    ${sinDatos ? `<p class="small muted" style="margin:8px 4px 0">${plural(sinDatos, 'ítem del plan no tiene', 'ítems del plan no tienen')} la última vez que se hizo. <a href="#/auto">Completalo en Auto</a> para que te avise.</p>` : ''}`;

  let backupCard = '';
  const sinBackup = state.lastBackup ? daysBetween(state.lastBackup.slice(0, 10), hoy) : null;
  const nReg = fuel.length + state.services.length + state.notes.length + state.expenses.length;
  if (nReg >= 3 && (sinBackup == null || sinBackup > 30)) {
    backupCard = `<div class="card notice" style="margin-bottom:12px">
      <p>${sinBackup == null ? 'Todavía no hiciste ninguna copia de seguridad.' : `Hace ${sinBackup} días que no hacés una copia de seguridad.`}</p>
      <button class="btn btn-sm btn-primary" id="quickBackup" type="button">Hacer copia</button>
    </div>`;
  }

  if (!fuel.length) {
    view().innerHTML = `${backupCard}
      <div class="card empty">
        <h3>Todavía no hay cargas</h3>
        <p>Registrá la primera para empezar. Si tenés datos viejos, cargalos con su fecha original.</p>
        <a class="btn btn-primary" href="#/carga/nueva">+ Nueva carga</a>
      </div>${vencHtml}`;
    $('#quickBackup')?.addEventListener('click', () => downloadBackup(false));
    return;
  }

  const valid = segs.filter(s => !s.dudoso);
  const recent = agg(valid.slice(-5)), all = agg(valid);
  const c = cons(recent), cAll = cons(all);
  const costs = allCosts(state).filter(x => x.fecha.startsWith(ym));
  const gastoMes = costs.reduce((a, x) => a + x.monto, 0);
  const combMes = costs.filter(x => x.rubro === 'combustible').reduce((a, x) => a + x.monto, 0);
  const ckm = totalCostPerKm({ ...state });
  const last = lastFuel();
  const pc = lastPrice('comun'), pp = lastPrice('premium');

  view().innerHTML = `
    ${backupCard}
    <div class="card hero">
      <p class="card-title">Consumo · últimos ${plural(recent.n || 0, 'tanque', 'tanques')}</p>
      ${recent.n ? `
        <div class="hero-row">
          <div><span class="big">${c.v}</span><span class="big-unit">${c.u}</span></div>
          <div class="hero-side"><span class="muted">Histórico</span><strong class="num">${cAll.v} <small>${cAll.u}</small></strong></div>
        </div>
        <div class="muted small" style="margin-top:8px">${c.alt} · ${fmtInt(recent.km)} km</div>`
      : `<p style="margin:6px 0 0">Necesito dos cargas con <b>tanque lleno</b> y km para calcular el consumo.</p>`}
    </div>

    <div class="grid2">
      <div class="card"><p class="card-title">Km actuales</p><div class="stat-val">${fmtInt(currentKm())}</div></div>
      <div class="card"><p class="card-title">Gasto del mes</p><div class="stat-val">${fmtMoney(gastoMes)}</div>
        <div class="stat-sub">${fmtMoney(combMes)} en combustible</div></div>
      <div class="card"><p class="card-title">Costo por km</p><div class="stat-val">${all.costoKm != null ? fmtPrice(Math.round(all.costoKm * 10) / 10) : '—'}</div>
        <div class="stat-sub">combustible${ckm != null ? ` · total ${fmtPrice(Math.round(ckm * 10) / 10)}` : ''}</div></div>
      <div class="card"><p class="card-title">Último precio</p>
        <div class="stat-sub" style="margin-top:0">Común <b class="num">${fmtPrice(pc)}</b></div>
        <div class="stat-sub">Premium <b class="num">${fmtPrice(pp)}</b></div></div>
    </div>

    ${vencHtml}

    <div class="section-head"><h2>Última carga</h2><a href="#/historial">Historial</a></div>
    <div class="list">${fuelItem(last)}</div>`;

  $('#quickBackup')?.addEventListener('click', () => downloadBackup(false));
}

// =====================================================================
// Historial
// =====================================================================
function dateCol(fecha) {
  const [, m, d] = fecha.split('-');
  return `<div class="item-ico"><b>${+d}</b><small>${MESES_C[+m - 1]}</small></div>`;
}
function fuelItem(f) {
  if (!f) return '';
  const seg = state.segs.find(s => s.endId === f.id);
  const tags = [
    `<span class="tag ${f.tipo}">${TIPOS[f.tipo]}</span>`,
    f.lleno ? '<span class="tag">Lleno</span>' : '<span class="tag">Parcial</span>',
    f.uso ? `<span class="tag">${USOS[f.uso]}</span>` : '',
    f.aditivo ? '<span class="tag">Limpiainyectores</span>' : '',
    seg ? `<span class="tag ${seg.dudoso ? 'dudoso' : 'cons'}">${cons(seg).v} ${cons(seg).u}${seg.dudoso ? ' · revisar' : ''}</span>` : '',
  ].join('');
  const lugar = [f.marca, f.estacion].filter(Boolean).join(' ');
  return `<a class="item" href="#/carga/${encodeURIComponent(f.id)}">${dateCol(f.fecha)}
    <div class="item-main">
      <div class="item-top"><span class="num">${fmtNum(f.litros, 2)} L</span><span class="num">${fmtMoney(f.total)}</span></div>
      <div class="item-sub">${f.odo != null ? fmtInt(f.odo) + ' km' : 'sin km'} · ${fmtPrice(f.precio)}/L${lugar ? ' · ' + esc(lugar) : ''}</div>
      <div class="tags">${tags}</div>
    </div></a>`;
}
function serviceItem(s) {
  const trabajos = [...(s.items || []).map(i => i.nombre), s.otros].filter(Boolean).join(', ');
  return `<a class="item" href="#/service/${encodeURIComponent(s.id)}">${dateCol(s.fecha)}
    <div class="item-main">
      <div class="kind service">Service</div>
      <div class="item-top"><span>${esc(trabajos || 'Service')}</span><span class="num">${s.costo ? fmtMoney(s.costo) : ''}</span></div>
      <div class="item-sub">${[s.odo != null ? fmtInt(s.odo) + ' km' : '', s.taller].filter(Boolean).map(esc).join(' · ')}</div>
    </div></a>`;
}
function noteItem(n) {
  const cat = [n.categoria, n.posicion ? POSICIONES[n.posicion] : ''].filter(Boolean).join(' · ');
  return `<a class="item" href="#/novedad/${encodeURIComponent(n.id)}">${dateCol(n.fecha)}
    <div class="item-main">
      <div class="kind novedad">${esc(cat || 'Novedad')}</div>
      <div class="item-top"><span>${esc(n.descripcion)}</span><span class="num">${n.costo ? fmtMoney(n.costo) : ''}</span></div>
      ${n.odo != null ? `<div class="item-sub">${fmtInt(n.odo)} km</div>` : ''}
    </div></a>`;
}
function expenseItem(e) {
  return `<a class="item" href="#/gasto/${encodeURIComponent(e.id)}">${dateCol(e.fecha)}
    <div class="item-main">
      <div class="kind gasto">Gasto</div>
      <div class="item-top"><span>${esc(e.categoria || 'Gasto')}</span><span class="num">${fmtMoney(e.monto)}</span></div>
      ${e.notas ? `<div class="item-sub">${esc(e.notas)}</div>` : ''}
    </div></a>`;
}

let histFilter = 'todo';
function renderHistory() {
  setActiveTab('historial');
  const FILTROS = { todo: 'Todo', carga: 'Cargas', service: 'Services', novedad: 'Novedades', gasto: 'Gastos' };
  const entries = [
    ...state.fuel.map(x => ({ t: 'carga', x, monto: x.total || 0, html: fuelItem })),
    ...state.services.map(x => ({ t: 'service', x, monto: x.costo || 0, html: serviceItem })),
    ...state.notes.map(x => ({ t: 'novedad', x, monto: x.costo || 0, html: noteItem })),
    ...state.expenses.map(x => ({ t: 'gasto', x, monto: x.monto || 0, html: expenseItem })),
  ].filter(e => histFilter === 'todo' || e.t === histFilter)
    .sort((a, b) => a.x.fecha > b.x.fecha ? -1 : a.x.fecha < b.x.fecha ? 1 : (b.x.odo ?? 0) - (a.x.odo ?? 0) || (b.x.creado || 0) - (a.x.creado || 0));

  const filterHtml = `<div class="chips filter">${Object.entries(FILTROS).map(([k, l]) =>
    `<button type="button" data-f="${k}" class="${k === histFilter ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  if (!entries.length) {
    view().innerHTML = `${filterHtml}<div class="card empty"><h3>Nada por acá</h3><p>Usá el botón + para registrar algo.</p></div>`;
  } else {
    const groups = new Map();
    entries.forEach(e => { const k = e.x.fecha.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
    view().innerHTML = filterHtml + [...groups].map(([ym, items]) => `
      <div class="month"><h3>${monthLabel(ym)}</h3><span>${fmtMoney(items.reduce((a, e) => a + e.monto, 0))}</span></div>
      <div class="list">${items.map(e => e.html(e.x)).join('')}</div>`).join('');
  }
  $$('.filter button').forEach(b => b.onclick = () => { histFilter = b.dataset.f; renderHistory(); });
}

// =====================================================================
// Carga de combustible
// =====================================================================
function renderFuelForm(id) {
  setActiveTab(id ? 'historial' : 'nuevo');
  const editing = id ? state.fuel.find(f => f.id === id) : null;
  if (id && !editing) { navTo('#/historial'); return; }

  const last = lastFuel();
  const f = editing || {
    fecha: todayISO(), odo: null, litros: null,
    tipo: last?.tipo || 'premium', marca: last?.marca || '', precio: null, total: null,
    lleno: true, aditivo: false, uso: last?.uso || 'mixto', estacion: last?.estacion || '', notas: '',
  };
  if (!editing) f.precio = lastPrice(f.tipo);
  const estaciones = [...new Set(state.fuel.map(x => x.estacion).filter(Boolean))];
  const marcas = [...state.listas.marcas];
  if (f.marca && !marcas.includes(f.marca)) marcas.push(f.marca);

  view().innerHTML = `
    <h2 style="margin-top:4px">${editing ? 'Editar carga' : 'Nueva carga'}</h2>
    <form class="form" id="fuelForm" novalidate autocomplete="off">
      <div class="row2">${fieldDate('fecha', f.fecha)}${fieldOdo('odo', f.odo)}</div>
      <div class="hint" id="odoHint"></div>

      <div class="field"><span class="label">Combustible</span>${segmented('tipo', { comun: 'Común', premium: 'Premium' }, f.tipo)}</div>
      <div class="field"><span class="label">Marca</span>${chips('marca', marcas, f.marca)}</div>

      <div class="row3">
        <div class="field"><label for="litros">Litros</label>
          <div class="with-unit"><input class="input num" id="litros" inputmode="decimal" value="${toInput(f.litros)}"><span class="unit">L</span></div></div>
        <div class="field"><label for="precio">Precio/L</label>
          <div class="with-unit pre"><input class="input num" id="precio" inputmode="decimal" value="${toInput(f.precio)}"><span class="unit">$</span></div></div>
        ${fieldMoney('total', f.total, 'Total')}
      </div>
      <div class="hint">Completá dos de los tres y el otro se calcula solo.</div>

      ${switchRow('lleno', 'Tanque lleno', 'Necesario para calcular el consumo', f.lleno)}
      ${switchRow('aditivo', 'Limpiainyectores', 'Le pusiste aditivo en esta carga', f.aditivo)}

      <div class="field"><span class="label">¿Cómo manejaste desde la carga anterior?</span>${segmented('uso', USOS, f.uso)}</div>

      <div class="field"><label for="estacion">Estación</label>
        <input class="input" id="estacion" list="estacionesList" value="${esc(f.estacion)}" placeholder="Opcional: BV, Ruta 8 km 50…" autocapitalize="sentences">
        <datalist id="estacionesList">${estaciones.map(e => `<option value="${esc(e)}">`).join('')}</datalist></div>
      ${fieldArea('notas', f.notas, 'Notas')}

      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        ${editing ? '<button class="btn btn-danger btn-block" type="button" id="delBtn">Eliminar carga</button>' : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;

  const form = $('#fuelForm');
  wireToggleChips(form);
  const el = { litros: $('#litros'), precio: $('#precio'), total: $('#total') };

  // Cálculo automático: se recalcula el campo que se tocó hace más tiempo.
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
  $$('input[name="tipo"]', form).forEach(r => r.addEventListener('change', () => {
    if (!precioPrefilled) return;
    const p = lastPrice(r.value);
    el.precio.value = toInput(p);
    if (p == null) { const i = order.indexOf('precio'); if (i >= 0) order.splice(i, 1); }
    recalc();
  }));

  wireOdo('odo', 'fecha', 'odoHint', id);
  $('#cancelBtn').onclick = () => goBack(editing ? '#/historial' : '#/');
  $('#delBtn')?.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar la carga del ${fmtDate(editing.fecha, true)}?`)) return;
    await dbDelete('fuel', editing.id);
    await loadState(); toast('Carga eliminada'); goBack('#/historial');
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = read();
    const obj = {
      id: editing?.id || uid(), vehicleId: state.vehicle.id,
      fecha: $('#fecha').value, odo: parseNum($('#odo').value, 'int'),
      litros: v.litros, tipo: radioVal(form, 'tipo') || 'premium', marca: radioVal(form, 'marca') || '',
      precio: v.precio, total: v.total,
      lleno: $('#lleno').checked, aditivo: $('#aditivo').checked, uso: radioVal(form, 'uso'),
      estacion: $('#estacion').value.trim(), notas: $('#notas').value.trim(),
      creado: editing?.creado || Date.now(), modificado: Date.now(),
    };
    if (obj.total == null && obj.litros && obj.precio) obj.total = Math.round(obj.litros * obj.precio);
    if (obj.precio == null && obj.litros && obj.total) obj.precio = Math.round(obj.total / obj.litros * 100) / 100;

    if (!checkDate(obj.fecha)) return;
    if (!(obj.litros > 0)) { el.litros.focus(); return toast('Faltan los litros'); }
    if (obj.litros > 200 && !confirm(`¿${fmtNum(obj.litros, 2)} litros en una sola carga? ¿Guardar igual?`)) return;
    if (obj.odo != null) {
      if (!confirmOdo(obj.odo, obj.fecha, obj.id)) return;
      const prev = sortFuel(state.fuel.filter(o => o.id !== obj.id && o.odo != null && o.fecha <= obj.fecha)).pop();
      const maxJump = Math.max(1500, (state.vehicle.tanque || 0) * 35);
      if (prev && obj.odo - prev.odo > maxJump && !confirm(`Son ${fmtInt(obj.odo - prev.odo)} km desde la carga anterior. ¿Está bien el odómetro?`)) return;
    } else if (obj.lleno && !confirm('Sin el odómetro esta carga no sirve para calcular el consumo. ¿Guardar igual?')) return;

    await saveAndBack('fuel', obj, editing ? 'Cambios guardados' : 'Carga guardada', editing ? '#/historial' : '#/');
  });
}

async function saveAndBack(store, obj, msg, fallback) {
  await dbPut(store, obj);
  requestPersistence();
  await loadState();
  toast(msg);
  goBack(fallback);
}
async function deleteAndBack(store, id, msg, fallback) {
  await dbDelete(store, id);
  await loadState();
  toast(msg);
  goBack(fallback);
}

// =====================================================================
// Service
// =====================================================================
function renderServiceForm(id) {
  setActiveTab(id ? 'historial' : 'nuevo');
  const editing = id ? state.services.find(s => s.id === id) : null;
  if (id && !editing) { navTo('#/historial'); return; }
  const s = editing || { fecha: todayISO(), odo: null, items: [], otros: '', costo: null, taller: state.services.slice(-1)[0]?.taller || '', notas: '' };
  const chosen = new Set((s.items || []).map(i => i.id));
  // Ítems guardados que ya no están en el plan, para no perderlos al editar
  const huerfanos = (s.items || []).filter(i => !state.plan.some(p => p.id === i.id));
  const talleres = [...new Set(state.services.map(x => x.taller).filter(Boolean))];

  view().innerHTML = `
    <h2 style="margin-top:4px">${editing ? 'Editar service' : 'Nuevo service'}</h2>
    <form class="form" id="sForm" novalidate autocomplete="off">
      <div class="row2">${fieldDate('fecha', s.fecha)}${fieldOdo('odo', s.odo)}</div>
      <div class="hint" id="odoHint"></div>
      <div class="field"><span class="label">¿Qué se hizo?</span>
        ${state.plan.length || huerfanos.length ? `<div class="checks">
          ${state.plan.map(p => `<label class="check-row"><input type="checkbox" name="item" value="${esc(p.id)}" ${chosen.has(p.id) ? 'checked' : ''}>
            <span>${esc(p.nombre)}<small>${planInterval(p)}</small></span></label>`).join('')}
          ${huerfanos.map(i => `<label class="check-row"><input type="checkbox" name="item" value="${esc(i.id)}" data-nombre="${esc(i.nombre)}" checked>
            <span>${esc(i.nombre)}<small>ya no está en el plan</small></span></label>`).join('')}
        </div>` : '<p class="small muted" style="margin:0">El plan está vacío. Podés agregar ítems desde la pestaña Auto.</p>'}
      </div>
      ${fieldText('otros', s.otros, 'Otros trabajos', 'Ej.: cambio de pastillas de freno')}
      <div class="row2">${fieldMoney('costo', s.costo, 'Costo total')}
        <div class="field"><label for="taller">Taller</label><input class="input" id="taller" list="tallerList" value="${esc(s.taller)}" autocapitalize="sentences">
        <datalist id="tallerList">${talleres.map(t => `<option value="${esc(t)}">`).join('')}</datalist></div></div>
      ${fieldArea('notas', s.notas, 'Notas')}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        ${editing ? '<button class="btn btn-danger btn-block" type="button" id="delBtn">Eliminar service</button>' : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;

  wireOdo('odo', 'fecha', 'odoHint', id);
  $('#cancelBtn').onclick = () => goBack(editing ? '#/historial' : '#/');
  $('#delBtn')?.addEventListener('click', () => {
    if (confirm(`¿Eliminar el service del ${fmtDate(editing.fecha, true)}?`)) deleteAndBack('services', editing.id, 'Service eliminado', '#/historial');
  });
  $('#sForm').addEventListener('submit', async e => {
    e.preventDefault();
    const items = $$('input[name="item"]:checked').map(c => {
      const p = state.plan.find(p => p.id === c.value);
      return { id: c.value, nombre: p ? p.nombre : c.dataset.nombre };
    });
    const obj = {
      id: editing?.id || uid(), vehicleId: state.vehicle.id,
      fecha: $('#fecha').value, odo: parseNum($('#odo').value, 'int'),
      items, otros: $('#otros').value.trim(), costo: parseNum($('#costo').value, 'money'),
      taller: $('#taller').value.trim(), notas: $('#notas').value.trim(),
      creado: editing?.creado || Date.now(), modificado: Date.now(),
    };
    if (!checkDate(obj.fecha)) return;
    if (!items.length && !obj.otros) return toast('Marcá qué se hizo o escribilo en "Otros trabajos"');
    if (obj.odo == null && items.some(i => state.plan.find(p => p.id === i.id)?.km) &&
      !confirm('Sin el odómetro no puedo calcular cuándo toca el próximo por km. ¿Guardar igual?')) return;
    if (!confirmOdo(obj.odo, obj.fecha, obj.id)) return;
    await saveAndBack('services', obj, editing ? 'Cambios guardados' : 'Service guardado', editing ? '#/historial' : '#/');
  });
}
function planInterval(p) {
  return [p.km ? `cada ${fmtInt(p.km)} km` : '', p.meses ? (p.meses === 12 ? 'cada año' : p.meses === 1 ? 'cada mes' : `cada ${p.meses % 12 === 0 ? plural(p.meses / 12, 'año', 'años') : plural(p.meses, 'mes', 'meses')}`) : '']
    .filter(Boolean).join(' o ') || 'sin intervalo';
}

// =====================================================================
// Novedad
// =====================================================================
const esCubiertas = cat => /cubierta|neum/i.test(cat || '');
function renderNoteForm(id) {
  setActiveTab(id ? 'historial' : 'nuevo');
  const editing = id ? state.notes.find(n => n.id === id) : null;
  if (id && !editing) { navTo('#/historial'); return; }
  const n = editing || { fecha: todayISO(), odo: null, categoria: state.listas.catNovedad[0] || '', posicion: '', descripcion: '', costo: null };
  const cats = [...state.listas.catNovedad];
  if (n.categoria && !cats.includes(n.categoria)) cats.push(n.categoria);

  view().innerHTML = `
    <h2 style="margin-top:4px">${editing ? 'Editar novedad' : 'Nueva novedad'}</h2>
    <form class="form" id="nForm" novalidate autocomplete="off">
      <div class="row2">${fieldDate('fecha', n.fecha)}${fieldOdo('odo', n.odo)}</div>
      <div class="hint" id="odoHint"></div>
      <div class="field"><span class="label">Categoría</span>${chips('categoria', cats, n.categoria, false)}</div>
      <div class="field" id="posField"><span class="label">Posición</span>
        ${chips('posicion', Object.keys(POSICIONES).map(k => k === 'AUX' ? 'Auxilio' : k), n.posicion === 'AUX' ? 'Auxilio' : n.posicion)}
        <div class="hint">DI y DD: delanteras izquierda y derecha. TI y TD: traseras.</div></div>
      ${fieldArea('descripcion', n.descripcion, 'Qué pasó', 'Ej.: pinchazo, parche en gomería de ruta 8')}
      ${fieldMoney('costo', n.costo, 'Costo (opcional)')}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        ${editing ? '<button class="btn btn-danger btn-block" type="button" id="delBtn">Eliminar novedad</button>' : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;

  const form = $('#nForm');
  wireToggleChips(form);
  const syncPos = () => { $('#posField').hidden = !esCubiertas(radioVal(form, 'categoria')); };
  $$('input[name="categoria"]', form).forEach(r => r.addEventListener('change', syncPos));
  syncPos();
  wireOdo('odo', 'fecha', 'odoHint', id);
  $('#cancelBtn').onclick = () => goBack(editing ? '#/historial' : '#/');
  $('#delBtn')?.addEventListener('click', () => {
    if (confirm('¿Eliminar esta novedad?')) deleteAndBack('notes', editing.id, 'Novedad eliminada', '#/historial');
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const categoria = radioVal(form, 'categoria') || '';
    const pos = radioVal(form, 'posicion');
    const obj = {
      id: editing?.id || uid(), vehicleId: state.vehicle.id,
      fecha: $('#fecha').value, odo: parseNum($('#odo').value, 'int'), categoria,
      posicion: esCubiertas(categoria) && pos ? (pos === 'Auxilio' ? 'AUX' : pos) : '',
      descripcion: $('#descripcion').value.trim(), costo: parseNum($('#costo').value, 'money'),
      creado: editing?.creado || Date.now(), modificado: Date.now(),
    };
    if (!checkDate(obj.fecha)) return;
    if (!obj.descripcion) { $('#descripcion').focus(); return toast('Contá brevemente qué pasó'); }
    if (!confirmOdo(obj.odo, obj.fecha, obj.id)) return;
    await saveAndBack('notes', obj, editing ? 'Cambios guardados' : 'Novedad guardada', editing ? '#/historial' : '#/');
  });
}

// =====================================================================
// Gasto
// =====================================================================
function renderExpenseForm(id) {
  setActiveTab(id ? 'historial' : 'nuevo');
  const editing = id ? state.expenses.find(x => x.id === id) : null;
  if (id && !editing) { navTo('#/historial'); return; }
  const g = editing || { fecha: todayISO(), categoria: '', monto: null, notas: '' };
  const cats = [...state.listas.catGasto];
  if (g.categoria && !cats.includes(g.categoria)) cats.push(g.categoria);

  view().innerHTML = `
    <h2 style="margin-top:4px">${editing ? 'Editar gasto' : 'Nuevo gasto'}</h2>
    <form class="form" id="gForm" novalidate autocomplete="off">
      ${fieldDate('fecha', g.fecha)}
      <div class="field"><span class="label">Categoría</span>${chips('categoria', cats, g.categoria, false)}</div>
      ${fieldMoney('monto', g.monto, 'Monto')}
      ${fieldArea('notas', g.notas, 'Notas')}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        ${editing ? '<button class="btn btn-danger btn-block" type="button" id="delBtn">Eliminar gasto</button>' : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;
  const form = $('#gForm');
  $('#cancelBtn').onclick = () => goBack(editing ? '#/historial' : '#/');
  $('#delBtn')?.addEventListener('click', () => {
    if (confirm('¿Eliminar este gasto?')) deleteAndBack('expenses', editing.id, 'Gasto eliminado', '#/historial');
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const obj = {
      id: editing?.id || uid(), vehicleId: state.vehicle.id,
      fecha: $('#fecha').value, categoria: radioVal(form, 'categoria') || '',
      monto: parseNum($('#monto').value, 'money'), notas: $('#notas').value.trim(),
      creado: editing?.creado || Date.now(), modificado: Date.now(),
    };
    if (!checkDate(obj.fecha)) return;
    if (!obj.categoria) return toast('Elegí una categoría');
    if (!(obj.monto > 0)) { $('#monto').focus(); return toast('Falta el monto'); }
    await saveAndBack('expenses', obj, editing ? 'Cambios guardados' : 'Gasto guardado', editing ? '#/historial' : '#/');
  });
}

// =====================================================================
// Estadísticas
// =====================================================================
function renderStats() {
  setActiveTab('stats');
  const { segs, fuel } = state;
  const valid = segs.filter(s => !s.dudoso);

  // Gasto por mes (12 meses) apilado por rubro
  const months = [];
  const d = new Date();
  for (let i = 11; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  const costs = allCosts(state).filter(c => c.fecha.slice(0, 7) >= months[0]);
  const rubros = Object.keys(RUBROS);
  const porMes = months.map(m => rubros.map(r => costs.filter(c => c.rubro === r && c.fecha.startsWith(m)).reduce((a, c) => a + c.monto, 0)));
  const total12 = costs.reduce((a, c) => a + c.monto, 0);
  const porRubro = rubros.map(r => ({ r, v: costs.filter(c => c.rubro === r).reduce((a, c) => a + c.monto, 0) }));
  const maxR = Math.max(...porRubro.map(x => x.v), 1);
  const ckm = totalCostPerKm({ ...state });

  const gastoHtml = `
    <h2>Gasto por mes</h2>
    <div class="card">${stackedBars(months, porMes)}
      <div class="legend">${rubros.map(r => `<span><i style="background:var(--s-${r === 'combustible' ? 'fuel' : r})"></i>${RUBROS[r]}</span>`).join('')}</div></div>
    <h2>En qué se va la plata</h2>
    <div class="card"><p class="card-title">Últimos 12 meses · ${fmtMoney(total12)}</p><div class="cmp">
      ${porRubro.map(x => `<div class="cmp-row"><div class="cmp-label">${RUBROS[x.r]}</div>
        <div class="bar"><i style="width:${x.v ? Math.max(3, x.v / maxR * 100) : 0}%;background:var(--s-${x.r === 'combustible' ? 'fuel' : x.r})"></i></div>
        <div class="cmp-val num">${fmtMoney(x.v)}</div></div>`).join('')}
    </div>${ckm != null ? `<p class="small muted" style="margin:12px 0 0">Costo total por km, desde que registrás: <b class="num">${fmtPrice(Math.round(ckm * 10) / 10)}</b></p>` : ''}</div>`;

  if (!valid.length) {
    view().innerHTML = `<div class="card empty"><h3>Falta para el consumo</h3>
      <p>El consumo aparece cuando hay al menos dos cargas con tanque lleno y odómetro.</p></div>${gastoHtml}`;
    return;
  }
  const all = agg(valid);
  const unit = cons(all).u;
  const dudosos = segs.length - valid.length;
  const marcas = [...new Set(valid.map(s => s.marca).filter(m => m && m !== 'Varias'))].sort();

  const groups = [
    { title: 'Común vs Premium', rows: groupStats(valid, 'tipo', ['comun', 'premium']).map(g => ({ ...g, label: TIPOS[g.key] })) },
    { title: 'Según el uso', rows: groupStats(valid, 'uso', ['ruta', 'mixto', 'urbano']).map(g => ({ ...g, label: USOS[g.key] })) },
    { title: 'Limpiainyectores', rows: [{ label: 'Con', ...agg(valid.filter(s => s.aditivo)) }, { label: 'Sin', ...agg(valid.filter(s => !s.aditivo)) }] },
  ];
  if (marcas.length) groups.push({ title: 'Por marca', rows: marcas.map(m => ({ label: m, ...agg(valid.filter(s => s.marca === m)) })) });
  const maxV = Math.max(...groups.flatMap(g => g.rows.map(r => r.n ? consVal(r) : 0)));
  const cmpHtml = g => `
    <div class="card"><p class="card-title">${g.title}</p><div class="cmp">
      ${g.rows.map(r => `<div class="cmp-row ${r.n < 3 ? 'few' : ''}">
        <div class="cmp-label">${esc(r.label)}<small>${plural(r.n, 'tanque', 'tanques')} · ${fmtInt(r.km)} km</small></div>
        <div class="bar"><i style="width:${r.n ? Math.max(4, consVal(r) / maxV * 100) : 0}%"></i></div>
        <div class="cmp-val num">${r.n ? cons(r).v : '—'}</div>
      </div>`).join('')}
    </div></div>`;

  view().innerHTML = `
    <div class="card hero">
      <p class="card-title">Promedio histórico</p>
      <div class="hero-row">
        <div><span class="big">${cons(all).v}</span><span class="big-unit">${unit}</span></div>
        <div class="hero-side"><span class="muted">${plural(all.n, 'tanque', 'tanques')}</span><strong class="num">${fmtInt(all.km)} km</strong></div>
      </div>
      <div class="muted small" style="margin-top:8px">${cons(all).alt}${all.costoKm != null ? ` · ${fmtPrice(Math.round(all.costoKm * 10) / 10)} de combustible por km` : ''}</div>
    </div>
    ${dudosos ? `<p class="small muted" style="margin:10px 4px 0">${plural(dudosos, 'tramo quedó', 'tramos quedaron')} afuera por valores raros (probablemente un error de km o litros). Están marcados con “revisar” en el historial.</p>` : ''}

    <h2>Consumo por tanque</h2>
    <div class="card">${consChart(valid, all)}
      <div class="legend"><span><i style="background:var(--comun)"></i>Común</span><span><i style="background:var(--premium)"></i>Premium</span><span><i style="background:var(--muted)"></i>Mezcla</span></div></div>

    <h2>Comparativas</h2>
    ${groups.map(cmpHtml).join('')}
    <p class="tiny muted" style="margin:8px 4px 0">Con menos de 3 tanques la comparación todavía no es confiable (se ve más tenue). ${state.prefs.unidad === 'kml' ? 'Barra más larga = más km por litro.' : 'Barra más larga = más consumo.'}</p>

    <h2>Precio por litro</h2>
    <div class="card">${priceChart()}
      <div class="legend"><span><i style="background:var(--comun)"></i>Común</span><span><i style="background:var(--premium)"></i>Premium</span></div></div>
    ${gastoHtml}`;
}

// ---------- Gráficos SVG simples ----------
const W = 320, H = 150, PAD = { l: 40, r: 10, t: 10, b: 22 };
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
// Con un solo día de datos, los puntos se reparten parejos para que no queden encimados
function xScale(isoList) {
  const ts = isoList.map(tsOf), a = Math.min(...ts), b = Math.max(...ts);
  const span = W - PAD.l - PAD.r - 16;
  if (b === a) return (iso, i, n) => n > 1 ? PAD.l + 8 + span * i / (n - 1) : PAD.l + 8 + span / 2;
  return iso => PAD.l + 8 + span * (tsOf(iso) - a) / (b - a);
}
function xLabels(first, last) {
  return `<text x="${PAD.l}" y="${H - 5}">${fmtDate(first)}</text>${first !== last ? `<text x="${W - PAD.r}" y="${H - 5}" text-anchor="end">${fmtDate(last)}</text>` : ''}`;
}
const colorOf = t => t === 'premium' ? 'var(--premium)' : t === 'comun' ? 'var(--comun)' : 'var(--muted)';

function consChart(segs, all) {
  const vals = segs.map(consVal);
  const sc = scaleY(Math.min(...vals), Math.max(...vals));
  const x = xScale(segs.map(s => s.hasta));
  const pts = segs.map((s, i) => [x(s.hasta, i, segs.length), sc.y(consVal(s)), s]);
  const avgY = sc.y(consVal(all));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Consumo por tanque">
    ${gridLines(sc, v => fmtNum(v, 1))}
    <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${avgY}" y2="${avgY}" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="4 3"/>
    ${pts.length > 1 ? `<polyline fill="none" stroke="var(--line)" stroke-width="1.5" points="${pts.map(p => `${p[0]},${p[1]}`).join(' ')}"/>` : ''}
    ${pts.map(([cx, cy, s]) => `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${colorOf(s.tipo)}"${s.aditivo ? ' stroke="var(--text)" stroke-width="1.6"' : ''}/>`).join('')}
    ${xLabels(segs[0].hasta, segs[segs.length - 1].hasta)}
  </svg><p class="tiny muted" style="margin:4px 0 0">Línea punteada: promedio. Punto con borde: tanque con limpiainyectores.</p>`;
}

function priceChart() {
  const pts = sortFuel(state.fuel.filter(f => f.precio > 0));
  if (!pts.length) return '<p class="muted small">Sin precios cargados.</p>';
  const sc = scaleY(Math.min(...pts.map(p => p.precio)), Math.max(...pts.map(p => p.precio)));
  const x = xScale(pts.map(p => p.fecha));
  const pos = new Map(pts.map((p, i) => [p.id, x(p.fecha, i, pts.length)]));
  const series = ['comun', 'premium'].map(t => {
    const s = pts.filter(p => p.tipo === t);
    if (!s.length) return '';
    return `${s.length > 1 ? `<polyline fill="none" stroke="${colorOf(t)}" stroke-width="2" stroke-linejoin="round" points="${s.map(p => `${pos.get(p.id)},${sc.y(p.precio)}`).join(' ')}"/>` : ''}
      ${s.map(p => `<circle cx="${pos.get(p.id)}" cy="${sc.y(p.precio)}" r="3" fill="${colorOf(t)}"/>`).join('')}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Precio por litro">
    ${gridLines(sc, v => fmtInt(v))}${series}${xLabels(pts[0].fecha, pts[pts.length - 1].fecha)}</svg>`;
}

function stackedBars(months, stacks) {
  const totals = stacks.map(s => s.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals, 1);
  const y = v => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const bw = (W - PAD.l - PAD.r) / months.length;
  const short = v => v >= 1e6 ? fmtNum(v / 1e6, 1) + 'M' : v >= 1e3 ? fmtInt(v / 1e3) + 'k' : fmtInt(v);
  const colors = ['var(--s-fuel)', 'var(--s-service)', 'var(--s-novedad)', 'var(--s-gasto)'];
  const bars = stacks.map((s, i) => {
    let acc = 0;
    return s.map((v, j) => {
      if (!v) return '';
      const y1 = y(acc + v), y0 = y(acc); acc += v;
      return `<rect x="${PAD.l + i * bw + bw * 0.18}" y="${y1}" width="${bw * 0.64}" height="${Math.max(0.5, y0 - y1)}" fill="${colors[j]}"/>`;
    }).join('');
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gasto por mes">
    ${[0, 0.5, 1].map(t => { const v = max * t, yy = y(v); return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${yy}" y2="${yy}"/><text x="${PAD.l - 5}" y="${yy + 3}" text-anchor="end">${short(v)}</text>`; }).join('')}
    ${bars}
    ${months.map((m, i) => i % 2 === 1 ? `<text x="${PAD.l + i * bw + bw / 2}" y="${H - 5}" text-anchor="middle">${MESES_C[+m.slice(5) - 1]}</text>` : '').join('')}
  </svg>`;
}

// =====================================================================
// Auto: plan, cubiertas, hoja técnica
// =====================================================================
function renderAuto() {
  setActiveTab('auto');
  const v = state.vehicle;
  const today = todayISO();
  const kmNow = currentKm();
  const sts = statuses();
  const ejemplo = state.plan.some(p => p.ejemplo);

  const planRows = sts.map(st => `
    <a class="row" href="#/plan/${encodeURIComponent(st.item.id)}"><span class="dot ${st.nivel}"></span>
      <div class="row-main"><div class="row-title">${esc(st.item.nombre)}</div>
        <div class="row-sub">${planInterval(st.item)}${st.last ? ` · última: ${st.last.fecha ? fmtDate(st.last.fecha) : ''}${st.last.odo != null ? ` ${fmtInt(st.last.odo)} km` : ''}` : ''}</div>
        <div class="row-sub">${esc(statusText(st))}</div></div>
      <span class="pill ${st.nivel}">${NIVEL_TXT[st.nivel]}</span></a>`).join('');

  const tireRows = Object.entries(POSICIONES).map(([pos, label]) => {
    const t = activeTires().find(t => t.posicion === pos);
    if (!t) return `<a class="row" href="#/cubierta/${pos}"><span class="dot sin-datos"></span>
      <div class="row-main"><div class="row-title">${label}</div><div class="row-sub">Sin cargar</div></div></a>`;
    const age = tireAge(t.dot, today), nivel = tireNivel(age);
    const km = pos !== 'AUX' && t.odoMontaje != null && kmNow != null ? kmNow - t.odoMontaje : null;
    return `<a class="row" href="#/cubierta/${pos}"><span class="dot ${nivel}"></span>
      <div class="row-main"><div class="row-title">${label}</div>
        <div class="row-sub">${esc([t.marca, t.modelo, t.medida].filter(Boolean).join(' ') || 'Sin datos de la cubierta')}</div>
        <div class="row-sub">${[age != null ? `${fmtNum(age, 1)} años` : 'sin DOT', km != null ? `${fmtInt(km)} km desde que se montó` : ''].filter(Boolean).join(' · ')}</div></div>
      ${nivel !== 'ok' && nivel !== 'sin-datos' ? `<span class="pill ${nivel}">${nivel === 'vencido' ? '+6 años' : '+5 años'}</span>` : ''}</a>`;
  }).join('');

  const ficha = v.ficha || {};
  const fichaSecs = FICHA.map(([sec, fields]) => {
    const filled = fields.filter(([k]) => ficha[k]);
    if (!filled.length) return '';
    return `<div class="ficha-sec"><h4>${sec}</h4>${filled.map(([k, l]) => `<div class="kv"><span>${l}</span><span>${esc(ficha[k])}</span></div>`).join('')}</div>`;
  }).join('');

  view().innerHTML = `
    <div class="card">
      <div class="kv"><span>Nombre</span><b>${esc(v.nombre)}</b></div>
      ${v.modelo ? `<div class="kv"><span>Marca y modelo</span><span>${esc(v.modelo)}</span></div>` : ''}
      ${v.anio ? `<div class="kv"><span>Año</span><span>${v.anio}</span></div>` : ''}
      ${v.patente ? `<div class="kv"><span>Patente</span><span>${esc(v.patente)}</span></div>` : ''}
      ${v.tanque ? `<div class="kv"><span>Tanque</span><span>${fmtNum(v.tanque, v.tanque % 1 ? 1 : 0)} L</span></div>` : ''}
      <div class="kv"><span>Km actuales</span><span class="num">${fmtInt(kmNow)}</span></div>
      <a class="btn btn-block btn-sm" href="#/auto/datos" style="margin-top:8px">Editar datos</a>
    </div>

    <div class="section-head"><h2>Plan de mantenimiento</h2><a href="#/plan/nuevo">+ Agregar</a></div>
    ${ejemplo ? '<p class="small muted" style="margin:-4px 4px 10px">Es un plan de ejemplo para un diésel. Revisá los intervalos con el manual o tu mecánico, y cargá cuándo se hizo cada cosa por última vez.</p>' : ''}
    ${planRows ? `<div class="rows">${planRows}</div>` : '<div class="card"><p class="muted small" style="margin:0">El plan está vacío.</p></div>'}

    <div class="section-head"><h2>Cubiertas</h2></div>
    <div class="rows">${tireRows}</div>
    <p class="tiny muted" style="margin:8px 4px 0">La antigüedad sale del DOT (semana y año de fabricación). Aviso a los 5 años y alerta a los 6, aunque tengan dibujo.</p>

    <div class="section-head"><h2>Hoja técnica</h2><a href="#/ficha">Editar</a></div>
    <div class="card">${fichaSecs || '<p class="muted small" style="margin:0">Todavía no la completaste: lámparas, medidas, presiones, aceite, filtros, batería…</p>'}
      ${fichaSecs ? '' : '<a class="btn btn-block btn-sm" href="#/ficha" style="margin-top:12px">Completar</a>'}</div>`;
}

function renderPlanForm(id) {
  setActiveTab('auto');
  const editing = id ? state.plan.find(p => p.id === id) : null;
  if (id && !editing) { navTo('#/auto'); return; }
  const p = editing || { nombre: '', km: null, meses: null, baseFecha: '', baseOdo: null };
  const st = editing ? planStatus(editing, state.services, currentKm(), todayISO()) : null;
  const hist = editing ? state.services.filter(s => (s.items || []).some(i => i.id === editing.id)).sort((a, b) => a.fecha < b.fecha ? 1 : -1) : [];

  view().innerHTML = `
    <h2 style="margin-top:4px">${editing ? 'Ítem del plan' : 'Nuevo ítem del plan'}</h2>
    ${st && st.nivel !== 'sin-datos' ? `<div class="card" style="margin-bottom:14px"><span class="pill ${st.nivel}">${NIVEL_TXT[st.nivel]}</span>
      <p style="margin:8px 0 0">${esc(statusText(st))}</p>
      <p class="small muted" style="margin:4px 0 0">${[st.dueKm != null ? `Próximo a los ${fmtInt(st.dueKm)} km` : '', st.dueFecha ? `antes del ${fmtDate(st.dueFecha, true)}` : ''].filter(Boolean).join(' o ')}</p></div>` : ''}
    <form class="form" id="pForm" novalidate autocomplete="off">
      ${fieldText('nombre', p.nombre, 'Nombre', 'Ej.: Aceite y filtro de aceite')}
      <div class="row2">
        <div class="field"><label for="km">Cada</label><div class="with-unit"><input class="input num" id="km" inputmode="numeric" value="${p.km != null ? fmtInt(p.km) : ''}"><span class="unit">km</span></div></div>
        <div class="field"><label for="meses">o cada</label><div class="with-unit"><input class="input num" id="meses" inputmode="numeric" value="${p.meses ?? ''}"><span class="unit">meses</span></div></div>
      </div>
      <div class="hint">Lo que llegue primero. Podés dejar uno vacío (el matafuego y la VTV van solo por meses).</div>

      <p class="form-sec">Última vez, si fue antes de usar la app</p>
      <div class="row2">${fieldDate('baseFecha', p.baseFecha, 'Fecha')}${fieldOdo('baseOdo', p.baseOdo, 'Km')}</div>
      <div class="hint">${hist.length ? 'Ya hay services con este ítem, así que se toma el más reciente.' : 'Cuando registres un service con este ítem, se usa ese.'}</div>

      ${hist.length ? `<p class="form-sec">Services con este ítem</p><div class="list">${hist.map(serviceItem).join('')}</div>` : ''}

      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        ${editing ? '<button class="btn btn-danger btn-block" type="button" id="delBtn">Quitar del plan</button>' : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;

  $('#baseOdo').addEventListener('input', e => { const n = parseNum(e.target.value, 'int'); e.target.value = n == null ? '' : fmtInt(n); });
  $('#km').addEventListener('input', e => { const n = parseNum(e.target.value, 'int'); e.target.value = n == null ? '' : fmtInt(n); });
  $('#cancelBtn').onclick = () => goBack('#/auto');
  $('#delBtn')?.addEventListener('click', () => {
    if (confirm(`¿Quitar "${editing.nombre}" del plan? Los services ya registrados no se borran.`)) deleteAndBack('plan', editing.id, 'Ítem quitado', '#/auto');
  });
  $('#pForm').addEventListener('submit', async e => {
    e.preventDefault();
    const obj = {
      ...p, id: editing?.id || uid(), vehicleId: state.vehicle.id,
      nombre: $('#nombre').value.trim(),
      km: parseNum($('#km').value, 'int') || null, meses: parseNum($('#meses').value, 'int') || null,
      baseFecha: $('#baseFecha').value || '', baseOdo: parseNum($('#baseOdo').value, 'int'),
      orden: editing?.orden ?? (Math.max(-1, ...state.plan.map(x => x.orden ?? 0)) + 1),
      ejemplo: false,
    };
    if (!obj.nombre) { $('#nombre').focus(); return toast('Falta el nombre'); }
    if (!obj.km && !obj.meses) return toast('Poné cada cuántos km o cada cuántos meses');
    if (obj.baseFecha && obj.baseFecha > todayISO()) return toast('La fecha no puede ser futura');
    // Si el resto del plan sigue siendo el de ejemplo, igual se marca como revisado este ítem
    await saveAndBack('plan', obj, 'Plan guardado', '#/auto');
  });
}

function renderTireForm(pos, nueva) {
  setActiveTab('auto');
  if (!POSICIONES[pos]) { navTo('#/auto'); return; }
  const current = activeTires().find(t => t.posicion === pos);
  const replacing = !!(current && nueva);
  const editing = current && !nueva ? current : null;
  const medidaFicha = state.vehicle.ficha?.nMedida || '';
  const t = editing || { marca: '', modelo: '', medida: current?.medida || medidaFicha, dot: '', fechaMontaje: todayISO(), odoMontaje: replacing ? currentKm() : null, costo: null, notas: '' };
  const prev = state.tires.filter(x => x.posicion === pos && !x.activa).sort((a, b) => (a.fechaBaja || '') < (b.fechaBaja || '') ? 1 : -1);
  const age = editing ? tireAge(editing.dot, todayISO()) : null;

  view().innerHTML = `
    <h2 style="margin-top:4px">${POSICIONES[pos]}</h2>
    ${replacing ? `<p class="small muted" style="margin:-4px 4px 12px">Cargá la cubierta nueva. La actual (${esc([current.marca, current.modelo].filter(Boolean).join(' ') || 'sin datos')}) pasa al historial.</p>` : ''}
    ${editing && age != null ? `<div class="card" style="margin-bottom:14px"><span class="pill ${tireNivel(age)}">${fmtNum(age, 1)} años</span>
      <p class="small muted" style="margin:8px 0 0">Fabricada alrededor del ${fmtDate(dotDate(editing.dot), true)}.</p></div>` : ''}
    <form class="form" id="tForm" novalidate autocomplete="off">
      <div class="row2">${fieldText('marca', t.marca, 'Marca', 'Pirelli, Fate…')}${fieldText('modelo', t.modelo, 'Modelo', 'Opcional')}</div>
      <div class="row2">${fieldText('medida', t.medida, 'Medida', '205/55 R16')}
        <div class="field"><label for="dot">DOT</label><input class="input num" id="dot" inputmode="numeric" maxlength="4" value="${esc(t.dot)}" placeholder="2321"></div></div>
      <div class="hint">DOT: los últimos 4 números del costado, dentro de un óvalo. Semana y año: 2321 es la semana 23 de 2021.</div>
      <div class="row2">${fieldDate('fechaMontaje', t.fechaMontaje, 'Montada el')}${fieldOdo('odoMontaje', t.odoMontaje, 'Km al montarla')}</div>
      ${fieldMoney('costo', t.costo, 'Costo (opcional)')}
      ${fieldArea('notas', t.notas, 'Notas')}
      ${replacing ? switchRow('aNovedad', 'Anotar el cambio en novedades', 'Queda en el historial, con el costo', true) : ''}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">${replacing ? 'Guardar cubierta nueva' : 'Guardar'}</button>
        ${editing ? `<a class="btn btn-block" href="#/cubierta/${pos}/nueva">Cambiar por una cubierta nueva</a>` : ''}
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>
    ${prev.length ? `<p class="form-sec" style="margin-top:22px">Cubiertas anteriores en esta posición</p>
      <div class="rows">${prev.map(x => `<div class="row"><div class="row-main"><div class="row-title">${esc([x.marca, x.modelo].filter(Boolean).join(' ') || 'Sin datos')}</div>
        <div class="row-sub">${[x.fechaMontaje ? `montada ${fmtDate(x.fechaMontaje)}` : '', x.fechaBaja ? `retirada ${fmtDate(x.fechaBaja)}` : '', x.dot ? `DOT ${esc(x.dot)}` : ''].filter(Boolean).join(' · ')}</div></div></div>`).join('')}</div>` : ''}`;

  $('#odoMontaje').addEventListener('input', e => { const n = parseNum(e.target.value, 'int'); e.target.value = n == null ? '' : fmtInt(n); });
  $('#cancelBtn').onclick = () => goBack('#/auto');
  $('#tForm').addEventListener('submit', async e => {
    e.preventDefault();
    const dot = $('#dot').value.replace(/\D/g, '');
    const obj = {
      ...(editing || {}), id: editing?.id || uid(), vehicleId: state.vehicle.id, posicion: pos, activa: true,
      marca: $('#marca').value.trim(), modelo: $('#modelo').value.trim(), medida: $('#medida').value.trim(),
      dot, fechaMontaje: $('#fechaMontaje').value || '', odoMontaje: parseNum($('#odoMontaje').value, 'int'),
      costo: parseNum($('#costo').value, 'money'), notas: $('#notas').value.trim(),
      creado: editing?.creado || Date.now(), modificado: Date.now(),
    };
    if (dot && !dotDate(dot)) return toast('El DOT tiene que ser 4 números: semana y año (ej. 2321)');
    if (obj.fechaMontaje && obj.fechaMontaje > todayISO()) return toast('La fecha no puede ser futura');
    if (replacing) {
      const old = { ...current, activa: false, fechaBaja: obj.fechaMontaje || todayISO() };
      await dbPut('tires', old, obj);
      if ($('#aNovedad').checked) {
        await dbPut('notes', {
          id: uid(), vehicleId: state.vehicle.id, fecha: obj.fechaMontaje || todayISO(), odo: obj.odoMontaje,
          categoria: state.listas.catNovedad.find(esCubiertas) || 'Cubiertas', posicion: pos,
          descripcion: `Cambio de cubierta: ${[obj.marca, obj.modelo, obj.medida].filter(Boolean).join(' ') || 'nueva'}`,
          costo: obj.costo, creado: Date.now(), modificado: Date.now(),
        });
      }
      requestPersistence();
      await loadState();
      toast('Cubierta nueva guardada');
      // Volver dos pantallas (saltando la ficha de la cubierta vieja) hasta Auto
      if (navStack.length > 2) history.go(-2); else navTo('#/auto');
      return;
    }
    await saveAndBack('tires', obj, 'Cubierta guardada', '#/auto');
  });
}

function renderFichaForm() {
  setActiveTab('auto');
  const ficha = state.vehicle.ficha || {};
  view().innerHTML = `
    <h2 style="margin-top:4px">Hoja técnica</h2>
    <p class="small muted" style="margin:-4px 4px 10px">Completá lo que sepas. Lo vacío no se muestra.</p>
    <form class="form" id="fForm" novalidate autocomplete="off">
      ${FICHA.map(([sec, fields]) => `<p class="form-sec">${sec}</p>
        ${fields.map(([k, l]) => k === 'oNotas' ? fieldArea('f_' + k, ficha[k], l, '') : fieldText('f_' + k, ficha[k], l, placeholderFicha(k), 'autocapitalize="off"')).join('')}`).join('')}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">Guardar</button>
        <button class="btn btn-block" type="button" id="cancelBtn">Cancelar</button>
      </div>
    </form>`;
  $('#cancelBtn').onclick = () => goBack('#/auto');
  $('#fForm').addEventListener('submit', async e => {
    e.preventDefault();
    const nf = {};
    FICHA.forEach(([, fields]) => fields.forEach(([k]) => { const v = $('#f_' + k).value.trim(); if (v) nf[k] = v; }));
    await saveAndBack('vehicles', { ...state.vehicle, ficha: nf }, 'Hoja técnica guardada', '#/auto');
  });
}
function placeholderFicha(k) {
  return { lBaja: 'H7', lAlta: 'H1', lPosicion: 'W5W', lGiroDel: 'PY21W', lFreno: 'P21/5W', nMedida: '205/55 R16', nPresionDel: '32 psi',
    mAceite: '5W-40 sintético', mAceiteCap: '4,5 L con filtro', oBateria: '12V 70Ah', oEscobillaDel: '600 + 475 mm' }[k] || '';
}

function renderVehicleForm(first) {
  setActiveTab(first ? '' : 'auto');
  const v = state.vehicle || {};
  view().innerHTML = `
    ${first ? `<div class="card hero" style="margin-bottom:16px"><p class="card-title">Bienvenido</p>
      <p style="margin:0">Empecemos con los datos del auto. Solo el nombre es obligatorio; el resto lo podés completar después.</p></div>`
      : '<h2 style="margin-top:4px">Datos del auto</h2>'}
    <form class="form" id="vForm" novalidate autocomplete="off">
      ${fieldText('vNombre', v.nombre, 'Nombre', 'Ej.: Bora')}
      ${fieldText('vModelo', v.modelo, 'Marca y modelo', 'Ej.: Volkswagen Bora 1.9 TDI', 'autocapitalize="words"')}
      <div class="row2">
        <div class="field"><label for="vAnio">Año</label><input class="input num" id="vAnio" inputmode="numeric" value="${v.anio ?? ''}"></div>
        ${fieldText('vPatente', v.patente, 'Patente', '', 'autocapitalize="characters"')}
      </div>
      <div class="row2">
        <div class="field"><label for="vTanque">Capacidad del tanque</label><div class="with-unit"><input class="input num" id="vTanque" inputmode="decimal" value="${toInput(v.tanque, 1)}"><span class="unit">L</span></div></div>
        ${fieldOdo('vOdo', v.odoInicial, 'Km al empezar')}
      </div>
      ${fieldArea('vNotas', v.notas, 'Notas')}
      <div class="form-actions">
        <button class="btn btn-primary btn-block" type="submit">${first ? 'Empezar' : 'Guardar'}</button>
        ${first ? `<label class="btn btn-block file-btn">Ya tengo una copia de seguridad…<input type="file" id="firstRestore" accept=".json,application/json"></label>`
          : '<button class="btn btn-block" type="button" id="vCancel">Cancelar</button>'}
      </div>
    </form>`;

  $('#vOdo').addEventListener('input', e => { const n = parseNum(e.target.value, 'int'); e.target.value = n == null ? '' : fmtInt(n); });
  $('#vCancel')?.addEventListener('click', () => goBack('#/auto'));
  $('#firstRestore')?.addEventListener('change', e => restoreBackup(e.target.files[0]));
  $('#vForm').addEventListener('submit', async e => {
    e.preventDefault();
    const nombre = $('#vNombre').value.trim();
    if (!nombre) { $('#vNombre').focus(); return toast('Ponele un nombre al auto'); }
    const obj = {
      ...v, id: v.id || uid(), nombre,
      modelo: $('#vModelo').value.trim(), anio: parseNum($('#vAnio').value, 'int'),
      patente: $('#vPatente').value.trim().toUpperCase(), tanque: parseNum($('#vTanque').value, 'dec'),
      odoInicial: parseNum($('#vOdo').value, 'int'), notas: $('#vNotas').value.trim(),
      creado: v.creado || Date.now(),
    };
    await dbPut('vehicles', obj);
    await setMeta('activeVehicle', obj.id);
    await loadState();
    toast(first ? '¡Listo! Ya podés registrar' : 'Datos guardados');
    if (first) navTo('#/'); else goBack('#/auto');
  });
}

// =====================================================================
// Ajustes
// =====================================================================
async function renderSettings() {
  setActiveTab('ajustes');
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* sin soporte */ }
  let canShare = false;
  try { canShare = !!(navigator.canShare && window.File && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })); } catch { /* sin soporte */ }
  const L = state.listas;

  view().innerHTML = `
    <div class="card hero"><p class="card-title">Versión instalada</p>
      <div class="hero-row"><div><span class="big" style="font-size:2.2rem">${APP_VERSION}</span></div>
      <div class="hero-side"><span class="muted">del</span><strong>${fmtDate(CHANGELOG[0][1], true)}</strong></div></div></div>

    <h2>Preferencias</h2>
    <div class="card"><div class="field"><span class="label">Mostrar el consumo en</span>${segmented('unidad', { l100: 'L/100 km', kml: 'km/L' }, state.prefs.unidad)}</div></div>

    <h2>Listas</h2>
    <div class="card form">
      <p class="small muted" style="margin:0">Una opción por renglón. Lo que ya registraste no cambia.</p>
      <div class="field"><label for="lMarcas">Marcas de combustible</label><textarea class="input" id="lMarcas" rows="4">${esc(L.marcas.join('\n'))}</textarea></div>
      <div class="field"><label for="lNov">Categorías de novedades</label><textarea class="input" id="lNov" rows="4">${esc(L.catNovedad.join('\n'))}</textarea></div>
      <div class="field"><label for="lGas">Categorías de gastos</label><textarea class="input" id="lGas" rows="4">${esc(L.catGasto.join('\n'))}</textarea></div>
      <button class="btn btn-block" id="saveLists" type="button">Guardar listas</button>
    </div>

    <h2>Exportar a Excel</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Una planilla con resumen, cargas, services, plan, novedades, gastos, cubiertas y la hoja técnica.</p>
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

    <h2>Novedades de la app</h2>
    <div class="card changelog">${CHANGELOG.map(([ver, fecha, items]) => `<div>
      <h4>Versión ${ver} <span class="muted small">· ${fmtDate(fecha, true)}</span></h4>
      <ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')}</div>

    <h2>Zona peligrosa</h2>
    <div class="card"><button class="btn btn-danger btn-block" id="wipe" type="button">Borrar todos los datos</button></div>`;

  $$('input[name="unidad"]').forEach(r => r.addEventListener('change', async () => {
    state.prefs.unidad = r.value; await setMeta('prefs', state.prefs); toast('Listo');
  }));
  $('#saveLists').onclick = async () => {
    const parse = id => [...new Set($('#' + id).value.split('\n').map(s => s.trim()).filter(Boolean))];
    const nl = { marcas: parse('lMarcas'), catNovedad: parse('lNov'), catGasto: parse('lGas') };
    for (const k of Object.keys(nl)) if (!nl[k].length) nl[k] = DEFAULT_LISTAS[k];
    await setMeta('listas', nl); state.listas = nl; toast('Listas guardadas'); renderSettings();
  };
  $('#xlsxDl').onclick = () => exportExcel(false);
  $('#xlsxShare')?.addEventListener('click', () => exportExcel(true));
  $('#bkDl').onclick = () => downloadBackup(false);
  $('#bkShare')?.addEventListener('click', () => downloadBackup(true));
  $('#bkRestore').onchange = e => restoreBackup(e.target.files[0]);
  $('#wipe').onclick = wipeAll;
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
      if (err.name === 'AbortError') return false;
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
  const bytes = buildWorkbook({ ...state, exportDate: todayISO() });
  const ok = await deliverFile(bytes, `bitacora-${slug(state.vehicle.nombre)}-${todayISO()}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', share);
  if (ok && !share) toast('Excel descargado');
}

async function downloadBackup(share) {
  const data = { app: 'bitacora-auto', formato: 2, version: APP_VERSION, exportado: new Date().toISOString() };
  for (const s of STORES) data[s] = await dbAll(s);
  data.meta = (await dbAll('meta')).filter(m => m.key !== 'lastBackup');
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
  const n = (data.fuel.length + (data.services?.length || 0) + (data.notes?.length || 0) + (data.expenses?.length || 0));
  const actuales = state.fuel.length + state.services.length + state.notes.length + state.expenses.length;
  const msg = `La copia es del ${fmtDate((data.exportado || '').slice(0, 10), true)} y tiene ${plural(n, 'registro', 'registros')}.\n\n` +
    (actuales ? `Va a REEMPLAZAR los datos actuales (${plural(actuales, 'registro', 'registros')}). ¿Seguir?` : '¿Restaurar?');
  if (!confirm(msg)) return;
  await replaceAll({ ...data, meta: [...(data.meta || []), { key: 'lastBackup', value: data.exportado || new Date().toISOString() }] });
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
