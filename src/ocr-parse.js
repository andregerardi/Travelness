/* Extração estruturada do texto do cupom. Port fiel de ocr.py — mesmas regras,
   para que o resultado seja igual rodando no servidor ou no navegador. */

export const CATEGORIAS = ["alimentacao", "combustivel", "transporte", "outros"];

export const stripAccents = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
export const norm = (s) => stripAccents(s).toUpperCase();

/* ----------------------------------------------------------------- dinheiro */
const MONEY_RE = /(?:^|[^\d/])(\d{1,3}(?:[.\s]\d{3})+|\d+)\s?[,.]\s?(\d{2})(?![\d/])/g;

export function parseMoney(s) {
  const out = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(s)) !== null) {
    const inteiro = m[1].replace(/[.\s]/g, "");
    const v = parseFloat(`${parseInt(inteiro, 10)}.${m[2]}`);
    if (!isNaN(v)) out.push(v);
    MONEY_RE.lastIndex = m.index + m[0].length;
  }
  return out;
}

const TOTAL_KEYS = [
  [/VALOR\s*(A|À)?\s*PAGAR/, 1],
  [/TOTAL\s*A\s*PAGAR/, 1],
  [/VALOR\s*TOTAL(\s*R\$)?/, 2],
  [/TOTAL\s*(DA\s*)?(CORRIDA|VIAGEM)/, 2],
  [/TOTAL\s*GERAL/, 2],
  [/TOTAL\s*R\s*\$/, 3],
  [/VALOR\s*(DA\s*)?(CORRIDA|VIAGEM)/, 3],
  [/\bTOTAL\b/, 4],
  [/VALOR\s*PAGO/, 5],
  [/\bVALOR\b/, 6],
];
const TOTAL_EXCLUDE =
  /TRIBUTO|IMPOSTO|LEI\s*12|TROCO|DESCONTO|ACRESC|QTD|QUANT|ITENS|APROX|IBPT|SUBTOTAL|UNIT|ICMS|PIS|COFINS|FEDERAL|ESTADUAL|MUNICIPAL/;
const PAYMENT =
  /DINHEIRO|CARTAO|CREDITO|DEBITO|\bPIX\b|VOUCHER|TICKET|ALELO|SODEXO|\bVR\b|PAGAMENTO|RECEBIDO/;

export function findTotal(lines) {
  const cands = [];
  lines.forEach((ln, i) => {
    const n = norm(ln);
    if (TOTAL_EXCLUDE.test(n)) return;
    for (const [rx, prio] of TOTAL_KEYS) {
      if (rx.test(n)) {
        let vals = parseMoney(ln);
        if (!vals.length && i + 1 < lines.length) {
          const nxt = norm(lines[i + 1]);
          if (!PAYMENT.test(nxt) && !TOTAL_EXCLUDE.test(nxt)) vals = parseMoney(lines[i + 1]);
        }
        if (vals.length) cands.push([prio, i, vals[vals.length - 1]]);
        return;
      }
    }
  });
  if (cands.length) {
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const best = cands[0][2];
    if (best > 0 && best < 100000) return [best, true];
  }
  const plain = [], paid = [];
  for (const ln of lines) {
    const n = norm(ln);
    if (TOTAL_EXCLUDE.test(n)) continue;
    const bucket = PAYMENT.test(n) ? paid : plain;
    for (const v of parseMoney(ln)) if (v > 0 && v < 20000) bucket.push(v);
  }
  const pool = plain.length ? plain : paid;
  return pool.length ? [Math.max(...pool), false] : [null, false];
}

/* ----------------------------------------------------------------- data/hora */
const MONTHS = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };
const DATE_RE = /(?:^|\D)(\d{1,2})\s?[/.\-]\s?(\d{1,2})\s?[/.\-]\s?(\d{4}|\d{2})(?!\d)/g;
const DATE_TXT_RE = /(?:^|\D)(\d{1,2})\s*(?:DE\s+)?(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[A-Z]*\.?\s*(?:DE\s+)?(\d{4})/g;
const TIME_RE = /(?:^|\D)([01]?\d|2[0-3])\s?[:h]\s?([0-5]\d)(?::[0-5]\d)?(?!\d)/;

function mkDate(d, m, y) {
  y = parseInt(y, 10);
  if (y < 100) y += 2000;
  d = parseInt(d, 10); m = parseInt(m, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const now = new Date();
  if (y < 2015 || y > now.getFullYear() + 1) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function findDateTime(lines) {
  const found = [];
  lines.forEach((ln, i) => {
    const n = norm(ln);
    const prio = /EMISS|DATA|EMITIDO/.test(n) ? 0 : 1;
    for (const [re, isText] of [[DATE_RE, false], [DATE_TXT_RE, true]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(n)) !== null) {
        const iso = isText ? mkDate(m[1], MONTHS[m[2]], m[3]) : mkDate(m[1], m[2], m[3]);
        if (iso) {
          const tm = TIME_RE.exec(n.slice(m.index + m[0].length));
          found.push([prio, i, iso, tm ? `${String(parseInt(tm[1], 10)).padStart(2, "0")}:${tm[2]}` : null]);
        }
      }
    }
  });
  if (!found.length) return [null, null];
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return [found[0][2], found[0][3]];
}

/* ----------------------------------------------------------------- CNPJ/chave */
const CNPJ_RE = /(\d{2})\s?[.,]?\s?(\d{3})\s?[.,]?\s?(\d{3})\s?[/|l1I]?\s?(\d{4})\s?[-.]?\s?(\d{2})/g;

export function cnpjValid(c) {
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (base, pesos) => {
    const s = base.split("").reduce((a, d, i) => a + parseInt(d, 10) * pesos[i], 0) % 11;
    return s < 2 ? "0" : String(11 - s);
  };
  const d1 = dv(c.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(c.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return c.slice(-2) === d1 + d2;
}
export const fmtCnpj = (c) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;

export function findCnpj(text) {
  CNPJ_RE.lastIndex = 0;
  let m, first = null;
  while ((m = CNPJ_RE.exec(text)) !== null) {
    const c = m.slice(1, 6).join("");
    if (cnpjValid(c)) return fmtCnpj(c);
    first = first || c;
  }
  return first ? fmtCnpj(first) : "";
}

export function findChave(text) {
  const re = /(?:\d{4}[\s.]?){10}\d{4}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const k = m[0].replace(/\D/g, "");
    if (k.length === 44 && ["55", "65", "59"].includes(k.slice(20, 22))) return k;
  }
  return "";
}

/* ----------------------------------------------------------------- campos */
const SKIP_ESTAB =
  /CNPJ|CPF|DOCUMENTO|AUXILIAR|CUPOM|NOTA FISCAL|NFC|EXTRATO|SAT\b|CONSUMIDOR|ENDERE|RUA |AV\.|AVENIDA|^IE\b|INSCR|TEL|FONE|RECIBO|COMPROVANTE|ELETRONIC/;

export function findEstablishment(lines) {
  for (const ln of lines.slice(0, 8)) {
    const n = norm(ln).trim();
    const letters = (n.match(/[A-Z]/g) || []).length;
    if (letters >= 4 && letters / Math.max(n.length, 1) > 0.55 && !SKIP_ESTAB.test(n)) {
      return ln.trim().replace(/^[-*|.:\s]+|[-*|.:\s]+$/g, "").replace(/\s{2,}/g, " ").slice(0, 80);
    }
  }
  return "";
}

const LITROS_RE = /(\d{1,3}[,.]\d{2,3})\s*(?:L\b|LT\b|LTS\b|LITROS?)/;
export function findLitros(text) {
  const m = LITROS_RE.exec(norm(text));
  return m ? parseFloat(m[1].replace(",", ".")) : null;
}

export function findRoute(lines) {
  let origem = "", destino = "";
  lines.forEach((ln, i) => {
    const n = norm(ln);
    const nxt = i + 1 < lines.length ? lines[i + 1].trim() : "";
    const val = () => (ln.includes(":") ? ln.split(":").slice(1).join(":").trim() : "") || nxt;
    if (!origem && /^\s*(ORIGEM|PARTIDA|EMBARQUE|DE)\s*[:\-]/.test(n)) origem = val();
    if (!destino && /^\s*(DESTINO|CHEGADA|DESEMBARQUE|PARA)\s*[:\-]/.test(n)) destino = val();
  });
  return [origem.slice(0, 120), destino.slice(0, 120)];
}

/* ----------------------------------------------------------------- categoria */
const KEYWORDS = {
  combustivel: {
    GASOLINA: 5, ETANOL: 5, DIESEL: 5, GNV: 4, COMBUSTIVE: 5, "ALCOOL HIDRAT": 4,
    POSTO: 3, "AUTO POSTO": 4, BICO: 3, BOMBA: 2, LITRO: 3, ABASTEC: 4,
    SHELL: 3, IPIRANGA: 3, PETROBRAS: 3, "BR DISTRIB": 3, ADITIVADA: 4, S10: 2, ARLA: 3,
  },
  transporte: {
    UBER: 6, TAXI: 6, TAXIMETRO: 6, CORRIDA: 5, CABIFY: 6, INDRIVE: 6, "99POP": 6,
    "99 TECNOLOGIA": 6, "99TAXI": 6, MOTORISTA: 4, PASSAGEIRO: 4, BANDEIRA: 3, PLACA: 2,
    EMBARQUE: 2, DESEMBARQUE: 3, ORIGEM: 2, DESTINO: 2, "KM RODADO": 3, VIAGEM: 1,
    TRANSPORTE: 3, COOPERATIVA: 2, PEDAGIO: 3, ESTACIONAMENTO: 2,
  },
  alimentacao: {
    RESTAURANTE: 6, LANCHONETE: 6, PADARIA: 5, CAFE: 3, CAFETERIA: 5, REFEICAO: 6,
    ALIMENT: 4, PIZZA: 4, BURGER: 4, HAMBURG: 4, LANCHE: 4, SANDUICHE: 4, SUCO: 3,
    REFRIGERANTE: 3, COCA: 2, "AGUA MINERAL": 3, PRATO: 3, BUFFET: 4, "SELF SERVICE": 5,
    "A LA CARTE": 4, EXECUTIVO: 2, SOBREMESA: 4, CERVEJA: 2, PAO: 2, SALGADO: 3,
    IFOOD: 5, MERCADO: 2, SUPERMERCADO: 3, "BAR ": 2, CHOPP: 3, ESPRESSO: 4,
    CAPPUCCINO: 4, TAPIOCA: 4, CHURRASC: 4, PEIXE: 3, FRANGO: 3, CARNE: 2,
    GORJETA: 3, "TAXA DE SERVICO": 4, COUVERT: 4, KG: 1,
  },
};

const countOf = (hay, needle) => {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};

export function classify(text) {
  const n = norm(text);
  const scores = {};
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    scores[cat] = Object.entries(kws)
      .reduce((a, [k, w]) => a + w * Math.min(countOf(n, k), 3), 0);
  }
  if (/\b99\s?(APP|POP|TAXI|TECNOLOGIA)/.test(n)) scores.transporte += 6;
  if (LITROS_RE.test(n) && /R\$\s*\/\s*L|PRECO\s*\/?\s*L|VL\.?\s*UNIT/.test(n)) scores.combustivel += 6;

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, top] = entries[0];
  if (top < 3) return ["outros", 0, scores];
  const second = entries[1] ? entries[1][1] : 0;
  const conf = Math.min(1, (top - second) / Math.max(top, 1) + (top >= 8 ? 0.2 : 0));
  return [best, Math.round(conf * 100) / 100, scores];
}

export function mealFromTime(hhmm) {
  if (!hhmm) return "Refeição";
  const [h, m] = hhmm.split(":").map(Number);
  const t = h * 60 + m;
  if (t < 10 * 60 + 30) return "Café da manhã";
  if (t < 15 * 60 + 30) return "Almoço";
  if (t < 18 * 60) return "Lanche";
  return "Jantar";
}

/* ----------------------------------------------------------------- principal */
export function parseReceipt(text) {
  const lines = (text || "").split("\n").filter((l) => l.trim());
  const [valor, byKey] = findTotal(lines);
  let [data, hora] = findDateTime(lines);
  const chave = findChave(text);
  let cnpj = findCnpj(text);
  if (!cnpj && chave) cnpj = fmtCnpj(chave.slice(6, 20));
  if (!data && chave) {
    const iso = mkDate(1, chave.slice(4, 6), `20${chave.slice(2, 4)}`);
    if (iso) data = iso;
  }
  const estab = findEstablishment(lines);
  const [categoria, confCat] = classify(text);

  const out = {
    categoria, valor: valor || 0, data: data || "", hora,
    estabelecimento: estab, cnpj, chave_acesso: chave,
    descricao: "", origem: "", destino: "", litros: null, km: null,
  };

  if (categoria === "combustivel") {
    out.litros = findLitros(text);
    out.descricao = "Abastecimento" + (estab ? ` – ${estab}` : "");
  } else if (categoria === "transporte") {
    const [o, d] = findRoute(lines);
    out.origem = o; out.destino = d;
    const nt = norm(text);
    const app = nt.includes("UBER") ? "Uber"
      : /\b99\s?(APP|POP|TAXI|TECNOLOGIA)/.test(nt) ? "99"
      : nt.includes("CABIFY") ? "Cabify"
      : nt.includes("INDRIVE") ? "inDrive" : "";
    out.descricao = app ? `Corrida ${app}` : "Táxi";
  } else if (categoria === "alimentacao") {
    out.descricao = mealFromTime(hora);
  } else {
    out.descricao = estab;
  }

  const confianca =
    (valor ? 0.4 : 0) * (byKey ? 1 : 0.6) +
    (data ? 0.25 : 0) +
    0.2 * confCat +
    (estab || cnpj ? 0.15 : 0);
  out.confianca = Math.round(confianca * 100) / 100;
  out.revisar = confianca < 0.75 || !valor || !data || categoria === "outros" ? 1 : 0;
  return out;
}
