import assert from "node:assert/strict";
import test from "node:test";
import { setup, receipt } from "./app-harness.mjs";

test("ZIP keeps every attachment when natural, generated, and case-insensitive names collide", async () => {
  const { api, archives } = setup();
  await api.autoMatchFiles([receipt("a.pdf"), receipt("a.pdf"), receipt("a_2.pdf"), receipt("A.PDF")]);
  await api.exportReceiptZip();
  const names = Object.keys(archives[0].files);
  assert.equal(names.length, 4);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 4);
  assert.equal(api.getAttachmentNames().length, 4);
});

test("a receipt fitting two same-day same-merchant same-amount purchases stays unassigned", async () => {
  const { api } = setup([
    "09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01",
    "09/01 09/03 SAMPLE SHOP 3200 2388 US USD 100.00 09/01"
  ].join("\n"));
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 100.00")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, "");
  assert.ok(result.rows.every((row) => !row.invoiceFound));
  assert.match(result.attachments[0].matchReasons.join(" "), /多筆|相近|待確認/);
});

test("a small date-score difference does not decide between otherwise matching purchases", async () => {
  const { api } = setup([
    "09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01",
    "09/03 09/04 SAMPLE SHOP 3200 2388 US USD 100.00 09/03"
  ].join("\n"));
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 100.00")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("an occupied best purchase does not redirect a receipt to a weaker purchase", async () => {
  const { api } = setup([
    "09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01",
    "09/20 09/21 SAMPLE SHOP 3200 2388 US USD 100.00 09/20"
  ].join("\n"));
  const rowId = api.getState().rows[0].id;
  api.attachFiles(rowId, [receipt("manual.pdf")]);
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 100.00")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, rowId, "manual assignment remains intact");
  assert.equal(result.attachments[1].rowId, "");
  assert.equal(result.rows[1].invoiceFound, false);
  assert.match(result.attachments[1].matchReasons.join(" "), /已有附件/);
});

test("equally credible receipts competing for one purchase both require review", async () => {
  const { api } = setup([
    "09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01",
    "09/20 09/21 SAMPLE SHOP 3200 2388 US USD 100.00 09/20"
  ].join("\n"));
  const text = "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 100.00";
  await api.autoMatchFiles([receipt("one.pdf", text), receipt("two.pdf", text)]);
  const result = api.getState();
  assert.ok(result.attachments.every((item) => item.rowId === ""));
  assert.ok(result.rows.every((row) => !row.invoiceFound));
  assert.ok(result.attachments.every((item) => /同一筆/.test(item.matchReasons.join(" "))));
});

test("an explicitly EUR receipt never confirms an otherwise identical USD purchase", async () => {
  const { api } = setup();
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid EUR 100.00")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, "");
  assert.equal(result.rows[0].invoiceFound, false);
  assert.match(result.attachments[0].matchReasons.join(" "), /幣別/);
});

test("explicit non-USD currency symbols are not mistaken for US dollars", async () => {
  for (const currency of ["€", "£", "HK$", "CA$", "A$", "NT$", "￥"]) {
    const { api } = setup();
    await api.autoMatchFiles([receipt("receipt.pdf", `SAMPLE SHOP Official receipt — 2027-09-01 — total paid ${currency}100.00`)]);
    assert.equal(api.getState().attachments[0].rowId, "", currency);
  }
});

test("matching amount and date without the merchant is not enough to mark a purchase found", async () => {
  const { api } = setup();
  await api.autoMatchFiles([receipt("receipt.pdf", "UNRELATED BUSINESS Official receipt — 2027-09-01 — total paid USD 100.00")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, "");
  assert.equal(result.rows[0].invoiceFound, false);
  assert.match(result.attachments[0].matchReasons.join(" "), /不足|店家/);
});

test("a convincing filename cannot replace evidence from the receipt contents", async () => {
  const { api } = setup();
  await api.autoMatchFiles([receipt("SAMPLE_SHOP_2027-09-01_USD100.pdf")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("one strong receipt still automatically attaches and marks its purchase found", async () => {
  const { api } = setup();
  const expectedRow = api.getState().rows[0].id;
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 100.00")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, expectedRow);
  assert.equal(result.attachments[0].matchLevel, "high");
  assert.equal(result.rows[0].invoiceFound, true);
});

test("a conflicting receipt can still be manually assigned after review", async () => {
  const { api, elements } = setup();
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid EUR 100.00")]);
  const initial = api.getState();
  const card = { dataset: { attachmentId: initial.attachments[0].id } };
  const select = { value: initial.rows[0].id, closest: () => card };
  elements.get("#reviewGrid").listeners.get("change")({ target: { closest: () => select } });
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, initial.rows[0].id);
  assert.equal(result.attachments[0].matchLevel, "manual");
  assert.equal(result.rows[0].invoiceFound, true);
});

test("matching merchant and date without the amount remains pending", async () => {
  const { api } = setup();
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 7.77")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("merchant words and a transaction identifier cannot outweigh a wrong receipt amount", async () => {
  const { api } = setup("09/01 09/02 SAMPLE SHOP SERVICES 987654 3200 2388 US USD 100.00 09/01");
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP SERVICES 987654 Official receipt — 2027-09-01 — total paid USD 7.77")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, "");
  assert.equal(result.rows[0].invoiceFound, false);
});

test("a foreign receipt cannot confirm by confusing the converted TWD figure with the original amount", async () => {
  const { api } = setup();
  await api.autoMatchFiles([receipt("receipt.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 3200.00")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("a failed receipt reader cannot auto-confirm from its filename", async () => {
  const { api } = setup(undefined, {
    windowProperties: { pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.reject(new Error("synthetic read failure")) }) } },
    globals: { console: { error() {} } }
  });
  await api.autoMatchFiles([receipt("SAMPLE_SHOP_2027-09-01_USD100.pdf")]);
  const result = api.getState();
  assert.equal(result.attachments[0].rowId, "");
  assert.match(result.attachments[0].matchReasons.join(" "), /文字讀取不完整/);
});
