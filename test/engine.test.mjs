// Run: node test/engine.test.mjs
// Expected symbols are worked out by hand from the Code 128 rules (start B = 104, start C = 105,
// switch to C = 99, stop = 106, check = (start + sum of value x position) mod 103).
import assert from "node:assert/strict";
import { encode128, code128Widths, buildLabel, stretchModule, MIN_QUIET } from "../public/engine.js";

// digits only: set C packs two digits per symbol. (105 + 12*1 + 34*2) % 103 = 82
assert.deepEqual(encode128("1234"), [105, 12, 34, 82, 106]);
// letters only: set B. (104 + 33*1 + 34*2) % 103 = 102
assert.deepEqual(encode128("AB"), [104, 33, 34, 102, 106]);
// mixed serial: B for "EE7B", then switch to C for 20 10 26 00 12. Check = 1433 % 103 = 94
assert.deepEqual(encode128("EE7B2010260012"), [104, 37, 37, 23, 34, 99, 20, 10, 26, 0, 12, 94, 106]);
// 145 modules: why this serial only fits with 1-dot bars on a 39 mm label
assert.equal(code128Widths("EE7B2010260012").reduce((a, b) => a + b, 0), 145);

// Every bar on a real label stays inside the 2 mm blank margin, with and without stretch.
const cfg = { w: 39, h: 30, gap: 2, elements: [{ type: "barcode", source: "serial", text: true }] };
const W = 39 * 8;
for (const stretch of [0, 1, 2, 3]) {
  const label = buildLabel(cfg, { serial: "EE7B2010260012" }, { stretch });
  for (const [x, , w] of label.bars) {
    assert.ok(w >= 1, `bar narrower than 1 dot at stretch ${stretch}`);
    assert.ok(x >= MIN_QUIET && x + w <= W - MIN_QUIET, `bar outside the margin at stretch ${stretch}`);
  }
  if (stretch) assert.ok(stretchModule("EE7B2010260012", W, stretch) > 1, `stretch ${stretch} did not widen`);
}

console.log("engine tests passed");
