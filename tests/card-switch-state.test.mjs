import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parseStatementText } from "./parser-harness.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const fileSource = html.slice(html.indexOf("      function buildFingerprint("), html.indexOf("      function storageKey("));
const cacheSource = html.slice(html.indexOf("      function storageKey("), html.indexOf("      function getCounts("));
const workbookSource = html.slice(html.indexOf("      function exportMonth("), html.indexOf("      async function downloadExcel("));
const selectSource = html.slice(html.indexOf("      function selectFiles("), html.indexOf("      function findRow("));

const rawText = [
  "08/01 08/02 SAMPLE OFFICE 1200 2388",
  "08/02 08/03 SAMPLE TRAVEL 3400 7802"
].join("\n");

function setup({ stored = [] } = {}) {
  const values = new Map(stored);
  const writes = [];
  const pending = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    CARD_TAILS: ["2388", "7802"],
    LEGACY_STORAGE_PREFIX: "company-card-expense-2388:v2:",
    state: {
      cardTail: "2388", fingerprint: "sample.pdf:100:123", statementYear: 2026,
      rows: parseStatementText(rawText, 2026, "2388").rows,
      excluded: [], rawText, statementRawText: rawText, attachments: [],
      attachmentTargetId: "", filter: "all", search: "", showAdvancedColumns: false,
      accountingMailSignature: "", accountingMailText: "", files: [],
      busy: false, attachmentProcessing: false, exportProcessing: false
    },
    cardSessions: new Map(), persistTimer: 0, workspaceCleared: false,
    queueWorkspaceSave: () => {},
    dom: {
      receiptProgress: { textContent: "" }, statementYear: {}, searchInput: {}, cardTailSelect: {},
      dropZone: { classList: { add: () => {} } }, fileName: {}, fileMeta: {}
    },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); writes.push(key); }
    },
    window: { setTimeout: (callback) => { const id = nextTimer++; pending.set(id, callback); return id; } },
    clearTimeout: (id) => pending.delete(id),
    URL: { revokeObjectURL: () => {} },
    parseStatementText,
    render: () => {}, setProgress: () => {}, showNotice: () => {}, hideNotice: () => {},
    updatePreview: () => {}, toast: () => {}, runOCR: () => {}, formatBytes: String,
    formatInteger: String,
    getCounts: () => ({ total: 0, found: 0, physical: 0, missing: 0, fees: [], cashback: [] }),
    buildAttachmentNames: () => [], attachmentCountForRow: () => 0,
    slashDate: (date) => date || "", safeFilename: (value) => value
  });
  vm.runInContext(fileSource + cacheSource + workbookSource + selectSource, context);
  return { context, values, writes, pending };
}

test("switching cards keeps edited rows, flags, attachments, and filters separate", () => {
  const { context: ctx } = setup();
  const originalRow = ctx.state.rows[0];
  originalRow.note = "office receipt";
  originalRow.invoiceFound = true;
  originalRow.physicalInvoice = true;
  const originalAttachment = { id: "receipt-a", rowId: originalRow.id, file: { name: "office.pdf" }, url: "blob:a" };
  ctx.state.attachments.push(originalAttachment);
  ctx.state.filter = "found";
  ctx.state.search = "office";
  assert.equal(ctx.switchCardTail("7802"), true);
  assert.equal(ctx.state.rows.length, 1);
  assert.equal(ctx.state.rows[0].amount, 3400);
  assert.equal(ctx.state.attachments.length, 0);
  ctx.state.rows[0].note = "travel receipt";
  ctx.state.attachments.push({ id: "receipt-b", rowId: ctx.state.rows[0].id, url: "blob:b" });
  assert.equal(ctx.switchCardTail("2388"), true);
  assert.equal(ctx.state.rows[0], originalRow);
  assert.equal(ctx.state.rows[0].note, "office receipt");
  assert.equal(ctx.state.rows[0].invoiceFound, true);
  assert.equal(ctx.state.rows[0].physicalInvoice, true);
  assert.equal(ctx.state.attachments[0], originalAttachment);
  assert.equal(ctx.state.filter, "found");
  assert.equal(ctx.state.search, "office");
  ctx.switchCardTail("7802");
  assert.equal(ctx.state.rows[0].note, "travel receipt");
  assert.equal(ctx.state.attachments[0].id, "receipt-b");
});

test("legacy 2388 progress stays intact and new progress uses separate card keys", () => {
  const legacyKey = "company-card-expense-2388:v2:sample.pdf:100:123";
  const legacy = JSON.stringify({ rows: [{ id: "legacy-row", note: "keep me", invoiceFound: true }], rawText, statementYear: 2026 });
  const { context: ctx, values, writes } = setup({ stored: [[legacyKey, legacy]] });
  assert.equal(ctx.restoreState(), true);
  assert.equal(ctx.state.rows[0].note, "keep me");
  ctx.state.rows[0].note = "edited new copy";
  ctx.persistState(true);
  ctx.switchCardTail("7802");
  assert.equal(values.get(legacyKey), legacy);
  assert.equal(writes.includes(legacyKey), false);
  assert.equal(JSON.parse(values.get("company-card-expense-2388:v3:sample.pdf:100:123")).rows[0].note, "edited new copy");
  assert.equal(JSON.parse(values.get("company-card-expense-7802:v3:sample.pdf:100:123")).rows[0].amount, 3400);
});

test("debounced saves cannot cross cards and an unseen card reuses saved recognition text", () => {
  const { context: ctx, values, pending } = setup();
  ctx.state.rows[0].note = "latest change";
  ctx.persistState();
  ctx.switchCardTail("7802");
  pending.forEach((callback) => callback());
  assert.equal(JSON.parse(values.get("company-card-expense-2388:v3:sample.pdf:100:123")).rows[0].note, "latest change");
  assert.equal(JSON.parse(values.get("company-card-expense-7802:v3:sample.pdf:100:123")).cardTail, "7802");

  const restored = setup({ stored: [...values] }).context;
  restored.state.statementRawText = "";
  restored.state.rawText = "";
  assert.equal(restored.restoreSharedRawText(), rawText);
});

test("selecting a different statement flushes pending edits to the old fingerprint only", () => {
  const { context: ctx, values, pending } = setup();
  ctx.state.rows[0].note = "save before replacement";
  ctx.persistState();
  // The async storage/confirmation boundary is covered by statement-restore-safety.
  ctx.selectFiles([{ name: "next.pdf", size: 200, lastModified: 456, type: "application/pdf" }], null);
  pending.forEach((callback) => callback());
  assert.equal(ctx.state.fingerprint, "next.pdf:200:456");
  assert.equal(ctx.state.rows.length, 0);
  assert.equal(ctx.state.statementRawText, "");
  assert.equal(ctx.cardSessions.size, 0);
  assert.equal(JSON.parse(values.get("company-card-expense-2388:v3:sample.pdf:100:123")).rows[0].note, "save before replacement");
  assert.equal(values.has("company-card-expense-2388:v3:next.pdf:200:456"), false);
});

test("card switching is blocked while recognition, attachment processing, or export is running", () => {
  for (const flag of ["busy", "attachmentProcessing", "exportProcessing"]) {
    const { context: ctx } = setup();
    ctx.state[flag] = true;
    assert.equal(ctx.switchCardTail("7802"), false);
    assert.equal(ctx.state.cardTail, "2388");
    assert.equal(ctx.dom.cardTailSelect.value, "2388");
  }
});

test("recognizing the same card again preserves edited rows and attachment IDs", () => {
  const { context: ctx } = setup();
  const previous = ctx.state.rows[0];
  previous.note = "verified office receipt";
  previous.description = "Office expense, reviewed";
  previous.invoiceFound = true;
  previous.physicalInvoice = true;
  ctx.state.attachments = [{ id: "a", rowId: previous.id, url: "blob:a", status: "matched" }];
  ctx.state.rows.push({ id: "manual-a", raw: "手動新增", amount: 50, note: "manual expense" });
  ctx.persistState(true);
  const reparsed = parseStatementText(rawText, 2026, "2388");
  assert.notEqual(reparsed.rows[0].id, previous.id);
  ctx.applyParsedCardResult(reparsed);
  assert.equal(ctx.state.rows[0].id, previous.id);
  assert.equal(ctx.state.rows[0].description, "Office expense, reviewed");
  assert.equal(ctx.state.rows[0].note, "verified office receipt");
  assert.equal(ctx.state.rows[0].invoiceFound, true);
  assert.equal(ctx.state.rows[0].physicalInvoice, true);
  assert.equal(ctx.state.rows[1].id, "manual-a");
  assert.equal(ctx.state.attachments[0].rowId, previous.id);
  ctx.switchCardTail("7802");
  ctx.switchCardTail("2388");
  assert.equal(ctx.state.rows[0].id, previous.id);
  assert.equal(ctx.state.attachments[0].rowId, previous.id);
});

test("changed OCR rows leave old receipts visibly unmatched instead of linking them by row position", () => {
  const { context: ctx } = setup();
  const attachment = { id: "a", rowId: ctx.state.rows[0].id, url: "blob:a", status: "matched", matchLevel: "high" };
  ctx.state.attachments = [attachment];
  const differentPurchase = parseStatementText("08/03 08/04 DIFFERENT SHOP 500 2388", 2026, "2388");
  ctx.applyParsedCardResult(differentPurchase);
  assert.equal(ctx.state.rows[0].description, "DIFFERENT SHOP");
  assert.equal(ctx.state.attachments[0], attachment);
  assert.equal(attachment.rowId, "");
  assert.equal(attachment.status, "unmatched");
  assert.equal(attachment.matchLevel, "unmatched");
  assert.equal(attachment.url, "blob:a");
});

test("duplicate source rows retain their own receipt links across reparsing", () => {
  const { context: ctx } = setup();
  const repeated = "SAMPLE OFFICE 1200 2388\nSAMPLE OFFICE 1200 2388";
  ctx.state.rows = parseStatementText(repeated, 2026, "2388").rows;
  assert.equal(ctx.state.rows.length, 2);
  const ids = ctx.state.rows.map((row) => row.id);
  ctx.state.rows[0].note = "first";
  ctx.state.rows[1].note = "second";
  ctx.applyParsedCardResult(parseStatementText(repeated, 2026, "2388"));
  assert.equal(ctx.state.rows[0].id, ids[0]);
  assert.equal(ctx.state.rows[1].id, ids[1]);
  assert.equal(ctx.state.rows[0].note, "first");
  assert.equal(ctx.state.rows[1].note, "second");
});

test("Excel rows, summary, and filename use the selected card", () => {
  const { context: ctx } = setup();
  ctx.switchCardTail("7802");
  const sheets = new Map();
  const XLSX = { utils: {
    aoa_to_sheet: (rows) => ({ rows }), book_new: () => ({}),
    book_append_sheet: (_, sheet, name) => sheets.set(name, sheet)
  } };
  const result = ctx.createExcelWorkbook(XLSX);
  assert.match(result.filename, /^公司卡7802_/);
  assert.equal(sheets.get("報帳明細").rows[1][8], "7802");
  assert.equal(sheets.get("核對摘要").rows[1][1], "7802");
  ctx.state.rows[0].transactionDate = "";
  assert.match(ctx.createExcelWorkbook(XLSX).filename, /日期待確認/);
});
