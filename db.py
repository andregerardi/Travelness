"""Camada de persistência (SQLite).

Modelo:
  profile   -> dados do usuário (1 linha)
  trips     -> prestações de contas (uma por viagem/projeto)
  receipts  -> cupons/NFs vinculados a uma viagem
"""
import os
import sqlite3
from contextlib import contextmanager

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("TRAVELNESS_DATA", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "travelness.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    nome        TEXT NOT NULL DEFAULT '',
    cpf         TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    banco       TEXT NOT NULL DEFAULT '',
    agencia     TEXT NOT NULL DEFAULT '',
    conta       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS trips (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    projeto             TEXT NOT NULL,
    centro_custo        TEXT NOT NULL DEFAULT '',
    motivo              TEXT NOT NULL DEFAULT '',
    data_inicio         TEXT,
    data_fim            TEXT,
    email_destinatario  TEXT NOT NULL DEFAULT '',
    adiantamento        REAL NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    categoria       TEXT NOT NULL DEFAULT 'outros',  -- alimentacao|combustivel|transporte|outros
    data            TEXT,                            -- ISO yyyy-mm-dd
    valor           REAL NOT NULL DEFAULT 0,
    estabelecimento TEXT NOT NULL DEFAULT '',
    cnpj            TEXT NOT NULL DEFAULT '',
    chave_acesso    TEXT NOT NULL DEFAULT '',
    descricao       TEXT NOT NULL DEFAULT '',
    origem          TEXT NOT NULL DEFAULT '',
    destino         TEXT NOT NULL DEFAULT '',
    litros          REAL,
    km              REAL,
    image_path      TEXT NOT NULL DEFAULT '',
    image_hash      TEXT NOT NULL DEFAULT '',
    ocr_text        TEXT NOT NULL DEFAULT '',
    confianca       REAL NOT NULL DEFAULT 0,          -- 0..1
    fonte           TEXT NOT NULL DEFAULT '',         -- texto do PDF|servidor|aparelho
    revisar         INTEGER NOT NULL DEFAULT 1,       -- 1 = precisa de revisão
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS ix_receipts_trip ON receipts(trip_id, data);
CREATE INDEX IF NOT EXISTS ix_receipts_hash ON receipts(image_hash);
"""

PROFILE_FIELDS = ("nome", "cpf", "email", "banco", "agencia", "conta")
TRIP_FIELDS = ("projeto", "centro_custo", "motivo", "data_inicio", "data_fim",
               "email_destinatario", "adiantamento")
RECEIPT_FIELDS = ("categoria", "data", "valor", "estabelecimento", "cnpj", "chave_acesso",
                  "descricao", "origem", "destino", "litros", "km", "revisar", "fonte")
CATEGORIAS = ("alimentacao", "combustivel", "transporte", "estacionamento", "outros")


def init_db():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    with connect() as con:
        con.executescript(SCHEMA)
        con.execute("INSERT OR IGNORE INTO profile (id) VALUES (1)")
        # bancos criados antes da coluna "fonte" continuam abrindo
        cols = {r["name"] for r in con.execute("PRAGMA table_info(receipts)")}
        if "fonte" not in cols:
            con.execute("ALTER TABLE receipts ADD COLUMN fonte TEXT NOT NULL DEFAULT ''")


@contextmanager
def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def _row(r):
    return dict(r) if r else None


# ---------- profile ----------
def get_profile():
    with connect() as con:
        return _row(con.execute("SELECT * FROM profile WHERE id = 1").fetchone())


def save_profile(data):
    vals = {k: str(data.get(k, "") or "").strip() for k in PROFILE_FIELDS}
    with connect() as con:
        con.execute(
            f"UPDATE profile SET {', '.join(f'{k} = :{k}' for k in vals)}, "
            "updated_at = datetime('now','localtime') WHERE id = 1", vals)
    return get_profile()


# ---------- trips ----------
TRIP_SUMMARY_SQL = """
SELECT t.*,
       COUNT(r.id)                                   AS qtd,
       COALESCE(SUM(r.valor), 0)                     AS total,
       COALESCE(SUM(r.revisar), 0)                   AS pendentes,
       COALESCE(SUM(CASE WHEN r.categoria='alimentacao' THEN r.valor END), 0) AS total_alimentacao,
       COALESCE(SUM(CASE WHEN r.categoria='combustivel' THEN r.valor END), 0) AS total_combustivel,
       COALESCE(SUM(CASE WHEN r.categoria='transporte'  THEN r.valor END), 0) AS total_transporte,
       COALESCE(SUM(CASE WHEN r.categoria='estacionamento' THEN r.valor END), 0) AS total_estacionamento,
       COALESCE(SUM(CASE WHEN r.categoria='outros'      THEN r.valor END), 0) AS total_outros
FROM trips t LEFT JOIN receipts r ON r.trip_id = t.id
"""


def list_trips():
    with connect() as con:
        rows = con.execute(TRIP_SUMMARY_SQL + " GROUP BY t.id ORDER BY t.created_at DESC, t.id DESC")
        return [dict(r) for r in rows]


def get_trip(trip_id):
    with connect() as con:
        return _row(con.execute(TRIP_SUMMARY_SQL + " WHERE t.id = ? GROUP BY t.id", (trip_id,)).fetchone())


def _clean_trip(data):
    vals = {}
    for k in TRIP_FIELDS:
        if k not in data:
            continue
        v = data[k]
        if k == "adiantamento":
            v = float(v or 0)
        elif v is None:
            v = None if k.startswith("data_") else ""
        else:
            v = str(v).strip() or (None if k.startswith("data_") else "")
        vals[k] = v
    return vals


def _check_period(inicio, fim):
    """O período precisa fazer sentido venha de onde vier — formulário ou API."""
    if inicio and fim and fim < inicio:
        raise ValueError("A data de fim não pode ser anterior à de início.")


def create_trip(data):
    vals = _clean_trip(data)
    if not vals.get("projeto"):
        raise ValueError("Informe o nome do projeto.")
    _check_period(vals.get("data_inicio"), vals.get("data_fim"))
    cols = ", ".join(vals)
    with connect() as con:
        cur = con.execute(f"INSERT INTO trips ({cols}) VALUES ({', '.join(':' + k for k in vals)})", vals)
        tid = cur.lastrowid
    return get_trip(tid)


def update_trip(trip_id, data):
    vals = _clean_trip(data)
    if "projeto" in vals and not vals["projeto"]:
        raise ValueError("Informe o nome do projeto.")
    atual = get_trip(trip_id) or {}
    _check_period(vals.get("data_inicio", atual.get("data_inicio")),
                  vals.get("data_fim", atual.get("data_fim")))
    if vals:
        vals["id"] = trip_id
        sets = ", ".join(f"{k} = :{k}" for k in vals if k != "id")
        with connect() as con:
            con.execute(f"UPDATE trips SET {sets}, updated_at = datetime('now','localtime') WHERE id = :id", vals)
    return get_trip(trip_id)


def delete_trip(trip_id):
    paths = [r["image_path"] for r in list_receipts(trip_id)]
    with connect() as con:
        con.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
    for p in paths:
        _remove_image(p)


# ---------- receipts ----------
def list_receipts(trip_id):
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM receipts WHERE trip_id = ? ORDER BY COALESCE(data, '9999'), id", (trip_id,))
        return [dict(r) for r in rows]


def get_receipt(rid):
    with connect() as con:
        return _row(con.execute("SELECT * FROM receipts WHERE id = ?", (rid,)).fetchone())


def find_duplicate(trip_id, image_hash, chave, cnpj, data, valor):
    """Duplicado = mesma imagem, mesma chave de acesso, ou mesmo CNPJ+data+valor."""
    with connect() as con:
        r = con.execute(
            """SELECT id FROM receipts WHERE trip_id = :t AND (
                   image_hash = :h
                   OR (:k <> '' AND chave_acesso = :k)
                   OR (:c <> '' AND cnpj = :c AND data = :d AND ABS(valor - :v) < 0.005))
               LIMIT 1""",
            {"t": trip_id, "h": image_hash, "k": chave or "", "c": cnpj or "", "d": data, "v": valor or 0},
        ).fetchone()
        return r["id"] if r else None


def _clean_receipt(data):
    vals = {}
    for k in RECEIPT_FIELDS:
        if k not in data:
            continue
        v = data[k]
        if k in ("valor",):
            v = round(float(v or 0), 2)
        elif k in ("litros", "km"):
            v = None if v in (None, "") else float(v)
        elif k == "revisar":
            v = 1 if v else 0
        elif k == "categoria":
            v = v if v in CATEGORIAS else "outros"
        elif k == "data":
            v = (str(v).strip() or None) if v else None
        else:
            v = str(v or "").strip()
        vals[k] = v
    return vals


def create_receipt(trip_id, data, extra):
    vals = _clean_receipt(data)
    vals.update(extra)
    vals["trip_id"] = trip_id
    cols = ", ".join(vals)
    with connect() as con:
        cur = con.execute(f"INSERT INTO receipts ({cols}) VALUES ({', '.join(':' + k for k in vals)})", vals)
        rid = cur.lastrowid
    return get_receipt(rid)


def update_receipt(rid, data):
    vals = _clean_receipt(data)
    if vals:
        vals["id"] = rid
        sets = ", ".join(f"{k} = :{k}" for k in vals if k != "id")
        with connect() as con:
            con.execute(f"UPDATE receipts SET {sets}, updated_at = datetime('now','localtime') WHERE id = :id",
                        vals)
    return get_receipt(rid)


def delete_receipt(rid):
    r = get_receipt(rid)
    with connect() as con:
        con.execute("DELETE FROM receipts WHERE id = ?", (rid,))
    if r:
        _remove_image(r["image_path"])


def _remove_image(name):
    if not name:
        return
    for p in (os.path.join(UPLOAD_DIR, name), os.path.join(UPLOAD_DIR, "thumb_" + name)):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
