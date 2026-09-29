import assert from "node:assert/strict";
import test from "node:test";
import { setup, receipt } from "./app-harness.mjs";

test("canceling a retry cannot match later files from stale extracted text", async () => {
  const app = setup([
    "09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01",
    "09/03 09/04 OTHER SHOP 6400 2388 US USD 200.00 09/03"
  ].join("\n"));
  const rows = app.api.getState().rows;
  for (const [index, row] of rows.entries()) app.api.attachFiles(row.id, [receipt(`manual-${index}.pdf`)]);
  await app.api.autoMatchFiles([
    receipt("one.pdf", "SAMPLE SHOP Official receipt 2027-09-01 total paid USD 100.00"),
    receipt("two.pdf", "OTHER SHOP Official receipt 2027-09-03 total paid USD 200.00")
  ]);
  const waiting = app.api.getState().attachments.filter(item => !item.rowId);
  assert.equal(waiting.length, 2, "occupied rows must keep the new receipts pending");
  for (const item of app.api.getState().attachments.filter(item => item.rowId)) {
    app.api.setAttachmentExcluded(item.id, true);
  }
  app.window.pdfjsLib.getDocument = () => ({ promise: new Promise(() => {}) });

  const retry = app.api.retryPendingReceipts();
  app.elements.get("#receiptStopButton").click();
  await retry;

  const result = app.api.getState().attachments.filter(item => !item.excludedFromPeriod);
  assert.equal(result.length, 2);
  assert.ok(result.every(item => !item.rowId), "not-yet-reread receipts cannot use an earlier attempt's text after cancellation");
  assert.ok(result.every(item => item.matchReasons.join(" ").includes("已停止辨識")));
});
