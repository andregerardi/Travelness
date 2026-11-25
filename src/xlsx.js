/* Gerador de .xlsx no navegador: escreve o OOXML direto e compacta com JSZip.
   Reproduz o layout de exporters.py (seções A/B/C, fechamento, assinaturas + aba de dados).
   Escolhi montar o XML à mão em vez de usar uma biblioteca de planilhas porque o layout
   depende de mesclagens, preenchimentos e fórmulas — justamente o que as versões leves
   dessas bibliotecas não escrevem. */

import JSZip from "jszip";

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/\x00-\x08|\x0B|\x0C|\x0E-\x1F/g, "");

const colName = (n) => {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = ((n - m) / 26) | 0; }
  return s;
};
const refToRC = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [parseInt(m[2], 10), c];
};
/** Serial de data do Excel (base 1899-12-30). */
const dateSerial = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
};

/* ------------------------------------------------------------------ estilos */
// índices usados no corpo: devem bater com a ordem de cellXfs abaixo
const S = {
  base: 0, titulo: 1, secao: 2, cabec: 3, cell: 4, wrap: 5, money: 6, date: 7,
  totLabel: 8, totMoney: 9, nota: 10, fechKey: 11, fechVal: 12,
  dHead: 13, dMoney: 14, dDate: 15, dPct: 16, label: 17,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
 <numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/>
 <numFmt numFmtId="165" formatCode="DD/MM/YYYY"/>
 <numFmt numFmtId="166" formatCode="0%"/>
</numFmts>
<fonts count="7">
 <font><sz val="11"/><name val="Calibri"/></font>
 <font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 <font><b/><sz val="11"/><name val="Calibri"/></font>
 <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 <font><i/><sz val="9"/><color rgb="FF555555"/><name val="Calibri"/></font>
 <font><b/><sz val="12"/><name val="Calibri"/></font>
 <font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
 <fill><patternFill patternType="none"/></fill>
 <fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F2"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFF2F5F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
 <border><left/><right/><top/><bottom/><diagonal/></border>
 <border>
  <left style="thin"><color rgb="FF9AA4B2"/></left><right style="thin"><color rgb="FF9AA4B2"/></right>
  <top style="thin"><color rgb="FF9AA4B2"/></top><bottom style="thin"><color rgb="FF9AA4B2"/></bottom>
  <diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="18">
 <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
 <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
 <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
 <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
 <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
 <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
 <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>
 <xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
 <xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
 <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
 <xf numFmtId="164" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
 <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
 <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
 <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
 <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* ------------------------------------------------------------------ builder */
class Sheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();   // "A1" -> {v, t, s, f}
    this.merges = [];
    this.cols = [];
    this.heights = new Map();
    this.freeze = null;
    this.fit = false;
  }
  put(ref, cell) { this.cells.set(ref, cell); return this; }
  str(ref, v, s = S.cell) { return this.put(ref, { t: "s", v, s }); }
  num(ref, v, s = S.cell) { return this.put(ref, { t: "n", v: Number(v) || 0, s }); }
  money(ref, v, s = S.money) { return this.put(ref, { t: "n", v: Math.round((Number(v) || 0) * 100) / 100, s }); }
  date(ref, iso, s = S.date) {
    const d = dateSerial(iso);
    return d == null ? this.str(ref, "", s) : this.put(ref, { t: "n", v: d, s });
  }
  formula(ref, f, cached, s = S.money) { return this.put(ref, { t: "n", f, v: cached, s }); }
  blank(ref, s = S.cell) { return this.put(ref, { t: "s", v: "", s }); }

  /** Mescla e já aplica o estilo em todas as células da faixa (senão a borda some). */
  mergeStr(range, v, s = S.cell) {
    const [a, b] = range.split(":");
    this.merges.push(range);
    this.str(a, v, s);
    const [r1, c1] = refToRC(a), [r2, c2] = refToRC(b);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const ref = colName(c) + r;
        if (ref !== a) this.blank(ref, s);
      }
    }
    return this;
  }
  mergeCell(range, cell) {
    const [a, b] = range.split(":");
    this.merges.push(range);
    this.put(a, cell);
    const [r1, c1] = refToRC(a), [r2, c2] = refToRC(b);
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const ref = colName(c) + r;
        if (ref !== a) this.blank(ref, cell.s);
      }
    return this;
  }
  /** Aplica borda nas células de um retângulo que ainda não foram escritas. */
  box(r1, r2, c1 = 1, c2 = 8) {
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const ref = colName(c) + r;
        if (!this.cells.has(ref)) this.blank(ref);
      }
    return this;
  }

  toXML() {
    const byRow = new Map();
    for (const [ref, cell] of this.cells) {
      const [r] = refToRC(ref);
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r).push([ref, cell]);
    }
    const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([r, cells]) => {
      cells.sort((a, b) => refToRC(a[0])[1] - refToRC(b[0])[1]);
      const inner = cells.map(([ref, c]) => {
        const s = ` s="${c.s || 0}"`;
        if (c.f !== undefined) {
          const v = c.v === undefined || c.v === null ? "" : `<v>${c.v}</v>`;
          return `<c r="${ref}"${s}><f>${esc(c.f)}</f>${v}</c>`;
        }
        if (c.t === "n") return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
        if (c.v === "" || c.v == null) return `<c r="${ref}"${s}/>`;
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
      }).join("");
      const h = this.heights.get(r);
      return `<row r="${r}"${h ? ` ht="${h}" customHeight="1"` : ""}>${inner}</row>`;
    }).join("");

    const cols = this.cols.length
      ? `<cols>${this.cols.map((w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const pane = this.freeze
      ? `<pane ySplit="1" topLeftCell="${this.freeze}" activePane="bottomLeft" state="frozen"/>`
      : "";
    const merges = this.merges.length
      ? `<mergeCells count="${this.merges.length}">${
          this.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
      : "";
    const page = this.fit
      ? `<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/>`
      : `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`;
    const props = this.fit ? `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${props}<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${merges}${page}</worksheet>`;
  }
}

/* ------------------------------------------------------------------ layout */
const CAT_LABEL = {
  alimentacao: "Alimentação", combustivel: "Combustível", transporte: "Transporte",
  estacionamento: "Estacionamento", outros: "Outros",
};

export function periodo(trip, receipts) {
  const datas = receipts.map((r) => r.data).filter(Boolean).sort();
  const di = trip.data_inicio || datas[0];
  const df = trip.data_fim || datas[datas.length - 1];
  if (!di || !df) return "";
  const f = (iso) => { const [, m, d] = iso.split("-"); return `${d}_${m}`; };
  return `${f(di)} a ${f(df)}`;
}

export function baseFilename(trip, receipts, ext) {
  const slug = (trip.projeto || "prestacao").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "prestacao";
  const p = periodo(trip, receipts);
  return `reembolso_${slug}${p ? ` - ${p}` : ""}.${ext}`;
}

function buildMain(profile, trip, receipts) {
  const ws = new Sheet("RELATÓRIO DESPESAS");
  ws.cols = [12, 16, 14, 14, 16, 12, 12, 15];
  ws.fit = true;

  ws.mergeCell("A1:H1", { t: "s", v: "Prestação de Contas de Viagens", s: S.titulo });
  ws.heights.set(1, 26);
  ws.mergeStr("A2:H2", "Passageiro/Hóspede", S.secao);
  ws.mergeStr("A3:E3", `Nome: ${profile.nome || ""}`, S.cell);
  ws.mergeStr("F3:G3", "Data da Solicitação", S.label);
  ws.date("H3", new Date().toLocaleDateString("sv-SE"), S.date);
  ws.mergeStr("A4:C4", `CPF: ${profile.cpf || ""}`, S.cell);
  ws.mergeStr("D4:E4", `Centro de Custo: ${trip.centro_custo || ""}`, S.cell);
  ws.mergeStr("F4:H4", `Unidade/Projeto: ${trip.projeto || ""}`, S.cell);

  const p = periodo(trip, receipts).replace(/_/g, "/");
  let motivo = trip.motivo || "";
  if (p && !motivo.includes(p)) motivo += ` De ${p}.`;
  ws.mergeStr("A5:H5", motivo, S.wrap);
  ws.heights.set(5, Math.max(30, 15 * (Math.floor(motivo.length / 95) + 1)));

  const byCat = {};
  for (const k of Object.keys(CAT_LABEL)) byCat[k] = receipts.filter((r) => r.categoria === k);
  let row = 7;
  const totalRefs = {};

  const sectionTotal = (letter, first, last) => {
    const vals = [];
    for (let r = first; r <= last; r++) {
      const c = ws.cells.get(`H${r}`);
      if (c && c.t === "n") vals.push(c.v);
    }
    const sum = Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100;
    ws.str(`G${row}`, `Total (${letter})`, S.totLabel);
    ws.formula(`H${row}`, `SUM(H${first}:H${last})`, sum, S.totMoney);
    totalRefs[letter] = `H${row}`;
    return sum;
  };

  /* ---- (A) transporte */
  ws.mergeStr(`A${row}:H${row}`, "Táxi / Transporte por aplicativo (A)", S.secao);
  row++;
  ws.mergeStr(`A${row}:A${row}`, "Data", S.cabec);
  ws.mergeStr(`B${row}:D${row}`, "Origem", S.cabec);
  ws.mergeStr(`E${row}:G${row}`, "Destino", S.cabec);
  ws.mergeStr(`H${row}:H${row}`, "Valor", S.cabec);
  row++;
  let first = row;
  for (const r of byCat.transporte.length ? byCat.transporte : [null]) {
    if (r) {
      ws.date(`A${row}`, r.data);
      ws.mergeStr(`B${row}:D${row}`, r.origem || r.descricao || r.estabelecimento, S.wrap);
      ws.mergeStr(`E${row}:G${row}`, r.destino, S.wrap);
      ws.money(`H${row}`, r.valor);
    } else {
      ws.blank(`A${row}`);
      ws.mergeStr(`B${row}:D${row}`, "", S.wrap);
      ws.mergeStr(`E${row}:G${row}`, "", S.wrap);
      ws.blank(`H${row}`);
    }
    row++;
  }
  ws.box(first - 1, row - 1);
  sectionTotal("A", first, row - 1);
  row += 2;

  /* ---- (B) combustível */
  ws.mergeStr(`A${row}:H${row}`, "Combustível (B)", S.secao);
  row++;
  ["Data", "Posto", "Origem", "Destino", "Distância (km)", "Litros", "Valor do litro", "Valor do Reembolso"]
    .forEach((t, i) => ws.str(colName(i + 1) + row, t, S.cabec));
  ws.heights.set(row, 32);
  row++;
  first = row;
  for (const r of byCat.combustivel.length ? byCat.combustivel : [null]) {
    if (r) {
      ws.date(`A${row}`, r.data);
      ws.str(`B${row}`, r.estabelecimento || r.descricao, S.wrap);
      ws.str(`C${row}`, r.origem);
      ws.str(`D${row}`, r.destino);
      if (r.km != null) ws.num(`E${row}`, r.km); else ws.blank(`E${row}`);
      if (r.litros != null) ws.num(`F${row}`, r.litros); else ws.blank(`F${row}`);
      if (r.litros) ws.formula(`G${row}`, `IFERROR(H${row}/F${row},"")`,
        Math.round((r.valor / r.litros) * 100) / 100, S.money);
      else ws.blank(`G${row}`);
      ws.money(`H${row}`, r.valor);
    }
    row++;
  }
  ws.box(first - 1, row - 1);
  sectionTotal("B", first, row - 1);
  row += 2;

  /* ---- (C) refeição e outros */
  ws.mergeStr(`A${row}:H${row}`, "Extra Refeição/Hotel/Estacionamento/Outros (C)", S.secao);
  row++;
  ws.mergeStr(`A${row}:A${row}`, "Data", S.cabec);
  ws.mergeStr(`B${row}:G${row}`, "Descrição", S.cabec);
  ws.mergeStr(`H${row}:H${row}`, "Valor", S.cabec);
  row++;
  first = row;
  const extras = [...byCat.alimentacao, ...byCat.estacionamento, ...byCat.outros]
    .sort((a, b) => (a.data || "9").localeCompare(b.data || "9") || a.id - b.id);
  for (const r of extras.length ? extras : [null]) {
    if (r) {
      ws.date(`A${row}`, r.data);
      let desc = r.descricao || r.estabelecimento;
      if (r.estabelecimento && !desc.includes(r.estabelecimento)) desc = `${desc} – ${r.estabelecimento}`;
      ws.mergeStr(`B${row}:G${row}`, desc, S.wrap);
      ws.money(`H${row}`, r.valor);
    } else {
      ws.blank(`A${row}`);
      ws.mergeStr(`B${row}:G${row}`, "", S.wrap);
      ws.blank(`H${row}`);
    }
    row++;
  }
  ws.box(first - 1, row - 1);
  const totC = sectionTotal("C", first, row - 1);
  row += 2;

  /* ---- dados bancários */
  ws.mergeStr(`A${row}:H${row}`,
    `Dados Bancários:   Banco: ${profile.banco || ""}    Agência: ${profile.agencia || ""}` +
    `    C/c: ${profile.conta || ""}`, S.label);
  row += 2;

  /* ---- fechamento */
  ws.mergeStr(`A${row}:H${row}`, "Fechamento", S.secao);
  row++;
  [["A", "B", "Valor Geral de Despesas (A+B+C)"], ["C", "D", "Total/Diária/Adiantamento recebido"],
   ["E", "F", "Valor a Pagar"], ["G", "H", "Valor a Restituir"]]
    .forEach(([a, b, t]) => ws.mergeStr(`${a}${row}:${b}${row}`, t, S.fechKey));
  ws.heights.set(row, 30);
  row++;
  const totA = receipts.filter((r) => r.categoria === "transporte").reduce((s, r) => s + r.valor, 0);
  const totB = receipts.filter((r) => r.categoria === "combustivel").reduce((s, r) => s + r.valor, 0);
  const geral = Math.round((totA + totB + totC) * 100) / 100;
  const adi = Number(trip.adiantamento) || 0;
  ws.mergeCell(`A${row}:B${row}`, {
    t: "n", f: `${totalRefs.A}+${totalRefs.B}+${totalRefs.C}`, v: geral, s: S.fechVal });
  ws.mergeCell(`C${row}:D${row}`, { t: "n", v: adi, s: S.fechVal });
  ws.mergeCell(`E${row}:F${row}`, {
    t: "n", f: `MAX(A${row}-C${row},0)`, v: Math.max(geral - adi, 0), s: S.fechVal });
  ws.mergeCell(`G${row}:H${row}`, {
    t: "n", f: `MAX(C${row}-A${row},0)`, v: Math.max(adi - geral, 0), s: S.fechVal });
  row += 2;

  /* ---- autorização */
  ws.mergeStr(`A${row}:H${row}`, "Autorização do Documento", S.secao);
  row++;
  ws.mergeStr(`A${row}:B${row}`, "Data:", S.cell);
  ws.mergeStr(`C${row}:H${row}`, "Aprovador (Coordenação do Projeto):", S.cell);
  ws.heights.set(row, 34);
  row++;
  ws.mergeStr(`A${row}:B${row}`, "Data:", S.cell);
  ws.mergeStr(`C${row}:H${row}`, "Carimbo / Assinatura (Administração Superior):", S.cell);
  ws.heights.set(row, 34);
  row += 2;
  ws.mergeStr(`A${row}:H${row + 1}`,
    "Nota: * Para todos os casos devem ser anexados os “Comprovantes de Despesas” — seguem no PDF " +
    "gerado pelo Travelness.  * O valor a pagar/restituir é a diferença entre o Total Geral de " +
    "Despesas e o Total Diária/Adiantamento recebido, na moeda da prestação de contas.", S.nota);
  return ws;
}

function buildData(receipts) {
  const ws = new Sheet("Cupons (dados)");
  ws.cols = [5, 12, 14, 30, 20, 28, 26, 26, 8, 8, 13, 48, 9, 13];
  ws.freeze = "A2";
  ["#", "Data", "Categoria", "Estabelecimento", "CNPJ", "Descrição", "Origem", "Destino",
   "Litros", "Km", "Valor", "Chave de acesso", "Revisar", "Confiança OCR"]
    .forEach((t, i) => ws.str(colName(i + 1) + 1, t, S.dHead));
  receipts.forEach((r, i) => {
    const row = i + 2;
    ws.num(`A${row}`, i + 1, S.base);
    ws.date(`B${row}`, r.data, S.dDate);
    ws.str(`C${row}`, CAT_LABEL[r.categoria] || r.categoria, S.base);
    ws.str(`D${row}`, r.estabelecimento, S.base);
    ws.str(`E${row}`, r.cnpj, S.base);
    ws.str(`F${row}`, r.descricao, S.base);
    ws.str(`G${row}`, r.origem, S.base);
    ws.str(`H${row}`, r.destino, S.base);
    if (r.litros != null) ws.num(`I${row}`, r.litros, S.base);
    if (r.km != null) ws.num(`J${row}`, r.km, S.base);
    ws.money(`K${row}`, r.valor, S.dMoney);
    ws.str(`L${row}`, r.chave_acesso, S.base);
    ws.str(`M${row}`, r.revisar ? "Sim" : "Não", S.base);
    ws.num(`N${row}`, r.confianca, S.dPct);
  });
  const last = receipts.length + 1;
  const tot = Math.round(receipts.reduce((s, r) => s + r.valor, 0) * 100) / 100;
  ws.str(`J${last + 2}`, "Total", S.totLabel);
  ws.formula(`K${last + 2}`, `SUM(K2:K${Math.max(last, 2)})`, tot, S.dMoney);
  return ws;
}

/* ------------------------------------------------------------------ pacote */
export async function buildXlsx(profile, trip, receipts, type = "blob") {
  const sheets = [buildMain(profile, trip, receipts), buildData(receipts)];
  const zip = new JSZip();

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);

  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) =>
    `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
<calcPr fullCalcOnLoad="1"/>
</workbook>`);

  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  zip.file("xl/styles.xml", STYLES_XML);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, s.toXML()));

  return zip.generateAsync({
    type,                                   // "nodebuffer" nos testes, "blob" no navegador
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}
