import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, receipt } from './app-harness.mjs';

function database() {
  const data = new Map();
  return {
    async read(key) { return structuredClone(data.get(key)); },
    async write(value, expected) {
      if ((data.get(value.fingerprint)?.revision || 0) !== expected) throw new Error('conflict');
      const revision = expected + 1;
      data.set(value.fingerprint, structuredClone({ ...value, revision }));
      data.set('latest', value.fingerprint);
      return revision;
    },
    async remove(key) { data.delete(key); if (data.get('latest') === key) data.delete('latest'); }
  };
}

async function start(db) {
  const app = setup('', { database: db, initialize: false });
  await app.api.ready;
  return app;
}
function importRows(app) {
  app.elements.get('#statementYear').value = '2027';
  app.elements.get('#statementYear').listeners.get('change')();
  app.elements.get('#rawText').value = '09/01 09/02 SAMPLE OFFICE 1200 2388\n09/02 09/03 SAMPLE TRAVEL 3400 7802';
  app.elements.get('#reparseButton').click();
}

test('page reopens with both card receipts, edit flags and exact original bytes', async () => {
  const db = database();
  const app = await start(db);
  importRows(app);
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('office.pdf', 'office bytes')]);
  app.api.switchCardTail('7802');
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('travel.pdf', 'travel bytes')]);
  await app.api.saveProgress();
  const reopened = await start(db);
  assert.equal(reopened.api.getState().cardTail, '7802');
  assert.equal(reopened.api.getState().attachments[0].name, 'travel.pdf');
  assert.equal(reopened.api.getState().rows[0].invoiceFound, true);
  reopened.api.switchCardTail('2388');
  assert.equal(reopened.api.getState().attachments[0].name, 'office.pdf');
  await reopened.elements.get('#backupButton').click();
  const files = reopened.archives.at(-1).files;
  assert.equal(await files['receipts/2388/1_office.pdf'].text(), 'office bytes');
  assert.equal(await files['receipts/7802/1_travel.pdf'].text(), 'travel bytes');
});

test('a failed save warns persistently, preserves the working copy and protects leaving', async () => {
  const db = database();
  const write = db.write;
  db.write = async () => { throw new Error('QuotaExceededError'); };
  const app = await start(db);
  importRows(app);
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('keep.pdf', 'keep bytes')]);
  await assert.rejects(app.api.saveProgress());
  assert.match(app.elements.get('#localSaveStatus').textContent, /尚未成功保存/);
  let prevented = false;
  app.windowListeners.get('beforeunload')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(app.api.getState().attachments[0].name, 'keep.pdf');
  db.write = write;
  await app.api.saveProgress();
  assert.match(app.elements.get('#localSaveStatus').textContent, /已保存到/);
});

test('clearing needs confirmation and clears only the saved copy, not live receipt files', async () => {
  const db = database();
  const app = await start(db);
  importRows(app);
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('keep.pdf')]);
  await app.api.saveProgress();
  app.window.confirm = () => false;
  await app.elements.get('#clearLocalButton').click();
  assert.equal((await start(db)).api.getState().attachments.length, 1);
  app.window.confirm = () => true;
  await app.elements.get('#clearLocalButton').click();
  assert.equal((await start(db)).api.getState().rows.length, 0);
  assert.equal(app.api.getState().attachments.length, 1);
  assert.match(app.elements.get('#localSaveStatus').textContent, /已清除/);
});

test('retrying a stale page save cannot overwrite another page after a conflict', async () => {
  const db = database();
  const current = await start(db);
  importRows(current);
  await current.api.saveProgress();
  const stale = await start(db);
  current.api.attachFiles(current.api.getState().rows[0].id, [receipt('newer.pdf', 'newer reviewed receipt')]);
  await current.api.saveProgress();

  await assert.rejects(stale.api.saveProgress());
  await assert.rejects(stale.api.saveProgress());

  const reopened = await start(db);
  assert.equal(reopened.api.getState().attachments.length, 1);
  assert.equal(reopened.api.getState().attachments[0].name, 'newer.pdf');
});

test('clearing locks receipt edits and keeps that lock when the page rerenders', async () => {
  const db = database();
  const app = await start(db);
  importRows(app);
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('keep-live.pdf', 'retained working-copy receipt')]);
  await app.api.saveProgress();
  const before = app.api.getState();
  const card = { dataset: { attachmentId: before.attachments[0].id } };
  const select = { value: '', closest: () => card, disabled: false };
  const removeButton = { disabled: false };
  app.elements.get('#reviewGrid').querySelectorAll = () => [select, removeButton];
  const remove = db.remove;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  db.remove = async key => { markStarted(); await gate; return remove(key); };

  const clearing = app.elements.get('#clearLocalButton').click();
  await started;
  try {
    assert.equal(select.disabled, true);
    assert.equal(removeButton.disabled, true);
    assert.equal(app.api.setPhysicalInvoice(before.rows[0].id, true), false);
    app.elements.get('#reviewGrid').listeners.get('change')({ target: { closest: () => select } });
    app.elements.get('#reviewGrid').listeners.get('click')({
      target: { closest: selector => selector === '[data-attachment-id]' ? card : selector === '.remove-attachment' ? removeButton : null }
    });
    app.elements.get('#searchInput').listeners.get('input')();
    assert.equal(app.elements.get('#checkAll').disabled, true);
    assert.deepEqual(app.api.getState(), before);
  } finally {
    release();
    await clearing;
  }

  assert.equal(select.disabled, false);
  assert.equal(removeButton.disabled, false);
  assert.equal((await start(db)).api.getState().rows.length, 0);
  assert.deepEqual(app.api.getState(), before);
});

test('the first manual purchase immediately enables complete backup and local clearing', async () => {
  const app = await start(database());
  assert.equal(app.elements.get('#backupButton').disabled, true);
  assert.equal(app.elements.get('#clearLocalButton').disabled, true);

  app.elements.get('#addRowButton').click();

  assert.equal(app.api.getState().rows.length, 1);
  assert.equal(app.elements.get('#backupButton').disabled, false);
  assert.equal(app.elements.get('#clearLocalButton').disabled, false);
});

test('marking a physical receipt through the public action queues persistence', async () => {
  const db = database();
  const app = await start(db);
  importRows(app);
  await app.api.saveProgress();

  assert.equal(app.api.setPhysicalInvoice(app.api.getState().rows[0].id, true), true);
  assert.match(app.elements.get('#localSaveStatus').textContent, /儲存中/);
  await app.api.saveProgress();

  const reopened = await start(db);
  assert.equal(reopened.api.getState().rows[0].physicalInvoice, true);
  assert.equal(reopened.api.getState().rows[0].invoiceFound, true);
});
