// EZ Label Printing - Cloudflare Worker (API + print queue). Static pages are served from /public.
import { buildLabel, tsplHeader, tsplLabel, validateConfig, DEFAULT_TEMPLATE, checkChars } from "../public/engine.js";

const SESSION_DAYS = 90;
const MAX_LABELS = 500;
const CHUNK = 10;                 // labels sent to the printer per agent poll (keeps each request under the free 10 ms CPU limit)
const ONLINE_SECONDS = 40;        // agent counts as online if seen within this time
const POLL_MS = 4000;
const MIN_PASSWORD = 8;           // the app is public; lockout still allows ~1,440 guesses a day per name

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', active INTEGER NOT NULL DEFAULT 1, fails INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS models(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, created TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, config TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS printers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, density INTEGER NOT NULL DEFAULT 6, speed INTEGER NOT NULL DEFAULT 2, direction INTEGER NOT NULL DEFAULT 1, ox INTEGER NOT NULL DEFAULT 0, oy INTEGER NOT NULL DEFAULT 0, last_seen TEXT, status TEXT, created TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, printer_id INTEGER NOT NULL, user_id INTEGER NOT NULL, template_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'print', extra TEXT, meta TEXT, status TEXT NOT NULL DEFAULT 'queued', total INTEGER NOT NULL DEFAULT 0, reprint INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT (datetime('now')), finished TEXT)`,
  `CREATE TABLE IF NOT EXISTS prints(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, serial TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, sent_at TEXT, printed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS prints_serial ON prints(serial)`,
  `CREATE INDEX IF NOT EXISTS prints_status ON prints(status)`,
  `CREATE INDEX IF NOT EXISTS prints_job ON prints(job_id)`,
  `CREATE INDEX IF NOT EXISTS jobs_printer ON jobs(printer_id, status)`,
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)))
      .then(() => env.DB.prepare(`ALTER TABLE printers ADD COLUMN stretch REAL NOT NULL DEFAULT 0`).run()
        .catch((e) => { if (!/duplicate column/i.test(String(e && (e.message || e)))) throw e; }))
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hashPassword(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 10000 }, key, 256));
}
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const marks = (n) => Array(n).fill("?").join(",");
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);

async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, "Bad request"); }
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function currentUser(env, request) {
  const tok = parseCookies(request).ezl;
  if (!tok) return null;
  const th = await sha256(tok);
  return await env.DB.prepare(
    `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires > datetime('now') AND u.active = 1`
  ).bind(th).first();
}

function sessionCookie(request, token, days) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `ezl=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`;
}

async function startSession(env, request, userId) {
  const token = randHex(32);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires < datetime('now')`),
    env.DB.prepare(`INSERT INTO sessions(token_hash, user_id, expires) VALUES(?, ?, datetime('now', ?))`).bind(await sha256(token), userId, `+${SESSION_DAYS} days`),
  ]);
  return sessionCookie(request, token, SESSION_DAYS);
}

function printerSettings(p) {
  return { density: p.density, speed: p.speed, direction: p.direction, ox: p.ox, oy: p.oy };
}

const STRETCH_CAPS = [0, 1, 2, 3];       // 0 off, 1 mild, 2 medium, 3 wide
function stretchOf(p) {
  return STRETCH_CAPS.includes(p.stretch) ? p.stretch : 0;
}

function isOnline(p) {
  if (!p.last_seen) return false;
  return Date.now() - new Date(p.last_seen.replace(" ", "T") + "Z").getTime() < ONLINE_SECONDS * 1000;
}

function publicPrinter(p) {
  let st = null;
  try { st = p.status ? JSON.parse(p.status) : null; } catch { /* ignore */ }
  return { id: p.id, name: p.name, online: isOnline(p), last_seen: p.last_seen, status: st, density: p.density, speed: p.speed, direction: p.direction, ox: p.ox, oy: p.oy, stretch: stretchOf(p) };
}

async function getTemplate(env, id) {
  const t = await env.DB.prepare(`SELECT id, name, config FROM templates WHERE id = ?`).bind(id).first();
  if (!t) throw new HttpError(400, "Template not found");
  return { id: t.id, name: t.name, cfg: JSON.parse(t.config) };
}

function extraOf(input) {
  return { extra1: str(input?.extra1, 60), extra2: str(input?.extra2, 60) };
}

async function finalizeJob(env, jobId) {
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prints WHERE job_id = ? AND status IN ('queued','sending')`).bind(jobId).first();
  if (!left.n) {
    await env.DB.prepare(`UPDATE jobs SET status = 'done', finished = datetime('now') WHERE id = ? AND status != 'done'`).bind(jobId).run();
  }
}

async function insertPrints(env, jobId, items) {
  const stmts = [];
  for (const part of chunks(items, 30)) {
    stmts.push(env.DB.prepare(`INSERT INTO prints(job_id, serial, model) VALUES ${part.map(() => "(?,?,?)").join(",")}`)
      .bind(...part.flatMap((it) => [jobId, it.serial, it.model])));
  }
  await env.DB.batch(stmts);
}

// A job and its labels. If adding the labels fails, the empty job is removed again.
async function createJob(env, printerId, userId, templateId, extraJson, items, reprint) {
  const job = await env.DB.prepare(`INSERT INTO jobs(printer_id, user_id, template_id, extra, total, reprint) VALUES(?,?,?,?,?,?) RETURNING id`)
    .bind(printerId, userId, templateId, extraJson, items.length, reprint).first();
  try { await insertPrints(env, job.id, items); }
  catch (e) { await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(job.id).run(); throw e; }
  return job.id;
}

async function findDuplicates(env, serials) {
  const found = new Map();
  for (const part of chunks(serials, 90)) {
    const r = await env.DB.prepare(
      `SELECT p.serial, p.printed_at, p.status, u.name AS user FROM prints p
       JOIN jobs j ON j.id = p.job_id JOIN users u ON u.id = j.user_id
       WHERE p.serial IN (${marks(part.length)}) AND p.status IN ('queued','sending','printed') ORDER BY p.id DESC`
    ).bind(...part).all();
    for (const row of r.results) if (!found.has(row.serial)) found.set(row.serial, row);
  }
  return found;
}

function normalizeItems(input, defaultModel) {
  if (!Array.isArray(input) || !input.length) throw new HttpError(400, "Add at least one serial number");
  if (input.length > MAX_LABELS) throw new HttpError(400, `Print at most ${MAX_LABELS} labels at a time`);
  const seen = new Set();
  const items = [];
  for (const it of input) {
    const serial = str(typeof it === "string" ? it : it?.serial, 80);
    const model = str((typeof it === "object" && it?.model) || defaultModel, 80);
    if (!serial) continue;
    if (seen.has(serial)) throw new HttpError(400, `Serial ${serial} is in the list twice`);
    seen.add(serial);
    items.push({ serial, model });
  }
  if (!items.length) throw new HttpError(400, "Add at least one serial number");
  return items;
}

function validateItems(cfg, items, extra) {
  const errors = [];
  for (const it of items) {
    try { buildLabel(cfg, { serial: it.serial, model: it.model, ...extra }); }
    catch (e) { errors.push(`${it.serial}: ${e.message}`); if (errors.length >= 5) break; }
  }
  if (errors.length) throw new HttpError(400, "Some labels can't be made: " + errors.join("; "));
}

// ---------- routes ----------
const routes = [];
const route = (method, path, auth, handler) => {
  const keys = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, auth, handler });
};

// --- public ---
route("GET", "/api/state", "none", async ({ env, user }) => {
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  return json({ needsSetup: c.n === 0, user });
});

route("POST", "/api/setup", "none", async ({ env, request }) => {
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  if (c.n > 0) throw new HttpError(403, "Setup is already done");
  const b = await body(request);
  const name = str(b.name, 40), password = str(b.password, 100);
  if (!name) throw new HttpError(400, "Enter a name");
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  const salt = randHex(16);
  const r = await env.DB.prepare(`INSERT INTO users(name, salt, hash, role) VALUES(?, ?, ?, 'admin') RETURNING id`).bind(name, salt, await hashPassword(password, salt)).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO templates(name, config) VALUES(?, ?)`).bind("Model and serial, 39x30", JSON.stringify(DEFAULT_TEMPLATE)),
    env.DB.prepare(`INSERT OR IGNORE INTO models(code) VALUES(?)`).bind("CM4X16GC3200C16K2E"),
  ]);
  return json({ ok: true }, 200, { "set-cookie": await startSession(env, request, r.id) });
});

route("POST", "/api/login", "none", async ({ env, request }) => {
  const b = await body(request);
  const u = await env.DB.prepare(`SELECT * FROM users WHERE name = ?`).bind(str(b.name, 40)).first();
  const bad = new HttpError(401, "Wrong name or password");
  if (!u || !u.active) throw bad;
  if (u.locked_until && u.locked_until > new Date().toISOString().slice(0, 19).replace("T", " ")) {
    throw new HttpError(429, "Too many wrong attempts. Try again in a few minutes.");
  }
  if ((await hashPassword(str(b.password, 100), u.salt)) !== u.hash) {
    const fails = u.fails + 1;
    await env.DB.prepare(`UPDATE users SET fails = ?, locked_until = CASE WHEN ? >= 5 THEN datetime('now', '+5 minutes') ELSE NULL END WHERE id = ?`).bind(fails >= 5 ? 0 : fails, fails, u.id).run();
    throw bad;
  }
  if (u.fails) await env.DB.prepare(`UPDATE users SET fails = 0, locked_until = NULL WHERE id = ?`).bind(u.id).run();
  return json({ ok: true }, 200, { "set-cookie": await startSession(env, request, u.id) });
});

route("POST", "/api/logout", "user", async ({ env, request }) => {
  const tok = parseCookies(request).ezl;
  if (tok) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(tok)).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
});

// --- staff ---
route("GET", "/api/bootstrap", "user", async ({ env, user }) => {
  const [models, templates, printers] = await env.DB.batch([
    env.DB.prepare(`SELECT id, code FROM models ORDER BY code`),
    env.DB.prepare(`SELECT id, name, config FROM templates WHERE archived = 0 ORDER BY id`),
    env.DB.prepare(`SELECT * FROM printers ORDER BY id`),
  ]);
  return json({
    user,
    models: models.results,
    templates: templates.results.map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) })),
    printers: printers.results.map(publicPrinter),
  });
});

route("GET", "/api/status", "user", async ({ env }) => {
  const r = await env.DB.prepare(`SELECT * FROM printers ORDER BY id`).all();
  return json({ printers: r.results.map(publicPrinter) });
});

route("POST", "/api/models", "user", async ({ env, request }) => {
  const code = str((await body(request)).code, 80);
  try { checkChars(code, "Model"); } catch (e) { throw new HttpError(400, e.message); }
  await env.DB.prepare(`INSERT OR IGNORE INTO models(code) VALUES(?)`).bind(code).run();
  return json({ ok: true, code });
});

route("DELETE", "/api/models/:id", "admin", async ({ env, params }) => {
  await env.DB.prepare(`DELETE FROM models WHERE id = ?`).bind(+params.id).run();
  return json({ ok: true });
});

route("POST", "/api/check", "user", async ({ env, request }) => {
  const b = await body(request);
  const serials = [...new Set((Array.isArray(b.serials) ? b.serials : []).map((s) => str(s, 80)).filter(Boolean))].slice(0, MAX_LABELS);
  const dups = await findDuplicates(env, serials);
  return json({ dups: Object.fromEntries([...dups].map(([k, v]) => [k, { printed_at: v.printed_at, user: v.user, status: v.status }])) });
});

route("POST", "/api/print", "user", async ({ env, request, user }) => {
  const b = await body(request);
  const tpl = await getTemplate(env, +b.template_id);
  const printer = await env.DB.prepare(`SELECT id FROM printers WHERE id = ?`).bind(+b.printer_id).first();
  if (!printer) throw new HttpError(400, "Choose a printer");
  const items = normalizeItems(b.items, b.model);
  const extra = extraOf(b.extra);
  validateItems(tpl.cfg, items, extra);
  if (!b.allow_dups) {
    const dups = await findDuplicates(env, items.map((i) => i.serial));
    if (dups.size) {
      throw new HttpError(409, `${dups.size} serial number(s) were already printed`, {
        dups: Object.fromEntries([...dups].map(([k, v]) => [k, { printed_at: v.printed_at, user: v.user }])),
      });
    }
  }
  const jobId = await createJob(env, printer.id, user.id, tpl.id, JSON.stringify(extra), items, 0);
  return json({ job_id: jobId, total: items.length });
});

route("GET", "/api/jobs/:id", "user", async ({ env, params }) => {
  const j = await env.DB.prepare(`SELECT id, status, total, kind FROM jobs WHERE id = ?`).bind(+params.id).first();
  if (!j) throw new HttpError(404, "Job not found");
  const r = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM prints WHERE job_id = ? GROUP BY status`).bind(j.id).all();
  const counts = Object.fromEntries(r.results.map((x) => [x.status, x.n]));
  const err = await env.DB.prepare(`SELECT error FROM prints WHERE job_id = ? AND status = 'failed' AND error IS NOT NULL LIMIT 1`).bind(j.id).first();
  return json({ ...j, counts, error: err?.error || null });
});

route("POST", "/api/jobs/:id/cancel", "user", async ({ env, params }) => {
  const id = +params.id;
  await env.DB.prepare(`UPDATE prints SET status = 'cancelled' WHERE job_id = ? AND status = 'queued'`).bind(id).run();
  await env.DB.prepare(`UPDATE jobs SET status = 'cancelled', finished = datetime('now') WHERE id = ? AND kind = 'tune' AND status = 'queued'`).bind(id).run();
  await finalizeJob(env, id);
  return json({ ok: true });
});

route("GET", "/api/history", "user", async ({ env, url }) => {
  const q = str(url.searchParams.get("q"), 60);
  const limit = Math.max(1, Math.min(+url.searchParams.get("limit") || 100, 300));   // SQLite treats a negative LIMIT as no limit
  const where = q ? `WHERE p.serial LIKE ? OR p.model LIKE ?` : "";
  const binds = q ? [`%${q}%`, `%${q}%`, limit] : [limit];
  const r = await env.DB.prepare(
    `SELECT p.id, p.serial, p.model, p.status, p.error, p.printed_at, j.created, j.reprint, u.name AS user, t.name AS template, pr.name AS printer
     FROM prints p JOIN jobs j ON j.id = p.job_id JOIN users u ON u.id = j.user_id
     LEFT JOIN templates t ON t.id = j.template_id LEFT JOIN printers pr ON pr.id = j.printer_id
     ${where} ORDER BY p.id DESC LIMIT ?`
  ).bind(...binds).all();
  return json({ rows: r.results });
});

route("POST", "/api/reprint", "user", async ({ env, request, user }) => {
  const b = await body(request);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean))].slice(0, 100);
  if (!ids.length) throw new HttpError(400, "Choose labels to reprint");
  const printerId = +b.printer_id;
  if (!(await env.DB.prepare(`SELECT id FROM printers WHERE id = ?`).bind(printerId).first())) throw new HttpError(400, "Choose a printer");
  const rows = (await env.DB.prepare(
    `SELECT p.serial, p.model, j.template_id, j.extra FROM prints p JOIN jobs j ON j.id = p.job_id WHERE p.id IN (${marks(ids.length)})`
  ).bind(...ids).all()).results;
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.template_id}|${r.extra}`;
    if (!groups.has(key)) groups.set(key, { template_id: r.template_id, extra: r.extra, items: [] });
    groups.get(key).items.push({ serial: r.serial, model: r.model });
  }
  let total = 0, jobId = null;
  for (const g of groups.values()) {
    const tpl = await getTemplate(env, g.template_id);
    validateItems(tpl.cfg, g.items, JSON.parse(g.extra || "{}"));
    jobId = await createJob(env, printerId, user.id, g.template_id, g.extra, g.items, 1);
    total += g.items.length;
  }
  return json({ job_id: jobId, total });
});

// --- admin: templates ---
route("GET", "/api/templates/all", "admin", async ({ env }) => {
  const r = await env.DB.prepare(`SELECT id, name, config, archived FROM templates ORDER BY id`).all();
  return json({ templates: r.results.map((t) => ({ ...t, config: JSON.parse(t.config) })) });
});

async function saveTemplate(env, id, b) {
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, "Give the template a name");
  let cfg;
  try { cfg = validateConfig(b.config); } catch (e) { throw new HttpError(400, e.message); }
  try {
    if (id) await env.DB.prepare(`UPDATE templates SET name = ?, config = ?, archived = 0 WHERE id = ?`).bind(name, JSON.stringify(cfg), id).run();
    else id = (await env.DB.prepare(`INSERT INTO templates(name, config) VALUES(?, ?) RETURNING id`).bind(name, JSON.stringify(cfg)).first()).id;
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(400, "A template with that name already exists");
    throw e;
  }
  return id;
}
route("POST", "/api/templates", "admin", async ({ env, request }) => json({ ok: true, id: await saveTemplate(env, null, await body(request)) }));
route("PUT", "/api/templates/:id", "admin", async ({ env, request, params }) => json({ ok: true, id: await saveTemplate(env, +params.id, await body(request)) }));
route("DELETE", "/api/templates/:id", "admin", async ({ env, params }) => {
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM templates WHERE archived = 0`).first();
  if (left.n <= 1) throw new HttpError(400, "Keep at least one template");
  await env.DB.prepare(`UPDATE templates SET archived = 1 WHERE id = ?`).bind(+params.id).run();
  return json({ ok: true });
});

// --- admin: users ---
route("GET", "/api/users", "admin", async ({ env }) => {
  const r = await env.DB.prepare(`SELECT id, name, role, active, created FROM users ORDER BY id`).all();
  return json({ users: r.results });
});
route("POST", "/api/users", "admin", async ({ env, request }) => {
  const b = await body(request);
  const name = str(b.name, 40), password = str(b.password, 100);
  if (!name) throw new HttpError(400, "Enter a name");
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  const salt = randHex(16);
  try {
    await env.DB.prepare(`INSERT INTO users(name, salt, hash, role) VALUES(?,?,?,?)`).bind(name, salt, await hashPassword(password, salt), b.role === "admin" ? "admin" : "staff").run();
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new HttpError(400, "That name is taken");
    throw e;
  }
  return json({ ok: true });
});
route("PUT", "/api/users/:id", "admin", async ({ env, request, params, user }) => {
  const b = await body(request), id = +params.id;
  if (id === user.id && (b.active === false || (b.role && b.role !== "admin"))) throw new HttpError(400, "You can't remove your own admin access");
  if (b.password) {
    const pw = str(b.password, 100);
    if (pw.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
    const salt = randHex(16);
    await env.DB.prepare(`UPDATE users SET salt = ?, hash = ?, fails = 0, locked_until = NULL WHERE id = ?`).bind(salt, await hashPassword(pw, salt), id).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  }
  if (typeof b.active === "boolean") {
    await env.DB.prepare(`UPDATE users SET active = ? WHERE id = ?`).bind(b.active ? 1 : 0, id).run();
    if (!b.active) await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  }
  if (b.role) await env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(b.role === "admin" ? "admin" : "staff", id).run();
  return json({ ok: true });
});

// --- admin: printers ---
route("POST", "/api/printers", "admin", async ({ env, request }) => {
  const name = str((await body(request)).name, 60) || "Label printer";
  const key = "ezk_" + randHex(24);
  const r = await env.DB.prepare(`INSERT INTO printers(name, key_hash) VALUES(?, ?) RETURNING id`).bind(name, await sha256(key)).first();
  return json({ id: r.id, key });
});
route("POST", "/api/printers/:id/key", "admin", async ({ env, params }) => {
  const key = "ezk_" + randHex(24);
  await env.DB.prepare(`UPDATE printers SET key_hash = ? WHERE id = ?`).bind(await sha256(key), +params.id).run();
  return json({ key });
});
route("PUT", "/api/printers/:id", "admin", async ({ env, request, params }) => {
  const b = await body(request);
  const n = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const stretch = STRETCH_CAPS.includes(Number(b.stretch)) ? Number(b.stretch) : 0;
  await env.DB.prepare(`UPDATE printers SET name = ?, density = ?, speed = ?, direction = ?, ox = ?, oy = ?, stretch = ? WHERE id = ?`)
    .bind(str(b.name, 60) || "Label printer", n(b.density, 0, 15, 6), n(b.speed, 1, 6, 2), n(b.direction, 0, 1, 1), n(b.ox, -80, 80, 0), n(b.oy, -80, 80, 0), stretch, +params.id).run();
  return json({ ok: true });
});
route("DELETE", "/api/printers/:id", "admin", async ({ env, params }) => {
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM printers`).first();
  if (n.n <= 1) throw new HttpError(400, "Keep at least one printer");
  await env.DB.prepare(`UPDATE prints SET status = 'cancelled' WHERE status IN ('queued','sending') AND job_id IN (SELECT id FROM jobs WHERE printer_id = ?)`).bind(+params.id).run();
  await env.DB.prepare(`DELETE FROM printers WHERE id = ?`).bind(+params.id).run();
  return json({ ok: true });
});
route("POST", "/api/printers/:id/tune", "admin", async ({ env, request, params, user }) => {
  const b = await body(request);
  const tpl = await getTemplate(env, +b.template_id);
  const meta = { serial: str(b.serial, 80), model: str(b.model, 80), ...extraOf(b) };
  if (b.mode === "stretch") meta.mode = "stretch";
  validateItems(tpl.cfg, [{ serial: meta.serial, model: meta.model }], meta);
  const j = await env.DB.prepare(`INSERT INTO jobs(printer_id, user_id, template_id, kind, meta, total) VALUES(?,?,?,'tune',?,4) RETURNING id`)
    .bind(+params.id, user.id, tpl.id, JSON.stringify(meta)).first();
  return json({ job_id: j.id });
});

// --- agent (the program on the shop PC) ---
async function agentPrinter(env, request) {
  const m = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, "Missing key");
  const p = await env.DB.prepare(`SELECT * FROM printers WHERE key_hash = ?`).bind(await sha256(m[1])).first();
  if (!p) throw new HttpError(401, "Unknown key");
  return p;
}

route("POST", "/api/agent/poll", "agent", async ({ env, request }) => {
  const printer = await agentPrinter(env, request);
  const b = await body(request);
  const status = JSON.stringify({ ok: !!b.status?.ok, text: str(b.status?.text, 120), version: str(b.version, 20) });
  const stale = !printer.last_seen || Date.now() - new Date(printer.last_seen.replace(" ", "T") + "Z").getTime() > 10000;
  if (stale || status !== printer.status) {
    await env.DB.prepare(`UPDATE printers SET last_seen = datetime('now'), status = ? WHERE id = ?`).bind(status, printer.id).run();
  }
  const reply = { poll_ms: POLL_MS, job: null };
  if (!b.want_job) return json(reply);

  // Labels claimed but never confirmed (agent crashed) go back in the queue after 2 minutes.
  await env.DB.prepare(`UPDATE prints SET status = 'queued', sent_at = NULL WHERE status = 'sending' AND sent_at < datetime('now', '-2 minutes')`).run();

  const tune = await env.DB.prepare(`SELECT id, template_id, meta FROM jobs WHERE printer_id = ? AND kind = 'tune' AND status = 'queued' ORDER BY id LIMIT 1`).bind(printer.id).first();
  if (tune) {
    await env.DB.prepare(`UPDATE jobs SET status = 'done', finished = datetime('now') WHERE id = ?`).bind(tune.id).run();
    const tpl = await getTemplate(env, tune.template_id);
    const meta = JSON.parse(tune.meta);
    const lines = tsplHeader(tpl.cfg, printerSettings(printer));
    if (meta.mode === "stretch") {
      const names = ["S1 normal", "S2 mild", "S3 medium", "S4 wide"];
      STRETCH_CAPS.forEach((cap, i) => lines.push(...tsplLabel(buildLabel(tpl.cfg, meta, { stretch: cap }), null, names[i])));
    } else {
      const label = buildLabel(tpl.cfg, meta);
      for (const d of [4, 6, 8, 10]) lines.push(...tsplLabel(label, d, `D${d}`));
    }
    return json({ ...reply, job: { id: tune.id, ids: [], tspl: lines.join("\r\n") + "\r\n" } });
  }

  const cand = (await env.DB.prepare(
    `SELECT p.id, p.serial, p.model, p.job_id FROM prints p JOIN jobs j ON j.id = p.job_id
     WHERE j.printer_id = ? AND j.kind = 'print' AND p.status = 'queued' ORDER BY p.id LIMIT ?`
  ).bind(printer.id, CHUNK).all()).results;
  if (!cand.length) return json(reply);
  const jobId = cand[0].job_id;
  const picked = cand.filter((r) => r.job_id === jobId);
  // Claim only labels still queued, so two agents polling at once never get the same label.
  const [claim] = await env.DB.batch([
    env.DB.prepare(`UPDATE prints SET status = 'sending', sent_at = datetime('now') WHERE id IN (${marks(picked.length)}) AND status = 'queued' RETURNING id`).bind(...picked.map((r) => r.id)),
    env.DB.prepare(`UPDATE jobs SET status = 'printing' WHERE id = ? AND status = 'queued'`).bind(jobId),
  ]);
  const mine = new Set(claim.results.map((r) => r.id));
  const rows = picked.filter((r) => mine.has(r.id));
  if (!rows.length) return json(reply);
  const job = await env.DB.prepare(`SELECT template_id, extra FROM jobs WHERE id = ?`).bind(jobId).first();
  const tpl = await getTemplate(env, job.template_id);
  const extra = JSON.parse(job.extra || "{}");
  const lines = tsplHeader(tpl.cfg, printerSettings(printer));
  const ids = [], bad = [];
  for (const r of rows) {
    try { lines.push(...tsplLabel(buildLabel(tpl.cfg, { serial: r.serial, model: r.model, ...extra }, { stretch: stretchOf(printer) }))); ids.push(r.id); }
    catch (e) { bad.push([r.id, e.message]); }
  }
  for (const [id, msg] of bad) await env.DB.prepare(`UPDATE prints SET status = 'failed', error = ? WHERE id = ?`).bind(msg, id).run();
  if (bad.length && !ids.length) { await finalizeJob(env, jobId); return json(reply); }
  return json({ ...reply, job: { id: jobId, ids, tspl: lines.join("\r\n") + "\r\n" } });
});

route("POST", "/api/agent/ack", "agent", async ({ env, request }) => {
  const printer = await agentPrinter(env, request);
  const b = await body(request);
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean).slice(0, 100);
  if (!ids.length) return json({ ok: true });
  const own = `id IN (${marks(ids.length)}) AND job_id IN (SELECT id FROM jobs WHERE printer_id = ${printer.id})`;
  if (b.ok) {
    await env.DB.prepare(`UPDATE prints SET status = 'printed', printed_at = datetime('now'), error = NULL WHERE ${own}`).bind(...ids).run();
  } else {
    const msg = str(b.error, 200) || "Printer error";
    await env.DB.prepare(
      `UPDATE prints SET attempts = attempts + 1, error = ?, sent_at = NULL, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END WHERE ${own}`
    ).bind(msg, ...ids).run();
  }
  const jobs = await env.DB.prepare(`SELECT DISTINCT job_id FROM prints WHERE id IN (${marks(ids.length)})`).bind(...ids).all();
  for (const j of jobs.results) await finalizeJob(env, j.job_id);
  return json({ ok: true });
});

// ---------- entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      const method = request.method;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let user = null;
        if (r.auth !== "agent") {
          user = await currentUser(env, request);
          if (r.auth === "user" && !user) throw new HttpError(401, "Please sign in");
          if (r.auth === "admin" && (!user || user.role !== "admin")) throw new HttpError(user ? 403 : 401, user ? "Admins only" : "Please sign in");
        }
        if (method !== "GET" && r.auth !== "agent" && request.headers.get("x-ez") !== "1") throw new HttpError(400, "Bad request");
        return await r.handler({ env, request, url, params, user });
      }
      throw new HttpError(404, "Not found");
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },
};
