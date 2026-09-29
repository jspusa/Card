import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, receipt } from './app-harness.mjs';

function database() {
  const records = new Map();
  return {
    async read(key) { return structuredClone(records.get(key)); },
    async write(value, expected) {
      assert.equal(records.get(value.fingerprint)?.revision || 0, expected);
      const revision = expected + 1;
      records.set(value.fingerprint, structuredClone({ ...value, revision }));
      records.set('latest', value.fingerprint);
      return revision;
    },
    async remove(key) { records.delete(key); }
  };
}

async function start(db, options = {}) {
  const app = setup('', { database: db, initialize: false, ...options });
  await app.api.ready;
  return app;
}

async function settle() {
  // Let storage promises settle without firing the app's debounce timers.
  await new Promise(resolve => setImmediate(resolve));
}

async function importRows(app) {
  app.elements.get('#statementYear').value = '2027';
  app.elements.get('#statementYear').listeners.get('change')();
  app.elements.get('#rawText').value = '09/01 09/02 SYNTHETIC SHOP 3200 2388 US USD 100.00 09/01';
  app.elements.get('#reparseButton').click();
  await app.api.saveProgress();
}

test('a newly dropped statement is durable before OCR and without waiting for a debounce timer', async () => {
  const db = database();
  const app = await start(db);
  const file = receipt('synthetic-statement.pdf', 'Exact synthetic statement bytes');
  await app.elements.get('#dropZone').listeners.get('drop')({ dataTransfer: { files: [file] } });
  await settle();

  const reopened = await start(db);
  assert.equal(reopened.elements.get('#fileName').textContent, file.name);
  assert.equal(reopened.api.getState().rows.length, 0, 'dropping a statement must not fabricate OCR rows');
  assert.match(reopened.elements.get('#progressText').textContent, /等待.*辨識/);
  assert.equal(reopened.elements.get('#progressPercent').textContent, '0%');
  assert.equal(reopened.elements.get('#recognizeButton').disabled, false);
  await reopened.elements.get('#backupButton').click();
  assert.equal(await reopened.archives.at(-1).files[`statement/1_${file.name}`].text(), await file.text());
});

test('dropped receipt originals survive reopening while extraction is still pending, before any debounce', async () => {
  const db = database();
  const app = await start(db, {
    windowProperties: {
      pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }
    }
  });
  await importRows(app);
  const file = receipt('synthetic-pending.pdf', 'Exact synthetic receipt bytes');
  app.elements.get('#receiptDropZone').listeners.get('drop')({ dataTransfer: { files: [file] } });
  await settle();

  const reopened = await start(db);
  assert.equal(reopened.api.getState().attachments.length, 1);
  assert.equal(reopened.api.getState().attachments[0].name, file.name);
  assert.equal(reopened.api.getState().attachments[0].status, 'unmatched');
  assert.equal(reopened.api.getState().attachments[0].rowId, '', 'unfinished extraction cannot mark a receipt matched');
  await reopened.elements.get('#backupButton').click();
  assert.equal(await reopened.archives.at(-1).files[`receipts/2388/1_${file.name}`].text(), await file.text());
});

test('a manually attached original is durable without waiting for a debounce timer', async () => {
  const db = database();
  const app = await start(db);
  await importRows(app);
  const rowId = app.api.getState().rows[0].id;
  const file = receipt('synthetic-manual.pdf', 'Exact manual receipt bytes');
  app.api.attachFiles(rowId, [file]);
  await settle();

  const reopened = await start(db);
  assert.equal(reopened.api.getState().attachments[0]?.name, file.name);
  assert.equal(reopened.api.getState().attachments[0]?.rowId, rowId);
  assert.equal(reopened.api.getState().attachments[0]?.matchLevel, 'manual');
});

test('a receipt intake with an unfinished storage write warns before refresh and never falsely reports saved', async () => {
  const db = database();
  const app = await start(db);
  await importRows(app);
  let release;
  const originalWrite = db.write;
  db.write = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return originalWrite(...args);
  };
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('synthetic-slow-save.pdf')]);
  let prevented = false;
  app.windowListeners.get('beforeunload')({ preventDefault() { prevented = true; } });
  await settle();
  assert.equal(prevented, true);
  assert.match(app.elements.get('#localSaveStatus').textContent, /儲存中/);
  db.write = originalWrite;
  release();
  await settle();
  assert.match(app.elements.get('#localSaveStatus').textContent, /已保存/);
});

test('a file dropped outside either upload area cannot navigate away from the saved workspace', async () => {
  const app = await start(database());
  await importRows(app);
  const before = app.api.getState();
  for (const type of ['dragover', 'drop']) {
    let prevented = false;
    app.windowListeners.get(type)?.({
      dataTransfer: { types: ['Files'], files: [receipt('synthetic.pdf')] },
      target: { closest: () => null },
      preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true, `${type} must cancel the browser's file-opening navigation`);
  }
  assert.deepEqual(app.api.getState(), before, 'outside drops must not guess whether a file is a statement or receipt');
});

test('text and link drags keep their native browser behavior', async () => {
  const app = await start(database());
  for (const type of ['dragover', 'drop']) {
    let prevented = false;
    app.windowListeners.get(type)?.({
      dataTransfer: { types: ['text/plain', 'text/uri-list'], files: [] },
      preventDefault() { prevented = true; }
    });
    assert.equal(prevented, false);
  }
});
