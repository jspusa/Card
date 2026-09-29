import assert from "node:assert/strict";
import test from "node:test";
import { setup, receipt } from "./app-harness.mjs";

function pdfBoundary(pages, onViewport = () => {}) {
  return {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({
      numPages: pages.length,
      getPage: async (number) => ({
        getTextContent: async () => ({ items: [{ str: pages[number - 1].text }] }),
        getAnnotations: async () => pages[number - 1].annotations || [],
        getViewport: (options) => { onViewport(options); return { width: 100, height: 100 }; },
        render: () => ({ promise: Promise.resolve() })
      }),
      destroy: async () => {}
    }) })
  };
}

test("a receipt whose payment is on page five automatically matches through the upload flow", async () => {
  const pages = Array.from({ length: 4 }, () => ({ text: "SAMPLE SHOP Official receipt itemized charges and terms USD 0.00" }));
  pages.push({ text: "SAMPLE SHOP Payment received on 2027-09-01 Mastercard USD 100.00" });
  const { api } = setup(undefined, { windowProperties: { pdfjsLib: pdfBoundary(pages) } });
  const rowId = api.getState().rows[0].id;

  await api.autoMatchFiles([receipt("five-page-receipt.pdf")]);

  assert.equal(api.getState().attachments[0].rowId, rowId);
  assert.equal(api.getState().rows[0].invoiceFound, true);
});

test("a receipt with a brand visible only in an image gets supplemental OCR before matching", async () => {
  let calls = 0;
  const renderScales = [];
  const page = setup(undefined, { windowProperties: {
    pdfjsLib: pdfBoundary([{ text: "Official receipt payment received on 2027-09-01 paid amount USD 100.00" }], options => renderScales.push(options.scale)),
    Tesseract: {
      OEM: { LSTM_ONLY: 1 }, PSM: { AUTO: 3 },
      createWorker: async () => ({
        setParameters: async () => {}, terminate: async () => {},
        recognize: async () => {
          calls += 1;
          return { data: { text: "SAMPLE SHOP Official receipt 2027-09-01 paid USD 100.00" } };
        }
      })
    }
  } });
  const createElement = page.document.createElement;
  page.document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "canvas") element.getContext = () => ({ drawImage() {} });
    return element;
  };

  await page.api.autoMatchFiles([receipt("image-logo-receipt.pdf")]);

  assert.equal(calls, 1);
  assert.deepEqual(renderScales, [4], 'small merchant logos need actual high-resolution pixels, not only a DPI hint');
  assert.equal(page.api.getState().attachments[0].rowId, page.api.getState().rows[0].id);
});

test("hidden form fields and internal field names cannot supply missing receipt evidence", async () => {
  const { api } = setup(undefined, { windowProperties: { pdfjsLib: pdfBoundary([{
    text: "SAMPLE SHOP Official receipt payment date 2027-09-01 and paid amount USD 0.00",
    annotations: [
      { subtype: "Widget", fieldType: "Tx", fieldName: "USD 100.00", fieldValue: "USD 0.00" },
      { subtype: "Widget", fieldType: "Tx", fieldName: "Hidden amount", fieldValue: "USD 100.00", annotationFlags: 2 },
      { subtype: "Widget", fieldType: "Tx", fieldName: "No-view amount", fieldValue: "USD 100.00", annotationFlags: 32 },
      { subtype: "Widget", fieldType: "Btn", fieldName: "Button", fieldValue: "USD 100.00" },
      { subtype: "Text", contents: "USD 100.00" }
    ]
  }]) } });

  await api.autoMatchFiles([receipt("safe-field-receipt.pdf")]);

  assert.equal(api.getState().attachments[0].rowId, "");
});

test("visible PDF form-field payment values are included when matching an uploaded receipt", async () => {
  const { api } = setup(undefined, { windowProperties: { pdfjsLib: pdfBoundary([{
    text: "SAMPLE SHOP Official receipt payment date and paid amount USD 0.00",
    annotations: [
      { subtype: "Widget", fieldType: "Tx", fieldName: "Payment date", fieldValue: "2027-09-01", rect: [10, 30, 70, 40] },
      { subtype: "Widget", fieldType: "Tx", fieldName: "Paid amount", fieldValue: "USD 100.00", rect: [80, 30, 150, 40] }
    ]
  }]) } });
  const rowId = api.getState().rows[0].id;

  await api.autoMatchFiles([receipt("form-receipt.pdf")]);

  assert.equal(api.getState().attachments[0].rowId, rowId);
  assert.equal(api.getState().rows[0].invoiceFound, true);
});
