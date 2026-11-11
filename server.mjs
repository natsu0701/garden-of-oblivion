import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const assetUris = new Map();
for (const root of ROOTS) {
  let names = [];
  try {
    names = await readdir(path.join(root, "assets"));
  } catch {
    continue;
  }
  for (const name of names) {
    const key = `assets/${name}`;
    if (assetUris.has(key)) continue;
    const type = MIME[path.extname(name).toLowerCase()];
    if (!type || !type.startsWith("image/")) continue;
    const bytes = await readFile(path.join(root, "assets", name));
    assetUris.set(key, `data:${type};base64,${bytes.toString("base64")}`);
  }
  if (assetUris.size) break;
}

function inlineAssets(source) {
  let text = source;
  for (const key of [...assetUris.keys()].sort((a, b) => b.length - a.length)) {
    const uri = assetUris.get(key);
    text = text.split(`src="${key}"`).join(`src="${uri}"`);
    text = text.split(`url("${key}")`).join(`url("${uri}")`);
    text = text.split(`url('${key}')`).join(`url('${uri}')`);
  }
  return text;
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

async function openStore() {
  const url = process.env.DATABASE_URL;
  if (!url) return createFileStore();
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return createPgStore(pool);
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
  res.setHeader(
    "Set-Cookie",
    `garden_visitor=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`
  );
  return key;
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

const store = await openStore();
await store.init();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://garden.local");
    if (url.pathname === "/api/entries" && req.method === "GET") {
      const ownerHash = hashKey(visitorKey(req, res));
      send(res, 200, { saved: true, entries: await store.list(ownerHash) });
      return;
    }
    if (url.pathname === "/api/entries" && req.method === "POST") {
      const key = visitorKey(req, res);
      const ownerHash = hashKey(key);
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
      const entry = await store.add({ name, text, ownerHash });
      send(res, 201, { entry });
      return;
    }
    const removal = url.pathname.match(/^\/api\/entries\/([a-zA-Z0-9-]{8,80})$/);
    if (removal && req.method === "DELETE") {
      const ownerHash = hashKey(visitorKey(req, res));
      const removed = await store.remove({ id: removal[1], ownerHash });
      send(res, removed ? 200 : 404, removed ? { ok: true } : { error: "거둘 수 없는 말이다." });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      send(res, 404, { error: "없는 길이다." });
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
    let body = await readFile(file.full);
    if (file.ext === ".html" || file.ext === ".css") body = Buffer.from(inlineAssets(body.toString("utf8")), "utf8");
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
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`garden listening on ${PORT} (${store.kind})`);
});
