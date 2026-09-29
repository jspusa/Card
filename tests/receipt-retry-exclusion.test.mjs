import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, receipt } from './app-harness.mjs';

test('retry rereads existing pending originals without duplicates and preserves manual matches', async () => {
  const app = setup('09/01 09/02 SAMPLE SHOP 3200 2388 US USD 100.00 09/01\n09/03 09/04 OTHER SHOP 6400 2388 US USD 200.00 09/03');
  app.api.attachFiles(app.api.getState().rows[1].id, [receipt('manual.pdf')]);
  await app.api.autoMatchFiles([receipt('pending.pdf')]);
  const before = app.api.getState();
  app.window.pdfjsLib.getDocument = () => ({ promise: Promise.resolve({ numPages: 1,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'SAMPLE SHOP official receipt 2027-09-01 total paid USD 100.00' }] }) }),
    destroy: async () => {} }) });
  assert.equal(typeof app.api.retryPendingReceipts, 'function');
  await app.api.retryPendingReceipts();
  const after = app.api.getState();
  assert.equal(after.attachments.length, 2);
  assert.deepEqual(after.attachments.map(item => item.id), before.attachments.map(item => item.id));
  assert.equal(after.attachments[0].rowId, before.attachments[0].rowId);
  assert.equal(after.attachments[0].matchLevel, 'manual');
  assert.equal(after.attachments[1].rowId, after.rows[0].id);
});

test('excluding a wrong attachment is reversible, retained in backup but omitted from receipt ZIP', async () => {
  const app = setup();
  const rowId = app.api.getState().rows[0].id;
  app.api.attachFiles(rowId, [receipt('wrong.pdf', 'original retained bytes')]);
  const id = app.api.getState().attachments[0].id;
  assert.equal(typeof app.api.setAttachmentExcluded, 'function');
  app.api.setAttachmentExcluded(id, true);
  assert.equal(app.api.getState().attachments[0].excludedFromPeriod, true);
  assert.equal(app.api.getState().attachments[0].rowId, '');
  assert.doesNotMatch(app.elements.get('#readinessStatus').textContent, /附件待配對/);
  await app.api.autoMatchFiles([receipt('right.pdf', 'SAMPLE SHOP Official receipt 2027-09-01 total paid USD 100.00')]);
  await app.api.exportReceiptZip();
  assert.equal(Object.keys(app.archives.at(-1).files).length, 1);
  await app.elements.get('#backupButton').click();
  assert.equal(await app.archives.at(-1).files['receipts/2388/1_wrong.pdf'].text(), 'original retained bytes');
  app.api.setAttachmentExcluded(id, false);
  assert.equal(app.api.getState().attachments[0].excludedFromPeriod, false);
  assert.equal(app.api.getState().attachments[0].rowId, '', 'restoring must request review instead of silently recreating an old wrong match');
});
