import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("      function recognitionBands("),
  html.indexOf("      async function recognizeStatementCanvas("));
const { recognitionBands, textFromRecognitionBand } = new Function(
  `${source}; return { recognitionBands, textFromRecognitionBand };`
)();
const renderSource = html.slice(html.indexOf("      async function renderPdfPage("),
  html.indexOf("      function statusLabel("));

function rendererHarness({ renderError = null } = {}) {
  let smoothing = true;
  const contextPrototype = {};
  Object.defineProperty(contextPrototype, "imageSmoothingEnabled", {
    get: () => smoothing,
    set: (value) => { smoothing = value; },
    configurable: true
  });
  const context = Object.create(contextPrototype);
  const observations = {};
  const canvas = {
    getContext(type, options) {
      assert.equal(type, "2d");
      assert.equal(options.alpha, false);
      return context;
    }
  };
  const document = {
    createElement(tag) { assert.equal(tag, "canvas"); return canvas; }
  };
  const pdf = {
    async getPage(pageNumber) {
      observations.pageNumber = pageNumber;
      return {
        getViewport({ scale }) {
          observations.scale = scale;
          return { width: 100.25 * scale, height: 140.25 * scale };
        },
        render({ canvasContext, viewport }) {
          assert.equal(canvasContext, context);
          observations.viewport = viewport;
          // Simulate PDF.js selecting nearest-neighbor interpolation at a DPR
          // threshold. The OCR-only override must suppress that assignment.
          canvasContext.imageSmoothingEnabled = false;
          observations.duringSmoothing = canvasContext.imageSmoothingEnabled;
          observations.duringOwnProperty = Object.hasOwn(canvasContext, "imageSmoothingEnabled");
          return { promise: renderError ? Promise.reject(renderError) : Promise.resolve() };
        }
      };
    }
  };
  const renderPdfPage = new Function("document", `${renderSource}; return renderPdfPage;`)(document);
  return { renderPdfPage, pdf, context, canvas, observations };
}

test("statement PDF rendering forces smoothing during render and removes its temporary accessor", async () => {
  const { renderPdfPage, pdf, context, canvas, observations } = rendererHarness();
  assert.equal(await renderPdfPage(pdf, 2, 4, true), canvas);
  assert.equal(observations.pageNumber, 2);
  assert.equal(observations.scale, 4);
  assert.equal(observations.duringSmoothing, true);
  assert.equal(observations.duringOwnProperty, true);
  assert.equal(canvas.width, Math.ceil(observations.viewport.width));
  assert.equal(canvas.height, Math.ceil(observations.viewport.height));
  assert.equal(Object.hasOwn(context, "imageSmoothingEnabled"), false);
  context.imageSmoothingEnabled = false;
  assert.equal(context.imageSmoothingEnabled, false);
});

test("statement PDF rendering removes its smoothing accessor when PDF.js rejects", async () => {
  const error = new Error("test rendering failure");
  const { renderPdfPage, pdf, context, observations } = rendererHarness({ renderError: error });
  await assert.rejects(renderPdfPage(pdf, 1, 4, true), (actual) => actual === error);
  assert.equal(observations.duringSmoothing, true);
  assert.equal(Object.hasOwn(context, "imageSmoothingEnabled"), false);
  context.imageSmoothingEnabled = false;
  assert.equal(context.imageSmoothingEnabled, false);
});

test("preview and receipt PDF rendering leave PDF.js smoothing decisions unchanged", async () => {
  for (const flag of [false, undefined]) {
    const { renderPdfPage, pdf, context, observations } = rendererHarness();
    await renderPdfPage(pdf, 1, 0.75, flag);
    assert.equal(observations.scale, 0.75);
    assert.equal(observations.duringSmoothing, false);
    assert.equal(observations.duringOwnProperty, false);
    assert.equal(Object.hasOwn(context, "imageSmoothingEnabled"), false);
    assert.equal(context.imageSmoothingEnabled, false);
  }
});

test("statement OCR isolates its new language model from legacy receipt caches", () => {
  const statementOCR = html.slice(html.indexOf("      async function runOCR()"),
    html.indexOf("      async function updatePreview("));
  assert.match(statementOCR, /cachePath: "card-statement-lstm-v1"/);
  assert.doesNotMatch(statementOCR, /langPath:.*projectnaptha/);
});

test("long page bands cover the whole image with context around every boundary", () => {
  const bands = recognitionBands(2000, 2800);
  assert.equal(bands.length, 4);
  assert.equal(bands[0].top, 0);
  assert.equal(bands.at(-1).bottom, 2800);
  bands.forEach((band, i) => {
    assert.ok(band.top <= band.coreTop && band.bottom >= band.coreBottom);
    if (i) {
      assert.equal(bands[i - 1].coreBottom, band.coreTop);
      assert.ok(bands[i - 1].bottom > band.top);
    }
  });
});

test("overlap does not duplicate transactions and identical separate rows survive", () => {
  const bands = recognitionBands(2000, 2800);
  const rows = [20, 690, 700, 710, 1400, 2100, 2780].map((y) => ({
    y, text: "SAMPLE SHOP 100 2388"
  }));
  const extracted = bands.flatMap((band) => {
    const lines = rows.filter((row) => row.y > band.top && row.y < band.bottom)
      .map((row) => ({ text: row.text, bbox: { y0: row.y - band.top - 10, y1: row.y - band.top + 10 } }));
    return textFromRecognitionBand(lines, band).split("\n").filter(Boolean);
  });
  assert.equal(extracted.length, rows.length);
});
