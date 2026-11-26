/* Extração estruturada do texto do cupom. Port fiel de ocr.py — mesmas regras,
   para que o resultado seja igual rodando no servidor ou no navegador. */

export const CATEGORIAS = ["alimentacao", "combustivel", "transporte", "estacionamento", "outros"];

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
  /TRIBUTO|IMPOSTO|LEI\s*12|TROCO|DESCONTO|ACRESC|QTD|QUANT|ITENS|APROX|IBPT|SUBTOTAL|UNIT|ICMS|PIS|COFINS|FEDERAL|ESTADUAL|MUNICIPAL|MOTORISTA|PARCEIRO|GANHOS|REPASSE|TAXA DE SERVICO|ISS\b/;
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
const DATE_TXT_RE = /(?:^|\D)(\d{1,2})\s*(?:DE\s+)?(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[A-Z]*\.?,?\s*(?:DE\s+)?(\d{4})/g;   // "15 de nov. de 2026", "28 out, 2026" (99)
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
const SKIP_ESTAB = new RegExp(
  "CNPJ|CPF|DOCUMENTO|AUXILIAR|CUPOM|NOTA FISCAL|NFC|EXTRATO|SAT\\b|CONSUMIDOR|" +
  "ENDERE|RUA |AV\\.|AVENIDA|^IE\\b|INSCR|TEL|FONE|RECIBO|COMPROVANTE|ELETRONIC|" +
  "CODIGO|DESCRI|QTDE?\\b|VALOR UNIT|VL\\.? UN|\\bITEM\\b");  // cabeçalho da tabela de itens
const APOS_CNPJ_RE = /^.*?CNPJ\s*:?\s*[\d.,/|\-\s]{14,24}/i;

function pareceNome(ln) {
  const n = norm(ln).trim();
  const letters = (n.match(/[A-Z]/g) || []).length;
  return letters >= 4 && letters / Math.max(n.length, 1) > 0.55 && !SKIP_ESTAB.test(n);
}

export function findEstablishment(lines) {
  for (let ln of lines.slice(0, 8)) {
    // o OCR às vezes junta "CNPJ: 45.782.216/0001-94 NICO PANIFICADORA" numa linha só
    if (norm(ln).includes("CNPJ")) ln = ln.replace(APOS_CNPJ_RE, "");
    if (pareceNome(ln)) {
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

/* ------------------------------------------- recibos de app de corrida */
/* Uber, 99 e similares entregam PDF com camada de texto, então aqui não há
   erro de leitura — só um formato diferente do cupom fiscal: o endereço vem
   em blocos "HH:MM" seguidos das linhas do logradouro, e o documento repete
   a palavra "Total" nas seções de repasse ao motorista e de receita do app. */
export const RIDE_RE =
  /\bUBER\b|OBRIGADO POR VIAJAR|INFORMACOES DA VIAGEM|MOTORISTA PARCEIRO|GANHOS D[AO]|\b99\s?(APP|POP|TAXI|TECNOLOGIA)|CABIFY|INDRIVE|DETALHES DA (CORRIDA|VIAGEM)/;

export const isRideReceipt = (text) => RIDE_RE.test(norm(text));

/** Encurta endereço de app: tira CEP, país e pontuação solta. */
export function cleanAddress(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/,?\s*\d{5}-?\d{3}\b/g, "")
    .replace(/,?\s*(Brasil|Brazil)\b\.?/gi, "")
    .replace(/[\s,;·-]+$/, "")
    .trim()
    .slice(0, 120);
}

const SECAO_RE =
  /^(INFORMACOES|PAGAMENTO|TOTAL|GANHOS|TAXA|VOCE VIAJOU|QUER CONFERIR|PRECO|SUBTOTAL|TODAS AS SUAS|PRECISO|CENTRAL DE AJUDA|TERMOS|DUVIDA|AJUDA)/;

// "Detalhes" sozinho na linha é o cabeçalho do trajeto no recibo da 99
const INICIO_VIAGEM_RE = /INFORMACOES DA VIAGEM|DETALHES DA (VIAGEM|CORRIDA)|DADOS DA VIAGEM|TRAJETO|ITINERARIO|PERCURSO|^DETALHES$/;
const HORA_SO_RE = /^\d{1,2}:\d{2}(:\d{2})?(\s*[AP]\.?\s?M\.?)?$/i;   // "19:04", "08:37 PM"
const RUA_RE =
  /^(AV|AVENIDA|RUA|R|AL|ALAMEDA|PRACA|PC|TRAVESSA|TV|ROD|RODOVIA|ESTRADA|LARGO|VIA|MARGINAL|SHOPPING|AEROPORTO|TERMINAL)\b/;

/** Origem e destino a partir dos blocos "HH:MM" + endereço. */
export function findRideRoute(lines) {
  // O cabeçalho do recibo também traz uma hora solta; começar na seção da
  // viagem evita capturar a saudação ("Obrigado por viajar, Fulano") como rua.
  const i0 = lines.findIndex((l) => INICIO_VIAGEM_RE.test(norm(l)));
  const naSecao = i0 >= 0;
  if (naSecao) lines = lines.slice(i0 + 1);

  const blocos = [];
  let atual = null;
  for (const ln of lines) {
    const t = ln.trim();
    if (HORA_SO_RE.test(t)) {          // linha só com hora abre um bloco
      atual = { partes: [] };
      blocos.push(atual);
      continue;
    }
    if (!atual) continue;
    if (!t || SECAO_RE.test(norm(t))) { atual = null; continue; }
    atual.partes.push(t);
    // endereço de app ocupa no máximo três linhas; mais que isso é outra coisa
    if (atual.partes.length >= 3) atual = null;
  }
  // Fora da seção do trajeto, endereço precisa ter número — sem isso é texto
  // de cortesia que mora perto de uma hora. Dentro dela vale nome de lugar
  // ("Saída Principal", "Hotel Park Tower"), que é como a 99 mostra.
  const enderecos = blocos
    .map((b) => cleanAddress(b.partes.join(" ")))
    .filter((e) => (e.length > 8 && /\d/.test(e) && (/,/.test(e) || RUA_RE.test(norm(e)))) ||
      (naSecao && (e.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 4));
  if (!enderecos.length) return ["", ""];
  if (enderecos.length === 1) return [enderecos[0], ""];
  return [enderecos[0], enderecos[enderecos.length - 1]];
}

const KM_RE = /(\d{1,4}[.,]\d{1,2})\s*(QUIL[OÔ]METROS?|\bKMS?\b)/;
export function findKm(text) {
  const m = KM_RE.exec(norm(text));
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
    TRANSPORTE: 3, COOPERATIVA: 2, PEDAGIO: 3,
  },
  estacionamento: {
    ESTACIONAMENTO: 7, ESTAPAR: 7, MULTIPARK: 6, "PARK ": 4, PARKING: 6, AUTOPARK: 6,
    "ZONA AZUL": 6, "ROTATIVO ": 5, VALET: 6, MANOBRISTA: 5, GARAGEM: 5, "VAGA ": 3,
    "PATIO ": 3, "ENTRADA ": 1, "SAIDA ": 1, PERMANENCIA: 5, DIARIA: 2,
    "1A HORA": 4, "HORA ADICIONAL": 6, "HORAS ADICIONAIS": 6, "TEMPO DE PERMANENCIA": 7,
    "TOLERANCIA": 4, "CARTAO DE ESTACIONAMENTO": 7, "SHOPPING": 1,
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

// Palavras com dígito no meio ("POS70", "GA50L1NA") são letras lidas como
// número; a versão corrigida entra só como texto extra para a categoria.
const MISTO_RE = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{4,}\b/g;
const DIGITO_LETRA = { 0: "O", 1: "I", 5: "S", 7: "T" };
const desfazTrocaOcr = (n) =>
  (n.match(MISTO_RE) || []).map((w) => w.replace(/[0157]/g, (d) => DIGITO_LETRA[d])).join(" ");

export function classify(text) {
  let n = norm(text);
  n = n + "\n" + desfazTrocaOcr(n);
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
const TOTAL_CORTADO_RE = /(TOTAL|PAGAR|PAGO)\b.*?\d+[,.]\d(?!\d)\s*$/;

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
  const ride = isRideReceipt(text);
  // Num recibo de app o topo traz saudação e nome do passageiro, não o
  // estabelecimento — melhor deixar vazio do que gravar "Obrigado por viajar".
  const estab = ride ? "" : findEstablishment(lines);
  let [categoria, confCat] = classify(text);
  if (ride) { categoria = "transporte"; confCat = Math.max(confCat, 1); }

  const out = {
    categoria, valor: valor || 0, data: data || "", hora,
    estabelecimento: estab, cnpj, chave_acesso: chave,
    descricao: "", origem: "", destino: "", litros: null, km: null,
  };

  if (categoria === "combustivel") {
    out.litros = findLitros(text);
    out.descricao = "Abastecimento" + (estab ? ` – ${estab}` : "");
  } else if (categoria === "transporte") {
    const [o, d] = ride ? findRideRoute(lines) : findRoute(lines);
    out.origem = o; out.destino = d;
    if (ride) out.km = findKm(text);
    const nt = norm(text);
    const app = nt.includes("UBER") ? "Uber"
      : /\b99\s?(APP|POP|TAXI|TECNOLOGIA)/.test(nt) ? "99"
      : nt.includes("CABIFY") ? "Cabify"
      : nt.includes("INDRIVE") ? "inDrive" : "";
    out.descricao = app ? `Corrida ${app}` : "Táxi";
  } else if (categoria === "alimentacao") {
    out.descricao = mealFromTime(hora);
  } else if (categoria === "estacionamento") {
    out.descricao = "Estacionamento" + (estab ? ` – ${estab}` : "");
  } else {
    out.descricao = estab;
  }

  // num recibo de app o "contexto" é o trajeto, já que não há estabelecimento
  const temContexto = ride ? !!(out.origem || out.destino) : !!(estab || cnpj);
  const confianca =
    (valor ? 0.4 : 0) * (byKey ? 1 : 0.6) +
    (data ? 0.25 : 0) +
    0.2 * confCat +
    (temContexto ? 0.15 : 0);
  out.confianca = Math.round(confianca * 100) / 100;
  // Total sem rótulo (veio do "maior valor") ou rótulo com o valor cortado
  // ("TOTAL R$ 74,5") é palpite: pede conferência mesmo com confiança alta.
  const totalCortado = lines.some((l) => TOTAL_CORTADO_RE.test(norm(l)));
  out.revisar = confianca < 0.75 || !valor || !data || categoria === "outros" ||
    !byKey || totalCortado ? 1 : 0;
  return out;
}
