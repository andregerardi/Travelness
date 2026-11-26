"""Geração dos dois produtos: planilha Excel (layout de Prestação de Contas) e PDF com as notas."""
import io
import os
import re
import unicodedata
from datetime import date, datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from db import UPLOAD_DIR

CAT_LABEL = {"alimentacao": "Alimentação", "combustivel": "Combustível",
             "transporte": "Transporte", "estacionamento": "Estacionamento",
             "outros": "Outros"}
BRL = '"R$" #,##0.00'


def brl(v):
    s = f"{(v or 0):,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")


def to_date(iso):
    try:
        return datetime.strptime(iso, "%Y-%m-%d").date() if iso else None
    except ValueError:
        return None


def fmt_date(iso):
    d = to_date(iso)
    return d.strftime("%d/%m/%Y") if d else "—"


def slug(s):
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower() or "prestacao"


def periodo(trip, receipts):
    di, df = trip.get("data_inicio"), trip.get("data_fim")
    datas = sorted(r["data"] for r in receipts if r.get("data"))
    di = di or (datas[0] if datas else None)
    df = df or (datas[-1] if datas else None)
    if di and df:
        a, b = to_date(di), to_date(df)
        return f"{a:%d_%m} a {b:%d_%m}" if a and b else ""
    return ""


def base_filename(trip, receipts, ext):
    p = periodo(trip, receipts)
    return f"reembolso_{slug(trip['projeto'])}{(' - ' + p) if p else ''}.{ext}"


# ======================================================================= EXCEL
THIN = Side(style="thin", color="9AA4B2")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="1F3A5F")
SEC_FILL = PatternFill("solid", fgColor="DCE6F2")
TOT_FILL = PatternFill("solid", fgColor="F2F5F9")
WHITE_B = Font(bold=True, color="FFFFFF")
BOLD = Font(bold=True)


def _merge(ws, rng, value=None, **style):
    ws.merge_cells(rng)
    c = ws[rng.split(":")[0]]
    if value is not None:
        c.value = value
    for k, v in style.items():
        setattr(c, k, v)
    return c


def _box(ws, r1, r2, c1=1, c2=8):
    for row in ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2):
        for c in row:
            c.border = BOX


def build_excel(profile, trip, receipts) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "RELATÓRIO DESPESAS"
    for col, w in zip("ABCDEFGH", (12, 16, 14, 14, 16, 12, 12, 15)):
        ws.column_dimensions[col].width = w
    wrap = Alignment(wrap_text=True, vertical="top")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    # ---- cabeçalho
    _merge(ws, "A1:H1", "Prestação de Contas de Viagens", font=Font(bold=True, size=14, color="FFFFFF"),
           fill=HEAD_FILL, alignment=center)
    ws.row_dimensions[1].height = 26
    _merge(ws, "A2:H2", "Passageiro/Hóspede", font=BOLD, fill=SEC_FILL)
    _merge(ws, "A3:E3", f"Nome: {profile.get('nome', '')}")
    _merge(ws, "F3:G3", "Data da Solicitação", font=BOLD,
           alignment=Alignment(horizontal="right", vertical="center"))
    ws["H3"] = date.today()
    ws["H3"].number_format = "DD/MM/YYYY"
    ws["H3"].alignment = Alignment(horizontal="center")
    _merge(ws, "A4:C4", f"CPF: {profile.get('cpf', '')}")
    _merge(ws, "D4:E4", f"Centro de Custo: {trip.get('centro_custo') or ''}")
    _merge(ws, "F4:H4", f"Unidade/Projeto: {trip.get('projeto', '')}")
    p = periodo(trip, receipts).replace("_", "/")
    motivo = (trip.get("motivo") or "") + (f" De {p}." if p and p not in (trip.get("motivo") or "") else "")
    _merge(ws, "A5:H5", f"Motivo da Viagem: {motivo}", alignment=wrap)
    ws.row_dimensions[5].height = max(30, 15 * (len(motivo) // 95 + 1))
    _box(ws, 2, 5)
    row = 7

    by_cat = {k: [r for r in receipts if r["categoria"] == k] for k in CAT_LABEL}
    totals = {}

    # ---- (A) Transporte
    _merge(ws, f"A{row}:H{row}", "Táxi / Transporte por aplicativo (A)", font=BOLD, fill=SEC_FILL)
    row += 1
    for rng, t in ((f"A{row}:A{row}", "Data"), (f"B{row}:D{row}", "Origem"),
                   (f"E{row}:G{row}", "Destino"), (f"H{row}:H{row}", "Valor")):
        _merge(ws, rng, t, font=WHITE_B, fill=HEAD_FILL, alignment=center)
    row += 1
    first = row
    for r in by_cat["transporte"] or [None]:
        if r:
            ws[f"A{row}"] = to_date(r["data"])
            origem = r["origem"] or r["descricao"] or r["estabelecimento"]
            _merge(ws, f"B{row}:D{row}", origem, alignment=wrap)
            _merge(ws, f"E{row}:G{row}", r["destino"], alignment=wrap)
            ws[f"H{row}"] = r["valor"]
        else:
            _merge(ws, f"B{row}:D{row}")
            _merge(ws, f"E{row}:G{row}")
        row += 1
    _box(ws, first - 1, row - 1)
    ws[f"G{row}"] = "Total (A)"
    ws[f"H{row}"] = f"=SUM(H{first}:H{row - 1})"
    totals["A"] = f"H{row}"
    row += 2

    # ---- (B) Combustível
    _merge(ws, f"A{row}:H{row}", "Combustível (B)", font=BOLD, fill=SEC_FILL)
    row += 1
    for col, t in zip("ABCDEFGH", ("Data", "Posto", "Origem", "Destino", "Distância (km)", "Litros",
                                    "Valor do litro", "Valor do Reembolso")):
        ws[f"{col}{row}"] = t
        ws[f"{col}{row}"].font, ws[f"{col}{row}"].fill, ws[f"{col}{row}"].alignment = WHITE_B, HEAD_FILL, center
    ws.row_dimensions[row].height = 32
    row += 1
    first = row
    for r in by_cat["combustivel"] or [None]:
        if r:
            ws[f"A{row}"] = to_date(r["data"])
            ws[f"B{row}"] = r["estabelecimento"] or r["descricao"]
            ws[f"B{row}"].alignment = wrap
            ws[f"C{row}"] = r["origem"]
            ws[f"D{row}"] = r["destino"]
            ws[f"E{row}"] = r["km"]
            ws[f"F{row}"] = r["litros"]
            if r["litros"]:
                ws[f"G{row}"] = f"=IFERROR(H{row}/F{row},\"\")"
                ws[f"G{row}"].number_format = BRL
            ws[f"H{row}"] = r["valor"]
        row += 1
    _box(ws, first - 1, row - 1)
    ws[f"G{row}"] = "Total (B)"
    ws[f"H{row}"] = f"=SUM(H{first}:H{row - 1})"
    totals["B"] = f"H{row}"
    row += 2

    # ---- (C) Refeição / outros
    _merge(ws, f"A{row}:H{row}", "Extra Refeição/Hotel/Estacionamento/Outros (C)", font=BOLD, fill=SEC_FILL)
    row += 1
    _merge(ws, f"A{row}:A{row}", "Data", font=WHITE_B, fill=HEAD_FILL, alignment=center)
    _merge(ws, f"B{row}:G{row}", "Descrição", font=WHITE_B, fill=HEAD_FILL, alignment=center)
    _merge(ws, f"H{row}:H{row}", "Valor", font=WHITE_B, fill=HEAD_FILL, alignment=center)
    row += 1
    first = row
    extras = sorted(by_cat["alimentacao"] + by_cat["estacionamento"] + by_cat["outros"],
                    key=lambda r: (r["data"] or "9", r["id"]))
    for r in extras or [None]:
        if r:
            ws[f"A{row}"] = to_date(r["data"])
            desc = r["descricao"] or r["estabelecimento"]
            if r["estabelecimento"] and r["estabelecimento"] not in desc:
                desc = f"{desc} – {r['estabelecimento']}"
            _merge(ws, f"B{row}:G{row}", desc, alignment=wrap)
            ws[f"H{row}"] = r["valor"]
        else:
            _merge(ws, f"B{row}:G{row}")
        row += 1
    _box(ws, first - 1, row - 1)
    ws[f"G{row}"] = "Total (C)"
    ws[f"H{row}"] = f"=SUM(H{first}:H{row - 1})"
    totals["C"] = f"H{row}"
    row += 2

    # ---- dados bancários
    _merge(ws, f"A{row}:H{row}",
           f"Dados Bancários:   Banco: {profile.get('banco', '')}    Agência: {profile.get('agencia', '')}"
           f"    C/c: {profile.get('conta', '')}", font=BOLD, fill=TOT_FILL)
    _box(ws, row, row)
    row += 2

    # ---- fechamento
    _merge(ws, f"A{row}:H{row}", "Fechamento", font=BOLD, fill=SEC_FILL)
    row += 1
    heads = [("A", "B", "Valor Geral de Despesas (A+B+C)"), ("C", "D", "Total/Diária/Adiantamento recebido"),
             ("E", "F", "Valor a Pagar"), ("G", "H", "Valor a Restituir")]
    for a, b, t in heads:
        _merge(ws, f"{a}{row}:{b}{row}", t, font=WHITE_B, fill=HEAD_FILL, alignment=center)
    ws.row_dimensions[row].height = 30
    row += 1
    _merge(ws, f"A{row}:B{row}", f"={totals['A']}+{totals['B']}+{totals['C']}")
    _merge(ws, f"C{row}:D{row}", float(trip.get("adiantamento") or 0))
    _merge(ws, f"E{row}:F{row}", f"=MAX(A{row}-C{row},0)")
    _merge(ws, f"G{row}:H{row}", f"=MAX(C{row}-A{row},0)")
    for col in "ACEG":
        ws[f"{col}{row}"].font = Font(bold=True, size=12)
        ws[f"{col}{row}"].alignment = center
    _box(ws, row - 1, row)
    fech = row
    row += 2

    # ---- autorização
    _merge(ws, f"A{row}:H{row}", "Autorização do Documento", font=BOLD, fill=SEC_FILL)
    row += 1
    _merge(ws, f"A{row}:B{row}", "Data:")
    _merge(ws, f"C{row}:H{row}", "Aprovador (Coordenação do Projeto):")
    ws.row_dimensions[row].height = 34
    row += 1
    _merge(ws, f"A{row}:B{row}", "Data:")
    _merge(ws, f"C{row}:H{row}", "Carimbo / Assinatura (Administração Superior):")
    ws.row_dimensions[row].height = 34
    _box(ws, row - 2, row)
    row += 2
    _merge(ws, f"A{row}:H{row + 1}",
           "Nota: * Para todos os casos devem ser anexados os “Comprovantes de Despesas” — seguem no PDF "
           "gerado pelo Travelness.  * O valor a pagar/restituir é a diferença entre o Total Geral de "
           "Despesas e o Total Diária/Adiantamento recebido, na moeda da prestação de contas.",
           alignment=wrap, font=Font(italic=True, size=9, color="555555"))

    # formatos numéricos e datas
    for rw in range(7, fech + 1):
        for col in "ABCDEFGH":
            c = ws[f"{col}{rw}"]
            if getattr(c, "column_letter", None) is None:  # célula mesclada secundária
                continue
            if col == "H" or (rw == fech and col in "ACEG"):
                c.number_format = BRL
            elif col == "A" and isinstance(c.value, date):
                c.number_format = "DD/MM/YYYY"
                c.alignment = Alignment(horizontal="center", vertical="top")
    ws.page_setup.orientation = "portrait"
    ws.page_setup.fitToWidth = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToHeight = 0
    ws.print_options.horizontalCentered = True

    _data_sheet(wb, receipts)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def _data_sheet(wb, receipts):
    """Aba tabular (1 linha por cupom) — pronta para filtros, tabela dinâmica ou BI."""
    ws = wb.create_sheet("Cupons (dados)")
    cols = ["#", "Data", "Categoria", "Estabelecimento", "CNPJ", "Descrição", "Origem", "Destino",
            "Litros", "Km", "Valor", "Chave de acesso", "Revisar", "Confiança OCR", "Arquivo"]
    ws.append(cols)
    for i, r in enumerate(receipts, 1):
        ws.append([i, to_date(r["data"]), CAT_LABEL.get(r["categoria"], r["categoria"]), r["estabelecimento"],
                   r["cnpj"], r["descricao"], r["origem"], r["destino"], r["litros"], r["km"], r["valor"],
                   r["chave_acesso"], "Sim" if r["revisar"] else "Não", r["confianca"], r["image_path"]])
    n = len(receipts) + 1
    for c in ws[1]:
        c.font, c.fill = WHITE_B, HEAD_FILL
    for row in ws.iter_rows(min_row=2, max_row=n):
        row[1].number_format = "DD/MM/YYYY"
        row[10].number_format = BRL
        row[13].number_format = "0%"
    widths = [5, 12, 14, 30, 20, 28, 26, 26, 8, 8, 13, 48, 9, 13, 30]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    if receipts:
        t = Table(displayName="Cupons", ref=f"A1:{get_column_letter(len(cols))}{n}")
        t.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        ws.add_table(t)
    ws.append([])
    ws.append(["", "", "", "", "", "", "", "", "", "Total", f"=SUM(K2:K{max(n, 2)})"])
    ws.cell(ws.max_row, 11).number_format = BRL
    ws.cell(ws.max_row, 11).font = BOLD
    ws.freeze_panes = "A2"


# ======================================================================= PDF
NAVY = colors.HexColor("#1F3A5F")
INK = colors.HexColor("#1B2430")
MUTED = colors.HexColor("#6B7686")
LINE = colors.HexColor("#D7DEE7")


def _paginas_do_comprovante(r):
    """Caminhos de todas as páginas gravadas para um cupom, na ordem."""
    nome = r.get("image_path") or ""
    if not nome:
        return []
    base = nome[:-4] if nome.endswith(".jpg") else nome
    caminhos = []
    for n in range(1, (r.get("paginas") or 1) + 1):
        arq = nome if n == 1 else f"{base}-p{n}.jpg"
        caminho = os.path.join(UPLOAD_DIR, arq)
        if os.path.exists(caminho):
            caminhos.append(caminho)
    return caminhos


def build_pdf(profile, trip, receipts) -> bytes:
    buf = io.BytesIO()
    W, H = A4
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(f"Comprovantes – {trip['projeto']}")
    c.setAuthor(profile.get("nome", ""))
    M = 18 * mm

    # ---------- capa / resumo
    c.setFillColor(NAVY)
    c.rect(0, H - 38 * mm, W, 38 * mm, fill=1, stroke=0)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(M, H - 20 * mm, "Comprovantes de despesas")
    c.setFont("Helvetica", 11)
    p = periodo(trip, receipts).replace("_", "/")
    c.drawString(M, H - 28 * mm, f"{trip['projeto']}" + (f"  ·  {p}" if p else ""))

    y = H - 52 * mm
    c.setFillColor(INK)
    info = [("Nome", profile.get("nome", "")), ("CPF", profile.get("cpf", "")),
            ("E-mail", profile.get("email", "")),
            ("Banco / Ag. / Conta", f"{profile.get('banco', '')}  ·  {profile.get('agencia', '')}  ·  "
                                    f"{profile.get('conta', '')}")]
    for k, v in info:
        c.setFont("Helvetica", 9)
        c.setFillColor(MUTED)
        c.drawString(M, y, k.upper())
        c.setFont("Helvetica", 11)
        c.setFillColor(INK)
        c.drawString(M + 42 * mm, y, v or "—")
        y -= 7 * mm
    if trip.get("motivo"):
        c.setFont("Helvetica", 9)
        c.setFillColor(MUTED)
        c.drawString(M, y, "MOTIVO")
        c.setFont("Helvetica", 10)
        c.setFillColor(INK)
        for ln in _wrap(trip["motivo"], "Helvetica", 10, W - 2 * M - 42 * mm, c):
            c.drawString(M + 42 * mm, y, ln)
            y -= 5 * mm
        y -= 2 * mm

    # totais por categoria
    y -= 4 * mm
    gap = 3 * mm
    n_cat = len(CAT_LABEL)
    bw = (W - 2 * M - (n_cat - 1) * gap) / n_cat
    tot_all = sum(r["valor"] for r in receipts)
    for i, (k, lbl) in enumerate(CAT_LABEL.items()):
        x = M + i * (bw + gap)
        val = sum(r["valor"] for r in receipts if r["categoria"] == k)
        c.setStrokeColor(LINE)
        c.setFillColor(colors.HexColor("#F4F7FA"))
        c.roundRect(x, y - 16 * mm, bw, 16 * mm, 3 * mm, fill=1, stroke=1)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7)
        c.drawString(x + 2.5 * mm, y - 6 * mm, lbl.upper())
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(x + 2.5 * mm, y - 12.5 * mm, brl(val))
    y -= 24 * mm
    c.setFont("Helvetica-Bold", 13)
    c.drawString(M, y, f"Total geral: {brl(tot_all)}")
    adi = float(trip.get("adiantamento") or 0)
    if adi:
        c.setFont("Helvetica", 10)
        dif = tot_all - adi
        c.drawString(M + 80 * mm, y, f"Adiantamento: {brl(adi)}   ·   "
                     f"{'A pagar' if dif >= 0 else 'A restituir'}: {brl(abs(dif))}")
    y -= 10 * mm

    # índice
    cols = [(M, "#"), (M + 10 * mm, "Data"), (M + 32 * mm, "Categoria"), (M + 60 * mm, "Descrição"),
            (W - M - 28 * mm, "Valor")]

    def header(yy):
        c.setFont("Helvetica-Bold", 8.5)
        c.setFillColor(MUTED)
        for x, t in cols:
            c.drawString(x, yy, t.upper())
        c.setStrokeColor(LINE)
        c.line(M, yy - 2 * mm, W - M, yy - 2 * mm)
        return yy - 7 * mm

    y = header(y)
    for i, r in enumerate(receipts, 1):
        if y < 20 * mm:
            c.showPage()
            y = header(H - 20 * mm)
        c.setFont("Helvetica", 9.5)
        c.setFillColor(INK)
        desc = r["descricao"] or r["estabelecimento"]
        if r["categoria"] == "transporte" and (r["origem"] or r["destino"]):
            desc = f"{desc}: {r['origem']} → {r['destino']}"
        c.drawString(cols[0][0], y, str(i))
        c.drawString(cols[1][0], y, fmt_date(r["data"]))
        c.drawString(cols[2][0], y, CAT_LABEL.get(r["categoria"], ""))
        c.drawString(cols[3][0], y, _clip(desc, "Helvetica", 9.5, W - M - 32 * mm - cols[3][0], c))
        c.drawRightString(W - M, y, brl(r["valor"]))
        y -= 6 * mm
    c.showPage()

    # ---------- as páginas de cada comprovante
    # Um comprovante pode ter várias páginas: recibo de app traz trajeto,
    # pagamento e tributos em folhas separadas, e todas precisam ser anexadas.
    for i, r in enumerate(receipts, 1):
        caminhos = _paginas_do_comprovante(r)
        for k, path in enumerate(caminhos or [None], start=1):
            c.setFillColor(NAVY)
            c.rect(0, H - 22 * mm, W, 22 * mm, fill=1, stroke=0)
            c.setFillColor(colors.white)
            c.setFont("Helvetica-Bold", 12)
            marcador = f" · pág. {k}/{len(caminhos)}" if len(caminhos) > 1 else ""
            c.drawString(M, H - 10 * mm,
                         f"#{i} · {CAT_LABEL.get(r['categoria'], '')} · {fmt_date(r['data'])}{marcador}")
            c.drawRightString(W - M, H - 10 * mm, brl(r["valor"]))
            c.setFont("Helvetica", 9)
            sub = " · ".join(x for x in (r["estabelecimento"], r["cnpj"] and f"CNPJ {r['cnpj']}",
                                         r["descricao"]) if x)
            c.drawString(M, H - 17 * mm, _clip(sub, "Helvetica", 9, W - 2 * M, c))
            if path:
                img = ImageReader(path)
                iw, ih = img.getSize()
                maxw, maxh = W - 2 * M, H - 22 * mm - 2 * M
                s = min(maxw / iw, maxh / ih)
                dw, dh = iw * s, ih * s
                c.drawImage(img, (W - dw) / 2, M + (maxh - dh) / 2, dw, dh)
            else:
                c.setFillColor(MUTED)
                c.drawCentredString(W / 2, H / 2, "Imagem não disponível")
            c.setFont("Helvetica", 7.5)
            c.setFillColor(MUTED)
            c.drawRightString(W - M, 8 * mm, f"Travelness · comprovante {i}/{len(receipts)}")
            c.showPage()
    c.save()
    return buf.getvalue()


def _clip(s, font, size, width, c):
    s = s or ""
    while s and c.stringWidth(s, font, size) > width:
        s = s[:-2]
        if c.stringWidth(s + "…", font, size) <= width:
            return s + "…"
    return s


def _wrap(text, font, size, width, c):
    words, lines, cur = (text or "").split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if c.stringWidth(t, font, size) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines[:6]
