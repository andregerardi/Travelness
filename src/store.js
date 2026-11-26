/* Persistência local (IndexedDB). Espelha o schema do db.py da versão servidor.
   Stores: meta (perfil + configurações), trips, receipts, images (Blob). */

const DB_NAME = "travelness";
const DB_VERSION = 1;
let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("trips")) {
        db.createObjectStore("trips", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("receipts")) {
        const s = db.createObjectStore("receipts", { keyPath: "id", autoIncrement: true });
        s.createIndex("trip_id", "trip_id");
      }
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
      void e;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(new Error("Não consegui abrir o armazenamento do aparelho."));
  });
}

function tx(stores, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error || new Error("Falha ao gravar no aparelho."));
    Promise.resolve(fn(t)).then((v) => { out = v; }).catch(reject);
  }));
}

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* ---------------------------------------------------------------- meta */
export const getMeta = (k, dflt) =>
  tx(["meta"], "readonly", (t) => wrap(t.objectStore("meta").get(k))).then((v) => v ?? dflt);
export const setMeta = (k, v) => tx(["meta"], "readwrite", (t) => wrap(t.objectStore("meta").put(v, k)));

const EMPTY_PROFILE = { nome: "", cpf: "", email: "", banco: "", agencia: "", conta: "" };
export const getProfile = () => getMeta("profile", {}).then((p) => ({ ...EMPTY_PROFILE, ...p }));
export const saveProfile = (p) => {
  const clean = {};
  for (const k of Object.keys(EMPTY_PROFILE)) clean[k] = String(p[k] ?? "").trim();
  return setMeta("profile", clean).then(() => clean);
};

const EMPTY_SETTINGS = { serverUrl: "", useServerOcr: true };
export const getSettings = () => getMeta("settings", {}).then((s) => ({ ...EMPTY_SETTINGS, ...s }));
export const saveSettings = (s) =>
  getSettings().then((cur) => {
    const next = { ...cur, ...s, serverUrl: String(s.serverUrl ?? cur.serverUrl).trim().replace(/\/+$/, "") };
    return setMeta("settings", next).then(() => next);
  });

/* ---------------------------------------------------------------- trips */
const TRIP_DEFAULTS = {
  projeto: "", centro_custo: "", motivo: "", data_inicio: "", data_fim: "",
  email_destinatario: "", adiantamento: 0,
};

function summarize(trip, receipts) {
  const t = {
    ...trip, qtd: receipts.length, total: 0, pendentes: 0,
    total_alimentacao: 0, total_combustivel: 0, total_transporte: 0,
    total_estacionamento: 0, total_outros: 0,
  };
  for (const r of receipts) {
    t.total += r.valor;
    t.pendentes += r.revisar ? 1 : 0;
    t[`total_${r.categoria}`] += r.valor;
  }
  t.total = round2(t.total);
  return t;
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function listTrips() {
  const [trips, receipts] = await tx(["trips", "receipts"], "readonly", async (t) => [
    await wrap(t.objectStore("trips").getAll()),
    await wrap(t.objectStore("receipts").getAll()),
  ]);
  const byTrip = new Map();
  for (const r of receipts) {
    if (!byTrip.has(r.trip_id)) byTrip.set(r.trip_id, []);
    byTrip.get(r.trip_id).push(r);
  }
  return trips
    .map((t) => summarize(t, byTrip.get(t.id) || []))
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "") || b.id - a.id);
}

function cleanTrip(data) {
  const v = {};
  for (const k of Object.keys(TRIP_DEFAULTS)) {
    if (!(k in data)) continue;
    v[k] = k === "adiantamento" ? round2(data[k]) : String(data[k] ?? "").trim();
  }
  return v;
}

/** O período precisa fazer sentido venha de onde vier — formulário, API ou import. */
function checkPeriod(trip) {
  if (trip.data_inicio && trip.data_fim && trip.data_fim < trip.data_inicio) {
    throw new Error("A data de fim não pode ser anterior à de início.");
  }
}

export async function createTrip(data) {
  const v = cleanTrip(data);
  if (!v.projeto) throw new Error("Informe o nome do projeto.");
  const now = new Date().toISOString();
  const rec = { ...TRIP_DEFAULTS, ...v, created_at: now, updated_at: now };
  checkPeriod(rec);
  const id = await tx(["trips"], "readwrite", (t) => wrap(t.objectStore("trips").add(rec)));
  return summarize({ ...rec, id }, []);
}

export async function getTrip(id) {
  const [trip, receipts] = await tx(["trips", "receipts"], "readonly", async (t) => [
    await wrap(t.objectStore("trips").get(id)),
    await wrap(t.objectStore("receipts").index("trip_id").getAll(id)),
  ]);
  if (!trip) return null;
  receipts.sort((a, b) => (a.data || "9").localeCompare(b.data || "9") || a.id - b.id);
  return { trip: summarize(trip, receipts), receipts };
}

export async function updateTrip(id, data) {
  const v = cleanTrip(data);
  if ("projeto" in v && !v.projeto) throw new Error("Informe o nome do projeto.");
  await tx(["trips"], "readwrite", async (t) => {
    const s = t.objectStore("trips");
    const cur = await wrap(s.get(id));
    if (!cur) return;
    const next = { ...cur, ...v, updated_at: new Date().toISOString() };
    checkPeriod(next);   // valida o resultado, não só os campos enviados
    await wrap(s.put(next));
  });
  return (await getTrip(id)).trip;
}

export async function deleteTrip(id) {
  await tx(["trips", "receipts", "images"], "readwrite", async (t) => {
    const rs = await wrap(t.objectStore("receipts").index("trip_id").getAll(id));
    for (const r of rs) {
      t.objectStore("receipts").delete(r.id);
      apagaImagens(t.objectStore("images"), r);
    }
    t.objectStore("trips").delete(id);
  });
}

/* ---------------------------------------------------------------- receipts */
const RECEIPT_DEFAULTS = {
  categoria: "outros", data: "", valor: 0, estabelecimento: "", cnpj: "", chave_acesso: "",
  descricao: "", origem: "", destino: "", litros: null, km: null,
  image_key: "", image_hash: "", ocr_text: "", confianca: 0, revisar: 1,
  paginas: 1,  // PDF de recibo costuma ter mais de uma; guardamos todas
  fonte: "",   // "texto do PDF" | "servidor" | "aparelho" | "" (manual)
};
const CATEGORIAS = ["alimentacao", "combustivel", "transporte", "estacionamento", "outros"];

function cleanReceipt(data) {
  const v = {};
  for (const k of Object.keys(RECEIPT_DEFAULTS)) {
    if (!(k in data)) continue;
    const raw = data[k];
    if (k === "valor" || k === "confianca") v[k] = round2(raw);
    else if (k === "litros" || k === "km") v[k] = raw === "" || raw == null ? null : Number(raw);
    else if (k === "revisar") v[k] = raw ? 1 : 0;
    else if (k === "categoria") v[k] = CATEGORIAS.includes(raw) ? raw : "outros";
    else v[k] = String(raw ?? "").trim();
  }
  return v;
}

/** Duplicado: mesma imagem, mesma chave de acesso, ou mesmo CNPJ + data + valor. */
export async function findDuplicate(tripId, hash, chave, cnpj, data, valor) {
  const rs = await tx(["receipts"], "readonly", (t) =>
    wrap(t.objectStore("receipts").index("trip_id").getAll(tripId)));
  const hit = rs.find((r) =>
    (hash && r.image_hash === hash) ||
    (chave && r.chave_acesso === chave) ||
    (cnpj && r.cnpj === cnpj && r.data === data && Math.abs(r.valor - (valor || 0)) < 0.005));
  return hit ? hit.id : null;
}

/** Chave da página n. A página 1 mantém a chave original, para não quebrar
    cupons gravados antes de existir suporte a várias páginas. */
export const pageKey = (key, n) => (n <= 1 ? key : `${key}-p${n}`);

export async function createReceipt(tripId, data, blobs) {
  const v = { ...RECEIPT_DEFAULTS, ...cleanReceipt(data), trip_id: tripId };
  if (blobs) {
    v.image_key = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    // blobs.full pode ser um blob só (foto) ou a lista de páginas (PDF)
    const paginas = Array.isArray(blobs.full) ? blobs.full : [blobs.full];
    v.paginas = paginas.length;
    await tx(["images"], "readwrite", (t) => {
      const st = t.objectStore("images");
      paginas.forEach((b, i) => st.put(b, pageKey(v.image_key, i + 1)));
      st.put(blobs.thumb, `thumb_${v.image_key}`);   // miniatura só da 1ª página
    });
  }
  const now = new Date().toISOString();
  const rec = { ...v, created_at: now, updated_at: now };
  const id = await tx(["receipts"], "readwrite", (t) => wrap(t.objectStore("receipts").add(rec)));
  return { ...rec, id };
}

export async function updateReceipt(id, data) {
  const v = cleanReceipt(data);
  return tx(["receipts"], "readwrite", async (t) => {
    const s = t.objectStore("receipts");
    const cur = await wrap(s.get(id));
    if (!cur) throw new Error("Cupom não encontrado.");
    const next = { ...cur, ...v, revisar: 0, updated_at: new Date().toISOString() };
    await wrap(s.put(next));
    return next;
  });
}

/** Apaga a miniatura e todas as páginas de um cupom. */
function apagaImagens(store, r) {
  if (!r?.image_key) return;
  store.delete(`thumb_${r.image_key}`);
  for (let n = 1; n <= (r.paginas || 1); n++) store.delete(pageKey(r.image_key, n));
}

export async function deleteReceipt(id) {
  await tx(["receipts", "images"], "readwrite", async (t) => {
    const s = t.objectStore("receipts");
    const r = await wrap(s.get(id));
    apagaImagens(t.objectStore("images"), r);
    s.delete(id);
  });
}

export const getImage = (key) =>
  key ? tx(["images"], "readonly", (t) => wrap(t.objectStore("images").get(key))) : Promise.resolve(null);

/** Espaço ocupado, para avisar antes do navegador começar a descartar dados. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage: u = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage: u, quota, pct: quota ? u / quota : 0 };
}
