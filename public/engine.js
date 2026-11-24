// Label engine: Code 128 encoding, layout, TSPL output. Used by the browser preview AND the server,
// so what you see on screen is exactly what the printer gets.

export const DOTS_PER_MM = 8;          // XP-365B is 203 dpi = 8 dots per mm
export const MIN_QUIET = 16;           // blank dots kept each side of a barcode (2 mm)
export const MAX_MODULE = 3;           // thickest bar tried, in dots
// Built-in printer fonts. cw = real width of one character on the XP-365B, in dots. Font 2 was measured
// from a printed label (about 13.4 dots, not the 12 in the manual). Font 1 is scaled by the same ratio.
const FONTS = { 2: { cw: 13.4, ch: 20 }, 1: { cw: 9, ch: 12 } };
const TEXT_MARGIN = 12;                // keep text at least this many dots from each edge

const PATTERNS = "212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,221312,231212,112232,122132,122231,113222,123122,123221,223211,221132,221231,213212,223112,312131,311222,321122,321221,312212,322112,322211,212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,231113,231311,112133,112331,132131,113123,113321,133121,313121,211331,231131,213113,213311,213131,311123,311321,331121,312113,312311,332111,314111,221411,431111,111224,111422,121124,121421,141122,141221,112214,112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,111242,121142,121241,114212,124112,124211,411212,421112,421211,212141,214121,412121,111143,111341,131141,114113,114311,411113,411311,113141,114131,311141,411131,211412,211214,211232,2331112".split(",");

export const SOURCES = ["serial", "model", "extra1", "extra2", "fixed"];

export function cleanValue(v) {
  return String(v ?? "").trim();
}

export function checkChars(text, what) {
  if (!text) throw new Error(`${what} is empty`);
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error(`${what} "${text}" has a character a barcode can't hold`);
    if (ch === '"') throw new Error(`${what} can't contain a double quote`);
  }
}

// Shortest Code 128 symbol list (start, data, check, stop) using sets B and C.
export function encode128(text) {
  const n = text.length;
  const dig = (i) => { const c = text.charCodeAt(i); return c >= 48 && c <= 57; };
  const val = (i) => text.charCodeAt(i) - 32;
  const B = new Array(n + 1).fill(null), C = new Array(n + 1).fill(null);
  B[0] = [104];
  C[0] = [105];
  const put = (arr, i, syms) => { if (!arr[i] || syms.length < arr[i].length) arr[i] = syms; };
  for (let i = 0; i <= n; i++) {
    if (B[i] && i < n) {
      put(B, i + 1, [...B[i], val(i)]);
      if (i < n - 1 && dig(i) && dig(i + 1)) put(C, i + 2, [...B[i], 99, +text.slice(i, i + 2)]);
    }
    if (C[i] && i < n) {
      if (i < n - 1 && dig(i) && dig(i + 1)) put(C, i + 2, [...C[i], +text.slice(i, i + 2)]);
      put(B, i + 1, [...C[i], 100, val(i)]);
    }
  }
  let syms = B[n] && C[n] ? (B[n].length <= C[n].length ? B[n] : C[n]) : (B[n] || C[n]);
  syms = [...syms];
  let sum = syms[0];
  for (let k = 1; k < syms.length; k++) sum += syms[k] * k;
  syms.push(sum % 103, 106);
  return syms;
}

// Bar/space widths in modules, alternating bar, space, bar ... (starts and ends with a bar)
const widthCache = new Map();     // the model code is the same on every label, so this saves most of the work
export function code128Widths(text) {
  let out = widthCache.get(text);
  if (out) return out;
  checkChars(text, "Barcode value");
  out = [];
  for (const s of encode128(text)) for (const ch of PATTERNS[s]) out.push(+ch);
  if (widthCache.size > 2000) widthCache.clear();
  widthCache.set(text, out);
  return out;                    // shared: callers must not change it
}

export function bestModule(text, W) {
  const n = code128Widths(text).reduce((a, b) => a + b, 0);
  for (let m = MAX_MODULE; m >= 1; m--) if (n * m + 2 * MIN_QUIET <= W) return m;
  return n + 16 <= W ? 1 : 0;     // last resort: 1 mm blank each side
}

// Thin barcodes: a serial that only fits with 1-dot bars can be widened by a fractional factor.
// The printer only makes whole dots, so bars come out 1 or 2 dots wide. Level 1, 2 and 3 are mild
// (1.4-1.6x), medium (1.6-1.8x) and wide (1.84x up to what fits with a 2 mm blank margin). Inside the
// band this picks the factor whose rounding distorts the bar widths least for this particular code.
const BANDS = { 1: [1.4, 1.6], 2: [1.6, 1.8], 3: [1.84, 9] };
const stretchCache = new Map();
function distortion(w, m) {
  const e = [0];
  for (const x of w) e.push(e[e.length - 1] + x);
  const r = e.map((c) => Math.round(c * m));
  let worst = 0;
  for (let k = 0; k + 2 < e.length; k++) {
    const ideal = (e[k + 2] - e[k]) * m;
    worst = Math.max(worst, Math.abs(r[k + 2] - r[k] - ideal) / ideal);
  }
  return worst;
}
export function stretchModule(text, W, level) {
  const key = `${text}|${W}|${level}`;
  let out = stretchCache.get(key);
  if (out !== undefined) return out;
  const w = code128Widths(text);
  const n = w.reduce((a, b) => a + b, 0);
  const fit = Math.floor(((W - 2 * MIN_QUIET) / n) * 100) / 100;     // widest that keeps a 2 mm margin
  let [lo, hi] = BANDS[level] || [0, 0];
  hi = Math.min(hi, fit);
  if (lo > hi) lo = 1.4;                                              // band does not fit: use what does
  out = 0;
  if (lo && hi >= 1.4) {
    let bestErr = Infinity;
    const cands = [];
    for (let m = lo; m < hi - 1e-9; m += 0.02) cands.push(Math.round(m * 100) / 100);
    cands.push(Math.floor(hi * 100) / 100);
    for (const m of cands) { const err = distortion(w, m); if (err < bestErr - 1e-9) { bestErr = err; out = m; } }
  }
  if (stretchCache.size > 2000) stretchCache.clear();
  stretchCache.set(key, out);
  return out;
}

function pickFont(text, W) {
  for (const f of [2, 1]) if (text.length * FONTS[f].cw <= W - 2 * TEXT_MARGIN) return f;
  throw new Error(`Text "${text}" is too long to print on this label`);
}

export function labelSize(cfg) {
  return { W: Math.round(cfg.w * DOTS_PER_MM), H: Math.round(cfg.h * DOTS_PER_MM) };
}

function resolve(el, data) {
  const what = el.source === "fixed" ? "Fixed text" : ({ serial: "Serial", model: "Model", extra1: "Extra field 1", extra2: "Extra field 2" })[el.source];
  const v = cleanValue(el.source === "fixed" ? el.value : data[el.source]);
  if (!v) throw new Error(`${what} is empty`);
  return v;
}

// Build one label: bars and texts in printer dots.
export function buildLabel(cfg, data, opts = {}) {
  const { W, H } = labelSize(cfg);
  const els = cfg.elements || [];
  if (!els.length) throw new Error("Template has no elements");
  const margin = 8, gapMin = 6, TH = 20, PAD = 4;
  const vals = els.map((el) => resolve(el, data));
  const nBar = els.filter((e) => e.type === "barcode").length;
  let fixed = 0;
  els.forEach((e) => { fixed += e.type === "barcode" ? (e.text === false ? 0 : PAD + TH) : TH; });
  const free = H - 2 * margin - fixed - gapMin * (els.length - 1);
  let barH = 0;
  if (nBar) {
    barH = Math.min(64, Math.floor(free / nBar));
    if (barH < 20) throw new Error("Too many items for this label height. Remove one or use a taller label.");
  }
  const total = fixed + nBar * barH;
  const gap = Math.max(gapMin, Math.floor((H - total) / (els.length + 1)));
  const bars = [], texts = [], warnings = [];
  const thin = [];
  const stretched = [];
  let y = Math.floor((H - total - gap * (els.length - 1)) / 2);
  if (y < margin) y = margin;
  els.forEach((el, i) => {
    const v = vals[i];
    if (el.type === "barcode") {
      checkChars(v, "Barcode value");
      let m = bestModule(v, W);
      if (!m) throw new Error(`"${v}" is too long to fit as a barcode on a ${cfg.w} mm label`);
      const name = ({ serial: "serial", model: "model", extra1: "extra field 1", extra2: "extra field 2", fixed: "fixed text" })[el.source];
      if (m === 1 && opts.stretch >= 1) {
        const sm = stretchModule(v, W, opts.stretch);
        if (sm) { m = sm; stretched.push(sm); }
      }
      if (m === 1) thin.push(name);
      const wd = code128Widths(v);
      const x0 = Math.floor((W - wd.reduce((a, b) => a + b, 0) * m) / 2);
      let c = 0;
      wd.forEach((w, k) => { const a = x0 + Math.round(c * m), b = x0 + Math.round((c + w) * m); if (k % 2 === 0) bars.push([a, y, b - a, barH]); c += w; });
      y += barH;
      if (el.text !== false) {
        checkChars(v, "Text");
        const f = pickFont(v, W);
        texts.push([Math.floor((W - v.length * FONTS[f].cw) / 2), y + PAD, f, v]);
        y += PAD + TH;
      }
    } else {
      checkChars(v, "Text");
      const f = pickFont(v, W);
      texts.push([Math.floor((W - v.length * FONTS[f].cw) / 2), y, f, v]);
      y += TH;
    }
    y += gap;
  });
  if (thin.length) warnings.push(`Thinnest bars on the ${thin.join(" and ")} barcode: it scans slower on a 203 dpi printer.`);
  if (stretched.length) warnings.push(`A barcode is stretched ${stretched[0]}x. Scan-test it before a big batch.`);
  return { W, H, bars, texts, warnings, stretched };
}

export function tsplHeader(cfg, s) {
  return [
    `SIZE ${cfg.w} mm,${cfg.h} mm`, `GAP ${cfg.gap ?? 2} mm,0 mm`, `SPEED ${s.speed ?? 2}`,
    `DENSITY ${s.density ?? 6}`, `DIRECTION ${s.direction ?? 1}`, `REFERENCE ${s.ox ?? 0},${s.oy ?? 0}`, "SET TEAR ON",
  ];
}

export function tsplLabel(label, density, note) {
  const out = ["CLS"];
  if (density != null) out.push(`DENSITY ${density}`);
  for (const [x, y, w, h] of label.bars) out.push(`BAR ${x},${y},${w},${h}`);
  for (const [x, y, f, t] of label.texts) out.push(`TEXT ${x},${y},"${f}",0,1,1,"${t}"`);
  if (note) out.push(`TEXT 4,${label.H - 14},"1",0,1,1,"${note}"`);
  out.push("PRINT 1,1");
  return out;
}

export function toSvg(label, scale = 3) {
  const { W, H } = label;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W / scale * 1.0}" height="${H / scale * 1.0}" shape-rendering="crispEdges" role="img" aria-label="Label preview"><rect width="${W}" height="${H}" fill="#fff"/>`;
  for (const [x, y, w, h] of label.bars) s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`;
  for (const [x, y, f, t] of label.texts) {
    const { cw, ch } = FONTS[f];
    const esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    s += `<text x="${x}" y="${y + ch * 0.82}" font-family="DejaVu Sans Mono, Consolas, monospace" font-size="${ch * 0.85}" textLength="${t.length * cw}" lengthAdjust="spacingAndGlyphs" fill="#000">${esc}</text>`;
  }
  return s + "</svg>";
}

export const DEFAULT_TEMPLATE = {
  w: 39, h: 30, gap: 2,
  labels: { extra1: "Extra field 1", extra2: "Extra field 2" },
  elements: [
    { type: "barcode", source: "model", text: true },
    { type: "barcode", source: "serial", text: true },
    { type: "text", source: "fixed", value: "Made in China" },
  ],
};

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("Template is missing");
  const w = Number(cfg.w), h = Number(cfg.h), gap = Number(cfg.gap ?? 2);
  if (!(w >= 20 && w <= 76)) throw new Error("Label width must be between 20 and 76 mm");
  if (!(h >= 10 && h <= 200)) throw new Error("Label height must be between 10 and 200 mm");
  if (!(gap >= 0 && gap <= 10)) throw new Error("Gap must be between 0 and 10 mm");
  const els = cfg.elements;
  if (!Array.isArray(els) || els.length < 1 || els.length > 8) throw new Error("A template needs 1 to 8 elements");
  const clean = els.map((e) => {
    const type = e.type === "text" ? "text" : "barcode";
    const source = SOURCES.includes(e.source) ? e.source : "serial";
    const out = { type, source };
    if (source === "fixed") { out.value = cleanValue(e.value); checkChars(out.value, "Fixed text"); }
    if (type === "barcode") out.text = e.text !== false;
    return out;
  });
  const labels = { extra1: cleanValue(cfg.labels?.extra1) || "Extra field 1", extra2: cleanValue(cfg.labels?.extra2) || "Extra field 2" };
  const out = { w, h, gap, labels, elements: clean };
  buildLabel(out, { serial: "232003036353997", model: "CM4X16GC3200C16K2E", extra1: "EXTRA1", extra2: "EXTRA2" });
  return out;
}
