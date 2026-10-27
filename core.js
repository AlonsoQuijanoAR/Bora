/* Bitácora del Auto — lógica pura (sin DOM): números, fechas, consumo y Excel. */
(function (root) {
  'use strict';

  // ---------- Números y fechas ----------
  // kind: 'int' (solo dígitos), 'dec' (coma o punto decimal), 'money' (acepta 1.450 como mil cuatrocientos cincuenta)
  function parseNum(str, kind) {
    if (str == null) return null;
    let s = String(str).trim().replace(/[\s$]/g, '');
    if (!s) return null;
    if (kind === 'int') {
      s = s.replace(/\D/g, '');
      return s ? parseInt(s, 10) : null;
    }
    const hasC = s.includes(','), hasD = s.includes('.');
    if (hasC && hasD) s = s.replace(/\./g, '').replace(',', '.');
    else if (hasC) s = s.replace(',', '.');
    else if (hasD && kind === 'money' && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  const nf = (min, max) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: min, maximumFractionDigits: max });
  const NF0 = nf(0, 0), NF1 = nf(1, 1), NF2 = nf(2, 2), NF02 = nf(0, 2);
  const ok = n => n != null && Number.isFinite(n);
  const fmtInt = n => ok(n) ? NF0.format(Math.round(n)) : '—';
  const fmtNum = (n, d = 1) => !ok(n) ? '—' : (d === 2 ? NF2 : d === 0 ? NF0 : NF1).format(n);
  const fmtMoney = n => ok(n) ? '$ ' + NF0.format(Math.round(n)) : '—';
  const fmtPrice = n => ok(n) ? '$ ' + NF02.format(n) : '—';
  // Para volver a mostrar un número dentro de un input (coma decimal, sin miles)
  const toInput = (n, dec = 2) => ok(n) ? String(Math.round(n * 10 ** dec) / 10 ** dec).replace('.', ',') : '';

  function todayISO(d = new Date()) {
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtDate(iso, long) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return long ? `${d}/${m}/${y}` : `${d}/${m}/${y.slice(2)}`;
  }
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_C = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function monthLabel(ym) { const [y, m] = ym.split('-'); return `${MESES[+m - 1]} ${y}`; }
  function daysBetween(isoA, isoB) {
    const a = Date.UTC(...isoA.split('-').map((v, i) => i === 1 ? v - 1 : +v));
    const b = Date.UTC(...isoB.split('-').map((v, i) => i === 1 ? v - 1 : +v));
    return Math.round((b - a) / 86400000);
  }

  // ---------- Etiquetas ----------
  const TIPOS = { comun: 'Común', premium: 'Premium', mezcla: 'Mezcla' };
  const USOS = { ruta: 'Ruta', mixto: 'Mixto', urbano: 'Urbano' };

  // ---------- Consumo ----------
  // Orden: fecha, después odómetro (sin km al final del día), después creación.
  function sortFuel(list) {
    return [...list].sort((a, b) =>
      a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 :
      (a.odo ?? Infinity) - (b.odo ?? Infinity) || (a.creado || 0) - (b.creado || 0));
  }

  // Método "tanque lleno a tanque lleno": entre dos cargas llenas con odómetro,
  // los litros cargados (incluidas las parciales del medio) son lo que se consumió.
  // - Combustible y limpiainyectores del tramo: los de las cargas desde el lleno inicial (lo que se quemó).
  // - Uso del tramo: el que se anotó en las cargas que cierran el tramo ("cómo manejaste desde la anterior").
  function computeSegments(fuel) {
    const list = sortFuel(fuel);
    const segs = [];
    let p = -1;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f.lleno || f.odo == null) continue;
      if (p >= 0) {
        const prev = list[p];
        const added = list.slice(p + 1, i + 1);
        const burned = list.slice(p, i);
        const km = f.odo - prev.odo;
        const litros = added.reduce((a, b) => a + (b.litros || 0), 0);
        const costoOk = added.every(b => b.total > 0);
        const costo = added.reduce((a, b) => a + (b.total || 0), 0);
        if (km > 0 && litros > 0) {
          const tipos = new Set(burned.map(b => b.tipo));
          const usos = new Set(added.map(b => b.uso).filter(Boolean));
          const marcas = new Set(burned.map(b => b.marca || ''));
          const l100 = litros / km * 100;
          segs.push({
            startId: prev.id, endId: f.id, desde: prev.fecha, hasta: f.fecha,
            km, litros, costo: costoOk ? costo : null,
            l100, kml: km / litros,
            tipo: tipos.size === 1 ? [...tipos][0] : 'mezcla',
            marca: marcas.size === 1 ? [...marcas][0] : 'Varias',
            uso: usos.size === 1 ? [...usos][0] : (usos.size ? 'mixto' : null),
            aditivo: burned.some(b => b.aditivo),
            dudoso: l100 < 2 || l100 > 40, // casi seguro un error de tipeo
          });
        }
      }
      p = i;
    }
    return segs;
  }

  function agg(segs) {
    const v = segs.filter(s => !s.dudoso);
    const km = v.reduce((a, s) => a + s.km, 0);
    const litros = v.reduce((a, s) => a + s.litros, 0);
    const conCosto = v.filter(s => s.costo != null);
    const kmC = conCosto.reduce((a, s) => a + s.km, 0);
    const costo = conCosto.reduce((a, s) => a + s.costo, 0);
    return {
      n: v.length, km, litros,
      l100: km ? litros / km * 100 : null,
      kml: litros ? km / litros : null,
      costoKm: kmC ? costo / kmC : null,
    };
  }

  function groupStats(segs, key, keys) {
    return keys.map(k => ({ key: k, ...agg(segs.filter(s => s[key] === k)) }));
  }

  // ---------- Fechas auxiliares ----------
  function addMonths(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, last));
    return t.toISOString().slice(0, 10);
  }

  // ---------- Plan de mantenimiento ----------
  // Estado de un ítem: lo último hecho sale del service más reciente que lo incluye;
  // si no hay ninguno, del "último realizado" que se cargó en el plan.
  function planStatus(item, services, kmNow, today) {
    const done = services
      .filter(s => (s.items || []).some(i => i.id === item.id))
      .sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.odo ?? 0) - (b.odo ?? 0));
    let last = null;
    if (done.length) { const s = done[done.length - 1]; last = { fecha: s.fecha, odo: s.odo ?? null, origen: 'service' }; }
    else if (item.baseFecha || item.baseOdo != null) last = { fecha: item.baseFecha || null, odo: item.baseOdo ?? null, origen: 'plan' };
    const r = { item, last, dueKm: null, dueFecha: null, kmRest: null, diasRest: null, nivel: 'sin-datos' };
    if (!last) return r;
    if (item.km && last.odo != null) { r.dueKm = last.odo + item.km; if (kmNow != null) r.kmRest = r.dueKm - kmNow; }
    if (item.meses && last.fecha) { r.dueFecha = addMonths(last.fecha, item.meses); r.diasRest = daysBetween(today, r.dueFecha); }
    if (r.kmRest == null && r.diasRest == null) return r;
    const vencido = (r.kmRest != null && r.kmRest <= 0) || (r.diasRest != null && r.diasRest <= 0);
    const pronto = (r.kmRest != null && r.kmRest <= Math.max(1000, item.km * 0.1)) || (r.diasRest != null && r.diasRest <= 30);
    r.nivel = vencido ? 'vencido' : pronto ? 'pronto' : 'ok';
    return r;
  }
  const NIVEL_ORDEN = { vencido: 0, pronto: 1, ok: 2, 'sin-datos': 3 };
  // Qué tan cerca está, para ordenar: fracción del intervalo que queda (lo menor primero)
  function urgency(st) {
    const f = [];
    if (st.kmRest != null && st.item.km) f.push(st.kmRest / st.item.km);
    if (st.diasRest != null && st.item.meses) f.push(st.diasRest / (st.item.meses * 30.4));
    return f.length ? Math.min(...f) : Infinity;
  }
  function sortStatuses(list) {
    return [...list].sort((a, b) => NIVEL_ORDEN[a.nivel] - NIVEL_ORDEN[b.nivel] || urgency(a) - urgency(b));
  }

  // Plan de ejemplo para un diésel. Los intervalos son orientativos: se editan.
  function defaultPlan() {
    return [
      ['Aceite y filtro de aceite', 10000, 12],
      ['Filtro de aire', 20000, 24],
      ['Filtro de gasoil', 20000, 24],
      ['Filtro de habitáculo', 15000, 12],
      ['Correa de distribución y bomba de agua', 60000, 48],
      ['Líquido de frenos', null, 24],
      ['Refrigerante', null, 48],
      ['Matafuego: carga', null, 12],
      ['Matafuego: prueba hidráulica', null, 60],
      ['VTV', null, 12],
    ].map(([nombre, km, meses], i) => ({ nombre, km, meses, orden: i }));
  }

  // ---------- Cubiertas ----------
  const POSICIONES = { DI: 'Delantera izquierda', DD: 'Delantera derecha', TI: 'Trasera izquierda', TD: 'Trasera derecha', AUX: 'Auxilio' };
  // DOT: 4 dígitos, semana y año de fabricación (ej. 2321 = semana 23 de 2021)
  function dotDate(dot) {
    const m = /^(\d{2})(\d{2})$/.exec(String(dot || '').replace(/\D/g, '').slice(-4));
    if (!m) return null;
    const w = +m[1], y = 2000 + +m[2];
    if (w < 1 || w > 53) return null;
    return new Date(Date.UTC(y, 0, 1 + (w - 1) * 7)).toISOString().slice(0, 10);
  }
  function tireAge(dot, today) {
    const d = dotDate(dot);
    return d ? daysBetween(d, today) / 365.25 : null;
  }
  const tireNivel = age => age == null ? 'sin-datos' : age >= 6 ? 'vencido' : age >= 5 ? 'pronto' : 'ok';

  // ---------- Costos ----------
  const RUBROS = { combustible: 'Combustible', service: 'Services', novedad: 'Novedades', gasto: 'Otros gastos' };
  function allCosts({ fuel = [], services = [], notes = [], expenses = [] }) {
    return [
      ...fuel.filter(f => f.total > 0).map(f => ({ fecha: f.fecha, rubro: 'combustible', monto: f.total })),
      ...services.filter(s => s.costo > 0).map(s => ({ fecha: s.fecha, rubro: 'service', monto: s.costo })),
      ...notes.filter(n => n.costo > 0).map(n => ({ fecha: n.fecha, rubro: 'novedad', monto: n.costo, categoria: n.categoria })),
      ...expenses.filter(e => e.monto > 0).map(e => ({ fecha: e.fecha, rubro: 'gasto', monto: e.monto, categoria: e.categoria })),
    ];
  }
  // Costo total por km = combustible por km (medido de tanque lleno a tanque lleno)
  // + el resto de los gastos repartido en los km registrados (del primer al último odómetro).
  function totalCostPerKm(data) {
    const odos = [...(data.fuel || []), ...(data.services || []), ...(data.notes || [])].map(x => x.odo).filter(n => n != null);
    if (data.vehicle?.odoInicial != null) odos.push(data.vehicle.odoInicial);
    if (odos.length < 2) return null;
    const km = Math.max(...odos) - Math.min(...odos);
    if (km < 500) return null;
    const costs = allCosts(data);
    const fuelKm = agg(computeSegments(data.fuel || [])).costoKm;
    const otros = costs.filter(c => c.rubro !== 'combustible').reduce((a, c) => a + c.monto, 0);
    const comb = costs.filter(c => c.rubro === 'combustible').reduce((a, c) => a + c.monto, 0);
    return (fuelKm != null ? fuelKm : comb / km) + otros / km;
  }

  // ---------- Excel (.xlsx) sin dependencias ----------
  // Celdas: número, string, null, o { v, s } donde s es un estilo de STYLE.
  const STYLE = { normal: 0, bold: 1, date: 2, int: 3, dec2: 4, money: 5, money2: 6, dec1: 7, title: 8 };

  function excelSerial(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  }
  const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  function colName(i) { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; }

  function sheetXml(sheet) {
    const cols = (sheet.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (cell == null || cell === '') return '';
        const o = (typeof cell === 'object') ? cell : { v: cell };
        if (o.v == null || o.v === '' || (typeof o.v === 'number' && !Number.isFinite(o.v))) return '';
        const ref = colName(c) + (r + 1);
        const s = o.s ? ` s="${o.s}"` : '';
        if (typeof o.v === 'number') return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(o.v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    const freeze = sheet.freeze ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;$&quot;\\ #,##0"/><numFmt numFmtId="166" formatCode="&quot;$&quot;\\ #,##0.00"/><numFmt numFmtId="167" formatCode="0.0"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EFE9"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function buildXlsx(sheets) {
    const files = [];
    const add = (name, text) => files.push({ name, data: new TextEncoder().encode(text) });
    add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
    add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    add('xl/styles.xml', STYLES_XML);
    sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
    return zipStore(files);
  }

  // ZIP sin compresión (método "store"): suficiente para planillas chicas.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function zipStore(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      chunks.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
      c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true);
      c.setUint32(38, 0, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(e.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let pos = 0; for (const a of all) { out.set(a, pos); pos += a.length; }
    return out;
  }

  // ---------- Hoja técnica: campos ----------
  const FICHA = [
    ['Lámparas', [['lBaja', 'Luz baja'], ['lAlta', 'Luz alta'], ['lPosicion', 'Posición'], ['lGiroDel', 'Giro delantero'], ['lGiroTras', 'Giro trasero'],
      ['lFreno', 'Freno'], ['lMarchaAtras', 'Marcha atrás'], ['lPatente', 'Patente'], ['lAntiniebla', 'Antiniebla'], ['lInterior', 'Interior']]],
    ['Neumáticos', [['nMedida', 'Medida'], ['nPresionDel', 'Presión delantera'], ['nPresionTras', 'Presión trasera'], ['nPresionAux', 'Presión auxilio']]],
    ['Motor', [['mAceite', 'Aceite (tipo y viscosidad)'], ['mAceiteCap', 'Capacidad de aceite'], ['mCombustible', 'Combustible recomendado']]],
    ['Filtros', [['fAceite', 'Filtro de aceite'], ['fAire', 'Filtro de aire'], ['fGasoil', 'Filtro de gasoil'], ['fHabitaculo', 'Filtro de habitáculo']]],
    ['Otros', [['oBateria', 'Batería'], ['oRefrigerante', 'Refrigerante'], ['oFrenos', 'Líquido de frenos'],
      ['oEscobillaDel', 'Escobillas delanteras'], ['oEscobillaTras', 'Escobilla trasera'], ['oNotas', 'Notas']]],
  ];

  // Arma el libro completo a partir de los datos de la app.
  function buildWorkbook(data) {
    const { vehicle, fuel = [], services = [], notes = [], expenses = [], tires = [], plan = [], exportDate } = data;
    const S = STYLE;
    const r2 = n => n == null ? null : Math.round(n * 100) / 100;
    const h = t => ({ v: t, s: S.bold });
    const D = iso => iso ? { v: excelSerial(iso), s: S.date } : null;
    const byDate = list => [...list].sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.odo ?? 0) - (b.odo ?? 0));
    const sorted = sortFuel(fuel);
    const segs = computeSegments(fuel);
    const segByEnd = new Map(segs.map(s => [s.endId, s]));
    const kmNow = (() => { const o = [...fuel, ...services, ...notes].map(x => x.odo).filter(n => n != null); if (vehicle?.odoInicial != null) o.push(vehicle.odoInicial); return o.length ? Math.max(...o) : null; })();

    const cargas = [[
      'Fecha', 'Odómetro (km)', 'Litros', 'Combustible', 'Marca', 'Precio por litro', 'Total', 'Tanque lleno',
      'Limpiainyectores', 'Uso desde la carga anterior', 'Estación', 'Notas',
      'Km del tramo', 'Litros del tramo', 'L/100 km del tramo', 'km/L del tramo', 'Tramo dudoso',
    ].map(h)];
    for (const f of sorted) {
      const s = segByEnd.get(f.id);
      cargas.push([
        D(f.fecha), { v: f.odo, s: S.int }, { v: f.litros, s: S.dec2 },
        TIPOS[f.tipo] || f.tipo, f.marca || '', { v: f.precio, s: S.money2 }, { v: f.total, s: S.money },
        f.lleno ? 'Sí' : 'No', f.aditivo ? 'Sí' : 'No', USOS[f.uso] || '', f.estacion || '', f.notas || '',
        s ? { v: s.km, s: S.int } : null, s ? { v: r2(s.litros), s: S.dec2 } : null,
        s ? { v: r2(s.l100), s: S.dec2 } : null, s ? { v: r2(s.kml), s: S.dec2 } : null,
        s && s.dudoso ? 'Sí' : null,
      ]);
    }

    const serv = [['Fecha', 'Odómetro (km)', 'Trabajos', 'Otros trabajos', 'Costo', 'Taller', 'Notas'].map(h),
      ...byDate(services).map(s => [D(s.fecha), { v: s.odo, s: S.int }, (s.items || []).map(i => i.nombre).join(', '), s.otros || '',
        { v: s.costo, s: S.money }, s.taller || '', s.notas || ''])];

    const nov = [['Fecha', 'Odómetro (km)', 'Categoría', 'Posición', 'Descripción', 'Costo'].map(h),
      ...byDate(notes).map(n => [D(n.fecha), { v: n.odo, s: S.int }, n.categoria || '', n.posicion ? POSICIONES[n.posicion] : '', n.descripcion || '', { v: n.costo, s: S.money }])];

    const gas = [['Fecha', 'Categoría', 'Monto', 'Notas'].map(h),
      ...byDate(expenses).map(e => [D(e.fecha), e.categoria || '', { v: e.monto, s: S.money }, e.notas || ''])];

    const posOrder = Object.keys(POSICIONES);
    const cub = [['Posición', 'Estado', 'Marca', 'Modelo', 'Medida', 'DOT', 'Fabricación (aprox.)', 'Antigüedad (años)', 'Montada el', 'Km al montar', 'Km recorridos', 'Retirada el', 'Costo', 'Notas'].map(h),
      ...[...tires].sort((a, b) => posOrder.indexOf(a.posicion) - posOrder.indexOf(b.posicion) || (b.activa - a.activa) || ((a.fechaMontaje || '') < (b.fechaMontaje || '') ? 1 : -1))
        .map(t => {
          const age = tireAge(t.dot, exportDate);
          return [POSICIONES[t.posicion] || t.posicion, t.activa ? 'Montada' : 'Retirada', t.marca || '', t.modelo || '', t.medida || '', t.dot || '',
            D(dotDate(t.dot)), age != null ? { v: Math.round(age * 10) / 10, s: S.dec1 } : null, D(t.fechaMontaje), { v: t.odoMontaje, s: S.int },
            t.activa && t.posicion !== 'AUX' && t.odoMontaje != null && kmNow != null ? { v: kmNow - t.odoMontaje, s: S.int } : null,
            D(t.fechaBaja), { v: t.costo, s: S.money }, t.notas || ''];
        })];

    const st = sortStatuses(plan.map(p => planStatus(p, services, kmNow, exportDate)));
    const NIV = { vencido: 'Vencido', pronto: 'Próximo', ok: 'Al día', 'sin-datos': 'Sin datos' };
    const pl = [['Ítem', 'Cada (km)', 'Cada (meses)', 'Último: fecha', 'Último: km', 'Próximo: km', 'Próximo: fecha', 'Faltan km', 'Faltan días', 'Estado'].map(h),
      ...st.map(x => [x.item.nombre, { v: x.item.km, s: S.int }, x.item.meses || null, D(x.last?.fecha), { v: x.last?.odo, s: S.int },
        { v: x.dueKm, s: S.int }, D(x.dueFecha), { v: x.kmRest, s: S.int }, x.diasRest, NIV[x.nivel]])];

    const all = agg(segs), last5 = agg(segs.filter(s => !s.dudoso).slice(-5));
    const costs = allCosts({ fuel, services, notes, expenses });
    const sumR = r => costs.filter(c => c.rubro === r).reduce((a, c) => a + c.monto, 0);
    const litrosTot = fuel.reduce((a, f) => a + (f.litros || 0), 0);
    const ckm = totalCostPerKm({ vehicle, fuel, services, notes, expenses });
    const resumen = [
      [{ v: `Resumen — ${vehicle?.nombre || 'Auto'}`, s: S.title }],
      ['Exportado el', D(exportDate)],
      ['Km actuales', { v: kmNow, s: S.int }],
      ['Cargas registradas', fuel.length],
      ['Litros cargados (total)', { v: r2(litrosTot), s: S.dec2 }],
      [],
      [h('Gasto total'), h('Monto')],
      ...Object.entries(RUBROS).map(([k, l]) => [l, { v: sumR(k), s: S.money }]),
      ['Total', { v: costs.reduce((a, c) => a + c.monto, 0), s: S.money }],
      ['Costo total por km', { v: r2(ckm), s: S.money2 }],
      [],
      [h('Consumo'), h('L/100 km'), h('km/L'), h('Tanques'), h('Km'), h('$ combustible por km')],
      ['Promedio general', { v: r2(all.l100), s: S.dec2 }, { v: r2(all.kml), s: S.dec2 }, all.n, { v: all.km, s: S.int }, { v: r2(all.costoKm), s: S.money2 }],
      ['Últimos 5 tanques', { v: r2(last5.l100), s: S.dec2 }, { v: r2(last5.kml), s: S.dec2 }, last5.n, { v: last5.km, s: S.int }, { v: r2(last5.costoKm), s: S.money2 }],
      [],
      [h('Comparativa'), h('L/100 km'), h('km/L'), h('Tanques'), h('Km'), h('$ combustible por km')],
    ];
    const cmp = (label, a) => resumen.push([label, { v: r2(a.l100), s: S.dec2 }, { v: r2(a.kml), s: S.dec2 }, a.n, { v: a.km, s: S.int }, { v: r2(a.costoKm), s: S.money2 }]);
    groupStats(segs, 'tipo', ['comun', 'premium']).forEach(g => cmp(`Combustible: ${TIPOS[g.key]}`, g));
    groupStats(segs, 'uso', ['ruta', 'mixto', 'urbano']).forEach(g => cmp(`Uso: ${USOS[g.key]}`, g));
    cmp('Con limpiainyectores', agg(segs.filter(s => s.aditivo)));
    cmp('Sin limpiainyectores', agg(segs.filter(s => !s.aditivo)));
    [...new Set(segs.map(s => s.marca).filter(m => m && m !== 'Varias'))].sort().forEach(m => cmp(`Marca: ${m}`, agg(segs.filter(s => s.marca === m))));
    resumen.push([], ['El consumo se calcula de tanque lleno a tanque lleno. Los tramos marcados como dudosos (menos de 2 o más de 40 L/100 km) no entran en los promedios.']);

    const v = vehicle || {};
    const ficha = v.ficha || {};
    const auto = [
      [{ v: 'Datos del auto', s: S.title }],
      ['Nombre', v.nombre || ''], ['Marca y modelo', v.modelo || ''], ['Año', v.anio || null],
      ['Patente', v.patente || ''], ['Capacidad del tanque (L)', v.tanque || null], ['Km al empezar a registrar', v.odoInicial != null ? { v: v.odoInicial, s: S.int } : null],
      ['Notas', v.notas || ''],
    ];
    for (const [sec, fields] of FICHA) {
      auto.push([], [h(sec)]);
      fields.forEach(([k, l]) => auto.push([l, ficha[k] || '']));
    }

    return buildXlsx([
      { name: 'Resumen', rows: resumen, widths: [32, 12, 10, 9, 10, 20] },
      { name: 'Cargas', rows: cargas, widths: [11, 14, 9, 12, 10, 15, 13, 12, 15, 24, 16, 30, 12, 15, 17, 13, 12], freeze: true },
      { name: 'Services', rows: serv, widths: [11, 14, 50, 30, 13, 18, 30], freeze: true },
      { name: 'Plan', rows: pl, widths: [36, 10, 12, 13, 12, 12, 14, 11, 11, 11], freeze: true },
      { name: 'Novedades', rows: nov, widths: [11, 14, 14, 20, 50, 12], freeze: true },
      { name: 'Gastos', rows: gas, widths: [11, 18, 13, 40], freeze: true },
      { name: 'Cubiertas', rows: cub, widths: [20, 10, 12, 14, 14, 7, 12, 10, 12, 12, 13, 12, 12, 30], freeze: true },
      { name: 'Auto', rows: auto, widths: [30, 40] },
    ]);
  }

  root.Core = {
    parseNum, fmtInt, fmtNum, fmtMoney, fmtPrice, toInput, todayISO, fmtDate, monthLabel, daysBetween,
    MESES_C, TIPOS, USOS, sortFuel, computeSegments, agg, groupStats, buildWorkbook, buildXlsx, crc32,
    addMonths, planStatus, sortStatuses, defaultPlan, POSICIONES, dotDate, tireAge, tireNivel,
    RUBROS, allCosts, totalCostPerKm, FICHA,
  };
})(typeof window !== 'undefined' ? window : globalThis);
