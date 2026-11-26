"""PaddleOCR (PP-OCRv6 small) com onnxruntime: detecção DB + reconhecimento CTC.

Versão servidor do mesmo pipeline de src/paddle-ocr.js (que roda no celular).
Os modelos são os mesmos arquivos publicados em docs/models/.

No teste com 11 cupons fotografados, acertou o valor em 10 (Tesseract: 3).
"""
import math
import os
import threading
import time

import cv2
import numpy as np
import onnxruntime as ort

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "models")
PRESETS = {
    "v6-small": ("PP-OCRv6_small_det.onnx", "PP-OCRv6_small_rec.onnx", "ppocrv6_dict.txt"),
}


class PaddleOCR:
    def __init__(self, preset="v6-small", det_limit=1280):
        det, rec, dic = PRESETS[preset]
        so = ort.SessionOptions(); so.intra_op_num_threads = 4
        self.det = ort.InferenceSession(os.path.join(D, det), so, providers=["CPUExecutionProvider"])
        self.rec = ort.InferenceSession(os.path.join(D, rec), so, providers=["CPUExecutionProvider"])
        # linhas vazias no arquivo não são caracteres; o espaço entra no fim,
        # como o PaddleOCR faz com use_space_char=True
        chars = [c for c in open(os.path.join(D, dic), encoding="utf-8-sig").read().splitlines() if c != ""]
        n_out = self.rec.get_outputs()[0].shape[-1]
        if isinstance(n_out, int) and len(chars) + 2 == n_out:
            chars.append(" ")
        self.chars = ["<blank>"] + chars
        self.det_limit = det_limit

    # ------------------------------------------------------------- detecção
    def _det_pre(self, img):
        h, w = img.shape[:2]
        r = min(1.0, self.det_limit / max(h, w))
        nh = max(32, int(round(h * r / 32)) * 32)
        nw = max(32, int(round(w * r / 32)) * 32)
        x = cv2.resize(img, (nw, nh)).astype(np.float32) / 255.0
        x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
        return x.transpose(2, 0, 1)[None].astype(np.float32), (h / nh, w / nw)

    def detect(self, img, thresh=0.3, box_thresh=0.6, unclip=1.6):
        x, (sy, sx) = self._det_pre(img)
        prob = self.det.run(None, {self.det.get_inputs()[0].name: x})[0][0, 0]
        mask = (prob > thresh).astype(np.uint8)
        cnts, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for c in cnts:
            if cv2.contourArea(c) < 6:
                continue
            rect = cv2.minAreaRect(c)
            (cx, cy), (rw, rh), ang = rect
            if min(rw, rh) < 3:
                continue
            # pontuação: média da probabilidade dentro do contorno
            m = np.zeros_like(mask); cv2.fillPoly(m, [c], 1)
            if prob[m == 1].mean() < box_thresh:
                continue
            # "unclip": expande pela distância área*ratio/perímetro (aprox. do pyclipper)
            area, peri = rw * rh, 2 * (rw + rh)
            d = area * unclip / max(peri, 1e-6)
            rect = ((cx, cy), (rw + 2 * d, rh + 2 * d), ang)
            pts = cv2.boxPoints(rect)
            pts[:, 0] *= sx; pts[:, 1] *= sy
            boxes.append(self._order(pts))
        return boxes

    @staticmethod
    def _order(pts):
        s = pts.sum(1); d = np.diff(pts, axis=1).ravel()
        return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32)

    # ------------------------------------------------------- reconhecimento
    @staticmethod
    def _crop(img, box):
        w = int(max(np.linalg.norm(box[0] - box[1]), np.linalg.norm(box[2] - box[3])))
        h = int(max(np.linalg.norm(box[0] - box[3]), np.linalg.norm(box[1] - box[2])))
        dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
        M = cv2.getPerspectiveTransform(box, dst)
        crop = cv2.warpPerspective(img, M, (w, h), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
        if h / max(w, 1) >= 1.5:
            crop = np.rot90(crop)
        return crop

    def recognize(self, crops, max_w=1600):
        out = []
        for crop in crops:
            h, w = crop.shape[:2]
            nw = min(max_w, max(16, int(math.ceil(48 * w / max(h, 1)))))
            x = cv2.resize(crop, (nw, 48)).astype(np.float32) / 255.0
            x = ((x - 0.5) / 0.5).transpose(2, 0, 1)[None].astype(np.float32)
            p = self.rec.run(None, {self.rec.get_inputs()[0].name: x})[0][0]
            idx = p.argmax(1); conf = p.max(1)
            txt, cs, last = [], [], -1
            for i, c in zip(idx, conf):
                if i != last and i != 0:
                    txt.append(self.chars[i] if i < len(self.chars) else ""); cs.append(c)
                last = i
            out.append(("".join(txt), float(np.mean(cs)) if cs else 0.0))
        return out

    # ------------------------------------------------------------ completo
    def __call__(self, img):
        t0 = time.time()
        boxes = self.detect(img)
        crops = [self._crop(img, b) for b in boxes]
        recs = self.recognize(crops)
        # Foto de lado: a linha do cupom fica inclinada e "VALOR TOTAL" (esquerda)
        # e "76,75" (direita) caem em alturas diferentes. Gira as coordenadas pelo
        # ângulo mediano das caixas de texto antes de agrupar em linhas.
        angs = [math.atan2(b[1][1] - b[0][1], b[1][0] - b[0][0]) for b in boxes
                if np.linalg.norm(b[1] - b[0]) > 2 * np.linalg.norm(b[3] - b[0])]
        a = -float(np.median(angs)) if angs else 0.0
        ca, sa = math.cos(a), math.sin(a)
        itens = []
        for b, (t, c) in zip(boxes, recs):
            if t.strip():
                rx = b[:, 0] * ca - b[:, 1] * sa
                ry = b[:, 0] * sa + b[:, 1] * ca
                itens.append((ry.mean(), rx.min(), ry.max() - ry.min(), t, c))
        texto = self._linhas(itens)
        return texto, time.time() - t0, len(boxes)

    @staticmethod
    def _linhas(itens):
        """Agrupa caixas em linhas pela altura, para 'TOTAL' e valor ficarem juntos."""
        itens.sort(key=lambda t: t[0])
        linhas, atual, y_ref, h_ref = [], [], None, None
        for y, x, h, t, c in itens:
            if y_ref is not None and abs(y - y_ref) > max(h_ref, h) * 0.55:
                linhas.append(atual); atual = []
            if not atual:
                y_ref, h_ref = y, h
            atual.append((x, t))
        if atual:
            linhas.append(atual)
        return "\n".join(" ".join(t for _, t in sorted(l)) for l in linhas)


_inst, _lock = None, threading.Lock()


def disponivel() -> bool:
    return all(os.path.exists(os.path.join(D, f)) for f in PRESETS["v6-small"])


def ler(pil_img) -> str:
    """Texto de uma imagem PIL. Carrega os modelos na primeira chamada."""
    global _inst
    with _lock:
        if _inst is None:
            _inst = PaddleOCR()
    img = cv2.cvtColor(np.asarray(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)
    return _inst(img)[0]


if __name__ == "__main__":
    import sys
    ocr = PaddleOCR()
    img = cv2.imread(sys.argv[1])
    texto, dt, n = ocr(img)
    print(f"[{n} caixas, {dt:.2f}s]\n{texto}")
