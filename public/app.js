import { buildLabel, toSvg, checkChars, DEFAULT_TEMPLATE, stretchModule } from "/engine.js";

// ---------- tiny helpers ----------
const $app = document.getElementById("app");
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (["value", "checked", "disabled", "selected", "hidden", "readOnly"].includes(k)) e[k] = v;
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(String(k))); }
  return e;
};
const sel = (options, value, onchange, attrs = {}) => {
  const s = h("select", { ...attrs, onchange: (ev) => onchange(ev.target.value) },
    options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value) }, label)));
  return s;
};
const field = (label, input) => h("div", {}, h("label", { class: "f" }, label), input);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
function toast(msg, kind = "") {
  const box = document.getElementById("toast");
  const d = h("div", { class: kind }, msg);
  box.append(d);
  setTimeout(() => d.remove(), kind === "bad" ? 6000 : 2800);
}
let audio;
function beep(freq = 880, ms = 70) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = 0.05;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* sound is optional */ }
}
const fmtTime = (s) => {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: { "content-type": "application/json", "x-ez": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("No connection. Check the internet and try again."), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { S.user = null; showLogin(); throw Object.assign(new Error("Please sign in"), { handled: true }); }
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong"), { status: res.status, data });
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!e.handled) toast(e.message, "bad"); } };

function modal(title, content, actions) {
  return new Promise((resolve) => {
    const dlg = h("dialog", {}, h("h2", {}, title), content,
      h("div", { class: "actions" }, actions.map(([label, val, cls]) =>
        h("button", { class: "btn " + (cls || ""), onclick: () => { dlg.close(); resolve(val); } }, label))));
    dlg.addEventListener("close", () => { dlg.remove(); resolve(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}
async function ask(title, label, { type = "text", value = "", ok = "Save" } = {}) {
  const inp = h("input", { type, value, autocomplete: "off" });
  const r = await modal(title, field(label, inp), [["Cancel", null], [ok, "ok", "primary"]]);
  return r === "ok" ? inp.value.trim() : null;
}

// ---------- state ----------
const S = { user: null, models: [], templates: [], printers: [], tab: "print", adminTab: "models", timers: [] };
const P = { items: [], dups: {}, model: "", extra: { extra1: "", extra2: "" }, templateId: null, printerId: null, job: null };

function tpl(id = P.templateId) { return S.templates.find((t) => t.id === +id) || S.templates[0]; }
function usesSource(cfg, src) { return cfg.elements.some((e) => e.source === src); }

async function loadBootstrap() {
  const b = await api("GET", "/api/bootstrap");
  S.user = b.user; S.models = b.models; S.templates = b.templates; S.printers = b.printers;
  const savedT = +store.get("ez.template"), savedP = +store.get("ez.printer");
  P.templateId = S.templates.find((t) => t.id === savedT)?.id ?? S.templates[0]?.id;
  P.printerId = S.printers.find((p) => p.id === savedP)?.id ?? S.printers[0]?.id;
  const savedM = store.get("ez.model");
  if (!P.model) P.model = S.models.find((m) => m.code === savedM)?.code ?? S.models[0]?.code ?? "";
}

// ---------- login ----------
async function start() {
  const st = await api("GET", "/api/state").catch((e) => { $app.replaceChildren(h("p", { class: "boot" }, e.message)); return null; });
  if (!st) return;
  if (st.user) { await loadBootstrap(); showMain(); } else showLogin(st.needsSetup);
}

function showLogin(setup) {
  clearTimers();
  const name = h("input", { autocomplete: "username", autocapitalize: "off" });
  const pw = h("input", { type: "password", autocomplete: setup ? "new-password" : "current-password" });
  const err = h("div", { class: "banner bad", hidden: true });
  const go = guard(async () => {
    err.hidden = true;
    try {
      await api("POST", setup ? "/api/setup" : "/api/login", { name: name.value, password: pw.value });
      await loadBootstrap(); showMain();
    } catch (e) { if (e.handled) return; err.textContent = e.message; err.hidden = false; }
  });
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $app.replaceChildren(h("div", { class: "login" },
    h("h1", {}, "EZ Label Printing"),
    h("p", { class: "muted" }, setup ? "First time here. Create the admin account. Do this now, before anyone else opens this page." : "Sign in to print labels."),
    h("div", { class: "card" }, field(setup ? "Your name" : "Name", name), h("div", { style: "height:10px" }),
      field(setup ? "Password (at least 6 characters)" : "Password", pw), err,
      h("button", { class: "btn primary big", style: "width:100%;margin-top:14px", onclick: go }, setup ? "Create admin account" : "Sign in"))));
  name.focus();
}

// ---------- shell ----------
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }

function showMain() {
  clearTimers();
  const tabs = [["print", "Print"], ["history", "History"]];
  if (S.user.role === "admin") tabs.push(["admin", "Admin"]);
  const nav = h("nav", {}, tabs.map(([k, l]) => h("button", { class: S.tab === k ? "on" : "", onclick: guard(async () => { S.tab = k; if (k === "print") await loadBootstrap(); showMain(); }) }, l)));
  const top = h("header", { class: "top" }, h("div", { class: "wrap" },
    h("span", { class: "brand" }, "EZ Labels"), nav,
    h("div", { class: "who" }, h("span", { id: "pstat" }), h("span", { class: "muted" }, S.user.name),
      h("button", { class: "btn small", onclick: guard(async () => { await api("POST", "/api/logout", {}); S.user = null; showLogin(); }) }, "Sign out"))));
  const body = h("div", { class: "wrap", id: "view" });
  $app.replaceChildren(top, body);
  paintStatus();
  if (S.tab === "print") printView(body);
  else if (S.tab === "history") historyView(body);
  else adminView(body);
  S.timers.push(setInterval(refreshStatus, 15000));
}

function printerPill(p) {
  if (!p) return h("span", { class: "pill bad" }, "No printer set up");
  if (!p.online) return h("span", { class: "pill bad" }, `${p.name}: print agent offline`);
  if (p.status && p.status.ok === false) return h("span", { class: "pill warn" }, `${p.name}: ${p.status.text || "printer problem"}`);
  return h("span", { class: "pill ok" }, `${p.name}: ready`);
}
function paintStatus() {
  const el = document.getElementById("pstat");
  if (!el) return;
  el.replaceChildren(printerPill(S.printers.find((p) => p.id === P.printerId) || S.printers[0]));
  const banner = document.getElementById("pbanner");
  if (banner) {
    const p = S.printers.find((x) => x.id === P.printerId);
    if (!p) { banner.textContent = "No printer is set up yet. An admin needs to add one under Admin > Printers."; banner.className = "banner bad"; banner.hidden = false; }
    else if (!p.online) { banner.textContent = "The print agent on the shop PC is not connected. Labels you send will wait in the queue and print when it is back."; banner.className = "banner warn"; banner.hidden = false; }
    else if (p.status && p.status.ok === false) { banner.textContent = `Printer problem: ${p.status.text}. Labels will wait until it is fixed.`; banner.className = "banner warn"; banner.hidden = false; }
    else banner.hidden = true;
  }
}
async function refreshStatus() {
  if (document.hidden) return;
  try { S.printers = (await api("GET", "/api/status")).printers; paintStatus(); } catch { /* keep the last known status */ }
}

// ---------- print view ----------
function printView(root) {
  if (!S.templates.length) { root.append(h("p", { class: "muted" }, "No template yet.")); return; }
  const scan = h("input", { id: "scan", class: "big mono", placeholder: "Scan or type a serial, then press Enter", autocomplete: "off", autocapitalize: "off", spellcheck: false });
  const chips = h("div", { class: "chips" });
  const count = h("span", { class: "muted" });
  const previewBox = h("div", { class: "preview" });
  const previewNote = h("div", { class: "small", style: "margin-top:8px" });
  const printBtn = h("button", { class: "btn primary printbtn", onclick: guard(doPrint) });
  const jobBox = h("div");
  const banner = h("div", { id: "pbanner", class: "banner warn", hidden: true });
  const extraBox = h("div");
  const modelBox = h("div");

  const checkDups = debounce(guard(async () => {
    const need = P.items.map((i) => i.serial).filter((s) => !(s in P.dups));
    if (!need.length) return;
    const r = await api("POST", "/api/check", { serials: need });
    for (const s of need) P.dups[s] = r.dups[s] || null;
    paintChips();
  }), 250);

  function addSerials(text) {
    let added = 0, dupInList = 0, bad = 0;
    for (const raw of text.split(/[\r\n\t]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const [serial, model] = line.includes(",") ? line.split(",").map((x) => x.trim()) : [line, ""];
      try { checkChars(serial, "Serial"); if (model) checkChars(model, "Model"); } catch (e) { bad++; toast(e.message, "bad"); continue; }
      if (P.items.some((i) => i.serial === serial)) { dupInList++; continue; }
      P.items.push({ serial, model: model || "" });
      added++;
    }
    if (dupInList) { toast(`${dupInList} already in the list`, "bad"); beep(300, 150); }
    else if (added && !bad) beep();
    paintChips(); paintPreview(); checkDups();
  }
  scan.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSerials(scan.value); scan.value = ""; } });
  scan.addEventListener("paste", (e) => {
    const t = (e.clipboardData || window.clipboardData).getData("text");
    if (/[\r\n]/.test(t.trim())) { e.preventDefault(); addSerials(t); }
  });

  function paintChips() {
    chips.replaceChildren(...P.items.map((it, i) => {
      const d = P.dups[it.serial];
      return h("span", { class: "chip" + (d ? " dup" : ""), title: d ? `Already printed ${fmtTime(d.printed_at)} by ${d.user}` : "" },
        it.serial + (it.model ? ` (${it.model})` : ""),
        h("button", { "aria-label": "Remove " + it.serial, onclick: () => { P.items.splice(i, 1); paintChips(); paintPreview(); } }, "×"));
    }));
    const nd = P.items.filter((i) => P.dups[i.serial]).length;
    count.textContent = P.items.length ? `${P.items.length} label${P.items.length === 1 ? "" : "s"}` + (nd ? `, ${nd} printed before (amber)` : "") : "";
    printBtn.textContent = P.items.length ? `Print ${P.items.length} label${P.items.length === 1 ? "" : "s"}` : "Print";
    printBtn.disabled = !P.items.length || !!P.blocker;
  }

  const curStretch = () => (S.printers.find((p) => p.id === P.printerId) || S.printers[0])?.stretch || 0;

  function paintPreview() {
    const t = tpl();
    const first = P.items[0];
    const sample = !first;
    const data = { serial: first?.serial || "232003036353997", model: first?.model || P.model || "MODEL-CODE", ...P.extra };
    P.blocker = null;
    previewNote.className = "small";
    try {
      const label = buildLabel(t.config, data, { stretch: curStretch() });
      previewBox.replaceChildren(); previewBox.insertAdjacentHTML("beforeend", toSvg(label, 1.6));
      previewNote.textContent = (sample ? "Sample preview. " : "First label. ") + `${t.config.w} x ${t.config.h} mm.` + (label.warnings.length ? " " + label.warnings[0] : "");
      if (label.warnings.length) previewNote.className = "small";
    } catch (e) {
      previewBox.replaceChildren();
      previewNote.textContent = e.message; previewNote.className = "small banner bad";
      P.blocker = e.message;
    }
    // every label must be buildable
    if (!P.blocker) for (const it of P.items) {
      try { buildLabel(t.config, { serial: it.serial, model: it.model || P.model, ...P.extra }, { stretch: curStretch() }); }
      catch (e) { P.blocker = `${it.serial}: ${e.message}`; previewNote.textContent = P.blocker; previewNote.className = "small banner bad"; break; }
    }
    printBtn.disabled = !P.items.length || !!P.blocker;
  }

  function paintOptions() {
    const t = tpl();
    modelBox.replaceChildren();
    if (usesSource(t.config, "model")) {
      const s = sel(S.models.map((m) => [m.code, m.code]).concat([["", S.models.length ? "Choose model..." : "No models yet"]]), P.model, (v) => { P.model = v; store.set("ez.model", v); paintPreview(); });
      modelBox.append(h("label", { class: "f" }, "Model"), h("div", { class: "row" },
        h("div", {}, s),
        h("button", { class: "btn fit", onclick: guard(async () => {
          const code = await ask("Add a model", "Model code", { ok: "Add" });
          if (!code) return;
          await api("POST", "/api/models", { code });
          S.models = (await api("GET", "/api/bootstrap")).models; P.model = code; store.set("ez.model", code); paintOptions(); paintPreview();
        }) }, "Add new")));
    }
    extraBox.replaceChildren();
    for (const k of ["extra1", "extra2"]) if (usesSource(t.config, k)) {
      extraBox.append(field(t.config.labels?.[k] || k, h("input", { value: P.extra[k], oninput: (e) => { P.extra[k] = e.target.value; paintPreview(); } })), h("div", { style: "height:8px" }));
    }
  }

  async function doPrint(force) {
    const body = { template_id: P.templateId, printer_id: P.printerId, model: P.model, extra: P.extra, items: P.items, allow_dups: force === true };
    printBtn.disabled = true;
    try {
      const r = await api("POST", "/api/print", body);
      P.items = []; P.dups = {}; paintChips(); paintPreview();
      trackJob(r.job_id, r.total);
      scan.focus();
    } catch (e) {
      if (e.status === 409) {
        const list = Object.entries(e.data.dups).slice(0, 8).map(([s, d]) => h("li", {}, h("span", { class: "mono" }, s), ` (${fmtTime(d.printed_at) || "queued"}, ${d.user})`));
        const r = await modal("Already printed", h("div", {}, h("p", {}, e.message + ":"), h("ul", {}, list)),
          [["Cancel", null], ["Remove them from the list", "remove"], ["Print anyway", "force", "primary"]]);
        if (r === "force") return doPrint(true);
        if (r === "remove") { P.items = P.items.filter((i) => !(i.serial in e.data.dups)); paintChips(); paintPreview(); }
      } else throw e;
    } finally { printBtn.disabled = !P.items.length || !!P.blocker; }
  }

  function trackJob(id, total) {
    P.job = { id, total };
    const bar = h("i"), line = h("div");
    const cancel = h("button", { class: "btn small", onclick: guard(async () => { await api("POST", `/api/jobs/${id}/cancel`, {}); }) }, "Cancel the rest");
    const card = h("div", { class: "card" }, h("h3", {}, "Print job"), line, h("div", { class: "progress" }, bar), cancel);
    jobBox.replaceChildren(card);
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const j = await api("GET", `/api/jobs/${id}`);
        const c = j.counts, done = c.printed || 0, failed = c.failed || 0, cancelled = c.cancelled || 0;
        bar.style.width = `${Math.round(((done + failed + cancelled) / total) * 100)}%`;
        const parts = [`${done} of ${total} printed`];
        if (c.sending) parts.push(`${c.sending} sending`);
        if (c.queued) parts.push(`${c.queued} waiting`);
        if (failed) parts.push(`${failed} failed`);
        if (cancelled) parts.push(`${cancelled} cancelled`);
        line.textContent = parts.join(", ");
        if (j.status === "done") {
          stop = true; cancel.hidden = true;
          card.className = "card";
          line.className = failed ? "banner bad" : "banner ok";
          line.textContent = failed ? `${done} printed, ${failed} failed${j.error ? ": " + j.error : ""}. Failed serials can be printed again.` : `All ${done} labels printed.`;
          return;
        }
      } catch (e) { if (e.handled) { stop = true; return; } }
      setTimeout(tick, 1500);
    };
    tick();
  }

  // layout
  const tplSel = S.templates.length > 1 ? field("Label", sel(S.templates.map((t) => [t.id, t.name]), P.templateId, (v) => { P.templateId = +v; store.set("ez.template", v); paintOptions(); paintPreview(); })) : null;
  const prSel = S.printers.length > 1 ? field("Printer", sel(S.printers.map((p) => [p.id, p.name]), P.printerId, (v) => { P.printerId = +v; store.set("ez.printer", v); paintStatus(); })) : null;
  root.append(banner,
    h("div", { class: "split" },
      h("div", {},
        h("div", { class: "card" },
          (tplSel || prSel) && h("div", { class: "row", style: "margin-bottom:12px" }, tplSel, prSel),
          modelBox, extraBox,
          h("label", { class: "f" }, "Serial numbers"), scan,
          h("div", { class: "small muted", style: "margin-top:6px" }, "A scanner works here. You can also paste a list, one serial per line."),
          h("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-top:10px" }, count,
            h("button", { class: "btn small", onclick: () => { P.items = []; P.dups = {}; paintChips(); paintPreview(); scan.focus(); } }, "Clear list")),
          chips, printBtn),
        jobBox),
      h("div", { class: "card" }, h("h3", {}, "Preview"), previewBox, previewNote)));
  paintOptions(); paintChips(); paintPreview(); paintStatus();
  scan.focus();
}

// ---------- history ----------
function historyView(root) {
  const q = h("input", { placeholder: "Search a serial or model", autocomplete: "off" });
  const box = h("div", { class: "tablewrap" });
  const info = h("span", { class: "muted small" });
  const chosen = new Set();
  const reBtn = h("button", { class: "btn primary", disabled: true }, "Reprint selected");
  const statusPill = (s) => h("span", { class: "pill " + ({ printed: "ok", failed: "bad", queued: "warn", sending: "warn" }[s] || "") }, s);
  const load = guard(async () => {
    const r = await api("GET", "/api/history?limit=150&q=" + encodeURIComponent(q.value.trim()));
    chosen.clear(); reBtn.disabled = true;
    info.textContent = r.rows.length ? `Showing the latest ${r.rows.length}` : "Nothing found";
    box.replaceChildren(h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Time"), h("th", {}, "Serial"), h("th", {}, "Model"), h("th", {}, "Printed by"), h("th", {}, "Status"))),
      h("tbody", {}, r.rows.map((x) => h("tr", {},
        h("td", {}, h("input", { type: "checkbox", "aria-label": "Select " + x.serial, onchange: (e) => { e.target.checked ? chosen.add(x.id) : chosen.delete(x.id); reBtn.disabled = !chosen.size; } })),
        h("td", {}, fmtTime(x.printed_at || x.created)), h("td", { class: "mono" }, x.serial), h("td", { class: "mono" }, x.model),
        h("td", {}, x.user + (x.reprint ? " (reprint)" : "")), h("td", {}, statusPill(x.status), x.error ? h("div", { class: "small muted" }, x.error) : null))))));
  });
  q.addEventListener("input", debounce(load, 300));
  reBtn.addEventListener("click", guard(async () => {
    const pr = S.printers.find((p) => p.id === P.printerId) || S.printers[0];
    if (!pr) throw new Error("No printer is set up");
    const r = await api("POST", "/api/reprint", { ids: [...chosen], printer_id: pr.id });
    toast(`${r.total} label${r.total === 1 ? "" : "s"} sent to ${pr.name}`);
    setTimeout(load, 2500);
  }));
  root.append(h("div", { class: "card" }, h("h2", {}, "History"),
    h("div", { class: "row" }, q, h("button", { class: "btn fit", onclick: load }, "Refresh"), h("div", { class: "fit" }, reBtn)), h("div", { style: "margin-top:8px" }, info), box));
  load();
}

// ---------- admin ----------
function adminView(root) {
  const tabs = [["models", "Models"], ["templates", "Label templates"], ["printers", "Printers"], ["users", "Staff"]];
  const body = h("div");
  const bar = h("div", { class: "tabs2" }, tabs.map(([k, l]) => h("button", { class: S.adminTab === k ? "on" : "", onclick: () => { S.adminTab = k; showMain(); } }, l)));
  root.append(bar, body);
  ({ models: adminModels, templates: adminTemplates, printers: adminPrinters, users: adminUsers })[S.adminTab](body);
}

function adminModels(root) {
  const list = h("div");
  const paint = () => list.replaceChildren(h("table", {}, h("tbody", {}, S.models.map((m) => h("tr", {},
    h("td", { class: "mono" }, m.code),
    h("td", { style: "text-align:right" }, h("button", { class: "btn small danger", onclick: guard(async () => {
      if (await modal("Remove model", h("p", {}, `Remove ${m.code} from the list? Old labels stay in the history.`), [["Cancel", null], ["Remove", "ok", "danger"]]) !== "ok") return;
      await api("DELETE", `/api/models/${m.id}`); S.models = S.models.filter((x) => x.id !== m.id); paint();
    }) }, "Remove")))))));
  const inp = h("input", { placeholder: "New model code", autocomplete: "off" });
  const add = guard(async () => {
    if (!inp.value.trim()) return;
    await api("POST", "/api/models", { code: inp.value.trim() });
    S.models = (await api("GET", "/api/bootstrap")).models; inp.value = ""; paint();
  });
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  paint();
  root.append(h("div", { class: "card" }, h("h2", {}, "Models"), h("p", { class: "muted small" }, "These appear in the model list on the Print page. Any staff member can add one there."),
    h("div", { class: "row" }, inp, h("button", { class: "btn primary fit", onclick: add }, "Add model")), list));
}

const SRC_LABEL = { serial: "Serial number", model: "Model", extra1: "Extra field 1", extra2: "Extra field 2", fixed: "Fixed text" };

async function adminTemplates(root) {
  const all = (await api("GET", "/api/templates/all")).templates.filter((t) => !t.archived);
  const box = h("div");
  root.append(box);
  const list = () => {
    box.replaceChildren(h("div", { class: "card" }, h("h2", {}, "Label templates"),
      h("p", { class: "muted small" }, "A template sets the label size and what goes on it. Staff pick one on the Print page. The size here is the label stock; the printer's own paper setting no longer matters."),
      h("table", {}, h("tbody", {}, all.map((t) => h("tr", {},
        h("td", {}, t.name), h("td", { class: "muted" }, `${t.config.w} x ${t.config.h} mm, ${t.config.elements.filter((e) => e.type === "barcode").length} barcode(s)`),
        h("td", { style: "text-align:right" }, h("button", { class: "btn small", onclick: () => edit(t) }, "Edit"))))) ),
      h("div", { style: "margin-top:12px" }, h("button", { class: "btn primary", onclick: () => edit(null) }, "New template"))));
  };
  function edit(t) {
    const cfg = JSON.parse(JSON.stringify(t ? t.config : DEFAULT_TEMPLATE));
    let name = t ? t.name : "";
    const prev = h("div", { class: "preview" }), note = h("div", { class: "small", style: "margin-top:8px" });
    const els = h("div"), extraLabels = h("div");
    const sample = { serial: "232003036353997", model: "CM4X16GC3200C16K2E", extra1: "SKU12345", extra2: "BATCH01" };
    const paintPrev = () => {
      try {
        const l = buildLabel(cfg, sample);
        prev.replaceChildren(); prev.insertAdjacentHTML("beforeend", toSvg(l, 1.6));
        note.className = "small"; note.textContent = `${cfg.w} x ${cfg.h} mm.` + (l.warnings[0] ? " " + l.warnings[0] : "");
      } catch (e) { prev.replaceChildren(); note.className = "small banner bad"; note.textContent = e.message; }
    };
    const paintEls = () => {
      els.replaceChildren(...cfg.elements.map((e, i) => h("div", { class: "el" },
        sel([["barcode", "Barcode"], ["text", "Text line"]], e.type, (v) => { e.type = v; if (v === "barcode" && e.text === undefined) e.text = true; paintEls(); paintPrev(); }),
        sel(Object.entries(SRC_LABEL), e.source, (v) => { e.source = v; if (v === "fixed" && !e.value) e.value = "Made in China"; paintEls(); paintPrev(); }),
        e.source === "fixed" ? h("input", { value: e.value || "", oninput: (ev) => { e.value = ev.target.value; paintPrev(); } })
          : (e.type === "barcode" ? h("label", { class: "small" }, h("input", { type: "checkbox", checked: e.text !== false, onchange: (ev) => { e.text = ev.target.checked; paintPrev(); } }), " Print the value under the bars") : h("span", { class: "muted small" }, "Printed as text")),
        h("span", {}, h("button", { class: "btn small", disabled: i === 0, onclick: () => { cfg.elements.splice(i - 1, 0, cfg.elements.splice(i, 1)[0]); paintEls(); paintPrev(); } }, "Up"), " ",
          h("button", { class: "btn small", disabled: i === cfg.elements.length - 1, onclick: () => { cfg.elements.splice(i + 1, 0, cfg.elements.splice(i, 1)[0]); paintEls(); paintPrev(); } }, "Down")),
        h("button", { class: "btn small danger", onclick: () => { cfg.elements.splice(i, 1); paintEls(); paintPrev(); } }, "Remove"))));
      extraLabels.replaceChildren(...["extra1", "extra2"].filter((k) => cfg.elements.some((e) => e.source === k)).map((k) =>
        field(`Name for ${SRC_LABEL[k]} (staff see this when printing)`, h("input", { value: cfg.labels?.[k] || "", oninput: (ev) => { cfg.labels = { ...cfg.labels, [k]: ev.target.value }; } }))));
    };
    const num = (k, label) => field(label, h("input", { type: "number", step: "0.5", value: cfg[k], oninput: (e) => { cfg[k] = +e.target.value; paintPrev(); } }));
    const save = guard(async () => {
      const b = { name, config: cfg };
      if (t) await api("PUT", `/api/templates/${t.id}`, b); else await api("POST", "/api/templates", b);
      toast("Template saved");
      S.templates = (await api("GET", "/api/bootstrap")).templates;
      S.tab = "admin"; S.adminTab = "templates"; showMain();
    });
    box.replaceChildren(h("div", { class: "card" }, h("h2", {}, t ? "Edit template" : "New template"),
      h("div", { class: "row" }, field("Name", h("input", { value: name, oninput: (e) => { name = e.target.value; } })), num("w", "Width (mm)"), num("h", "Height (mm)"), num("gap", "Gap between labels (mm)")),
      h("h3", { style: "margin-top:16px" }, "Items on the label, top to bottom"), els,
      h("button", { class: "btn small", onclick: () => { if (cfg.elements.length < 8) { cfg.elements.push({ type: "barcode", source: "serial", text: true }); paintEls(); paintPrev(); } } }, "Add item"),
      h("div", { style: "margin-top:12px" }, extraLabels),
      h("h3", { style: "margin-top:16px" }, "Preview"), prev, note,
      h("p", { class: "muted small" }, "More barcodes on a small label means thinner bars, which scan slower. The preview warns you when that happens."),
      h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn primary fit", onclick: save }, "Save template"), h("button", { class: "btn fit", onclick: () => { S.adminTab = "templates"; showMain(); } }, "Cancel"),
        t && all.length > 1 ? h("button", { class: "btn danger fit", onclick: guard(async () => {
          if (await modal("Delete template", h("p", {}, `Delete "${t.name}"? Old labels stay in the history.`), [["Cancel", null], ["Delete", "ok", "danger"]]) !== "ok") return;
          await api("DELETE", `/api/templates/${t.id}`); S.templates = (await api("GET", "/api/bootstrap")).templates; S.adminTab = "templates"; showMain();
        }) }, "Delete") : null)));
    paintEls(); paintPrev();
  }
  list();
}

async function adminPrinters(root) {
  const { printers } = await api("GET", "/api/status");
  S.printers = printers;
  const showKey = (key) => modal("Printer key", h("div", {}, h("p", {}, "Copy this key into the agent on the shop PC. It is shown only once."), h("code", { class: "k" }, key)), [["Done", "ok", "primary"]]);
  const cards = printers.map((p) => {
    const f = { name: p.name, density: p.density, speed: p.speed, direction: p.direction, ox: p.ox, oy: p.oy, stretch: p.stretch || 0 };
    const numIn = (k, label, min, max) => field(label, h("input", { type: "number", min, max, value: f[k], oninput: (e) => { f[k] = +e.target.value; } }));
    return h("div", { class: "card" }, h("div", { style: "display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap" }, h("h2", {}, p.name), printerPill(p)),
      p.last_seen ? h("p", { class: "muted small" }, "Last contact: " + fmtTime(p.last_seen)) : h("p", { class: "muted small" }, "The agent has never connected."),
      h("div", { class: "row" }, field("Name", h("input", { value: f.name, oninput: (e) => { f.name = e.target.value; } })),
        numIn("density", "Darkness (0-15)", 0, 15), numIn("speed", "Speed (1-6)", 1, 6),
        field("Direction", sel([[1, "Normal"], [0, "Flipped (use if upside down)"]], f.direction, (v) => { f.direction = +v; })),
        numIn("ox", "Shift right (dots, 8 = 1 mm)", -80, 80), numIn("oy", "Shift down (dots)", -80, 80),
        field("Thin barcodes (long serials)", sel([[0, "Normal (1-dot bars)"], [1, "Stretch: mild (S2)"], [2, "Stretch: medium (S3)"], [3, "Stretch: wide (S4)"]], f.stretch, (v) => { f.stretch = +v; }))),
      h("div", { class: "row", style: "margin-top:12px" },
        h("button", { class: "btn primary fit", onclick: guard(async () => { await api("PUT", `/api/printers/${p.id}`, f); toast("Saved"); }) }, "Save settings"),
        h("button", { class: "btn fit", onclick: guard(async () => {
          const t = tpl();
          const model = S.models[0]?.code || "MODEL";
          const r = await modal("Print the darkness test", h("p", {}, "Prints 4 identical labels at darkness 4, 6, 8 and 10, marked D4 to D10. Scan each one. Set Darkness above to the one that scans fastest."), [["Cancel", null], ["Print 4 labels", "ok", "primary"]]);
          if (r !== "ok") return;
          await api("POST", `/api/printers/${p.id}/tune`, { template_id: t.id, serial: "232003036353997", model });
          toast("Test labels sent");
        }) }, "Darkness test"),
        h("button", { class: "btn fit", onclick: guard(async () => {
          const t = tpl();
          const model = S.models[0]?.code || "MODEL";
          const serialIn = h("input", { value: "EE7B2010260012" });
          const r = await modal("Stretch test for long serials", h("div", {},
            h("p", {}, "Prints 4 labels with the barcode at normal width (S1) and stretched wider (S2, S3, S4). Scan each one with the scanner you use. Then set Thin barcodes above to the one that scans best and click Save settings."),
            h("p", { class: "muted small" }, "Type a long serial, one with letters that prints with thin bars:"), serialIn), [["Cancel", null], ["Print 4 labels", "ok", "primary"]]);
          if (r !== "ok") return;
          await api("POST", `/api/printers/${p.id}/tune`, { template_id: t.id, serial: serialIn.value.trim(), model, mode: "stretch" });
          toast("Test labels sent");
        }) }, "Stretch test"),
        h("button", { class: "btn fit", onclick: guard(async () => { if (await modal("New key", h("p", {}, "This replaces the old key. The agent on the shop PC stops working until you paste the new one in."), [["Cancel", null], ["Make new key", "ok"]]) === "ok") showKey((await api("POST", `/api/printers/${p.id}/key`, {})).key); }) }, "New key"),
        printers.length > 1 ? h("button", { class: "btn danger fit", onclick: guard(async () => { if (await modal("Remove printer", h("p", {}, `Remove ${p.name}? Its waiting labels are cancelled.`), [["Cancel", null], ["Remove", "ok", "danger"]]) === "ok") { await api("DELETE", `/api/printers/${p.id}`); showMain(); } }) }, "Remove") : null));
  });
  const nameIn = h("input", { placeholder: "Printer name, for example Counter" });
  root.append(...cards, h("div", { class: "card" }, h("h2", {}, "Add a printer"),
    h("p", { class: "muted small" }, "Each printer has its own PC agent and key. Add one when you set up a second printer or shop."),
    h("div", { class: "row" }, nameIn, h("button", { class: "btn primary fit", onclick: guard(async () => { const r = await api("POST", "/api/printers", { name: nameIn.value }); await showKey(r.key); showMain(); }) }, "Add printer"))));
}

async function adminUsers(root) {
  const { users } = await api("GET", "/api/users");
  const name = h("input", { autocomplete: "off" }), pw = h("input", { type: "text", autocomplete: "off" });
  let role = "staff";
  root.append(h("div", { class: "card" }, h("h2", {}, "Staff"),
    h("div", { class: "tablewrap" }, h("table", {}, h("tbody", {}, users.map((u) => h("tr", {},
      h("td", {}, u.name), h("td", {}, u.role === "admin" ? h("span", { class: "pill" }, "admin") : "staff"), h("td", {}, u.active ? "" : h("span", { class: "pill bad" }, "disabled")),
      h("td", { style: "text-align:right;white-space:nowrap" },
        h("button", { class: "btn small", onclick: guard(async () => { const p = await ask(`New password for ${u.name}`, "Password (at least 4 characters)", { ok: "Change" }); if (p) { await api("PUT", `/api/users/${u.id}`, { password: p }); toast("Password changed"); } }) }, "Reset password"), " ",
        u.id !== S.user.id ? h("button", { class: "btn small " + (u.active ? "danger" : ""), onclick: guard(async () => { await api("PUT", `/api/users/${u.id}`, { active: !u.active }); showMain(); }) }, u.active ? "Disable" : "Enable") : null)))))),
    h("h3", { style: "margin-top:16px" }, "Add a staff member"),
    h("div", { class: "row" }, field("Name", name), field("Password", pw), field("Role", sel([["staff", "Staff"], ["admin", "Admin"]], role, (v) => { role = v; })),
      h("button", { class: "btn primary fit", onclick: guard(async () => { await api("POST", "/api/users", { name: name.value, password: pw.value, role }); toast("Staff member added"); showMain(); }) }, "Add"))));
}

// ---------- go ----------
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.user) refreshStatus(); });
start();
