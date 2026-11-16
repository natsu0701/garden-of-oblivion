import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { statSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getIdentity } from "./cursor/identity.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [...new Set([ROOT, process.cwd(), path.join(ROOT, "public"), path.join(process.cwd(), "public")])];
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "entries.json");
const PORT = Number(process.env.PORT) || 8787;
const MAX_NOTES = 400;
const DAY = 86400000;

const SEEDS = [
  { id: "seed-1", name: "익명", text: "고생 많았습니다!", days: 2 },
  { id: "seed-2", name: "익명", text: "와.. 대박이에요", days: 5 },
  { id: "seed-3", name: "익명", text: "잘 봤습니다", days: 9 },
  { id: "seed-4", name: "익명", text: "고생 많았다!", days: 14 },
  { id: "seed-5", name: "익명", text: "스티커 너무 귀여워요", days: 20 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function assetFile(root, name) {
  const embedded = path.join(root, "embed", name);
  if (statSafe(embedded)) return embedded;
  const original = path.join(root, "assets", name);
  if (statSafe(original)) return original;
  return null;
}

let pageBody = null;

function assemblePage(htmlRaw, cssRaw, jsRaw) {
  let html = htmlRaw;
  const style = html.match(/<link rel="stylesheet" href="garden\.css"\s*\/?>/);
  const script = html.match(/<script src="garden\.js(?:\?[^"]*)?" defer><\/script>/);
  if (style) html = html.replace(style[0], () => `<style>\n${cssRaw}\n</style>`);
  if (script) html = html.replace(script[0], () => `<script>\n${jsRaw}\n</script>`);
  if (html.includes('href="garden.css"') || /src="garden\.js/.test(html)) {
    throw new Error("garden page still asks this host for its style or script");
  }
  const pictures = html.match(/<img\b[^>]*\ssrc="assets\/[^"]+"/g) || [];
  if (pictures.length < 8) throw new Error("garden page is missing its pictures");
  return html;
}

async function loadPage() {
  const htmlPath = statSafe(path.join(ROOT, "editable", "template.html"))
    ? path.join(ROOT, "editable", "template.html")
    : statSafe(path.join(ROOT, "editable", "index.html"))
      ? path.join(ROOT, "editable", "index.html")
      : path.join(ROOT, "index.html");
  const cssPath = statSafe(path.join(ROOT, "editable", "garden.css"))
    ? path.join(ROOT, "editable", "garden.css")
    : path.join(ROOT, "garden.css");
  const [htmlRaw, cssRaw, jsRaw] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(path.join(ROOT, "garden.js"), "utf8"),
  ]);
  pageBody = Buffer.from(assemblePage(htmlRaw, cssRaw, jsRaw));
}

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

function sameHash(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function seedRows(now = Date.now()) {
  return SEEDS.map((seed) => ({
    id: seed.id,
    name: seed.name,
    text: seed.text,
    at: now - seed.days * DAY,
    ownerHash: "seed",
    seed: true,
  }));
}

function publicEntry(row, ownerHash) {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    at: row.at,
    own: !row.seed && sameHash(row.ownerHash, ownerHash),
  };
}

let writeChain = Promise.resolve();

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function createFileStore() {
  async function readAll() {
    try {
      const raw = JSON.parse(await readFile(DATA_FILE, "utf8"));
      return Array.isArray(raw.entries) ? raw.entries : [];
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeAll(entries) {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ entries }), "utf8");
    await rename(tmp, DATA_FILE);
  }

  return {
    kind: "file",
    async init() {
      await enqueue(async () => {
        const entries = await readAll();
        const previous = new Map(entries.filter((entry) => entry.seed).map((entry) => [entry.id, entry]));
        const seeds = seedRows().map((row) => {
          const prev = previous.get(row.id);
          if (prev && prev.name === row.name && prev.text === row.text) return prev;
          return row;
        });
        const notes = entries.filter((entry) => !entry.seed);
        await writeAll([...notes, ...seeds]);
      });
    },
    async list(ownerHash) {
      const entries = await readAll();
      return entries
        .slice()
        .sort((a, b) => b.at - a.at)
        .map((entry) => publicEntry(entry, ownerHash));
    },
    async add({ name, text, ownerHash }) {
      return enqueue(async () => {
        const entries = await readAll();
        const row = {
          id: randomBytes(16).toString("hex"),
          name,
          text,
          at: Date.now(),
          ownerHash,
          seed: false,
        };
        const notes = entries.filter((entry) => !entry.seed);
        const seeds = entries.filter((entry) => entry.seed);
        notes.push(row);
        notes.sort((a, b) => b.at - a.at);
        await writeAll([...notes.slice(0, MAX_NOTES), ...seeds]);
        return publicEntry(row, ownerHash);
      });
    },
    async remove({ id, ownerHash }) {
      return enqueue(async () => {
        const entries = await readAll();
        const target = entries.find((entry) => entry.id === id);
        if (!target || target.seed || !sameHash(target.ownerHash, ownerHash)) return false;
        await writeAll(entries.filter((entry) => entry.id !== id));
        return true;
      });
    },
  };
}

function createPgStore(pool) {
  return {
    kind: "postgres",
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          owner_hash TEXT NOT NULL,
          seed BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS entries_created_idx ON entries (created_at DESC)
      `);
      for (const row of seedRows()) {
        await pool.query(
          `INSERT INTO entries (id, name, body, created_at, owner_hash, seed)
           VALUES ($1, $2, $3, $4, $5, TRUE)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name, body = EXCLUDED.body`,
          [row.id, row.name, row.text, row.at, row.ownerHash]
        );
      }
    },
    async list(ownerHash) {
      const result = await pool.query(
        `SELECT id, name, body, created_at, owner_hash, seed
         FROM entries
         ORDER BY created_at DESC
         LIMIT 500`
      );
      return result.rows.map((row) =>
        publicEntry(
          {
            id: row.id,
            name: row.name,
            text: row.body,
            at: Number(row.created_at),
            ownerHash: row.owner_hash,
            seed: row.seed,
          },
          ownerHash
        )
      );
    },
    async add({ name, text, ownerHash }) {
      const row = {
        id: randomBytes(16).toString("hex"),
        name,
        text,
        at: Date.now(),
        ownerHash,
        seed: false,
      };
      await pool.query(
        `INSERT INTO entries (id, name, body, created_at, owner_hash, seed)
         VALUES ($1, $2, $3, $4, $5, FALSE)`,
        [row.id, row.name, row.text, row.at, row.ownerHash]
      );
      await pool.query(
        `DELETE FROM entries
         WHERE seed = FALSE
           AND id NOT IN (
             SELECT id FROM entries
             WHERE seed = FALSE
             ORDER BY created_at DESC
             LIMIT $1
           )`,
        [MAX_NOTES]
      );
      return publicEntry(row, ownerHash);
    },
    async remove({ id, ownerHash }) {
      const result = await pool.query(
        `DELETE FROM entries
         WHERE id = $1 AND owner_hash = $2 AND seed = FALSE`,
        [id, ownerHash]
      );
      return result.rowCount > 0;
    },
  };
}

function databasePool(url) {
  const local = /\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)(?::|\/|$)/.test(url);
  return {
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 20000,
    ssl: local ? undefined : { rejectUnauthorized: false },
  };
}

async function openStore() {
  const url = process.env.DATABASE_URL;
  if (!url) return createFileStore();
  const { default: pg } = await import("pg");
  const pool = new pg.Pool(databasePool(url));
  pool.on("error", () => {});
  const store = createPgStore(pool);
  try {
    await store.init();
  } catch {
    await pool.end().catch(() => {});
    throw new Error("database unavailable");
  }
  return store;
}

let storeTask = null;

function readyStore() {
  if (!storeTask) {
    storeTask = openStore().catch((error) => {
      storeTask = null;
      throw error;
    });
  }
  return storeTask;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function visitorKey(req, res) {
  const current = parseCookies(req.headers.cookie).garden_visitor;
  if (/^[a-f0-9]{64}$/.test(current || "")) return current;
  const key = randomBytes(32).toString("hex");
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `garden_visitor=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
  return key;
}

function fromThisPage(req) {
  if (req.headers["x-garden-request"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [req.headers["x-forwarded-host"], req.headers.host]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return hosts.includes(originHost) || originHost.endsWith(".apps.grok.bot");
}

async function ownerHashOf(req, res) {
  const identity = await getIdentity(req);
  if (identity && identity.verified === true && identity.sub) return hashKey(`person:${identity.sub}`);
  return hashKey(`visitor:${visitorKey(req, res)}`);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "local";
}

const hits = new Map();

function limited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2048) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("bad json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function cleanField(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function statSafe(full) {
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

function publicFile(urlPath) {
  let pathname = "/";
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://garden.local").pathname);
  } catch {
    return null;
  }
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.startsWith("assets/")) {
    const embedded = assetFile(ROOT, path.basename(rel));
    if (embedded) {
      const ext = path.extname(embedded).toLowerCase();
      if (MIME[ext]) return { full: embedded, type: MIME[ext], ext };
    }
  }
  if ((rel === "index.html" || rel === "garden.css") && statSafe(path.join(ROOT, "editable", rel))) {
    rel = path.join("editable", rel);
  }
  const names = [rel];
  const nested = rel.indexOf("assets/");
  if (nested > 0) names.push(rel.slice(nested));
  for (const root of ROOTS) {
    for (const name of names) {
      const full = path.resolve(root, name);
      const relative = path.relative(root, full);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (/^(data|node_modules|migrations)(\/|$)/.test(relative)) continue;
      const ext = path.extname(full).toLowerCase();
      if (!MIME[ext]) continue;
      if (!statSafe(full)) continue;
      return { full, type: MIME[ext], ext };
    }
  }
  return null;
}

const FALLBACK_PAGE = Buffer.from(
  "<!doctype html><meta charset=\"utf-8\"><title>망각의 정원</title><p>정원을 열지 못했습니다.</p>",
  "utf8"
);

async function ensurePage() {
  if (pageBody) return;
  try {
    await loadPage();
  } catch {
    pageBody = FALLBACK_PAGE;
  }
}

async function withStore(res, task) {
  let store;
  try {
    store = await readyStore();
  } catch {
    send(res, 503, { error: "기록을 지금 열 수 없다." });
    return;
  }
  await task(store);
}

async function handleNode(req, res) {
  try {
    await ensurePage();
    const url = new URL(req.url || "/", "http://garden.local");
    if (url.pathname === "/api/entries" && req.method === "GET") {
      const ownerHash = await ownerHashOf(req, res);
      await withStore(res, async (store) => {
        send(res, 200, { saved: true, entries: await store.list(ownerHash) });
      });
      return;
    }
    if (url.pathname === "/api/entries" && req.method === "POST") {
      if (!fromThisPage(req)) {
        send(res, 403, { error: "이 정원에서만 걸 수 있다." });
        return;
      }
      const ownerHash = await ownerHashOf(req, res);
      if (limited(`visitor:${ownerHash}`, 8, 10 * 60 * 1000) || limited(`ip:${clientIp(req)}`, 20, 10 * 60 * 1000)) {
        send(res, 429, { error: "잠시 뒤에 다시 걸어 두어라." });
        return;
      }
      const body = await readJson(req);
      const name = cleanField(body.name, 10);
      const text = cleanField(body.text, 60);
      if (!name || !text) {
        send(res, 400, { error: "아직 비어있는 항목이 있습니다." });
        return;
      }
      await withStore(res, async (store) => {
        const entry = await store.add({ name, text, ownerHash });
        send(res, 201, { entry });
      });
      return;
    }
    const removal = url.pathname.match(/^\/api\/entries\/([a-zA-Z0-9-]{8,80})$/);
    if (removal && req.method === "DELETE") {
      if (!fromThisPage(req)) {
        send(res, 403, { error: "이 정원에서만 거둘 수 있다." });
        return;
      }
      const ownerHash = await ownerHashOf(req, res);
      await withStore(res, async (store) => {
        const removed = await store.remove({ id: removal[1], ownerHash });
        send(res, removed ? 200 : 404, removed ? { ok: true } : { error: "거둘 수 없는 말이다." });
      });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      send(res, 404, { error: "없는 길이다." });
      return;
    }
    if ((url.pathname === "/" || url.pathname === "/index.html") && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(pageBody.length),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : pageBody);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "허용되지 않은 방법이다." });
      return;
    }
    const file = publicFile(url.pathname);
    if (!file) {
      send(res, 404, { error: "없는 길이다." });
      return;
    }
    const body = await readFile(file.full);
    res.writeHead(200, {
      "content-type": file.type,
      "content-length": String(body.length),
      "x-content-type-options": "nosniff",
      "cache-control": file.type.startsWith("image/") || file.type.startsWith("font/") ? "public, max-age=86400" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    if (status === 500) console.error("garden request failed");
    if (!res.headersSent) send(res, status, { error: "걸리지 못했다." });
  }
}

function nodeRequest(request, body) {
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const url = new URL(request.url);
  return {
    url: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    socket: { remoteAddress: "" },
    on(event, callback) {
      if (event === "data" && body.length) callback(body);
      if (event === "end") callback();
      return this;
    },
    destroy() {},
  };
}

function captureResponse() {
  const headers = {};
  const chunks = [];
  return {
    status: 200,
    headersSent: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    writeHead(status, extra) {
      this.status = status;
      if (extra) {
        for (const [name, value] of Object.entries(extra)) headers[String(name).toLowerCase()] = String(value);
      }
      this.headersSent = true;
    },
    end(payload) {
      this.headersSent = true;
      if (payload !== undefined && payload !== null) {
        chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      }
      this.body = Buffer.concat(chunks);
      this.done = true;
    },
    body: Buffer.alloc(0),
    done: false,
    headerList() {
      return headers;
    },
  };
}

async function webHandle(request) {
  const method = request.method || "GET";
  const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
  const req = nodeRequest(request, body);
  const res = captureResponse();
  await handleNode(req, res);
  if (!res.done) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("걸리지 못했다.");
  }
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, headers: res.headerList() });
}

async function respond(request) {
  try {
    if (!request || typeof request.headers?.get !== "function") {
      return new Response(FALLBACK_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return await webHandle(request);
  } catch {
    return new Response(FALLBACK_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

export function GET(request) {
  return respond(request);
}

export function POST(request) {
  return respond(request);
}

export function DELETE(request) {
  return respond(request);
}

export function HEAD(request) {
  return respond(request);
}

export default function handler(request) {
  return respond(request);
}

const server = createServer((req, res) => {
  handleNode(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FALLBACK_PAGE);
    }
  });
});

process.on("unhandledRejection", () => {
  console.error("garden kept the page up after a failed task");
});

server.on("error", () => {
  console.error("garden kept the page up after a listen error");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`garden listening on ${PORT}`);
});
