// Servidor de Taxis Los Jardines.
// Sirve la página (carpeta public/) y una API pequeña guardada en MongoDB Atlas.
// Sin MONGODB_URI usa memoria (solo para probar en la computadora).

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const { MongoClient } = require("mongodb");
const fs = require("fs");

// En la computadora, lee las contraseñas del archivo .env (en Render se ponen en "Environment").
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env) && !/^PON_AQUI|CONTRASEÑA/.test(m[2])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "taxis_los_jardines";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) console.warn("Aviso: falta JWT_SECRET; las sesiones se cierran cada vez que el servidor reinicia.");
if (!ADMIN_PASSWORD) console.warn("Aviso: falta ADMIN_PASSWORD; nadie podrá entrar al Panel.");

const ESTADOS = ["disponible", "carrera", "no"];
const COLS = ["taxistas", "estados", "config", "credenciales"];

// ---------- Almacenamiento ----------
class MemoryStore {
  constructor() { this.cols = {}; }
  c(col) { return (this.cols[col] ||= new Map()); }
  async list(col) { return [...this.c(col)].map(([id, data]) => ({ id, data: { ...data } })); }
  async get(col, id) { const d = this.c(col).get(id); return d ? { ...d } : null; }
  async set(col, id, data) { this.c(col).set(id, { ...data }); }
  async update(col, id, data) { const d = this.c(col).get(id); if (!d) return false; this.c(col).set(id, { ...d, ...data }); return true; }
  async delete(col, id) { this.c(col).delete(id); }
  async findOne(col, field, value) { for (const [id, d] of this.c(col)) if (d[field] === value) return { id, data: { ...d } }; return null; }
}
class MongoStore {
  constructor(db) { this.db = db; }
  c(col) { return this.db.collection(col); }
  strip(doc) { const { _id, ...data } = doc; return { id: _id, data }; }
  async list(col) { return (await this.c(col).find({}).toArray()).map(d => this.strip(d)); }
  async get(col, id) { const d = await this.c(col).findOne({ _id: id }); return d ? this.strip(d).data : null; }
  async set(col, id, data) { await this.c(col).replaceOne({ _id: id }, data, { upsert: true }); }
  async update(col, id, data) { const r = await this.c(col).updateOne({ _id: id }, { $set: data }); return r.matchedCount > 0; }
  async delete(col, id) { await this.c(col).deleteOne({ _id: id }); }
  async findOne(col, field, value) { const d = await this.c(col).findOne({ [field]: value }); return d ? this.strip(d) : null; }
}

// ---------- Utilidades ----------
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const newId = () => crypto.randomBytes(10).toString("hex");
const idOk = id => /^[A-Za-z0-9_-]{1,40}$/.test(id);

function cleanTaxista(b) {
  const out = {};
  if ("nombre" in b) out.nombre = str(b.nombre, 60);
  if ("telefono" in b) out.telefono = str(b.telefono, 25);
  if ("unidad" in b) out.unidad = str(b.unidad, 6);
  return out;
}
function cleanTarifas(b) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30)
    .map(i => ({ destino: str(i?.destino, 60), dia: str(i?.dia, 30), noche: str(i?.noche, 30) }))
    .filter(i => i.destino);
  const hora = v => /^\d{2}:\d{2}$/.test(v || "") ? v : null;
  return { items, nocheDesde: hora(b.nocheDesde) || "19:00", nocheHasta: hora(b.nocheHasta) || "06:00", ejemplo: !!b.ejemplo, actualizado: Date.now() };
}

// Límite sencillo de intentos de inicio de sesión por IP.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  a.push(now); attempts.set(ip, a);
  return a.length > 12;
}

// ---------- Avisos en vivo (Server-Sent Events) ----------
const clients = new Set();
function broadcast(col) { const msg = `data: ${JSON.stringify({ col })}\n\n`; for (const res of clients) res.write(msg); }

async function main() {
  let store;
  if (MONGODB_URI) {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    store = new MongoStore(client.db(DB_NAME));
    await store.c("credenciales").createIndex({ usuario: 1 }, { unique: true });
    console.log("Conectado a MongoDB.");
  } else {
    store = new MemoryStore();
    console.warn("Aviso: sin MONGODB_URI; los datos se guardan solo en memoria.");
  }
  if (!(await store.get("config", "tarifas"))) {
    await store.set("config", "tarifas", cleanTarifas({ ejemplo: true, items: [
      { destino: "Carrera dentro de Quinindé", dia: "$1,50 – $2,00", noche: "$2,00 – $3,00" },
      { destino: "Viaje a Esmeraldas", dia: "$50 – $65", noche: "$60 – $75" }
    ] }));
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "50kb" }));

  // Quién hace la petición (taxista o administración), según su token.
  app.use(async (req, _res, next) => {
    req.who = null;
    const h = req.get("authorization") || "";
    if (h.startsWith("Bearer ")) {
      try {
        const t = jwt.verify(h.slice(7), JWT_SECRET);
        if (t.role === "admin") req.who = { role: "admin" };
        else if (t.role === "driver") {
          const cred = await store.get("credenciales", t.sub);
          // Si la cooperativa cambió la contraseña o quitó al taxista, el token deja de servir.
          if (cred && cred.creado === t.v && (await store.get("taxistas", t.sub))) req.who = { role: "driver", id: t.sub };
        }
      } catch {}
    }
    next();
  });
  const isAdmin = req => req.who?.role === "admin";
  const deny = res => res.status(403).json({ error: "Sin permiso" });

  app.get("/healthz", (_req, res) => res.send("ok"));

  app.get("/api/me", (req, res) => req.who ? res.json(req.who) : res.status(401).json({ error: "Sin sesión" }));

  app.post("/api/admin/login", (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    const a = Buffer.from(String(req.body?.clave || "")), b = Buffer.from(ADMIN_PASSWORD);
    if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Clave incorrecta" });
    res.json({ token: jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "30d" }) });
  });

  app.post("/api/login", async (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    const usuario = str(req.body?.usuario, 24).toLowerCase(), clave = String(req.body?.clave || "");
    const found = usuario && await store.findOne("credenciales", "usuario", usuario);
    const ok = found && found.data.hash && await bcrypt.compare(clave, found.data.hash) && await store.get("taxistas", found.id);
    if (!ok) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    res.json({ id: found.id, token: jwt.sign({ role: "driver", sub: found.id, v: found.data.creado }, JWT_SECRET, { expiresIn: "90d" }) });
  });

  // Lectura: todo es público menos las credenciales (solo administración, y nunca el hash).
  app.get("/api/col/:col", async (req, res) => {
    const { col } = req.params;
    if (!COLS.includes(col)) return res.status(404).end();
    if (col === "credenciales") {
      if (!isAdmin(req)) return deny(res);
      return res.json((await store.list(col)).map(d => ({ id: d.id, data: { usuario: d.data.usuario, creado: d.data.creado } })));
    }
    res.json(await store.list(col));
  });
  app.get("/api/doc/:col/:id", async (req, res) => {
    const { col, id } = req.params;
    if (!COLS.includes(col) || col === "credenciales" || !idOk(id)) return res.status(404).end();
    const d = await store.get(col, id);
    res.json({ exists: !!d, data: d });
  });

  // Escritura.
  app.post("/api/col/taxistas", async (req, res) => {
    if (!isAdmin(req)) return deny(res);
    const data = cleanTaxista(req.body || {});
    if (!data.nombre || (data.telefono || "").replace(/\D/g, "").length < 8) return res.status(400).json({ error: "Faltan datos" });
    const id = newId();
    await store.set("taxistas", id, { ...data, creado: Date.now() });
    broadcast("taxistas");
    res.json({ id });
  });

  app.put("/api/doc/:col/:id", async (req, res) => {
    const { col, id } = req.params, b = req.body || {};
    if (!idOk(id)) return res.status(400).end();
    if (col === "estados") {
      if (!(isAdmin(req) || (req.who?.role === "driver" && req.who.id === id))) return deny(res);
      if (!ESTADOS.includes(b.estado)) return res.status(400).json({ error: "Estado no válido" });
      if (!(await store.get("taxistas", id))) return res.status(404).end();
      await store.set("estados", id, { estado: b.estado, enLinea: b.estado === "disponible", actualizado: Date.now() });
      broadcast("estados");
      return res.json({ ok: true });
    }
    if (!isAdmin(req)) return deny(res);
    if (col === "config" && id === "tarifas") { await store.set("config", "tarifas", cleanTarifas(b)); broadcast("config"); return res.json({ ok: true }); }
    if (col === "credenciales") {
      const usuario = str(b.usuario, 24).toLowerCase(), clave = String(b.clave || "");
      if (!/^[a-z0-9]{3,24}$/.test(usuario)) return res.status(400).json({ error: "Usuario no válido" });
      if (clave.length < 6 || clave.length > 60) return res.status(400).json({ error: "Contraseña no válida" });
      if (!(await store.get("taxistas", id))) return res.status(404).end();
      const other = await store.findOne("credenciales", "usuario", usuario);
      if (other && other.id !== id) return res.status(409).json({ error: "Ese usuario ya existe" });
      await store.set("credenciales", id, { usuario, hash: await bcrypt.hash(clave, 10), creado: Date.now() });
      broadcast("credenciales");
      return res.json({ ok: true });
    }
    if (col === "taxistas") { await store.set("taxistas", id, { ...cleanTaxista(b), creado: Date.now() }); broadcast("taxistas"); return res.json({ ok: true }); }
    res.status(404).end();
  });

  app.patch("/api/doc/taxistas/:id", async (req, res) => {
    if (!isAdmin(req)) return deny(res);
    if (!idOk(req.params.id)) return res.status(400).end();
    const ok = await store.update("taxistas", req.params.id, cleanTaxista(req.body || {}));
    if (!ok) return res.status(404).end();
    broadcast("taxistas");
    res.json({ ok: true });
  });

  app.delete("/api/doc/:col/:id", async (req, res) => {
    const { col, id } = req.params;
    if (!isAdmin(req)) return deny(res);
    if (!["taxistas", "estados", "credenciales"].includes(col) || !idOk(id)) return res.status(404).end();
    await store.delete(col, id);
    broadcast(col);
    res.status(204).end();
  });

  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
  });

  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  app.listen(PORT, () => console.log(`Taxis Los Jardines en http://localhost:${PORT}`));
}

main().catch(err => { console.error("No se pudo iniciar:", err.message); process.exit(1); });
