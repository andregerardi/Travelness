/* PaddleOCR (PP-OCRv6 small) rodando no próprio aparelho, via onnxruntime-web.
 *
 * Por que não só o Tesseract: no teste com 11 cupons reais e fotografados, o
 * Tesseract acertou o valor de 3; o PaddleOCR acertou 10 (o 11º tinha o total
 * cortado na foto, e o parser agora pede revisão nesse caso). O Paddle é uma
 * rede treinada para texto em foto — inclinado, amassado, com sombra — enquanto
 * o Tesseract foi feito para página escaneada.
 *
 * O pipeline tem dois modelos:
 *   1. detecção (DB): devolve um mapa de probabilidade de "aqui tem texto";
 *      cada mancha vira uma caixa girada;
 *   2. reconhecimento (CTC): lê cada caixa recortada e endireitada.
 * Depois as caixas são agrupadas em linhas, para "TOTAL" e "76,75" ficarem
 * na mesma linha — que é o que o parser precisa.
 *
 * Os modelos (~31 MB) ficam em docs/models/ e o service worker os guarda na
 * primeira leitura; daí em diante o OCR funciona offline.
 * Esta implementação espelha paddle_ocr.py (versão servidor).
 */

const ORT_VERSION = "1.20.1";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODELOS = {
  det: "models/PP-OCRv6_small_det.onnx",
  rec: "models/PP-OCRv6_small_rec.onnx",
  dict: "models/ppocrv6_dict.txt",
};

const DET_LIMIT = 1280;      // lado maior da imagem que entra na detecção
const DET_THRESH = 0.3;      // pixel conta como texto acima disso
const BOX_THRESH = 0.6;      // caixa só vale se a probabilidade média passar disso
const UNCLIP = 1.6;          // quanto a caixa cresce (o modelo prevê o "miolo" do texto)
const REC_H = 48;            // altura de entrada do reconhecedor
const REC_MAX_W = 1600;

let _carga = null;

function carregaScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Não consegui baixar o onnxruntime."));
    document.head.appendChild(s);
  });
}

/** Baixa com progresso, para a tela mostrar "baixando OCR 40%" na 1ª vez. */
async function baixa(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${url} (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    const b = await res.arrayBuffer();
    onBytes?.(b.byteLength, b.byteLength);
    return b;
  }
  const leitor = res.body.getReader();
  const partes = [];
  let lidos = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    lidos += value.length;
    onBytes?.(lidos, total);
  }
  const out = new Uint8Array(lidos);
  let p = 0;
  for (const x of partes) { out.set(x, p); p += x.length; }
  return out.buffer;
}

/** Carrega onnxruntime + modelos uma vez só. `base` resolve os caminhos dos modelos. */
export function carregaPaddle(base, onProgress) {
  if (!_carga) {
    _carga = (async () => {
      if (!self.ort) await carregaScript(`${ORT_BASE}ort.min.js`);
      const ort = self.ort;
      ort.env.wasm.wasmPaths = ort.env.wasm.wasmPaths || ORT_BASE;
      // GitHub Pages não manda os cabeçalhos de isolamento que habilitam
      // SharedArrayBuffer; sem eles só existe a versão de uma thread.
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

      const urls = Object.fromEntries(Object.entries(MODELOS).map(([k, v]) => [k, new URL(v, base).href]));
      const feito = { det: 0, rec: 0, dict: 0 }, tam = { det: 9.9e6, rec: 21.2e6, dict: 7.5e4 };
      const prog = (k) => (n, t) => {
        feito[k] = n; tam[k] = t || tam[k];
        const s = (o) => Object.values(o).reduce((a, b) => a + b, 0);
        onProgress?.({ phase: "download", progress: Math.min(1, s(feito) / s(tam)) });
      };
      const [det, rec, dict] = await Promise.all([
        baixa(urls.det, prog("det")), baixa(urls.rec, prog("rec")), baixa(urls.dict, prog("dict")),
      ]);
      const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const sDet = await ort.InferenceSession.create(det, opts);
      const sRec = await ort.InferenceSession.create(rec, opts);

      // linhas vazias do dicionário não são caracteres; o espaço entra no fim,
      // como o PaddleOCR faz com use_space_char=True
      const chars = new TextDecoder().decode(dict).replace(/^﻿/, "").split(/\r?\n/).filter((c) => c !== "");
      return { ort, sDet, sRec, chars: ["<blank>", ...chars], espacoPendente: true };
    })().catch((e) => { _carga = null; throw e; });
  }
  return _carga;
}
export const paddleCarregado = () => !!_carga;

/* --------------------------------------------------------------- detecção */
function preDet(ort, src) {
  const w = src.width, h = src.height;
  const r = Math.min(1, DET_LIMIT / Math.max(w, h));
  const nh = Math.max(32, Math.round((h * r) / 32) * 32);
  const nw = Math.max(32, Math.round((w * r) / 32) * 32);
  const c = document.createElement("canvas");
  c.width = nw; c.height = nh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, nw, nh);
  const px = ctx.getImageData(0, 0, nw, nh).data;
  const N = nw * nh, x = new Float32Array(3 * N);
  // o modelo foi treinado em BGR (OpenCV): canal 0 = azul
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    x[p] = (px[i + 2] / 255 - mean[0]) / std[0];
    x[N + p] = (px[i + 1] / 255 - mean[1]) / std[1];
    x[2 * N + p] = (px[i] / 255 - mean[2]) / std[2];
  }
  return { tensor: new ort.Tensor("float32", x, [1, 3, nh, nw]), nw, nh, sx: w / nw, sy: h / nh };
}

/** Fecho convexo (monotone chain) de pontos [x, y]. */
function fecho(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** Retângulo de menor área (rotating calipers): centro, eixos unitários e lados. */
function retanguloMinimo(hull) {
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], ux: 1, uy: 0, w: 0, h: 0 };
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    let ux = b[0] - a[0], uy = b[1] - a[1];
    const L = Math.hypot(ux, uy);
    if (!L) continue;
    ux /= L; uy /= L;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { area, ux, uy, w: maxU - minU, h: maxV - minV, cx: cu * ux - cv * uy, cy: cu * uy + cv * ux };
    }
  }
  return best;
}

/** Ordena os 4 cantos como o PaddleOCR: sup-esq, sup-dir, inf-dir, inf-esq. */
function ordena(pts) {
  const s = pts.map((p) => p[0] + p[1]), d = pts.map((p) => p[1] - p[0]);
  const arg = (arr, f) => arr.reduce((bi, v, i) => (f(v, arr[bi]) ? i : bi), 0);
  return [pts[arg(s, (a, b) => a < b)], pts[arg(d, (a, b) => a < b)],
    pts[arg(s, (a, b) => a > b)], pts[arg(d, (a, b) => a > b)]];
}

function posDet(prob, W, H, sx, sy) {
  const N = W * H;
  const rotulo = new Int32Array(N);       // 0 = não visitado
  const pilha = new Int32Array(N);
  const caixas = [];
  let id = 0;
  for (let s = 0; s < N; s++) {
    if (rotulo[s] || prob[s] <= DET_THRESH) continue;
    id++;
    // flood fill 8-conectado; guarda só os extremos de cada linha (bastam p/ o fecho)
    let topo = 0, area = 0, soma = 0;
    const extremos = new Map();
    pilha[topo++] = s; rotulo[s] = id;
    while (topo) {
      const p = pilha[--topo];
      const y = (p / W) | 0, x = p - y * W;
      area++; soma += prob[p];
      const e = extremos.get(y);
      if (!e) extremos.set(y, [x, x]); else { if (x < e[0]) e[0] = x; if (x > e[1]) e[1] = x; }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W || (!dx && !dy)) continue;
          const q = yy * W + xx;
          if (!rotulo[q] && prob[q] > DET_THRESH) { rotulo[q] = id; pilha[topo++] = q; }
        }
      }
    }
    if (area < 6 || soma / area < BOX_THRESH) continue;
    const pts = [];
    for (const [y, [x0, x1]] of extremos) { pts.push([x0, y]); if (x1 !== x0) pts.push([x1, y]); }
    const r = retanguloMinimo(fecho(pts));
    if (Math.min(r.w, r.h) < 3) continue;
    // "unclip": o modelo marca o miolo da letra; cresce pela distância área·k/perímetro
    const d = (r.w * r.h * UNCLIP) / Math.max(2 * (r.w + r.h), 1e-6);
    const hw = r.w / 2 + d, hh = r.h / 2 + d;
    const vx = -r.uy, vy = r.ux;
    const cantos = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [
      (r.cx + a * hw * r.ux + b * hh * vx) * sx,
      (r.cy + a * hw * r.uy + b * hh * vy) * sy,
    ]);
    caixas.push(ordena(cantos));
  }
  return caixas;
}

/* --------------------------------------------------------- reconhecimento */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Recorta a caixa girada já endireitada e na altura do reconhecedor. */
function recorta(src, box) {
  const [tl, tr, br, bl] = box;
  const w = Math.max(dist(tl, tr), dist(br, bl));
  const h = Math.max(dist(tl, bl), dist(tr, br));
  // caixa em pé (texto vertical): gira 90° no sentido anti-horário, como np.rot90
  const [p0, p1, p2, lx, ly] = h / Math.max(w, 1) >= 1.5 ? [tr, br, tl, h, w] : [tl, tr, bl, w, h];
  const tw = Math.min(REC_MAX_W, Math.max(16, Math.ceil((REC_H * lx) / Math.max(ly, 1))));
  // matriz destino->origem: origem = p0 + x·u + y·v; o canvas quer a inversa
  const ux = (p1[0] - p0[0]) / tw, uy = (p1[1] - p0[1]) / tw;
  const vx = (p2[0] - p0[0]) / REC_H, vy = (p2[1] - p0[1]) / REC_H;
  const det = ux * vy - vx * uy || 1e-9;
  const a = vy / det, b = -uy / det, c = -vx / det, d = ux / det;
  const c2 = document.createElement("canvas");
  c2.width = tw; c2.height = REC_H;
  const ctx = c2.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, tw, REC_H);
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(a, b, c, d, -(a * p0[0] + c * p0[1]), -(b * p0[0] + d * p0[1]));
  ctx.drawImage(src, 0, 0);
  return { data: ctx.getImageData(0, 0, tw, REC_H).data, tw };
}

async function reconhece(m, src, box) {
  const { data, tw } = recorta(src, box);
  const N = tw * REC_H, x = new Float32Array(3 * N);
  for (let p = 0, i = 0; p < N; p++, i += 4) {        // BGR, (v/255 - 0.5) / 0.5
    x[p] = data[i + 2] / 127.5 - 1;
    x[N + p] = data[i + 1] / 127.5 - 1;
    x[2 * N + p] = data[i] / 127.5 - 1;
  }
  const feeds = { [m.sRec.inputNames[0]]: new m.ort.Tensor("float32", x, [1, 3, REC_H, tw]) };
  const out = (await m.sRec.run(feeds))[m.sRec.outputNames[0]];
  const [, T, C] = out.dims;
  if (m.espacoPendente) {                              // só dá para saber depois da 1ª saída
    if (m.chars.length + 1 === C) m.chars.push(" ");
    m.espacoPendente = false;
  }
  const p = out.data;
  let txt = "", soma = 0, n = 0, ultimo = -1;
  for (let t = 0; t < T; t++) {
    let bi = 0, bv = -Infinity;
    for (let k = 0, o = t * C; k < C; k++, o++) if (p[o] > bv) { bv = p[o]; bi = k; }
    if (bi !== ultimo && bi !== 0) { txt += m.chars[bi] || ""; soma += bv; n++; }
    ultimo = bi;
  }
  return [txt, n ? soma / n : 0];
}

/* ------------------------------------------------------------------ linhas */
/** Agrupa caixas em linhas pela altura, já descontando a inclinação da foto. */
function montaLinhas(caixas, textos) {
  // Foto de lado: "VALOR TOTAL" (esquerda) e "76,75" (direita) caem em alturas
  // diferentes. Gira as coordenadas pelo ângulo mediano das caixas largas.
  const angs = caixas
    .filter((b) => dist(b[0], b[1]) > 2 * dist(b[3], b[0]))
    .map((b) => Math.atan2(b[1][1] - b[0][1], b[1][0] - b[0][0]))
    .sort((a, b) => a - b);
  let a = 0;
  if (angs.length) {
    const k = angs.length >> 1;
    a = -(angs.length % 2 ? angs[k] : (angs[k - 1] + angs[k]) / 2);
  }
  const ca = Math.cos(a), sa = Math.sin(a);
  const itens = [];
  caixas.forEach((b, i) => {
    const t = textos[i][0];
    if (!t.trim()) return;
    const rx = b.map((p) => p[0] * ca - p[1] * sa), ry = b.map((p) => p[0] * sa + p[1] * ca);
    itens.push({ y: ry.reduce((s, v) => s + v, 0) / 4, x: Math.min(...rx),
      h: Math.max(...ry) - Math.min(...ry), t });
  });
  itens.sort((p, q) => p.y - q.y);
  const linhas = [];
  let atual = [], yRef = null, hRef = null;
  for (const it of itens) {
    if (yRef !== null && Math.abs(it.y - yRef) > Math.max(hRef, it.h) * 0.55) { linhas.push(atual); atual = []; }
    if (!atual.length) { yRef = it.y; hRef = it.h; }
    atual.push(it);
  }
  if (atual.length) linhas.push(atual);
  return linhas.map((l) => l.sort((p, q) => p.x - q.x).map((i) => i.t).join(" ")).join("\n");
}

/* ------------------------------------------------------------------ público */
/** Lê o texto de um canvas (ou ImageBitmap). Devolve { text, caixas, ms }. */
export async function paddleOcr(src, base, onProgress) {
  const m = await carregaPaddle(base, onProgress);
  const t0 = performance.now();
  const { tensor, nw, nh, sx, sy } = preDet(m.ort, src);
  const saida = (await m.sDet.run({ [m.sDet.inputNames[0]]: tensor }))[m.sDet.outputNames[0]];
  const caixas = posDet(saida.data, nw, nh, sx, sy);
  const textos = [];
  for (let i = 0; i < caixas.length; i++) {
    textos.push(await reconhece(m, src, caixas[i]));
    onProgress?.({ phase: "ocr", progress: (i + 1) / caixas.length });
  }
  return { text: montaLinhas(caixas, textos), caixas: caixas.length, ms: Math.round(performance.now() - t0) };
}
