import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup, receipt } from './app-harness.mjs';

const statement = [
  '09/01 09/02 OPENAI 1200 2388',
  '09/03 09/04 SAMPLE OFFICE 800 2388',
  '09/05 09/06 OTHER CARD SHOP 600 7802'
].join('\n');

function edit(app, row, field, value) {
  app.elements.get('#tableBody').listeners.get('input')({ target: {
    closest: () => ({ dataset: { id: row.id } }),
    classList: { contains: () => false, toggle() {} }, dataset: { field }, value
  } });
}

function choose(app, row, value) { edit(app, row, 'departmentChoice', value); }

function setValue(app, selector, value, event = 'input') {
  const element = app.elements.get(selector);
  element.value = value;
  element.listeners.get(event)({ target: element });
}

function database() {
  const data = new Map();
  return {
    data,
    async read(key) { return structuredClone(data.get(key)); },
    async write(snapshot, expected) {
      if ((data.get(snapshot.fingerprint)?.revision || 0) !== expected) throw new Error('conflict');
      const revision = expected + 1;
      data.set(snapshot.fingerprint, structuredClone({ ...snapshot, revision }));
      data.set('latest', snapshot.fingerprint);
      return revision;
    }
  };
}

function workbookApp() {
  const sheets = new Map();
  const XLSX = {
    utils: {
      aoa_to_sheet: rows => ({ rows }), book_new: () => ({}),
      book_append_sheet: (_, sheet, name) => sheets.set(name, sheet)
    },
    write: () => new Uint8Array()
  };
  return { ...setup(statement, { windowProperties: { XLSX } }), sheets };
}

test('every purchase has a visible blank department selector, with three presets and manual input', () => {
  const app = setup(statement);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<th>使用部門<\/th>/);
  const rendered = app.elements.get('#tableBody').innerHTML;
  assert.equal((rendered.match(/data-field="departmentChoice"/g) || []).length, 2);
  for (const option of ['未選擇', '電商', '行銷', '產品', '手動輸入']) assert.ok(rendered.includes(`>${option}</option>`));
  assert.ok(app.api.getState().rows.every(row => row.department === ''));
  assert.doesNotMatch(app.elements.get('#readinessStatus').textContent, /使用部門/);
});

test('preset and manual changes remain independent of notes and retain the manual draft when toggled', () => {
  const app = setup(statement);
  const row = app.api.getState().rows[0];
  edit(app, row, 'note', 'Original verified note');
  app.api.attachFiles(row.id, [receipt('original.pdf')]);
  const attachment = app.api.getState().attachments[0];
  choose(app, row, '行銷');
  assert.equal(app.api.getState().rows[0].department, '行銷');
  choose(app, row, 'custom');
  assert.equal(app.api.getState().rows[0].department, '', 'manual mode must not silently copy the former preset');
  edit(app, row, 'department', '客服專案');
  choose(app, row, '電商');
  assert.equal(app.api.getState().rows[0].department, '電商');
  choose(app, row, 'custom');
  assert.equal(app.api.getState().rows[0].department, '客服專案');
  choose(app, row, '');
  assert.equal(app.api.getState().rows[0].department, '');
  assert.equal(app.api.getState().rows[0].note, 'Original verified note');
  assert.deepEqual(app.api.getState().attachments[0], attachment);
});

test('department requests require explicit company seat or workspace-credit evidence, never a merchant guess', () => {
  const app = setup([
    '09/01 09/02 OPENAI 1200 2388',
    '09/03 09/04 OPENAI 800 2388',
    '09/05 09/06 OPENAI 600 2388',
    '09/07 09/08 OPENAI 400 2388',
    '09/09 09/10 OPENAI 300 2388',
    '09/11 09/12 SAMPLE OFFICE 200 2388'
  ].join('\n'));
  const rows = app.api.getState().rows;
  edit(app, rows[0], 'note', 'ChatGPT公司版 Premium 追加1席（行銷用途待確認）');
  edit(app, rows[1], 'note', 'ChatGPT公司版工作區點數自動儲值');
  edit(app, rows[2], 'note', 'ChatGPT個人 Pro 訂閱');
  edit(app, rows[3], 'note', '可能是 ChatGPT公司版追加1席');
  edit(app, rows[5], 'note', 'ChatGPT公司版追加1席');
  assert.ok(app.api.getState().rows.every(row => row.department === ''), 'notes must not assign a department');
  assert.match(app.elements.get('#readinessStatus').textContent, /2 筆 ChatGPT 公司版費用尚未填使用部門/);
  choose(app, rows[0], 'custom');
  edit(app, rows[0], 'department', '   ');
  assert.match(app.elements.get('#readinessStatus').textContent, /2 筆 ChatGPT 公司版費用尚未填使用部門/);
  choose(app, rows[0], '產品');
  assert.match(app.elements.get('#readinessStatus').textContent, /1 筆 ChatGPT 公司版費用尚未填使用部門/);
  choose(app, rows[1], '電商');
  assert.doesNotMatch(app.elements.get('#readinessStatus').textContent, /使用部門/);
  assert.equal(app.elements.get('#excelExportButton').disabled, false, 'department warning is non-blocking');
});

test('department edits invalidate a saved draft without expanding the brief email', () => {
  const app = setup(statement);
  const row = app.api.getState().rows[0];
  const before = app.api.generateAccountingMail();
  choose(app, row, '產品');
  assert.equal(app.api.getGeneratedAccountingMail(), before);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true);
  assert.match(app.elements.get('#accountingMailStatus').textContent, /過期/);
  const after = app.api.generateAccountingMail();
  assert.equal(after, before);
  assert.doesNotMatch(after, /產品|使用部門/);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, false);
});

test('search matches the actual selected department, not unused choices or a hidden manual draft', () => {
  const app = setup(statement);
  const [first, second] = app.api.getState().rows;
  choose(app, first, 'custom');
  edit(app, first, 'department', '客服專案');
  choose(app, first, '電商');
  choose(app, second, '產品');
  setValue(app, '#searchInput', '電商');
  assert.match(app.elements.get('#tableBody').innerHTML, /OPENAI/);
  assert.doesNotMatch(app.elements.get('#tableBody').innerHTML, /SAMPLE OFFICE/);
  setValue(app, '#searchInput', '客服專案');
  assert.equal(app.elements.get('#tableBody').innerHTML, '');
});

test('both cards retain departments across exact-source reparse, local save, reload and complete backup', async () => {
  const db = database();
  const app = setup(statement, { database: db, initialize: false });
  await app.api.ready;
  setValue(app, '#statementYear', '2027', 'change');
  app.elements.get('#rawText').value = statement;
  app.elements.get('#reparseButton').click();
  const first = app.api.getState().rows[0];
  choose(app, first, 'custom');
  edit(app, first, 'department', '客服專案');
  edit(app, first, 'note', 'Keep original note');
  app.api.attachFiles(first.id, [receipt('first.pdf')]);
  const attachmentId = app.api.getState().attachments[0].id;
  app.elements.get('#rawText').value = statement;
  app.elements.get('#reparseButton').click();
  assert.equal(app.api.getState().rows[0].department, '客服專案');
  assert.equal(app.api.getState().attachments[0].id, attachmentId);
  app.api.switchCardTail('7802');
  choose(app, app.api.getState().rows[0], '行銷');
  assert.equal(app.api.getState().rows[0].department, '行銷');
  // Card switching flushes the legacy localStorage debounce; this harness
  // deliberately does not run browser timers automatically.
  app.api.switchCardTail('2388');
  app.api.switchCardTail('7802');
  await app.api.saveProgress();
  const local7802 = [...app.values.entries()].find(([key]) => key.startsWith('company-card-expense-7802:v3:'));
  assert.equal(JSON.parse(local7802[1]).rows[0].department, '行銷');
  const reopened = setup(statement, { database: db, initialize: false });
  await reopened.api.ready;
  assert.equal(reopened.api.getState().rows[0].department, '行銷');
  reopened.api.switchCardTail('2388');
  assert.equal(reopened.api.getState().rows[0].department, '客服專案');
  assert.equal(reopened.api.getState().rows[0].note, 'Keep original note');
  assert.equal(reopened.api.getState().attachments[0].id, attachmentId);
  await reopened.elements.get('#backupButton').click();
  const saved = JSON.parse(reopened.archives[0].files['整理進度.json']);
  assert.equal(saved.cards.find(([tail]) => tail === '2388')[1].rows[0].department, '客服專案');
  assert.equal(saved.cards.find(([tail]) => tail === '7802')[1].rows[0].department, '行銷');
});

test('legacy rows without department fields reopen blank without inferring a value from notes', async () => {
  const db = database();
  const app = setup(statement, { database: db, initialize: false });
  await app.api.ready;
  app.elements.get('#rawText').value = statement;
  app.elements.get('#reparseButton').click();
  edit(app, app.api.getState().rows[0], 'note', 'ChatGPT公司版追加1席（行銷）');
  await app.api.saveProgress();
  const snapshot = db.data.get(db.data.get('latest'));
  for (const [, card] of snapshot.cards) for (const row of card.rows) {
    delete row.department; delete row.departmentMode; delete row.departmentDraft;
  }
  const reopened = setup(statement, { database: db, initialize: false });
  await reopened.api.ready;
  assert.ok(reopened.api.getState().rows.every(row => !row.department));
  assert.match(reopened.elements.get('#tableBody').innerHTML, /value="" selected>未選擇/);
  assert.match(reopened.elements.get('#readinessStatus').textContent, /1 筆 ChatGPT 公司版費用尚未填使用部門/);
});

test('custom department is escaped in HTML and exported as an explicit text cell, never a formula', async () => {
  const app = workbookApp();
  const row = app.api.getState().rows[0];
  const payload = '=HYPERLINK("https://example.invalid","<script>alert(1)</script>")';
  choose(app, row, 'custom');
  edit(app, row, 'department', payload);
  app.elements.get('#searchInput').listeners.get('input')();
  const rendered = app.elements.get('#tableBody').innerHTML;
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /&lt;script&gt;/);
  await app.api.downloadExcel();
  const sheet = app.sheets.get('報帳明細');
  assert.equal(sheet.rows[0][11], '使用部門');
  assert.equal(sheet.rows[1][11], payload);
  assert.equal(sheet.L2.t, 's');
  assert.equal(sheet.L2.v, payload);
  assert.equal(sheet.L2.f, undefined);
  assert.equal(sheet['!autofilter'].ref, 'A1:L3');
});

test('typing a manual department does not replace the table and disrupt IME composition', () => {
  const app = setup(statement);
  const row = app.api.getState().rows[0];
  choose(app, row, 'custom');
  const rendered = app.elements.get('#tableBody').innerHTML;
  for (const value of ['客', '客服', '客服專案']) {
    edit(app, row, 'department', value);
    assert.equal(app.elements.get('#tableBody').innerHTML, rendered);
  }
  assert.equal(app.api.getState().rows[0].department, '客服專案');
});

test('department controls lock during receipt processing and never inherit from a different OCR transaction', async () => {
  const app = setup(statement, { windowProperties: {
    pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }
  } });
  const row = app.api.getState().rows[0];
  choose(app, row, '產品');
  const pending = app.api.autoMatchFiles([receipt('pending.pdf')]);
  choose(app, row, '行銷');
  assert.equal(app.api.getState().rows[0].department, '產品');
  app.elements.get('#receiptStopButton').click();
  await pending;
  app.elements.get('#rawText').value = '09/10 09/11 DIFFERENT PURCHASE 500 2388';
  app.elements.get('#reparseButton').click();
  assert.equal(app.api.getState().rows[0].department, '');
  app.elements.get('#addRowButton').click();
  assert.equal(app.api.getState().rows.at(-1).department, '');
});
