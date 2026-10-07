// A4 adhesive label sheets for pre-printed asset tags. All sizes are in mm;
// the browser must print at 100% scale with no margins for them to line up.
export const SHEET_PRESETS = [
  // TW-2065 (65/A4, nominal 38.1 × 21.2 mm), calibrated by test prints on the
  // lab printer on 7 Oct 2026: printing 1 mm wider than nominal, 2 mm higher
  // and 0.75 mm further left than the Avery L7651 template lines up best.
  { id: "tw-2065", label: "TW-2065 · 38,1 × 21,2 mm · 5 × 13 (65/coală)", columns: 5, rows: 13, width: 39.1, height: 21.2, top: 8.7, left: 4, gapX: 1.5, gapY: 0 },
  { id: "5x13-38.1x21.2", label: "38,1 × 21,2 mm · 5 × 13 (65/coală, ex. Avery L7651)", columns: 5, rows: 13, width: 38.1, height: 21.2, top: 10.7, left: 4.75, gapX: 2.5, gapY: 0 },
  { id: "3x8-70x37", label: "70 × 37 mm · 3 × 8 (24/coală, ex. Avery 3474)", columns: 3, rows: 8, width: 70, height: 37, top: 0.5, left: 0, gapX: 0, gapY: 0 },
  { id: "3x7-63.5x38.1", label: "63,5 × 38,1 mm · 3 × 7 (21/coală, ex. Avery L7160)", columns: 3, rows: 7, width: 63.5, height: 38.1, top: 15.15, left: 7.21, gapX: 2.54, gapY: 0 },
  { id: "2x7-99.1x38.1", label: "99,1 × 38,1 mm · 2 × 7 (14/coală, ex. Avery L7163)", columns: 2, rows: 7, width: 99.1, height: 38.1, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0 },
  { id: "4x10-48.5x25.4", label: "48,5 × 25,4 mm · 4 × 10 (40/coală, ex. Avery 3657)", columns: 4, rows: 10, width: 48.5, height: 25.4, top: 21.5, left: 8, gapX: 0, gapY: 0 },
];

export function presetById(id) {
  return SHEET_PRESETS.find((preset) => preset.id === id) || SHEET_PRESETS[0];
}

export function labelsPerSheet(preset) {
  return preset.columns * preset.rows;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const round = (value) => Math.round(value * 100) / 100;

// Position labels across pages; `skip` leaves already-used spots on the first
// sheet empty so a partly used sheet can be fed again.
export function layoutTags(count, preset, skip = 0) {
  const perSheet = labelsPerSheet(preset);
  const offset = Math.min(Math.max(0, Math.floor(skip) || 0), perSheet - 1);
  return Array.from({ length: count }, (_, index) => {
    const slot = index + offset;
    const position = slot % perSheet;
    const column = position % preset.columns;
    const row = Math.floor(position / preset.columns);
    return {
      page: Math.floor(slot / perSheet),
      left: round(preset.left + column * (preset.width + preset.gapX)),
      top: round(preset.top + row * (preset.height + preset.gapY)),
    };
  });
}

export function buildTagSheetHtml(tags, preset, { skip = 0, outline = false, brand = "Inventar" } = {}) {
  const positions = layoutTags(tags.length, preset, skip);
  // Small labels drop the brand line so the barcode keeps its height; the
  // barcode image already contains the required quiet zones on both sides.
  const compact = preset.height < 25;
  const barcodeHeight = round(preset.height * (compact ? 0.5 : 0.42));
  const brandLine = compact ? "" : `<div class="brand">${escapeHtml(brand)}</div>`;
  const pages = [];
  tags.forEach((tag, index) => {
    const { page, left, top } = positions[index];
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tag.barcode_svg)}`;
    (pages[page] ||= []).push(`<div class="tag" style="left:${left}mm;top:${top}mm">`
      + brandLine
      + `<img src="${escapeHtml(source)}" alt="Cod de bare ${escapeHtml(tag.code)}" />`
      + `<div class="code">${escapeHtml(tag.code)}</div></div>`);
  });
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8" />
<title>Etichete ${escapeHtml(tags[0]?.code || "")} – ${escapeHtml(tags.at(-1)?.code || "")}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, Arial, sans-serif; color: #000; background: white; }
  .sheet { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; }
  .sheet:last-child { break-after: auto; }
  .tag { position: absolute; width: ${preset.width}mm; height: ${preset.height}mm; padding: ${compact ? "1.2mm 1.2mm" : "2mm 3mm"}; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1mm; overflow: hidden; ${outline ? "outline: .2mm dashed #888; outline-offset: -.1mm;" : ""} }
  .brand { font-size: 6.5pt; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: #333; }
  .tag img { display: block; width: 100%; height: ${barcodeHeight}mm; }
  .code { font: 800 ${compact ? 7.5 : preset.height < 30 ? 9 : 11}pt ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: ${compact ? ".02em" : ".06em"}; }
</style>
</head>
<body>
${pages.map((items) => `<section class="sheet">${items.join("")}</section>`).join("\n")}
</body>
</html>`;
}

// Open the window synchronously in the click handler: popup blockers refuse
// windows opened after awaiting the server.
export function openPrintWindow() {
  const printWindow = window.open("", "_blank", "width=900,height=1000");
  if (!printWindow) throw new Error("Browserul a blocat fereastra de print. Permite pop-up-uri pentru această pagină și încearcă din nou.");
  printWindow.opener = null;
  printWindow.document.write("<!doctype html><title>Se pregătesc etichetele…</title><p style=\"font-family:sans-serif\">Se pregătesc etichetele…</p>");
  return printWindow;
}

export function printTagSheet(printWindow, tags, preset, options) {
  printWindow.document.open();
  printWindow.document.write(buildTagSheetHtml(tags, preset, options));
  printWindow.document.close();
  // decode() also settles for images that finished loading before this ran.
  return Promise.all(Array.from(printWindow.document.images, (image) => image.decode())).then(() => {
    if (printWindow.closed) return;
    printWindow.focus();
    printWindow.print();
  }, () => {
    printWindow.close();
    throw new Error("Etichetele nu au putut fi pregătite pentru tipărire. Încearcă din nou.");
  });
}
