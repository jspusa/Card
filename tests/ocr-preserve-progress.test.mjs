import assert from "node:assert/strict";
import { Blob, File } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sources = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const sampleText = "08/01 08/02 SYNTHETIC OFFICE 1200 2388";

// Exercise the actual button events and public state reader. Only browser I/O
// and the external OCR engine are substituted; parsing and rendering run as-is.
function setup(ocrTexts) {
  const elements = new Map();
  const storage = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let nextUrl = 0;
  class Element {
    constructor() {
      this.listeners = new Map();
      this.style = {};
      this.dataset = {};
      this.value = "";
      this.textContent = "";
      this.innerHTML = "";
      this.lastChild = { textContent: "" };
      this.open = false;
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        }
      };
    }
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) || [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }
    async fire(type, event = {}) {
      for (const callback of this.listeners.get(type) || []) {
        await callback({ target: this, preventDefault() {}, ...event });
      }
    }
    click() { return this.fire("click"); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {}
  }
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const document = {
    querySelector: element,
    querySelectorAll: () => [],
    createElement: () => new Element(),
    addEventListener() {},
    body: new Element()
  };
  const window = {
    location: { search: "", hash: "" },
    addEventListener() {},
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    requestAnimationFrame: (callback) => callback(),
    confirm: () => true,
    Tesseract: {
      OEM: { LSTM_ONLY: 1 }, PSM: { SINGLE_BLOCK: 1 },
      createWorker: async () => ({
        setParameters: async () => {},
        recognize: async () => ({ data: { text: ocrTexts.shift() ?? "" } }),
        terminate: async () => {}
      })
    }
  };
  class Image {
    naturalWidth = 1800;
    naturalHeight = 1200;
    set src(_) { this.onload(); }
  }
  const context = vm.createContext({
    window, document, Image, HTMLCanvasElement: class {},
    URL: { createObjectURL: () => `blob:synthetic-${++nextUrl}`, revokeObjectURL() {} },
    URLSearchParams, structuredClone, console, Blob, File,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    clearTimeout: (id) => timers.delete(id),
    CSS: { escape: (value) => value }
  });
  for (const source of sources) vm.runInContext(source, context);
  return {
    app: window.CompanyCard,
    element,
    async selectStatement() {
      await window.CompanyCard.ready;
      element("#fileInput").files = [new File([new Uint8Array(100)], "synthetic.png", { type: "image/png", lastModified: 1 })];
      await element("#fileInput").fire("change");
    },
    recognize: () => element("#recognizeButton").click(),
    async editNote(rowId, value) {
      const field = new Element();
      field.dataset.field = "note";
      field.value = value;
      field.closest = () => ({ dataset: { id: rowId } });
      await element("#tableBody").fire("change", { target: field });
    }
  };
}

test("a blank repeat scan preserves reviewed rows, notes, receipts, and original text", async () => {
  const page = setup([sampleText, ""]);
  await page.selectStatement();
  await page.recognize();
  const rowId = page.app.getState().rows[0].id;
  await page.editNote(rowId, "Synthetic receipt reviewed");
  page.app.attachFiles(rowId, [new File([new Uint8Array(50)], "synthetic-receipt.pdf", { type: "application/pdf" })]);
  const before = page.app.getState();

  await page.recognize();

  assert.deepEqual(page.app.getState(), before);
  assert.match(page.element("#noticeText").innerHTML, /保留/);
  assert.equal(page.element("#recognizeButton").disabled, false);
});

test("a repeat scan containing only another card cannot replace the selected card's progress", async () => {
  const page = setup([sampleText, "08/05 08/06 SYNTHETIC TRAVEL 3400 7802"]);
  await page.selectStatement();
  await page.recognize();
  const rowId = page.app.getState().rows[0].id;
  await page.editNote(rowId, "Keep the selected card's reviewed note");
  page.app.attachFiles(rowId, [new File([new Uint8Array(50)], "synthetic-receipt.pdf", { type: "application/pdf" })]);
  const before = page.app.getState();

  await page.recognize();

  assert.deepEqual(page.app.getState(), before);
  assert.match(page.element("#noticeText").innerHTML, /保留/);
});

test("a first scan with no selected-card purchases still opens editable recognition text", async () => {
  const otherCardText = "08/05 08/06 SYNTHETIC TRAVEL 3400 7802";
  const page = setup([otherCardText]);
  await page.selectStatement();
  await page.recognize();

  assert.equal(page.app.getState().rows.length, 0);
  assert.equal(page.app.getState().rawText, otherCardText);
  assert.equal(page.element("#rawDialog").open, true);
  assert.equal(page.element("#rawText").value, otherCardText);

  page.element("#rawText").value = "08/05 08/06 SYNTHETIC TRAVEL 3400 2388";
  await page.element("#reparseButton").click();
  assert.equal(page.app.getState().rows.length, 1);
  assert.equal(page.app.getState().rows[0].amount, 3400);
  assert.equal(page.element("#rawDialog").open, false);
});

test("a first blank scan leaves the original-text editor available for manual recovery", async () => {
  const page = setup([""]);
  await page.selectStatement();
  await page.recognize();

  assert.equal(page.app.getState().rows.length, 0);
  assert.equal(page.app.getState().rawText, "");
  assert.equal(page.element("#rawDialog").open, true);
  assert.equal(page.element("#recognizeButton").disabled, false);
});
