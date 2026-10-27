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
          const l100 = litros / km * 100;
          segs.push({
            startId: prev.id, endId: f.id, desde: prev.fecha, hasta: f.fecha,
            km, litros, costo: costoOk ? costo : null,
            l100, kml: km / litros,
            tipo: tipos.size === 1 ? [...tipos][0] : 'mezcla',
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

  // Arma el libro completo a partir de los datos de la app.
  function buildWorkbook({ vehicle, fuel, exportDate }) {
    const S = STYLE;
    const sorted = sortFuel(fuel);
    const segs = computeSegments(fuel);
    const segByEnd = new Map(segs.map(s => [s.endId, s]));
    const r2 = n => n == null ? null : Math.round(n * 100) / 100;
    const h = t => ({ v: t, s: S.bold });

    const cargas = [[
      'Fecha', 'Odómetro (km)', 'Litros', 'Combustible', 'Precio por litro', 'Total', 'Tanque lleno',
      'Limpiainyectores', 'Uso desde la carga anterior', 'Estación', 'Notas',
      'Km del tramo', 'Litros del tramo', 'L/100 km del tramo', 'km/L del tramo', 'Tramo dudoso',
    ].map(h)];
    for (const f of sorted) {
      const s = segByEnd.get(f.id);
      cargas.push([
        { v: excelSerial(f.fecha), s: S.date }, { v: f.odo, s: S.int }, { v: f.litros, s: S.dec2 },
        TIPOS[f.tipo] || f.tipo, { v: f.precio, s: S.money2 }, { v: f.total, s: S.money },
        f.lleno ? 'Sí' : 'No', f.aditivo ? 'Sí' : 'No', USOS[f.uso] || '', f.estacion || '', f.notas || '',
        s ? { v: s.km, s: S.int } : null, s ? { v: r2(s.litros), s: S.dec2 } : null,
        s ? { v: r2(s.l100), s: S.dec2 } : null, s ? { v: r2(s.kml), s: S.dec2 } : null,
        s && s.dudoso ? 'Sí' : null,
      ]);
    }

    const all = agg(segs), last5 = agg(segs.filter(s => !s.dudoso).slice(-5));
    const gasto = fuel.reduce((a, f) => a + (f.total || 0), 0);
    const litrosTot = fuel.reduce((a, f) => a + (f.litros || 0), 0);
    const resumen = [
      [{ v: `Resumen — ${vehicle?.nombre || 'Auto'}`, s: S.title }],
      ['Exportado el', { v: excelSerial(exportDate), s: S.date }],
      ['Cargas registradas', fuel.length],
      ['Litros cargados (total)', { v: r2(litrosTot), s: S.dec2 }],
      ['Gasto en combustible (total)', { v: gasto, s: S.money }],
      [],
      [h('Consumo'), h('L/100 km'), h('km/L'), h('Tanques'), h('Km'), h('$ por km')],
      ['Promedio general', { v: r2(all.l100), s: S.dec2 }, { v: r2(all.kml), s: S.dec2 }, all.n, { v: all.km, s: S.int }, { v: r2(all.costoKm), s: S.money2 }],
      ['Últimos 5 tanques', { v: r2(last5.l100), s: S.dec2 }, { v: r2(last5.kml), s: S.dec2 }, last5.n, { v: last5.km, s: S.int }, { v: r2(last5.costoKm), s: S.money2 }],
      [],
      [h('Comparativa'), h('L/100 km'), h('km/L'), h('Tanques'), h('Km'), h('$ por km')],
    ];
    const cmp = (label, a) => resumen.push([label, { v: r2(a.l100), s: S.dec2 }, { v: r2(a.kml), s: S.dec2 }, a.n, { v: a.km, s: S.int }, { v: r2(a.costoKm), s: S.money2 }]);
    groupStats(segs, 'tipo', ['comun', 'premium']).forEach(g => cmp(`Combustible: ${TIPOS[g.key]}`, g));
    groupStats(segs, 'uso', ['ruta', 'mixto', 'urbano']).forEach(g => cmp(`Uso: ${USOS[g.key]}`, g));
    cmp('Con limpiainyectores', agg(segs.filter(s => s.aditivo)));
    cmp('Sin limpiainyectores', agg(segs.filter(s => !s.aditivo)));
    resumen.push([], ['El consumo se calcula de tanque lleno a tanque lleno. Los tramos marcados como dudosos (menos de 2 o más de 40 L/100 km) no entran en los promedios.']);

    const v = vehicle || {};
    const auto = [
      [{ v: 'Datos del auto', s: S.title }],
      ['Nombre', v.nombre || ''], ['Marca y modelo', v.modelo || ''], ['Año', v.anio || null],
      ['Patente', v.patente || ''], ['Capacidad del tanque (L)', v.tanque || null], ['Km al empezar a registrar', v.odoInicial != null ? { v: v.odoInicial, s: S.int } : null],
      ['Notas', v.notas || ''],
    ];

    return buildXlsx([
      { name: 'Cargas', rows: cargas, widths: [11, 14, 9, 12, 15, 13, 12, 15, 24, 16, 30, 12, 15, 17, 13, 12], freeze: true },
      { name: 'Resumen', rows: resumen, widths: [32, 11, 9, 9, 10, 11] },
      { name: 'Auto', rows: auto, widths: [26, 40] },
    ]);
  }

  root.Core = {
    parseNum, fmtInt, fmtNum, fmtMoney, fmtPrice, toInput, todayISO, fmtDate, monthLabel, daysBetween,
    MESES_C, TIPOS, USOS, sortFuel, computeSegments, agg, groupStats, buildWorkbook, buildXlsx, crc32,
  };
})(typeof window !== 'undefined' ? window : globalThis);
