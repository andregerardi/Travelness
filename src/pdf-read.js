/* Leitura de PDF no navegador, com pdf.js.
 *
 * Recibo de Uber, 99 e companhia é PDF digital: tem camada de texto. Ler esse
 * texto dá o valor exato, sem OCR e sem a chance de trocar um dígito — é o
 * caminho preferido. Só quando o PDF é um scan (sem texto) a primeira página é
 * rasterizada e mandada para o Tesseract.
 *
 * Este módulo é carregado sob demanda (ver ocr-engine.js): o pdf.js pesa ~1,6 MB
 * e a maioria dos cupons é foto, então não faz sentido baixá-lo sempre.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// O worker vai como arquivo vizinho, resolvido a partir deste módulo, para
// funcionar tanto em /Travelness/ (GitHub Pages) quanto em /static/ (Flask).
pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.mjs", import.meta.url).href;

const RENDER_SCALE = 2.4;   // ~170 dpi: o bastante para o Tesseract num scan

/** Devolve a tarefa de carregamento: é nela que vive destroy(). */
function abrir(data) {
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableAutoFetch: true,
  });
}

/**
 * Remonta as linhas a partir dos fragmentos de texto, agrupando por altura.
 * O pdf.js devolve pedaços soltos com coordenadas; sem reagrupar, "Total" e
 * "R$ 15,99" viram linhas separadas e o parser não casa valor com rótulo.
 */
function linhasDaPagina(itens) {
  const porAltura = new Map();
  for (const it of itens) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);      // linha de base do fragmento
    if (!porAltura.has(y)) porAltura.set(y, []);
    porAltura.get(y).push([it.transform[4], it.str]);
  }
  return [...porAltura.entries()]
    .sort((a, b) => b[0] - a[0])                // de cima para baixo
    .map(([, frags]) =>
      frags.sort((a, b) => a[0] - b[0])         // da esquerda para a direita
        .map((f) => f[1]).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Extrai o texto de todas as páginas. Devolve "" se o PDF não tiver camada de texto. */
export async function extrairTexto(buffer) {
  const tarefa = abrir(buffer);
  const doc = await tarefa.promise;
  const linhas = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pagina = await doc.getPage(i);
    const conteudo = await pagina.getTextContent();
    linhas.push(...linhasDaPagina(conteudo.items));
    pagina.cleanup();
  }
  const texto = linhas.join("\n");
  await tarefa.destroy();
  return texto;
}

const MAX_PAGINAS = 20;   // trava de segurança: recibo não tem 200 páginas

async function desenhaPagina(doc, n) {
  const pagina = await doc.getPage(n);
  const viewport = pagina.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";                       // PDF sem fundo sai preto no JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pagina.render({ canvasContext: ctx, viewport, background: "#fff" }).promise;
  pagina.cleanup();
  return canvas;
}

/**
 * Rasteriza todas as páginas. O comprovante vale como documento inteiro —
 * num recibo de app as páginas seguintes trazem trajeto, pagamento e tributos,
 * e a prestação de contas precisa anexar tudo, não só a primeira folha.
 */
export async function rasterizarPaginas(buffer, onProgress) {
  const tarefa = abrir(buffer);
  const doc = await tarefa.promise;
  const total = Math.min(doc.numPages, MAX_PAGINAS);
  const canvases = [];
  for (let n = 1; n <= total; n++) {
    onProgress?.({ phase: "render", pagina: n, total });
    canvases.push(await desenhaPagina(doc, n));
  }
  await tarefa.destroy();
  return { canvases, totalNoPdf: doc.numPages };
}

/** Texto útil = tem letras suficientes para valer a pena pular o OCR. */
export function temCamadaDeTexto(texto) {
  const letras = (texto.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  return letras >= 40;
}
