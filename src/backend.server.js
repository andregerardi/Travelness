/* Backend da versão servidor: tudo vai para o Flask, que já guarda, lê e exporta. */

const BOOT = globalThis.__TRAVELNESS__ || { profile: {}, trips: [], features: {} };

async function call(path, { method = "GET", body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("Sem conexão com o servidor. Tente de novo.");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), data, { status: res.status });
  return data;
}

export const backend = {
  kind: "server",

  async boot() {
    return { profile: BOOT.profile, trips: BOOT.trips, settings: null, features: BOOT.features };
  },

  api: call,

  async addReceipt(tripId, file) {
    const form = new FormData();
    form.append("file", file);
    return call(`/api/trips/${tripId}/receipts`, { method: "POST", form });
  },

  async loadImage(receipt, kind = "thumb") {
    if (!receipt.image_path) return null;
    return kind === "thumb" ? `/uploads/thumb_${receipt.image_path}` : `/uploads/${receipt.image_path}`;
  },

  async buildExport(tripId, kind) {
    const res = await fetch(`/api/trips/${tripId}/export.${kind}`);
    if (!res.ok) throw new Error("Não consegui gerar o arquivo.");
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    const blob = await res.blob();
    return { blob, filename: m ? m[1] : `travelness.${kind}`, type: blob.type };
  },

  sendEmail(tripId, body) {
    return call(`/api/trips/${tripId}/email`, { method: "POST", body });
  },

  getSettings: async () => null,
  saveSettings: async () => null,
  usage: async () => null,
  pingServer: async () => true,
  warmUpOcr: async () => {},
};
