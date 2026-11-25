/* Normalização de imagem (canvas) e leitura do cupom.

   Duas rotas de OCR:
     1. servidor Flask, quando configurado e alcançável — rápido (~1s), não gasta bateria;
     2. Tesseract.js no próprio aparelho — funciona em qualquer lugar, 3-8s por cupom.
   A rota 2 é sempre o fallback: se o servidor não responder, o app não trava. */

import { parseReceipt } from "./ocr-parse.js";

const MAX_SIDE = 2000;      // imagem guardada (e anexada ao PDF)
const OCR_TARGET = 2200;    // resolução em que o Tesseract lê melhor
const THUMB_SIDE = 360;
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

/* ------------------------------------------------------------------ imagem */
async function decode(file) {
  // imageOrientation corrige a rotação EXIF das fotos de celular.
  if (self.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* abaixo */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
}

function draw(src, maxSide) {
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  const f = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * f));
  c.height = Math.max(1, Math.round(h * f));
  c.getContext("2d", { alpha: false }).drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (canvas, q) =>
  new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Não consegui processar a imagem."))), "image/jpeg", q));

async function sha256(blob) {
  const buf = await blob.arrayBuffer();
  if (!crypto?.subtle) return String(blob.size); // contexto inseguro: hash fraco, só p/ duplicata exata
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reduz, corrige orientação e gera miniatura. Devolve blobs prontos para gravar. */
export async function normalizeImage(file) {
  const src = await decode(file);
  const full = draw(src, MAX_SIDE);
  const thumb = draw(src, THUMB_SIDE);
  // O canvas do OCR sai direto da foto original: reamostrar duas vezes
  // (original -> 2000 -> 2200) borra justamente os traços finos do cupom.
  const srcLong = Math.max(src.width || src.naturalWidth, src.height || src.naturalHeight);
  const ocr = srcLong > MAX_SIDE ? draw(src, OCR_TARGET) : full;
  const [fullBlob, thumbBlob] = await Promise.all([toBlob(full, 0.82), toBlob(thumb, 0.7)]);
  src.close?.();
  return { full: fullBlob, thumb: thumbBlob, hash: await sha256(fullBlob), canvas: ocr };
}

/* ------------------------------------------------------- pré-processamento */
/**
 * Foto de cupom quase nunca tem iluminação uniforme: sombra da mão, brilho do
 * flash, papel térmico desbotado. Um limiar global escurece metade e estoura a
 * outra. Por isso a binarização aqui é **adaptativa** — cada pixel é comparado
 * com a média da vizinhança, calculada por imagem integral (O(n), roda rápido
 * mesmo em celular modesto). É o que mais melhora a leitura na prática.
 */
function prepForOcr(canvas) {
  // Tesseract precisa de ~25-30px de altura de letra. Em cupom fotografado,
  // isso costuma significar 1800-2200px no lado maior.
  const longSide = Math.max(canvas.width, canvas.height);
  const scale = longSide < OCR_TARGET ? OCR_TARGET / longSide : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, c.width, c.height);

  const W = c.width, H = c.height, N = W * H;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // 1. cinza
  const gray = new Uint8Array(N);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }

  // 2. imagem integral (soma de prefixos), em Float64 para não perder precisão
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += gray[y * W + x];
      integral[(y + 1) * (W + 1) + (x + 1)] = integral[y * (W + 1) + (x + 1)] + rowSum;
    }
  }

  // 3. limiar local: janela ~1/24 do lado maior, nunca menor que 15px
  const win = Math.max(15, Math.round(Math.max(W, H) / 24)) | 1;
  const r = win >> 1;
  const K = 0.15;              // quanto abaixo da média local ainda conta como tinta
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (W + 1) + (x1 + 1)]
                - integral[y0 * (W + 1) + (x1 + 1)]
                - integral[(y1 + 1) * (W + 1) + x0]
                + integral[y0 * (W + 1) + x0];
      const mean = sum / area;
      const p = y * W + x;
      const v = gray[p] > mean * (1 - K) ? 255 : 0;
      const i = p << 2;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------- tesseract.js */
let _workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (self.Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(
      "Não consegui baixar o motor de OCR. Conecte-se à internet uma vez para o app guardá-lo, " +
      "ou lance a despesa manualmente."));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  if (!_workerPromise) {
    _workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      return self.Tesseract.createWorker("por", 1, {
        logger: (m) => {
          if (m.status === "loading language traineddata" || m.status === "initializing tesseract") {
            onProgress?.({ phase: "download", progress: m.progress });
          } else if (m.status === "recognizing text") {
            onProgress?.({ phase: "ocr", progress: m.progress });
          }
        },
      });
    })().catch((e) => { _workerPromise = null; throw e; });
  }
  return _workerPromise;
}

export async function warmUpOcr(onProgress) { await getWorker(onProgress); }
export const ocrReady = () => !!_workerPromise;

async function recognizeLocal(canvas, onProgress) {
  const worker = await getWorker(onProgress);
  const prepped = prepForOcr(canvas);
  // psm 4 = colunas de tamanho variável, que é o formato de um cupom.
  // preserve_interword_spaces mantém o alinhamento de "DESCRIÇÃO ..... VALOR",
  // que é justamente o que o parser usa para achar o total.
  const base = { preserve_interword_spaces: "1", user_defined_dpi: "300" };
  await worker.setParameters({ ...base, tessedit_pageseg_mode: "4" });
  let { data } = await worker.recognize(prepped);
  let fields = parseReceipt(data.text);

  // Se a primeira passada não achou o essencial, tenta outro layout e fica com
  // a leitura mais confiante — em cupom amassado isso resolve boa parte.
  if (!fields.valor || !fields.data || fields.confianca < 0.6) {
    await worker.setParameters({ ...base, tessedit_pageseg_mode: "6" });
    const retry = await worker.recognize(prepped);
    const f2 = parseReceipt(retry.data.text);
    const melhor = (a, b) => (b.valor ? 1 : 0) - (a.valor ? 1 : 0)
      || (b.data ? 1 : 0) - (a.data ? 1 : 0) || b.confianca - a.confianca;
    if (melhor(fields, f2) > 0) { data = retry.data; fields = f2; }
  }
  return { text: data.text, fields, engine: "aparelho" };
}

/* ---------------------------------------------------------------- servidor */
async function recognizeServer(blob, serverUrl, signal) {
  const form = new FormData();
  form.append("file", blob, "cupom.jpg");
  const res = await fetch(`${serverUrl}/api/ocr`, { method: "POST", body: form, signal });
  if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
  const data = await res.json();
  return { text: data.text || "", fields: data.fields, engine: "servidor" };
}

/** Testa o servidor rapidamente; usado pela tela de configurações e antes de um lote. */
export async function pingServer(serverUrl, ms = 2500) {
  if (!serverUrl) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${serverUrl}/api/health`, { signal: ctl.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

/* ------------------------------------------------------------------ público */
/**
 * Lê um cupom. `settings` decide a rota; o fallback para o aparelho é automático.
 * Devolve { full, thumb, hash, text, fields, engine }.
 */
export async function readReceipt(file, settings = {}, onProgress) {
  const { full, thumb, hash, canvas } = await normalizeImage(file);
  const useServer = settings.useServerOcr && settings.serverUrl;

  if (useServer) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      onProgress?.({ phase: "servidor" });
      const r = await recognizeServer(full, settings.serverUrl, ctl.signal);
      return { full, thumb, hash, ...r };
    } catch {
      onProgress?.({ phase: "fallback" });
    } finally { clearTimeout(t); }
  }
  const r = await recognizeLocal(canvas, onProgress);
  return { full, thumb, hash, ...r };
}
