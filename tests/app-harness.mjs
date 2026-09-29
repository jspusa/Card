import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the shipped page through its UI events and CompanyCard public API.
// Only browser facilities and third-party PDF/ZIP IO are substituted.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const pageScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

export function setup(statement = "09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01", { globals = {}, windowProperties = {}, database, initialize = true } = {}) {
  const elements = new Map();
  const values = new Map();
  const archives = [];
  const windowListeners = new Map();
  function element() {
    const listeners = new Map();
    const classes = new Set();
    return {
      listeners, style: {}, dataset: {}, lastChild: {}, value: "", innerHTML: "",
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
      },
      addEventListener: (name, callback) => listeners.set(name, callback),
      click() { return listeners.get("click")?.({ target: this }); },
      close() {}, showModal() {}, remove() {}, setAttribute() {},
      appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }
    };
  }
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll: () => [], createElement: element,
    body: element(), head: element()
  };
  const window = {
    location: { search: "", hash: "" },
    addEventListener: (name, callback) => windowListeners.set(name, callback), setTimeout: () => 1, requestAnimationFrame() {},
    confirm: () => true,
    pdfjsLib: {
      GlobalWorkerOptions: {},
      getDocument({ data }) {
        const text = new TextDecoder().decode(data);
        return { promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: text }] }) }),
          destroy: async () => {}
        }) };
      }
    },
    JSZip: class {
      constructor() { this.files = {}; archives.push(this); }
      file(name, value) { this.files[name] = value; }
      async generateAsync() { return new Blob(["synthetic ZIP boundary"]); }
    }
  };
  Object.assign(window, windowProperties);
  const context = vm.createContext({
    window, document, console, URLSearchParams, Blob, File, structuredClone,
    URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL() {} },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    clearTimeout() {}, navigator: {}, TextDecoder, ...(database ? { indexedDB: {} } : {}), ...globals
  });
  for (const script of pageScripts) {
    if (database && window.CardLocalProgress) window.CardLocalProgress.indexedDB = () => database;
    vm.runInContext(script, context);
  }
  const api = window.CompanyCard;
  const result = { api, elements, archives, context, values, window, document, windowListeners };
  if (!initialize) return result;
  document.querySelector("#statementYear").value = "2027";
  document.querySelector("#statementYear").listeners.get("change")();
  document.querySelector("#rawText").value = statement;
  document.querySelector("#reparseButton").click();
  assert.ok(api.getState().rows.length > 0, "synthetic statement must import through the real UI");
  return result;
}

export function receipt(name, text = "UNRELATED MERCHANT — synthetic receipt for test only, Total USD 7.77") {
  return new File([text], name, { type: "application/pdf" });
}
