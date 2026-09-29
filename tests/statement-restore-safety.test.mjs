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

async function select(app, file) {
  const input = app.elements.get('#fileInput');
  input.files = [file];
  await input.listeners.get('change')();
}

function statement(name) {
  return new File(['synthetic statement'], name, { type: 'application/pdf', lastModified: 1 });
}

function importRow(app, merchant) {
  app.elements.get('#rawText').value = `09/01 09/02 ${merchant} 1200 2388`;
  app.elements.get('#reparseButton').click();
}

test('reopening after choosing an older saved statement restores that chosen statement and its receipts', async () => {
  const db = database();
  const app = await start(db);
  const earlier = statement('earlier-synthetic.pdf');
  await select(app, earlier);
  importRow(app, 'SAMPLE EARLIER');
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('earlier-receipt.pdf')]);
  await app.api.saveProgress();
  await select(app, statement('later-synthetic.pdf'));
  importRow(app, 'SAMPLE LATER');
  await app.api.saveProgress();

  await select(app, earlier);
  for (let turn = 0; turn < 20 && /儲存中/.test(app.elements.get('#localSaveStatus').textContent); turn += 1) {
    await Promise.resolve();
  }
  assert.match(app.elements.get('#localSaveStatus').textContent, /已保存到/);
  const reopened = await start(db);
  assert.equal(reopened.api.getState().rows[0].description, 'SAMPLE EARLIER');
  assert.equal(reopened.api.getState().attachments[0].name, 'earlier-receipt.pdf');
});

test('when browser storage is unavailable, canceling the replacement warning preserves the working statement and receipts', async () => {
  const app = setup();
  await app.api.ready;
  app.api.attachFiles(app.api.getState().rows[0].id, [receipt('keep-synthetic.pdf')]);
  const before = app.api.getState();
  const warnings = [];
  app.window.confirm = (message) => { warnings.push(message); return false; };

  await select(app, statement('replacement-synthetic.pdf'));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /尚未成功保存/);
  assert.deepEqual(app.api.getState(), before);
  assert.match(app.elements.get('#localSaveStatus').textContent, /尚未成功保存/);
});
