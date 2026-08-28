import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("statement picker accepts PDF alongside supported images", () => {
  const input = html.match(/<input[^>]+id="fileInput"[^>]*>/)?.[0] || "";
  assert.match(input, /accept="[^"]*application\/pdf/);
  assert.match(input, /multiple/);
});

test("statement PDFs are expanded into pages and rendered before OCR", () => {
  assert.match(html, /function isPdfFile\(file\)/);
  assert.match(html, /async function loadPdfDocument\(file\)/);
  assert.match(html, /async function renderPdfPage\(pdf, pageNumber/);
  assert.match(html, /pageNumber <= pdf\.numPages/);
  assert.match(html, /worker\.recognize\(canvas\)/);
});

test("PDF statement selection keeps local preview and source metadata", () => {
  assert.match(html, /canvas\.toDataURL\("image\/jpeg"/);
  assert.match(html, /\["來源檔案"/);
  assert.match(html, /帳單只會留在這個瀏覽器中，不會上傳到其他伺服器/);
});
