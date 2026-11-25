"""OCR e extração estruturada de cupons fiscais / NFC-e / NF-e / recibos de táxi e apps.

Pipeline:
  1. normalize_image()  -> corrige orientação (EXIF), reduz/aumenta, grava JPEG leve + miniatura
  2. run_ocr()          -> Tesseract (por) em imagem pré-processada (cinza + contraste)
  3. parse_receipt()    -> extrai valor, data, hora, CNPJ, chave de acesso, estabelecimento,
                           litros, origem/destino e classifica a categoria
Tudo é determinístico e roda localmente (sem enviar dados para terceiros).
"""
import hashlib
import io
import re
import unicodedata
from datetime import date, datetime

from PIL import Image, ImageFilter, ImageOps

try:
    import pytesseract
    pytesseract.get_tesseract_version()
    HAS_TESSERACT = True
except Exception:  # pragma: no cover - ambiente sem tesseract
    HAS_TESSERACT = False

MAX_SIDE = 2000      # lado máximo da imagem armazenada
THUMB_SIDE = 360


# ------------------------------------------------------------------ imagem
def normalize_image(raw: bytes):
    """Retorna (jpeg_bytes, thumb_bytes, sha256, pil_image)."""
    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=82, optimize=True)
    jpeg = out.getvalue()

    th = img.copy()
    th.thumbnail((THUMB_SIDE, THUMB_SIDE))
    tout = io.BytesIO()
    th.convert("RGB").save(tout, "JPEG", quality=70)
    return jpeg, tout.getvalue(), hashlib.sha256(jpeg).hexdigest(), img


def _prep_for_ocr(img: Image.Image) -> Image.Image:
    g = img.convert("L")
    w, h = g.size
    # cupons costumam ser estreitos; tesseract gosta de ~30px de altura de letra
    if max(w, h) < 1400:
        f = 1400 / max(w, h)
        g = g.resize((int(w * f), int(h * f)), Image.LANCZOS)
    g = ImageOps.autocontrast(g, cutoff=1)
    g = g.filter(ImageFilter.MedianFilter(3))
    return g


def run_ocr(img: Image.Image, psm: int = 4) -> str:
    if not HAS_TESSERACT:
        return ""
    g = _prep_for_ocr(img)
    return pytesseract.image_to_string(g, lang="por", config=f"--oem 1 --psm {psm}")


# ------------------------------------------------------------------ helpers
def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm(s: str) -> str:
    return strip_accents(s).upper()


MONEY_RE = re.compile(r"(?<![\d/])(\d{1,3}(?:[.\s]\d{3})+|\d+)\s?[,.]\s?(\d{2})(?![\d/])")


def parse_money(s: str):
    vals = []
    for m in MONEY_RE.finditer(s):
        inteiro = re.sub(r"[.\s]", "", m.group(1))
        try:
            vals.append(float(f"{int(inteiro)}.{m.group(2)}"))
        except ValueError:
            pass
    return vals


TOTAL_KEYS = [  # (regex, prioridade) - menor = melhor
    (r"VALOR\s*(A|À)?\s*PAGAR", 1),
    (r"TOTAL\s*A\s*PAGAR", 1),
    (r"VALOR\s*TOTAL(\s*R\$)?", 2),
    (r"TOTAL\s*(DA\s*)?(CORRIDA|VIAGEM)", 2),
    (r"TOTAL\s*GERAL", 2),
    (r"TOTAL\s*R\s*\$", 3),
    (r"VALOR\s*(DA\s*)?(CORRIDA|VIAGEM)", 3),
    (r"\bTOTAL\b", 4),
    (r"VALOR\s*PAGO", 5),
    (r"\bVALOR\b", 6),
]
TOTAL_EXCLUDE = re.compile(
    r"TRIBUTO|IMPOSTO|LEI\s*12|TROCO|DESCONTO|ACRESC|QTD|QUANT|ITENS|APROX|IBPT|SUBTOTAL|UNIT|ICMS|PIS|COFINS|"
    r"FEDERAL|ESTADUAL|MUNICIPAL|MOTORISTA|PARCEIRO|GANHOS|REPASSE|TAXA DE SERVICO|ISS\b")
# formas de pagamento: só viram candidato se nada melhor existir (evita pegar o valor entregue em dinheiro)
PAYMENT = re.compile(r"DINHEIRO|CARTAO|CREDITO|DEBITO|\bPIX\b|VOUCHER|TICKET|ALELO|SODEXO|VR\b|PAGAMENTO|RECEBIDO")


def find_total(lines):
    cands = []
    for i, ln in enumerate(lines):
        n = norm(ln)
        if TOTAL_EXCLUDE.search(n):
            continue
        for rx, prio in TOTAL_KEYS:
            if re.search(rx, n):
                vals = parse_money(ln)
                if not vals and i + 1 < len(lines):  # valor pode estar na linha seguinte
                    nxt = norm(lines[i + 1])
                    if not PAYMENT.search(nxt) and not TOTAL_EXCLUDE.search(nxt):
                        vals = parse_money(lines[i + 1])
                if vals:
                    cands.append((prio, i, vals[-1]))
                break
    if cands:
        cands.sort(key=lambda c: (c[0], c[1]))
        best = cands[0][2]
        if 0 < best < 100000:
            return best, True
    # fallback em dois níveis: maior valor fora de linhas de pagamento; só então as de pagamento
    plain, paid = [], []
    for ln in lines:
        n = norm(ln)
        if TOTAL_EXCLUDE.search(n):
            continue
        (paid if PAYMENT.search(n) else plain).extend(v for v in parse_money(ln) if 0 < v < 20000)
    pool = plain or paid
    return (max(pool), False) if pool else (None, False)


MONTHS = {"JAN": 1, "FEV": 2, "MAR": 3, "ABR": 4, "MAI": 5, "JUN": 6, "JUL": 7, "AGO": 8,
          "SET": 9, "OUT": 10, "NOV": 11, "DEZ": 12}
DATE_RE = re.compile(r"(?<!\d)(\d{1,2})\s?[/.\-]\s?(\d{1,2})\s?[/.\-]\s?(\d{4}|\d{2})(?!\d)")
DATE_TXT_RE = re.compile(r"(?<!\d)(\d{1,2})\s*(?:DE\s+)?(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[A-Z]*\.?"
                         r"\s*(?:DE\s+)?(\d{4})")
TIME_RE = re.compile(r"(?<!\d)([01]?\d|2[0-3])\s?[:h]\s?([0-5]\d)(?::[0-5]\d)?(?!\d)")


def _mkdate(d, m, y):
    y = int(y)
    if y < 100:
        y += 2000
    try:
        dt = date(y, int(m), int(d))
    except ValueError:
        return None
    if dt.year < 2015 or dt > date.today().replace(year=date.today().year + 1):
        return None
    return dt


def find_date_time(lines):
    found = []  # (prioridade, idx, date, time)
    for i, ln in enumerate(lines):
        n = norm(ln)
        prio = 0 if re.search(r"EMISS|DATA|EMITIDO", n) else 1
        for m in DATE_RE.finditer(n):
            dt = _mkdate(*m.groups())
            if dt:
                tm = TIME_RE.search(n[m.end():])
                found.append((prio, i, dt, tm.group(0) if tm else None))
        for m in DATE_TXT_RE.finditer(n):
            dt = _mkdate(m.group(1), MONTHS[m.group(2)], m.group(3))
            if dt:
                tm = TIME_RE.search(n[m.end():])
                found.append((prio, i, dt, tm.group(0) if tm else None))
    if not found:
        return None, None
    found.sort(key=lambda f: (f[0], f[1]))
    dt, tm = found[0][2], found[0][3]
    if tm:
        h, mi = re.findall(r"\d+", tm)[:2]
        tm = f"{int(h):02d}:{mi}"
    return dt.isoformat(), tm


CNPJ_RE = re.compile(r"(\d{2})\s?[.,]?\s?(\d{3})\s?[.,]?\s?(\d{3})\s?[/|l1I]?\s?(\d{4})\s?[-.]?\s?(\d{2})")


def cnpj_valid(c: str) -> bool:
    if len(c) != 14 or c == c[0] * 14:
        return False
    def dv(base, pesos):
        s = sum(int(a) * b for a, b in zip(base, pesos)) % 11
        return "0" if s < 2 else str(11 - s)
    d1 = dv(c[:12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    d2 = dv(c[:12] + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    return c[-2:] == d1 + d2


def fmt_cnpj(c: str) -> str:
    return f"{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}"


def find_cnpj(text):
    first = None
    for m in CNPJ_RE.finditer(text):
        c = "".join(m.groups())
        if cnpj_valid(c):
            return fmt_cnpj(c)
        first = first or c
    return fmt_cnpj(first) if first else ""


def find_chave(text):
    """Chave de acesso NF-e/NFC-e (44 dígitos, normalmente em grupos de 4)."""
    for m in re.finditer(r"(?:\d{4}[\s.]?){10}\d{4}", text):
        k = re.sub(r"\D", "", m.group(0))
        if len(k) == 44 and k[20:22] in ("55", "65", "59"):
            return k
    return ""


def find_establishment(lines):
    skip = re.compile(r"CNPJ|CPF|DOCUMENTO|AUXILIAR|CUPOM|NOTA FISCAL|NFC|EXTRATO|SAT\b|CONSUMIDOR|"
                      r"ENDERE|RUA |AV\.|AVENIDA|^IE\b|INSCR|TEL|FONE|RECIBO|COMPROVANTE|ELETRONIC")
    for ln in lines[:8]:
        n = norm(ln).strip()
        letters = sum(c.isalpha() for c in n)
        if letters >= 4 and letters / max(len(n), 1) > 0.55 and not skip.search(n):
            return re.sub(r"\s{2,}", " ", ln.strip(" -*|.:"))[:80]
    return ""


LITROS_RE = re.compile(r"(\d{1,3}[,.]\d{2,3})\s*(?:L\b|LT\b|LTS\b|LITROS?)")


def find_litros(text):
    m = LITROS_RE.search(norm(text))
    return float(m.group(1).replace(",", ".")) if m else None


# ------------------------------------------- recibos de app de corrida
# Uber, 99 e similares entregam PDF com camada de texto, então aqui não há erro
# de leitura — só um formato diferente do cupom fiscal: o endereço vem em blocos
# "HH:MM" seguidos das linhas do logradouro, e o documento repete a palavra
# "Total" nas seções de repasse ao motorista e de receita do app.
RIDE_RE = re.compile(
    r"\bUBER\b|OBRIGADO POR VIAJAR|INFORMACOES DA VIAGEM|MOTORISTA PARCEIRO|GANHOS D[AO]|"
    r"\b99\s?(APP|POP|TAXI|TECNOLOGIA)|CABIFY|INDRIVE|DETALHES DA (CORRIDA|VIAGEM)")


def is_ride_receipt(text):
    return bool(RIDE_RE.search(norm(text)))


def clean_address(s):
    """Encurta endereço de app: tira CEP, país e pontuação solta."""
    s = re.sub(r"\s+", " ", str(s or ""))
    s = re.sub(r",?\s*\d{5}-?\d{3}\b", "", s)
    s = re.sub(r",?\s*(Brasil|Brazil)\b\.?", "", s, flags=re.I)
    return re.sub(r"[\s,;·-]+$", "", s).strip()[:120]


SECAO_RE = re.compile(
    r"^(INFORMACOES|PAGAMENTO|TOTAL|GANHOS|TAXA|VOCE VIAJOU|QUER CONFERIR|PRECO|SUBTOTAL|TODAS AS SUAS)")
INICIO_VIAGEM_RE = re.compile(
    r"INFORMACOES DA VIAGEM|DETALHES DA (VIAGEM|CORRIDA)|DADOS DA VIAGEM|TRAJETO|ITINERARIO|PERCURSO")
RUA_RE = re.compile(
    r"^(AV|AVENIDA|RUA|R|AL|ALAMEDA|PRACA|PC|TRAVESSA|TV|ROD|RODOVIA|ESTRADA|LARGO|VIA|MARGINAL|"
    r"SHOPPING|AEROPORTO|TERMINAL)\b")
HORA_SO_RE = re.compile(r"^\d{1,2}:\d{2}(:\d{2})?$")


def find_ride_route(lines):
    """Origem e destino a partir dos blocos "HH:MM" + endereço."""
    # O cabeçalho do recibo também traz uma hora solta; começar na seção da
    # viagem evita capturar a saudação ("Obrigado por viajar, Fulano") como rua.
    for i, ln in enumerate(lines):
        if INICIO_VIAGEM_RE.search(norm(ln)):
            lines = lines[i + 1:]
            break

    blocos, atual = [], None
    for ln in lines:
        t = ln.strip()
        if HORA_SO_RE.match(t):
            atual = []
            blocos.append(atual)
            continue
        if atual is None:
            continue
        if not t or SECAO_RE.match(norm(t)):
            atual = None
            continue
        atual.append(t)
        # endereço de app ocupa no máximo três linhas; mais que isso é outra coisa
        if len(atual) >= 3:
            atual = None

    # endereço tem número; sem isso é texto de cortesia que mora perto de uma hora
    enderecos = [e for e in (clean_address(" ".join(b)) for b in blocos)
                 if len(e) > 8 and re.search(r"\d", e) and ("," in e or RUA_RE.match(norm(e)))]
    if not enderecos:
        return "", ""
    if len(enderecos) == 1:
        return enderecos[0], ""
    return enderecos[0], enderecos[-1]


KM_RE = re.compile(r"(\d{1,4}[.,]\d{1,2})\s*(QUIL[OÔ]METROS?|\bKMS?\b)")


def find_km(text):
    m = KM_RE.search(norm(text))
    return float(m.group(1).replace(",", ".")) if m else None


def find_route(lines):
    origem = destino = ""
    for i, ln in enumerate(lines):
        n = norm(ln)
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        m = re.match(r"\s*(ORIGEM|PARTIDA|EMBARQUE|DE)\s*[:\-]\s*(.*)", n)
        if m and not origem:
            origem = (ln.split(":", 1)[-1].strip() if ":" in ln else "") or nxt
        m = re.match(r"\s*(DESTINO|CHEGADA|DESEMBARQUE|PARA)\s*[:\-]\s*(.*)", n)
        if m and not destino:
            destino = (ln.split(":", 1)[-1].strip() if ":" in ln else "") or nxt
    return origem[:120], destino[:120]


# ------------------------------------------------------------------ classificação
KEYWORDS = {
    "combustivel": {
        "GASOLINA": 5, "ETANOL": 5, "DIESEL": 5, "GNV": 4, "COMBUSTIVE": 5, "ALCOOL HIDRAT": 4,
        "POSTO": 3, "AUTO POSTO": 4, "BICO": 3, "BOMBA": 2, "LITRO": 3, "ABASTEC": 4,
        "SHELL": 3, "IPIRANGA": 3, "PETROBRAS": 3, "BR DISTRIB": 3, "ADITIVADA": 4, "S10": 2,
        "ARLA": 3,
    },
    "transporte": {
        "UBER": 6, "TAXI": 6, "TAXIMETRO": 6, "CORRIDA": 5, "CABIFY": 6, "INDRIVE": 6, "99POP": 6,
        "99 TECNOLOGIA": 6, "99TAXI": 6, "MOTORISTA": 4, "PASSAGEIRO": 4, "BANDEIRA": 3, "PLACA": 2,
        "EMBARQUE": 2, "DESEMBARQUE": 3, "ORIGEM": 2, "DESTINO": 2, "KM RODADO": 3, "VIAGEM": 1,
        "TRANSPORTE": 3, "COOPERATIVA": 2, "PEDAGIO": 3,
    },
    "estacionamento": {
        "ESTACIONAMENTO": 7, "ESTAPAR": 7, "MULTIPARK": 6, "PARK ": 4, "PARKING": 6,
        "AUTOPARK": 6, "ZONA AZUL": 6, "ROTATIVO ": 5, "VALET": 6, "MANOBRISTA": 5,
        "GARAGEM": 5, "VAGA ": 3, "PATIO ": 3, "ENTRADA ": 1, "SAIDA ": 1,
        "PERMANENCIA": 5, "DIARIA": 2, "1A HORA": 4, "HORA ADICIONAL": 6,
        "HORAS ADICIONAIS": 6, "TEMPO DE PERMANENCIA": 7, "TOLERANCIA": 4,
        "CARTAO DE ESTACIONAMENTO": 7, "SHOPPING": 1,
    },
    "alimentacao": {
        "RESTAURANTE": 6, "LANCHONETE": 6, "PADARIA": 5, "CAFE": 3, "CAFETERIA": 5, "REFEICAO": 6,
        "ALIMENT": 4, "PIZZA": 4, "BURGER": 4, "HAMBURG": 4, "LANCHE": 4, "SANDUICHE": 4, "SUCO": 3,
        "REFRIGERANTE": 3, "COCA": 2, "AGUA MINERAL": 3, "PRATO": 3, "BUFFET": 4, "SELF SERVICE": 5,
        "A LA CARTE": 4, "EXECUTIVO": 2, "SOBREMESA": 4, "CERVEJA": 2, "PAO": 2, "SALGADO": 3,
        "IFOOD": 5, "MERCADO": 2, "SUPERMERCADO": 3, "BAR ": 2, "CHOPP": 3, "ESPRESSO": 4,
        "CAPPUCCINO": 4, "TAPIOCA": 4, "CHURRASC": 4, "PEIXE": 3, "FRANGO": 3, "CARNE": 2,
        "GORJETA": 3, "TAXA DE SERVICO": 4, "COUVERT": 4, "KG": 1,
    },
}


def classify(text):
    n = norm(text)
    scores = {cat: sum(w * min(n.count(k), 3) for k, w in kws.items()) for cat, kws in KEYWORDS.items()}
    # "99" sozinho é ambíguo; só pontua se aparecer como app
    if re.search(r"\b99\s?(APP|POP|TAXI|TECNOLOGIA)", n):
        scores["transporte"] += 6
    # litros + preço/litro é assinatura forte de combustível
    if LITROS_RE.search(n) and re.search(r"R\$\s*/\s*L|PRECO\s*/?\s*L|VL\.?\s*UNIT", n):
        scores["combustivel"] += 6
    best = max(scores, key=scores.get)
    top = scores[best]
    if top < 3:
        return "outros", 0.0, scores
    second = sorted(scores.values())[-2]
    conf = min(1.0, (top - second) / max(top, 1) + (0.2 if top >= 8 else 0))
    return best, round(conf, 2), scores


def meal_from_time(hhmm):
    if not hhmm:
        return "Refeição"
    h, m = map(int, hhmm.split(":"))
    t = h * 60 + m
    if t < 10 * 60 + 30:
        return "Café da manhã"
    if t < 15 * 60 + 30:
        return "Almoço"
    if t < 18 * 60:
        return "Lanche"
    return "Jantar"


# ------------------------------------------------------------------ orquestração
def parse_receipt(text: str) -> dict:
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    valor, by_key = find_total(lines)
    data, hora = find_date_time(lines)
    chave = find_chave(text)
    cnpj = find_cnpj(text)
    if not cnpj and chave:
        cnpj = fmt_cnpj(chave[6:20])
    if not data and chave:  # AAMM da chave -> dia 1 (usuário revisa)
        try:
            data = date(2000 + int(chave[2:4]), int(chave[4:6]), 1).isoformat()
        except ValueError:
            pass
    ride = is_ride_receipt(text)
    # Num recibo de app o topo traz saudação e nome do passageiro, não o
    # estabelecimento — melhor deixar vazio do que gravar "Obrigado por viajar".
    estab = "" if ride else find_establishment(lines)
    categoria, conf_cat, scores = classify(text)
    if ride:
        categoria, conf_cat = "transporte", max(conf_cat, 1.0)

    out = {
        "categoria": categoria, "valor": valor or 0, "data": data, "hora": hora,
        "estabelecimento": estab, "cnpj": cnpj, "chave_acesso": chave,
        "descricao": "", "origem": "", "destino": "", "litros": None, "km": None,
    }
    if categoria == "combustivel":
        out["litros"] = find_litros(text)
        out["descricao"] = "Abastecimento" + (f" – {estab}" if estab else "")
    elif categoria == "transporte":
        out["origem"], out["destino"] = (find_ride_route(lines) if ride else find_route(lines))
        if ride:
            out["km"] = find_km(text)
        nt = norm(text)
        app = ("Uber" if "UBER" in nt else
               "99" if re.search(r"\b99\s?(APP|POP|TAXI|TECNOLOGIA)", nt) else
               "Cabify" if "CABIFY" in nt else
               "inDrive" if "INDRIVE" in nt else "")
        out["descricao"] = f"Corrida {app}" if app else "Táxi"
    elif categoria == "alimentacao":
        out["descricao"] = meal_from_time(hora)
    elif categoria == "estacionamento":
        out["descricao"] = "Estacionamento" + (f" – {estab}" if estab else "")
    else:
        out["descricao"] = estab

    # num recibo de app o "contexto" é o trajeto, já que não há estabelecimento
    tem_contexto = bool(out["origem"] or out["destino"]) if ride else bool(estab or cnpj)
    confianca = (0.40 if valor else 0) * (1 if by_key else 0.6) + (0.25 if data else 0) \
        + 0.20 * conf_cat + (0.15 if tem_contexto else 0)
    out["confianca"] = round(confianca, 2)
    out["revisar"] = int(confianca < 0.75 or not valor or not data or categoria == "outros")
    out["_scores"] = scores
    return out


def extract(raw: bytes) -> dict:
    """Ponto de entrada: bytes da imagem -> dicionário com imagem normalizada + campos."""
    jpeg, thumb, sha, img = normalize_image(raw)
    text = run_ocr(img, psm=4)
    fields = parse_receipt(text)
    if not fields["valor"] and HAS_TESSERACT:  # segunda tentativa com outro layout
        text2 = run_ocr(img, psm=6)
        f2 = parse_receipt(text2)
        if f2["valor"]:
            text, fields = text2, f2
    return {"jpeg": jpeg, "thumb": thumb, "hash": sha, "text": text, "fields": fields}


if __name__ == "__main__":  # uso: python ocr.py cupom.jpg
    import json
    import sys
    r = extract(open(sys.argv[1], "rb").read())
    print(r["text"])
    print(json.dumps(r["fields"], ensure_ascii=False, indent=2, default=str))
