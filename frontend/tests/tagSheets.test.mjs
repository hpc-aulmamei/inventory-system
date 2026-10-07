import assert from "node:assert/strict";
import test from "node:test";
import { SHEET_PRESETS, buildTagSheetHtml, labelsPerSheet, layoutTags, presetById } from "../src/hooks/tagSheets.js";

test("every sheet preset fits on A4 paper", () => {
  for (const preset of SHEET_PRESETS) {
    const right = preset.left + preset.columns * preset.width + (preset.columns - 1) * preset.gapX;
    const bottom = preset.top + preset.rows * preset.height + (preset.rows - 1) * preset.gapY;
    assert.ok(right <= 210.01 && bottom <= 297.01, `${preset.id}: ${right} × ${bottom}`);
  }
});

test("labels fill rows left to right and continue on a new sheet", () => {
  const preset = presetById("3x8-70x37");
  const layout = layoutTags(26, preset);
  assert.deepEqual(layout[0], { page: 0, left: 0, top: 0.5 });
  assert.deepEqual(layout[4], { page: 0, left: 70, top: 37.5 });
  assert.deepEqual(layout[23], { page: 0, left: 140, top: 259.5 });
  assert.deepEqual(layout[24], { page: 1, left: 0, top: 0.5 });
});

test("skipped positions leave used spots on the first sheet empty", () => {
  const preset = presetById("3x7-63.5x38.1");
  const layout = layoutTags(3, preset, 20);
  assert.deepEqual(layout.map(item => item.page), [0, 1, 1]);
  assert.deepEqual(layout[0], { page: 0, left: 139.29, top: 243.75 });
  // Skipping a whole sheet or more is clamped instead of printing blank pages.
  assert.equal(layoutTags(1, preset, 500)[0].page, 0);
  assert.equal(labelsPerSheet(preset), 21);
});

test("sheet HTML escapes tag data and paginates", () => {
  const tags = Array.from({ length: 25 }, (_, index) => ({ code: `INV-${String(index + 1).padStart(6, "0")}`, barcode_svg: "<svg/>" }));
  tags[0] = { code: '<b>"x"</b>', barcode_svg: "<svg/>" };
  const html = buildTagSheetHtml(tags, presetById("3x8-70x37"), { outline: true });
  assert.equal(html.match(/class="sheet"/g).length, 2);
  assert.equal(html.match(/class="tag"/g).length, 25);
  assert.ok(html.includes("&lt;b&gt;&quot;x&quot;&lt;/b&gt;") && !html.includes('<b>"x"</b>'));
  assert.ok(html.includes("outline: .2mm dashed"));
});

test("TW-2065 sheets are the default, with the calibrated positions", () => {
  const preset = presetById("");
  assert.equal(preset.id, "tw-2065");
  assert.equal(labelsPerSheet(preset), 65);
  const layout = layoutTags(66, preset);
  assert.deepEqual(layout[0], { page: 0, left: 4, top: 8.7 });
  assert.deepEqual(layout[4], { page: 0, left: 166.4, top: 8.7 });
  assert.deepEqual(layout[5], { page: 0, left: 4, top: 29.9 });
  assert.deepEqual(layout[64], { page: 0, left: 166.4, top: 263.1 });
  assert.equal(layout[65].page, 1);
  const html = buildTagSheetHtml([{ code: "INV-000001", barcode_svg: "<svg/>" }], preset);
  assert.ok(!html.includes('class="brand"') && html.includes("width: 39.1mm"));
});

test("Avery L7651 sheets (38,1 × 21,2 mm) use the compact label", () => {
  const preset = presetById("5x13-38.1x21.2");
  assert.equal(labelsPerSheet(preset), 65);
  const layout = layoutTags(66, preset);
  assert.deepEqual(layout[0], { page: 0, left: 4.75, top: 10.7 });
  assert.deepEqual(layout[4], { page: 0, left: 167.15, top: 10.7 });
  assert.deepEqual(layout[5], { page: 0, left: 4.75, top: 31.9 });
  assert.deepEqual(layout[64], { page: 0, left: 167.15, top: 265.1 });
  assert.equal(layout[65].page, 1);
  const html = buildTagSheetHtml([{ code: "INV-000001", barcode_svg: "<svg/>" }], preset);
  assert.ok(!html.includes('class="brand"') && html.includes("height: 10.6mm"));
});
