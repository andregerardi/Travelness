/* PDF dos comprovantes, gerado no navegador com pdf-lib.
   Mesmo layout de exporters.py: capa com resumo, índice e uma página por nota. */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { periodo } from "./xlsx.js";

const A4 = [595.28, 841.89];
const mm = (v) => (v * 72) / 25.4;
const M = mm(18);

const NAVY = rgb(0.122, 0.227, 0.373);
const INK = rgb(0.106, 0.141, 0.188);
const MUTED = rgb(0.42, 0.463, 0.525);
const LINE = rgb(0.843, 0.871, 0.906);
const SOFT = rgb(0.957, 0.969, 0.98);
const WHITE = rgb(1, 1, 1);

const CAT_LABEL = {
  alimentacao: "Alimentação", combustivel: "Combustível", transporte: "Transporte",
  estacionamento: "Estacionamento", outros: "Outros",
};

export const brl = (v) =>
  "R$ " + (Number(v) || 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");

function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return y ? `${d}/${m}/${y}` : "—";
}

/* As fontes padrão do PDF usam WinAnsi: acentos passam, mas setas e traços longos não.
   Troco os caracteres de fora em vez de embutir uma fonte (que pesaria ~300 KB no app). */
const SUBS = { "→": "->", "←": "<-", "•": "-", "−": "-", " ": " ", " ": " " };
const san = (s) => String(s ?? "")
  .replace(/[→←•−  ]/g, (c) => SUBS[c])
  .replace(/[Ā-‒―-‛„-‥‧-￿]/g, "");

export async function buildPdf(profile, trip, receipts, images) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = A4;

  doc.setTitle(san(`Comprovantes – ${trip.projeto}`));
  doc.setAuthor(san(profile.nome || ""));
  doc.setCreator("Travelness");

  const width = (t, f, s) => f.widthOfTextAtSize(san(t), s);
  const clip = (t, f, s, max) => {
    let v = san(t);
    if (width(v, f, s) <= max) return v;
    while (v.length && width(v + "…", f, s) > max) v = v.slice(0, -1);
    return v + "…";
  };
  const wrap = (t, f, s, max, maxLines = 6) => {
    const words = san(t).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (width(next, f, s) <= max) cur = next;
      else { if (cur) lines.push(cur); cur = w; }
      if (lines.length >= maxLines) break;
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    return lines;
  };

  /* ------------------------------------------------------------ capa */
  let page = doc.addPage(A4);
  const text = (p, t, x, y, { size = 10, f = font, color = INK } = {}) =>
    p.drawText(san(t), { x, y, size, font: f, color });

  page.drawRectangle({ x: 0, y: H - mm(38), width: W, height: mm(38), color: NAVY });
  text(page, "Comprovantes de despesas", M, H - mm(20), { size: 20, f: bold, color: WHITE });
  const per = periodo(trip, receipts).replace(/_/g, "/");
  text(page, trip.projeto + (per ? `  ·  ${per}` : ""), M, H - mm(28), { size: 11, color: WHITE });

  let y = H - mm(52);
  const info = [
    ["NOME", profile.nome], ["CPF", profile.cpf], ["E-MAIL", profile.email],
    ["BANCO / AG. / CONTA",
      [profile.banco, profile.agencia, profile.conta].filter(Boolean).join("  ·  ")],
  ];
  for (const [k, v] of info) {
    text(page, k, M, y, { size: 9, color: MUTED });
    text(page, v || "—", M + mm(42), y, { size: 11 });
    y -= mm(7);
  }
  if (trip.motivo) {
    text(page, "MOTIVO", M, y, { size: 9, color: MUTED });
    for (const ln of wrap(trip.motivo, font, 10, W - 2 * M - mm(42))) {
      text(page, ln, M + mm(42), y, { size: 10 });
      y -= mm(5);
    }
    y -= mm(2);
  }

  // caixas por categoria
  y -= mm(4);
  const cats = Object.entries(CAT_LABEL);
  const gap = mm(3);
  const bw = (W - 2 * M - (cats.length - 1) * gap) / cats.length;
  cats.forEach(([k, lbl], i) => {
    const x = M + i * (bw + gap);
    const val = receipts.filter((r) => r.categoria === k).reduce((s, r) => s + r.valor, 0);
    page.drawRectangle({
      x, y: y - mm(16), width: bw, height: mm(16), color: SOFT,
      borderColor: LINE, borderWidth: 1,
    });
    text(page, lbl.toUpperCase(), x + mm(2.5), y - mm(6), { size: 7, color: MUTED });
    text(page, brl(val), x + mm(2.5), y - mm(12.5), { size: 10, f: bold });
  });
  y -= mm(24);

  const totAll = receipts.reduce((s, r) => s + r.valor, 0);
  text(page, `Total geral: ${brl(totAll)}`, M, y, { size: 13, f: bold });
  const adi = Number(trip.adiantamento) || 0;
  if (adi) {
    const dif = totAll - adi;
    text(page, `Adiantamento: ${brl(adi)}   ·   ${dif >= 0 ? "A pagar" : "A restituir"}: ${brl(Math.abs(dif))}`,
      M + mm(80), y, { size: 10 });
  }
  y -= mm(10);

  /* ------------------------------------------------------------ índice */
  const cols = [M, M + mm(10), M + mm(32), M + mm(60), W - M - mm(28)];
  const heads = ["#", "DATA", "CATEGORIA", "DESCRIÇÃO", "VALOR"];
  const header = (p, yy) => {
    heads.forEach((t, i) => text(p, t, cols[i], yy, { size: 8.5, f: bold, color: MUTED }));
    p.drawLine({
      start: { x: M, y: yy - mm(2) }, end: { x: W - M, y: yy - mm(2) },
      thickness: 0.7, color: LINE,
    });
    return yy - mm(7);
  };
  y = header(page, y);
  receipts.forEach((r, i) => {
    if (y < mm(20)) { page = doc.addPage(A4); y = header(page, H - mm(20)); }
    let desc = r.descricao || r.estabelecimento || "";
    if (r.categoria === "transporte" && (r.origem || r.destino)) {
      desc = `${desc}: ${r.origem} -> ${r.destino}`;
    }
    text(page, String(i + 1), cols[0], y, { size: 9.5 });
    text(page, fmtDate(r.data), cols[1], y, { size: 9.5 });
    text(page, CAT_LABEL[r.categoria] || "", cols[2], y, { size: 9.5 });
    text(page, clip(desc, font, 9.5, W - M - mm(32) - cols[3]), cols[3], y, { size: 9.5 });
    const v = brl(r.valor);
    text(page, v, W - M - width(v, font, 9.5), y, { size: 9.5 });
    y -= mm(6);
  });

  /* ------------------------------------------- as páginas de cada nota */
  /* Um comprovante pode ter várias páginas — recibo de app traz trajeto,
     pagamento e tributos em folhas separadas, e a prestação de contas precisa
     anexar o documento inteiro. Cada página vira uma página do PDF. */
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const paginas = images.get(r.id) || [];
    const total = Math.max(paginas.length, 1);

    for (let k = 0; k < total; k++) {
      const p = doc.addPage(A4);
      p.drawRectangle({ x: 0, y: H - mm(22), width: W, height: mm(22), color: NAVY });
      const marcador = total > 1 ? ` · pág. ${k + 1}/${total}` : "";
      text(p, `#${i + 1} · ${CAT_LABEL[r.categoria] || ""} · ${fmtDate(r.data)}${marcador}`,
        M, H - mm(10), { size: 12, f: bold, color: WHITE });
      const val = brl(r.valor);
      text(p, val, W - M - width(val, bold, 12), H - mm(10), { size: 12, f: bold, color: WHITE });
      const sub = [r.estabelecimento, r.cnpj && `CNPJ ${r.cnpj}`, r.descricao].filter(Boolean).join(" · ");
      text(p, clip(sub, font, 9, W - 2 * M), M, H - mm(17), { size: 9, color: WHITE });

      const blob = paginas[k];
      if (blob) {
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const img = bytes[0] === 0x89 ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const maxw = W - 2 * M;
          const maxh = H - mm(22) - 2 * M;
          const s = Math.min(maxw / img.width, maxh / img.height);
          const dw = img.width * s, dh = img.height * s;
          p.drawImage(img, { x: (W - dw) / 2, y: M + (maxh - dh) / 2, width: dw, height: dh });
        } catch {
          text(p, "Imagem não pôde ser incluída", M, H / 2, { size: 10, color: MUTED });
        }
      } else {
        const t = "Lançamento sem foto";
        text(p, t, (W - width(t, font, 11)) / 2, H / 2, { size: 11, color: MUTED });
      }
      const foot = `Travelness · comprovante ${i + 1}/${receipts.length}`;
      text(p, foot, W - M - width(foot, font, 7.5), mm(8), { size: 7.5, color: MUTED });
    }
  }

  const bytes = await doc.save();
  return new Blob([bytes], { type: "application/pdf" });
}
