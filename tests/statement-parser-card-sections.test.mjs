import assert from "node:assert/strict";
import test from "node:test";
import { parseStatementText } from "./parser-harness.mjs";

// Synthetic amounts and merchants preserve the cropped scan's column layout.
const croppedStatement = [
  "持卡人甲(5588 **** **** 7802)",
  "公司卡達減免下次年費累積金額123,456元",
  "SAMPLE TRAVEL 8,000 7802",
  "AMZ*SAMPLE PAYMENTS 320 7802 US USD 10.00 08/26",
  "國外交易手續費(10.00 USD) 5 7802",
  "現金回饋-公司商旅卡 -20 7802",
  "小計 8,305",
  "持卡人乙(5588 **** **** 2388)",
  "公司卡達減免下次年費累積金額987,654元",
  "SAMPLE STORE 630 2388",
  "SAMPLE AI 960 2388 US USD 30.00 08/12",
  "國外交易手續費(30.00 USD) 14 2388",
  "SAMPLE HOTEL 23,760 2388 US USD 735.82 08/17",
  "國外交易手續費(735.82 USD) 356 2388",
  "消費明細說明 新臺幣金額 卡號後四碼 消費國家 幣別 外幣金額 折算日",
  "SAMPLE SUBSCRIPTION 6,990 2388",
  "國外交易手續費(6990.00 TWD) 105 2388",
  "現金回饋-公司商旅卡 -70 2388",
  "小計 32,745"
].join("\n");

test("recovers card transactions when the scan crops both leading date columns", () => {
  const result = parseStatementText(croppedStatement, 2026, "2388");
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows.reduce((sum, row) => sum + row.amount, 0), 32340);
  assert.equal(result.excluded.filter((row) => row.reason === "fee").length, 3);
  assert.equal(result.excluded.filter((row) => row.reason === "cashback").length, 1);
  assert.ok(result.rows.every((row) => row.transactionDate === "" && row.postingDate === ""));
  assert.ok(result.rows.every((row) => row.dateMissing === true));
  assert.equal(result.rows[1].foreignAmount, 30);
});

test("switches to 7802 without mixing transactions or exclusions from 2388", () => {
  const result = parseStatementText(croppedStatement, 2026, "7802");
  assert.deepEqual(result.rows.map((row) => row.amount), [8000, 320]);
  assert.deepEqual(result.excluded.map((row) => row.amount), [5, -20]);
});

test("uses the selected card with normal dated rows and missing-tail recovery", () => {
  const statement = [
    "持卡人甲(5588 **** **** 7802)",
    "09/01 09/02 SAMPLE AIRLINE 7,000 7802",
    "09/03 09/04 SAMPLE STORE 500",
    "持卡人乙(5588 **** **** 2388)",
    "09/01 09/02 SAMPLE AI 960 2388 US USD 30.00 09/01",
    "09/01 09/02 國外交易手續費(30.00 USD) 14 2388"
  ].join("\n");
  const result = parseStatementText(statement, 2026, "7802");
  assert.deepEqual(result.rows.map((row) => row.amount), [7000, 500]);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.rows[0].transactionDate, "2026-09-01");
});

test("does not treat a card-like amount or another card's row as the selected card", () => {
  const statement = [
    "持卡人甲(5588 **** **** 2388)",
    "SAMPLE STORE 2,388 7802",
    "09/01 09/02 ANOTHER STORE 2,388 7802",
    "SAMPLE SERVICE 12388 USD 100.00 09/02",
    "小計 2388"
  ].join("\n");
  assert.equal(parseStatementText(statement, 2026, "2388").rows.length, 0);
});

test("retains repeated undated purchases because missing dates cannot prove duplicates", () => {
  const result = parseStatementText([
    "SAMPLE HOTEL 23,760 2388 US USD 735.82 08/17",
    "國外交易手續費(735.82 USD) 356 2388",
    "SAMPLE HOTEL 23,760 2388 US USD 735.82 08/18",
    "國外交易手續費(735.82 USD) 356 2388"
  ].join("\n"), 2026, "2388");
  assert.equal(result.rows.length, 2);
});

test("keeps a transaction when OCR adds a quote before the country column", () => {
  const result = parseStatementText([
    "SAMPLE SERVICE 32,000 2388 “Us USD 1,000.00 08/17",
    "EISH SAMPLE(1000.00 USD) 480 2388"
  ].join("\n"), 2026, "2388");
  assert.deepEqual(result.rows.map((row) => row.amount), [32000]);
  assert.equal(result.excluded[0].reason, "fee");
});

test("distinguishes a merchant containing CARD from a cardholder header", () => {
  const result = parseStatementText([
    "持卡人乙(5588 **** **** 2388)",
    "SAMPLE CARD SERVICES 800 2388",
    "小計 800 2388",
    "公司卡達減免下次年費累積金額 800 2388"
  ].join("\n"), 2026, "2388");
  assert.deepEqual(result.rows.map((row) => row.description), ["SAMPLE CARD SERVICES"]);
});

test("keeps year rollover for dated rows without using missing dates as January", () => {
  const mixed = parseStatementText([
    "12/20 12/21 SAMPLE SERVICE 400 7802",
    "SAMPLE STORE 500 7802"
  ].join("\n"), 2026, "7802");
  assert.equal(mixed.rows[0].transactionDate, "2026-12-20");
  assert.equal(mixed.rows[1].transactionDate, "");

  const rollover = parseStatementText([
    "12/20 12/21 SAMPLE SERVICE 400 7802",
    "01/02 01/03 SAMPLE STORE 500 7802"
  ].join("\n"), 2026, "7802");
  assert.deepEqual(rollover.rows.map((row) => row.transactionDate), ["2025-12-20", "2026-01-02"]);
});

test("does not turn a foreign fee reference without its amount or card column into a purchase", () => {
  const result = parseStatementText([
    "持卡人甲(5588 **** **** 7802)",
    "09/01 09/02 SAMPLE SERVICE 3,200 7802 US USD 100.00 09/01",
    "09/01 09/02 國外交易手續費(100.00 USD)",
    "國外交易手續費(7802.00 USD)",
    "持卡人乙(5588 **** **** 2388)",
    "09/01 09/02 SAMPLE AI 960 2388 US USD 30.00 09/01",
    "09/01 09/02 國外交易手續費(30.00 USD) 14"
  ].join("\n"), 2026, "7802");
  assert.deepEqual(result.rows.map((row) => row.amount), [3200]);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].reason, "fee");
});

test("excludes OCR-damaged foreign fee labels only with an adjacent matching bank-rate charge", () => {
  const result = parseStatementText([
    "SAMPLE STORE 3,200 7802 US USD 100.00 09/01",
    "圈外交易手繽刁0.00 USD) 48 7802",
    "SAMPLE SERVICE 640 7802 US USD 20.00 09/02",
    "國外交易手續學(20.00 USD) 10 7802",
    "SAMPLE LUNCH 150 7802",
    "國外交易手工商品 300 7802"
  ].join("\n"), 2026, "7802");
  assert.deepEqual(result.rows.map((row) => row.amount), [3200, 640, 150, 300]);
  assert.deepEqual(result.excluded.map((row) => row.amount), [48, 10]);
  assert.equal(result.rows[0].foreignAmount, 100);
});

test("accepts OCR punctuation at column boundaries without changing card identity", () => {
  const result = parseStatementText([
    "SAMPLE EXHIBITION 36,000”2388 US USD 1.122.50 09/01",
    "SAMPLE SUBSCRIPTION 6,000”2388",
    "SAMPLE AI 5,000 2388 _HK [UsD 159.00 09/02",
    "OTHER CARD 8,000”7802 US USD 250.00 09/02"
  ].join("\n"), 2026, "2388");
  assert.deepEqual(result.rows.map((row) => row.amount), [36000, 6000, 5000]);
  assert.equal(result.rows[0].foreignAmount, 1122.5);
  assert.equal(result.rows[2].country, "HK");
});

test("excludes fee and cashback OCR variants even across printed page banners", () => {
  const result = parseStatementText([
    "SAMPLE SERVICE 3,200 2388 US USD 100.00 09/01",
    "銀行客服與跨頁欄位標題",
    "國外交易手續發(100.00 USD) 48 2388",
    "國外交易手續貫(20.00 USD) 10 2388",
    "現金回蝕-公司商旅卡 ~30 2388",
    "現金商品專賣店 30 2388"
  ].join("\n"), 2026, "2388");
  assert.deepEqual(result.rows.map((row) => row.amount), [3200, 30]);
  assert.deepEqual(result.excluded.map(({ amount, reason }) => ({ amount, reason })), [
    { amount: 48, reason: "fee" }, { amount: 10, reason: "fee" }, { amount: -30, reason: "cashback" }
  ]);
});

test("repairs a missing foreign decimal only when the fee corroborates all digits", () => {
  const result = parseStatementText([
    "SAMPLE SERVICE 88,000 2388 US USD 2,75123 09/01",
    "國外交易手續費(2751.23 USD) 1,320 2388",
    "SAMPLE AI 3,200 2388 US USD 100.00 09/02",
    "國外交易手續費(1.00 USD) 48 2388"
  ].join("\n"), 2026, "2388");
  assert.equal(result.rows[0].foreignAmount, 2751.23);
  assert.equal(result.rows[1].foreignAmount, 100);
});

test("recognizes a single OCR typo in the foreign transaction fee label across a banner", () => {
  const result = parseStatementText([
    "SAMPLE SERVICE 2,000 2388",
    "銀行客服與跨頁欄位標題",
    "國外安易手續發(2000.00 TWD) 30 2388",
    "國外商品專賣店 30 2388"
  ].join("\n"), 2026, "2388");
  assert.deepEqual(result.rows.map((row) => row.amount), [2000, 30]);
  assert.deepEqual(result.excluded.map((row) => row.amount), [30]);
});
