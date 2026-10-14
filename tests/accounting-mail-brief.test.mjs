import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, receipt } from './app-harness.mjs';

const source = [
  '09/01 09/02 SAMPLE OFFICE 1200 2388',
  '09/03 09/04 SAMPLE PAPER 800 2388'
].join('\n');

function edit(app, row, field, value) {
  app.elements.get('#tableBody').listeners.get('change')({ target: {
    closest: () => ({ dataset: { id: row.id } }),
    classList: { contains: () => false, toggle() {} },
    dataset: { field }, value
  } });
}

function setValue(app, selector, value, event = 'input') {
  const element = app.elements.get(selector);
  element.value = value;
  element.listeners.get(event)({ target: element });
}

function workbookApp(statement) {
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

function summary(app) {
  return new Map(app.sheets.get('核對摘要').rows);
}

test('complete electronic report is a short reusable note, not a second ledger', () => {
  const app = setup(source);
  for (const row of app.api.getState().rows) {
    edit(app, row, 'note', 'Private expense details remain in the workbook');
    app.api.attachFiles(row.id, [receipt(`${row.id}.pdf`)]);
  }
  const body = app.api.generateAccountingMail();
  assert.equal(body, '您好，\n\n本期公司卡報帳明細及收據請見附件，再請協助核對。\n\n謝謝。');
  assert.doesNotMatch(body, /SAMPLE|Private|\.pdf|NT\$|勾選|憑證狀態|此草稿/);
  assert.match(app.elements.get('#accountingMailStatus').textContent, /未.*附件|未夾入附件/);
});

test('subject uses the full chronological consumption period, including month and year boundaries', () => {
  const app = setup(source);
  const [first, second] = app.api.getState().rows;
  edit(app, first, 'transactionDate', '2028-01-05');
  edit(app, second, 'transactionDate', '2027-12-17');
  app.api.generateAccountingMail();
  assert.equal(app.elements.get('#accountingMailSubject').value, '2027/12/17到2028/01/05公司卡2388');
  edit(app, first, 'transactionDate', '2027-10-06');
  edit(app, second, 'transactionDate', '2027-09-19');
  app.api.generateAccountingMail();
  assert.equal(app.elements.get('#accountingMailSubject').value, '2027/09/19到2027/10/06公司卡2388');
  edit(app, first, 'transactionDate', '2027-09-19');
  app.api.generateAccountingMail();
  assert.equal(app.elements.get('#accountingMailSubject').value, '2027/09/19公司卡2388');
});

test('a missing or invalid consumption date never produces a seemingly complete subject period', () => {
  for (const date of ['', '2027-02-30', '09/03']) {
    const app = setup(source);
    edit(app, app.api.getState().rows[1], 'transactionDate', date);
    app.api.generateAccountingMail();
    assert.equal(app.elements.get('#accountingMailSubject').value, '公司卡2388（消費日期待確認）');
  }
});

test('only the exact approved merchant names are exempt, regardless of checkbox or copied note', async () => {
  const app = workbookApp([
    '09/01 09/02 金箭旅行社 1200 2388',
    '09/03 09/04 金 箭 旅 行 社 有 限 公 司 800 2388',
    '09/05 09/06 金箭旅行社有限公司分店 600 2388',
    '09/07 09/08 SAMPLE TRAVEL 400 2388'
  ].join('\n'));
  const rows = app.api.getState().rows;
  edit(app, rows[3], 'note', '代刷（總務訂購，本人無收據）');
  app.elements.get('#checkAll').checked = true;
  app.elements.get('#checkAll').listeners.get('change')({ target: app.elements.get('#checkAll') });
  const body = app.api.generateAccountingMail();
  assert.match(body, /2027\/09\/01｜金箭旅行社｜NT\$1,200｜代刷（總務訂購，本人無收據）/);
  assert.match(body, /2027\/09\/03｜金箭旅行社｜NT\$800｜代刷（總務訂購，本人無收據）/);
  assert.match(body, /另有2筆憑證待補，詳見報帳明細。/);
  assert.equal((body.match(/代刷（總務訂購，本人無收據）/g) || []).length, 2);
  assert.doesNotMatch(body, /SAMPLE TRAVEL|分店/);
  assert.ok(app.api.getState().rows.every(row => row.invoiceFound && !row.physicalInvoice));
  await app.api.downloadExcel();
  assert.equal(summary(app).get('代刷免追收據'), 2);
  assert.equal(summary(app).get('缺少憑證'), 2);
  assert.equal(summary(app).get('實際報帳金額'), 3000);
  assert.match(app.elements.get('#readinessStatus').textContent, /代刷免追收據 2 筆/);
  assert.match(app.elements.get('#readinessStatus').textContent, /2 筆憑證待補/);
});

test('exemption keeps spending and unchecked flags while the workbook carries the canonical explanation', async () => {
  const app = workbookApp('09/01 09/02 金箭旅行社有限公司 1200 2388');
  const before = app.api.getState().rows[0];
  app.api.generateAccountingMail();
  await app.api.downloadExcel();
  const after = app.api.getState().rows[0];
  assert.equal(after.invoiceFound, false);
  assert.equal(after.physicalInvoice, false);
  assert.equal(after.amount, before.amount);
  assert.equal(after.note, before.note, 'generation and export must not overwrite stored notes');
  const exported = app.sheets.get('報帳明細').rows[1];
  assert.equal(exported[1], '代刷免追收據');
  assert.match(exported[9], /代刷（總務訂購，本人無收據）/);
  assert.equal(summary(app).get('缺少憑證'), 0);
  assert.equal(app.elements.get('#invoiceProgress').textContent, '0 / 1');
});

test('physical and current electronic evidence outrank merchant exemption without double-counting scans', async () => {
  const app = workbookApp([
    '09/01 09/02 金箭旅行社 1200 2388',
    '09/03 09/04 金箭旅行社有限公司 800 2388',
    '09/05 09/06 SAMPLE OFFICE 600 2388'
  ].join('\n'));
  const [physical, electronic, missing] = app.api.getState().rows;
  app.api.setPhysicalInvoice(physical.id, true);
  app.api.attachFiles(physical.id, [receipt('scan.pdf')]);
  app.api.attachFiles(electronic.id, [receipt('electronic.pdf')]);
  app.api.attachFiles(missing.id, [receipt('old-period.pdf')]);
  app.api.setAttachmentExcluded(app.api.getState().attachments.find(item => item.name === 'old-period.pdf').id, true);
  await app.api.autoMatchFiles([receipt('pending.pdf')]);
  const body = app.api.generateAccountingMail();
  assert.match(body, /另有實體發票 1 筆，交付方式另行確認。/);
  assert.match(body, /另有1筆憑證待補，詳見報帳明細。/);
  assert.doesNotMatch(body, /代刷|scan|electronic|old-period|pending/);
  await app.api.downloadExcel();
  assert.equal(summary(app).get('電子附件（筆）'), 1);
  assert.equal(summary(app).get('實體發票'), 1);
  assert.equal(summary(app).get('代刷免追收據'), 0);
  assert.equal(summary(app).get('缺少憑證'), 1);
  const oldFileRow = app.sheets.get('報帳明細').rows.find(row => row[4] === 'SAMPLE OFFICE');
  assert.equal(oldFileRow[1], '缺少憑證');
  assert.equal(oldFileRow[10], '');
});

test('physical notice stays short and scopes the subject to the physical transaction dates', () => {
  const app = setup(source);
  app.api.setPhysicalInvoice(app.api.getState().rows[1].id, true);
  setValue(app, '#accountingMailMode', 'physical', 'change');
  const body = app.api.generateAccountingMail();
  assert.equal(app.elements.get('#accountingMailSubject').value, '2027/09/03公司卡2388 實體發票');
  assert.match(body, /本期公司卡有實體發票 1 筆，交付方式另行確認。/);
  assert.doesNotMatch(body, /SAMPLE|缺少|待補|代刷|請見附件/);
});

test('template upgrade preserves old custom text but requires regeneration before copying or downloading', async () => {
  const data = new Map();
  const db = {
    async read(key) { return structuredClone(data.get(key)); },
    async write(snapshot, expected) {
      const revision = expected + 1;
      data.set(snapshot.fingerprint, structuredClone({ ...snapshot, revision }));
      data.set('latest', snapshot.fingerprint);
      return revision;
    }
  };
  const app = setup(source, { database: db, initialize: false });
  await app.api.ready;
  setValue(app, '#statementYear', '2027', 'change');
  app.elements.get('#rawText').value = source;
  app.elements.get('#reparseButton').click();
  app.api.generateAccountingMail();
  setValue(app, '#accountingMailSubject', 'Old custom subject');
  setValue(app, '#accountingMailText', 'Old custom body');
  await app.api.saveProgress();
  const saved = data.get(data.get('latest'));
  const card = saved.cards.find(([tail]) => tail === '2388')[1];
  const oldSignature = JSON.parse(card.accountingMailSignature);
  delete oldSignature.templateVersion;
  card.accountingMailSignature = JSON.stringify(oldSignature);
  const reopened = setup(source, { database: db, initialize: false });
  await reopened.api.ready;
  assert.equal(reopened.api.getGeneratedAccountingMail(), 'Old custom body');
  assert.equal(reopened.elements.get('#accountingMailSubject').value, 'Old custom subject');
  assert.match(reopened.elements.get('#accountingMailStatus').textContent, /過期/);
  assert.equal(reopened.elements.get('#copyAccountingMailButton').disabled, true);
  assert.equal(reopened.elements.get('#downloadAccountingMailButton').disabled, true);
  reopened.api.generateAccountingMail();
  assert.equal(reopened.elements.get('#copyAccountingMailButton').disabled, false);
  assert.equal(reopened.elements.get('#downloadAccountingMailButton').disabled, false);
  assert.notEqual(reopened.api.getGeneratedAccountingMail(), 'Old custom body');
});
