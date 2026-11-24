// Run: node test/poll-race.test.mjs   (starts its own wrangler dev on a throwaway database)
// Ten agents poll the same printer at once. Every label must be handed out exactly once.
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import http from "node:http";

const PORT = 8798, B = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "ezl-test-"));
const win = process.platform === "win32";
const dev = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", String(PORT), "--persist-to", dir],
  { stdio: "ignore", detached: !win });
const stop = () => {
  try { win ? execSync(`taskkill /pid ${dev.pid} /T /F`, { stdio: "ignore" }) : process.kill(-dev.pid); } catch { /* already gone */ }
};

let cookie = "";
async function call(method, path, body) {
  const r = await fetch(B + path, { method, headers: { "content-type": "application/json", "x-ez": "1", cookie }, body: body && JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return r.json();
}

// Each poll on its own connection, like separate agents. A shared keep-alive connection would queue them.
const poll = (key) => new Promise((resolve, reject) => {
  const req = http.request(B + "/api/agent/poll", { method: "POST", agent: false, headers: { "content-type": "application/json", authorization: "Bearer " + key } }, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve(JSON.parse(d)));
  });
  req.on("error", reject);
  req.end(JSON.stringify({ want_job: true, status: { ok: true, text: "Ready" } }));
});

try {
  for (let i = 0; ; i++) {
    try { await fetch(B + "/api/state"); break; } catch { if (i > 60) throw new Error("wrangler dev did not start"); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await call("POST", "/api/setup", { name: "Admin", password: "test-pass-123" });
  const { key } = await call("POST", "/api/printers", { name: "Test" });

  // The race depends on timing, so try it several times. Each round queues 5 new labels.
  for (let round = 1; round <= 20; round++) {
    const serials = [1, 2, 3, 4, 5].map((n) => `R${round}-${n}`);
    await call("POST", "/api/print", { template_id: 1, printer_id: 1, model: "M1", items: serials });
    const replies = await Promise.all(Array.from({ length: 10 }, () => poll(key)));
    const ids = replies.flatMap((r) => r.job?.ids || []);
    assert.equal(new Set(ids).size, ids.length, `round ${round}: a label was handed out twice: ${ids}`);
    assert.equal(ids.length, serials.length, `round ${round}: expected ${serials.length} labels, got ${ids.length}`);
  }
  console.log("poll race test passed");
} finally {
  stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold a file */ }
}
