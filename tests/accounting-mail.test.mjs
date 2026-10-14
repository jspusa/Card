import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, receipt } from './app-harness.mjs';

const statement = [
  '09/01 09/02 SAMPLE OFFICE 3200 2388 US USD 100.00 09/01',
  '09/03 09/04 SAMPLE TRAVEL 6400 2388 US USD 200.00 09/03',
  '09/05 09/06 SAMPLE PAPER 900 2388',
  '09/07 09/08 OTHER CARD SHOP 1500 7802'
].join('\n');

function makeApp(options = {}) {
  return setup(statement, { ...options, globals: { TextEncoder, btoa, ...options.globals } });
}

function setValue(app, selector, value, event = 'input') {
  const element = app.elements.get(selector);
  element.value = value;
  element.listeners.get(event)({ target: element });
}

function editRow(app, rowId, field, value) {
  app.elements.get('#tableBody').listeners.get('change')({ target: {
    closest: () => ({ dataset: { id: rowId } }),
    classList: { contains: () => false, toggle() {} },
    dataset: { field }, value
  } });
}

function database() {
  const data = new Map();
  return {
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

test('general accounting draft works with no physical receipts and covers the selected card, not the search filter', () => {
  const app = makeApp();
  setValue(app, '#searchInput', 'SAMPLE OFFICE');
  const body = app.api.generateAccountingMail();
  assert.equal(app.elements.get('#accountingMailSubject').value, '2027/09/01到2027/09/05公司卡2388');
  assert.match(body, /本期公司卡報帳明細及收據請見附件/);
  assert.match(body, /另有3筆憑證待補，詳見報帳明細。/);
  assert.doesNotMatch(body, /SAMPLE|OTHER CARD SHOP|10,500|憑證狀態/);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, false);
  assert.equal(app.elements.get('#downloadAccountingMailButton').disabled, false);
});

test('draft distinguishes electronic, physical and checked-but-unbacked rows and excludes out-of-period files', async () => {
  const app = makeApp();
  const [office, travel, paper] = app.api.getState().rows;
  app.api.attachFiles(office.id, [receipt('office.pdf')]);
  app.api.setPhysicalInvoice(paper.id, true);
  app.elements.get('#checkAll').checked = true;
  app.elements.get('#checkAll').listeners.get('change')({ target: app.elements.get('#checkAll') });
  await app.api.autoMatchFiles([receipt('old-period.pdf'), receipt('pending.pdf')]);
  const excludedId = app.api.getState().attachments.find(item => item.name === 'old-period.pdf').id;
  app.api.setAttachmentExcluded(excludedId, true);
  editRow(app, travel.id, 'note', '用途 <script>alert("x")</script> & 核對');
  const body = app.api.generateAccountingMail();
  assert.match(body, /另有實體發票 1 筆/);
  assert.match(body, /另有1筆憑證待補/);
  assert.match(app.elements.get('#readinessStatus').textContent, /1 筆已勾找到但尚未夾電子附件或標記實體/);
  assert.match(app.elements.get('#readinessStatus').textContent, /1 份附件待配對/);
  assert.doesNotMatch(body, /\.pdf|pending|old-period|原幣|用途 <script>/);
  assert.equal(app.elements.get('#accountingMailText').value, body);
  assert.equal(app.elements.get('#accountingMailText').innerHTML, '', 'metadata is never interpolated as HTML');
  assert.match(app.elements.get('#accountingMailStatus').textContent, /未夾入附件/);
});

test('physical mode preserves the existing focused notice without including electronic-only purchases', () => {
  const app = makeApp();
  app.api.setPhysicalInvoice(app.api.getState().rows[2].id, true);
  setValue(app, '#accountingMailMode', 'physical', 'change');
  const body = app.api.generateAccountingMail();
  assert.match(body, /本期公司卡有實體發票 1 筆/);
  assert.doesNotMatch(body, /SAMPLE|900|憑證待補/);
  app.api.setPhysicalInvoice(app.api.getState().rows[2].id, false);
  assert.equal(app.elements.get('#generateAccountingMailButton').disabled, true);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true);
});

test('source edits retain custom draft text but block stale copy/download until explicit regeneration', async () => {
  let copied = '';
  const blobs = [];
  const app = makeApp({ globals: {
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL() {} }
  } });
  app.api.generateAccountingMail();
  setValue(app, '#accountingMailSubject', '自訂主旨');
  setValue(app, '#accountingMailText', '自訂內容，請保留。');
  const row = app.api.getState().rows[0];
  editRow(app, row.id, 'note', 'new source note');
  assert.equal(app.api.getGeneratedAccountingMail(), '自訂內容，請保留。');
  assert.equal(app.elements.get('#accountingMailSubject').value, '自訂主旨');
  assert.match(app.elements.get('#accountingMailStatus').textContent, /已變更|過期/);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true);
  assert.equal(app.elements.get('#downloadAccountingMailButton').disabled, true);
  await app.elements.get('#copyAccountingMailButton').click();
  app.elements.get('#downloadAccountingMailButton').click();
  assert.equal(copied, '');
  assert.equal(blobs.length, 0);
  app.api.generateAccountingMail();
  assert.doesNotMatch(app.api.getGeneratedAccountingMail(), /new source note|自訂內容/);
  assert.equal(app.api.getState().rows[0].note, 'new source note');
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, false);
  await app.elements.get('#copyAccountingMailButton').click();
  assert.match(copied, /主旨：2027\/09\/01到2027\/09\/05公司卡2388/);
  assert.ok(copied.endsWith(app.api.getGeneratedAccountingMail()));
});

test('attachment assignment, exclusion and mode changes each invalidate but never erase a draft', () => {
  const app = makeApp();
  const row = app.api.getState().rows[0];
  const original = app.api.generateAccountingMail();
  app.api.attachFiles(row.id, [receipt('invoice.pdf')]);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true);
  assert.equal(app.api.getGeneratedAccountingMail(), original);
  app.api.generateAccountingMail();
  const withReceipt = app.api.getGeneratedAccountingMail();
  app.api.setAttachmentExcluded(app.api.getState().attachments[0].id, true);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true);
  assert.equal(app.api.getGeneratedAccountingMail(), withReceipt);
  app.api.generateAccountingMail();
  const report = app.api.getGeneratedAccountingMail();
  setValue(app, '#accountingMailMode', 'physical', 'change');
  assert.equal(app.api.getGeneratedAccountingMail(), report);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true);
});

test('generated and edited drafts persist separately across both cards and page reload', async () => {
  const db = database();
  const app = makeApp({ database: db, initialize: false });
  await app.api.ready;
  setValue(app, '#statementYear', '2027', 'change');
  app.elements.get('#rawText').value = statement;
  app.elements.get('#reparseButton').click();
  app.api.generateAccountingMail();
  setValue(app, '#accountingMailSubject', 'Card A subject');
  setValue(app, '#accountingMailText', 'Card A draft');
  assert.match(app.elements.get('#localSaveStatus').textContent, /儲存中/);
  app.api.switchCardTail('7802');
  assert.equal(app.api.getGeneratedAccountingMail(), '');
  app.api.generateAccountingMail();
  setValue(app, '#accountingMailText', 'Card B draft');
  await app.api.saveProgress();
  const reopened = makeApp({ database: db, initialize: false });
  await reopened.api.ready;
  assert.equal(reopened.api.getState().cardTail, '7802');
  assert.equal(reopened.api.getGeneratedAccountingMail(), 'Card B draft');
  assert.equal(reopened.elements.get('#copyAccountingMailButton').disabled, false);
  reopened.api.switchCardTail('2388');
  assert.equal(reopened.api.getGeneratedAccountingMail(), 'Card A draft');
  assert.equal(reopened.elements.get('#accountingMailSubject').value, 'Card A subject');
  assert.equal(reopened.elements.get('#copyAccountingMailButton').disabled, false);
});

test('EML preserves Unicode and long content, prevents header injection and contains no attachment or recipient', async () => {
  const blobs = [];
  const app = makeApp({ globals: {
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL() {} }
  } });
  app.api.generateAccountingMail();
  const subject = '中文草稿 '.repeat(20) + '\r\nBcc: attacker@example.invalid';
  const body = '完整長文與符號 & < > 🙂\n'.repeat(500);
  setValue(app, '#accountingMailSubject', subject);
  setValue(app, '#accountingMailText', body);
  app.elements.get('#downloadAccountingMailButton').click();
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, 'message/rfc822');
  const eml = await blobs[0].text();
  assert.match(eml, /X-Unsent: 1\r\n/);
  assert.match(eml, /Content-Type: text\/plain; charset=UTF-8\r\n/);
  assert.doesNotMatch(eml, /\r\n(?:To|Bcc|Cc):/);
  assert.doesNotMatch(eml, /multipart\/mixed|Content-Disposition: attachment/);
  assert.equal(eml.replace(/\r\n/g, '').includes('\n'), false, 'transport uses only CRLF newlines');
  assert.ok(eml.split('\r\n').every(line => line.length <= 78));
  const [headers, encodedBody] = eml.split('\r\n\r\n');
  const encodedSubject = headers.split('Subject: ')[1].split('\r\nContent-Type:')[0];
  const decodedSubject = [...encodedSubject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map(match => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(decodedSubject, subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim());
  assert.equal(Buffer.from(encodedBody.replace(/\s/g, ''), 'base64').toString('utf8'), body.replace(/\r?\n/g, '\r\n'));
});

test('receipt processing visibly locks draft inputs and actions, then preserves and unlocks the edited draft', async () => {
  const app = makeApp({ windowProperties: {
    pdfjsLib: { GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }
  } });
  app.api.generateAccountingMail();
  setValue(app, '#accountingMailText', 'My preserved edit');
  const pending = app.api.autoMatchFiles([receipt('pending.pdf')]);
  for (const selector of [
    '#accountingMailMode', '#accountingMailSubject', '#accountingMailText',
    '#generateAccountingMailButton', '#copyAccountingMailButton', '#downloadAccountingMailButton'
  ]) assert.equal(app.elements.get(selector).disabled, true, selector);
  app.elements.get('#searchInput').listeners.get('input')();
  assert.equal(app.elements.get('#accountingMailText').disabled, true, 'rerender cannot unlock processing inputs');
  app.elements.get('#receiptStopButton').click();
  await pending;
  assert.equal(app.api.getGeneratedAccountingMail(), 'My preserved edit');
  assert.equal(app.elements.get('#accountingMailText').value, 'My preserved edit');
  assert.equal(app.elements.get('#accountingMailText').disabled, false);
  assert.equal(app.elements.get('#generateAccountingMailButton').disabled, false);
  assert.equal(app.elements.get('#copyAccountingMailButton').disabled, true, 'new receipt makes the retained draft stale');
});

test('generating a draft starts durable persistence without requiring another unrelated edit', async () => {
  const db = database();
  const app = makeApp({ database: db, initialize: false });
  await app.api.ready;
  setValue(app, '#statementYear', '2027', 'change');
  app.elements.get('#rawText').value = statement;
  app.elements.get('#reparseButton').click();
  const body = app.api.generateAccountingMail();
  await new Promise(resolve => setImmediate(resolve));
  const reopened = makeApp({ database: db, initialize: false });
  await reopened.api.ready;
  assert.equal(reopened.api.getGeneratedAccountingMail(), body);
  assert.equal(reopened.elements.get('#copyAccountingMailButton').disabled, false);
});

test('changing the statement year invalidates an undated draft without erasing its edited text', () => {
  const app = makeApp();
  for (const row of app.api.getState().rows) {
    editRow(app, row.id, 'transactionDate', '');
    editRow(app, row.id, 'postingDate', '');
  }
  const body = app.api.generateAccountingMail();
  assert.equal(app.elements.get('#accountingMailSubject').value, '公司卡2388（消費日期待確認）');
  setValue(app, '#statementYear', '2028', 'change');
  assert.equal(app.api.getGeneratedAccountingMail(), body);
  assert.equal(app.elements.get('#downloadAccountingMailButton').disabled, true);
  assert.match(app.elements.get('#accountingMailStatus').textContent, /已變更|過期/);
});
