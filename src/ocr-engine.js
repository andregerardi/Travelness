/* Normalização de imagem (canvas) e leitura do cupom.

   Duas rotas de OCR:
     1. servidor Flask, quando configurado e alcançável — rápido (~1s), não gasta bateria;
     2. Tesseract.js no próprio aparelho — funciona em qualquer lugar, 3-8s por cupom.
   A rota 2 é sempre o fallback: se o servidor não responder, o app não trava. */

import { parseReceipt } from "./ocr-parse.js";

const MAX_SIDE = 2000;
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
  const [fullBlob, thumbBlob] = await Promise.all([toBlob(full, 0.82), toBlob(thumb, 0.7)]);
  src.close?.();
  return { full: fullBlob, thumb: thumbBlob, hash: await sha256(fullBlob), canvas: full };
}

/* ------------------------------------------------------- pré-processamento */
/** Cinza + autocontraste, equivalente ao que o ocr.py faz antes do Tesseract. */
function prepForOcr(canvas) {
  const scale = Math.max(canvas.width, canvas.height) < 1400
    ? 1400 / Math.max(canvas.width, canvas.height) : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, c.width, c.height);

  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
  }
  // descarta 1% das pontas antes de esticar o contraste (cutoff do autocontrast)
  const total = (d.length / 4) | 0, cut = total * 0.01;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > cut) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cut) { hi = i; break; } }
  if (hi > lo) {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, ((i - lo) * 255) / (hi - lo)));
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = lut[d[i]];
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
  // psm 4 = colunas de tamanho variável, que é o formato de um cupom
  await worker.setParameters({ tessedit_pageseg_mode: "4" });
  let { data } = await worker.recognize(prepped);
  let fields = parseReceipt(data.text);
  if (!fields.valor) { // segunda tentativa com outro layout, igual ao ocr.py
    await worker.setParameters({ tessedit_pageseg_mode: "6" });
    const retry = await worker.recognize(prepped);
    const f2 = parseReceipt(retry.data.text);
    if (f2.valor) { data = retry.data; fields = f2; }
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
