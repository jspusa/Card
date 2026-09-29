import assert from "node:assert/strict";
import test from "node:test";
import { setup, receipt } from "./app-harness.mjs";

test("a Mandalay Bay hotel payment matches the MBAY FRONT DESK bank descriptor", async () => {
  const { api } = setup("09/01 09/02 MBAY FRONT DESK 3200 2388 US USD 100.00 09/01");
  const expected = api.getState().rows[0].id;
  await api.autoMatchFiles([receipt("hotel.pdf", "MANDALAY BAY Resort and Casino Guest Receipt\nDeparture 2027-09-01\n2027-09-01 Mastercard USD 100.00\nBalance USD 0.00")]);
  assert.equal(api.getState().attachments[0].rowId, expected);
});

test("Freeman official name matches its corporate bank descriptor despite generic currency terms", async () => {
  const { api } = setup("09/01 09/02 FREEMAN CORPORATE LLC 3200 2388 US USD 100.00 09/01");
  const expected = api.getState().rows[0].id;
  await api.autoMatchFiles([receipt("exhibitor.pdf", "Freeman\nInvoice Statement\nInvoice Total $100.00 USD\nInvoice date 09/01/2027\nUnless otherwise agreed, all payments are to be made in CAD or USD.")]);
  assert.equal(api.getState().attachments[0].rowId, expected);
});

test("actual currency amounts still conflict even when the expected currency also appears", async () => {
  const { api } = setup("09/01 09/02 FREEMAN CORPORATE LLC 3200 2388 US USD 100.00 09/01");
  await api.autoMatchFiles([receipt("exhibitor.pdf", "Freeman\nInvoice Total $100.00 USD\nAmount paid CAD 100.00\nInvoice date 09/01/2027")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("an explicit invoice currency declaration is not discarded as boilerplate", async () => {
  const { api } = setup("09/01 09/02 FREEMAN CORPORATE LLC 3200 2388 US USD 100.00 09/01");
  await api.autoMatchFiles([receipt("exhibitor.pdf", "Freeman\nInvoice currency: CAD\nAmount converted: USD 100.00\nInvoice date 09/01/2027")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("APPA's explicitly recorded partial payment matches, not the invoice balance or grand total", async () => {
  const { api } = setup([
    "09/01 09/02 APPA INCGLOBAL PET EX 14400 2388 US USD 450.00 09/01",
    "09/01 09/02 APPA INCGLOBAL PET EX 32000 2388 US USD 1000.00 09/01",
    "09/01 09/02 APPA INCGLOBAL PET EX 46400 2388 US USD 1450.00 09/01"
  ].join("\n"));
  const expected = api.getState().rows[0].id;
  await api.autoMatchFiles([receipt("exhibition.pdf", "American Pet Products Association Inc\nGlobal Pet Expo\nPayments Made\nOrder / Invoice No. Method/Type Detail/Reference Payment Date Amount\n1001 Credit Card\n(MasterCard)\nCredit Card ending with: 2388, Auth-Code:\n123456\n09/01/2027 $400.00\n1002 Credit Card\n(MasterCard)\nCredit Card ending with: 2388, Auth-Code:\n123456\n09/01/2027 $50.00\nSummary\nTotal: $1,450.00\nPayments Total: -$450.00\nBalance: (Due By: 11/01/2027) $1,000.00")]);
  assert.equal(api.getState().attachments[0].rowId, expected);
});

test("a cumulative payments total without one corroborated card charge cannot auto-match", async () => {
  const { api } = setup([
    "09/01 09/02 APPA INCGLOBAL PET EX 6400 2388 US USD 200.00 09/01",
    "09/01 09/02 APPA INCGLOBAL PET EX 9600 2388 US USD 300.00 09/01"
  ].join("\n"));
  await api.autoMatchFiles([receipt("exhibition.pdf", "American Pet Products Association Inc\nGlobal Pet Expo\nPayments Made\n08/01/2027 MasterCard USD 100.00\n09/01/2027 MasterCard USD 200.00\nTotal USD 900.00\nPayments Total: -$300.00\nBalance USD 600.00")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("cumulative payment detail must share its date, card, and authorization, not merely add up", async () => {
  for (const [secondDate, secondCard, secondAuthorization] of [
    ["08/01/2027", "2388", "123456"],
    ["09/01/2027", "8888", "123456"],
    ["09/01/2027", "2388", "654321"]
  ]) {
    const { api } = setup("09/01 09/02 APPA INCGLOBAL PET EX 14400 2388 US USD 450.00 09/01");
    await api.autoMatchFiles([receipt("exhibition.pdf", `American Pet Products Association Inc\nPayments Made\nCredit Card ending with: 2388, Auth-Code: 123456\n09/01/2027 $400.00\nCredit Card ending with: ${secondCard}, Auth-Code: ${secondAuthorization}\n${secondDate} $50.00\nSummary\nPayments Total: -$450.00`)]);
    assert.equal(api.getState().attachments[0].rowId, "", [secondDate, secondCard, secondAuthorization].join("/"));
  }
});

test("a corroborated cumulative payment on a different card still cannot match the selected card", async () => {
  const { api } = setup("09/01 09/02 APPA INCGLOBAL PET EX 14400 2388 US USD 450.00 09/01");
  await api.autoMatchFiles([receipt("exhibition.pdf", "American Pet Products Association Inc\nPayments Made\nCredit Card ending with: 9999, Auth-Code: 123456\n09/01/2027 $400.00\nCredit Card ending with: 9999, Auth-Code: 123456\n09/01/2027 $50.00\nSummary\nPayments Total: -$450.00")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("new short merchant aliases must be complete words rather than another business's prefix", async () => {
  for (const [rowMerchant, otherMerchant] of [["APPA INCGLOBAL PET EX", "APPAREL STORE"], ["CANVA", "CANVAS SUPPLIES"], ["FREEMAN CORPORATE LLC", "FREEMANSON SHOP"]]) {
    const { api } = setup(`09/01 09/02 ${rowMerchant} 3200 2388 US USD 100.00 09/01`);
    await api.autoMatchFiles([receipt("receipt.pdf", `${otherMerchant}\nOfficial receipt\nDate paid September 1, 2027\nAmount paid USD 100.00`)]);
    assert.equal(api.getState().attachments[0].rowId, "", rowMerchant);
  }
});

test("a labeled paid date distinguishes same-amount Runway purchases two days apart", async () => {
  const { api } = setup([
    "09/01 09/02 RUNWAY 1440 2388 US USD 45.00 09/01",
    "09/03 09/04 RUNWAY 1440 2388 US USD 45.00 09/03"
  ].join("\n"));
  const expected = api.getState().rows.map(row => row.id);
  await api.autoMatchFiles([
    receipt("first.pdf", "Receipt\nRunway AI, Inc.\nDate paid September 1, 2027\nAmount paid $45.00"),
    receipt("second.pdf", "Receipt\nRunway AI, Inc.\nDate paid September 3, 2027\nAmount paid $45.00")
  ]);
  assert.deepEqual(Array.from(api.getState().attachments, item => item.rowId), Array.from(expected));
});

test("an exact paid date outranks another purchase's equal posting date before contenders are grouped", async () => {
  const { api } = setup([
    "09/01 09/03 RUNWAY 1440 2388 US USD 45.00 09/01",
    "09/03 09/05 RUNWAY 1440 2388 US USD 45.00 09/03"
  ].join("\n"));
  const expected = api.getState().rows.map(row => row.id);
  await api.autoMatchFiles([
    receipt("first.pdf", "Receipt\nRunway AI, Inc.\nDate paid September 1, 2027\nAmount paid $45.00"),
    receipt("second.pdf", "Receipt\nRunway AI, Inc.\nDate paid September 3, 2027\nAmount paid $45.00")
  ]);
  assert.deepEqual(Array.from(api.getState().attachments, item => item.rowId), Array.from(expected));
});

test("a posting-date tie stays manual when purchases are only one day apart", async () => {
  const { api } = setup([
    "09/01 09/02 RUNWAY 1440 2388 US USD 45.00 09/01",
    "09/02 09/04 RUNWAY 1440 2388 US USD 45.00 09/02"
  ].join("\n"));
  await api.autoMatchFiles([receipt("receipt.pdf", "Runway AI, Inc.\nDate paid September 2, 2027\nAmount paid $45.00")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});

test("a preferred exact paid date never redirects around an occupied purchase", async () => {
  const { api } = setup([
    "09/01 09/03 RUNWAY 1440 2388 US USD 45.00 09/01",
    "09/03 09/05 RUNWAY 1440 2388 US USD 45.00 09/03"
  ].join("\n"));
  const occupied = api.getState().rows[1].id;
  api.attachFiles(occupied, [receipt("manual.pdf")]);
  await api.autoMatchFiles([receipt("receipt.pdf", "Runway AI, Inc.\nDate paid September 3, 2027\nAmount paid $45.00")]);
  const result = api.getState().attachments;
  assert.equal(result[0].rowId, occupied);
  assert.equal(result[1].rowId, "");
  assert.match(result[1].matchReasons.join(" "), /已有附件/);
});

test("a labeled date does not resolve consecutive-day purchases or duplicate hotel charges", async () => {
  for (const secondDay of ["01", "02"]) {
    const { api } = setup([
      "09/01 09/02 MBAY FRONT DESK 3200 2388 US USD 100.00 09/01",
      `09/${secondDay} 09/03 MBAY FRONT DESK 3201 2388 US USD 100.00 09/${secondDay}`
    ].join("\n"));
    await api.autoMatchFiles([receipt("hotel.pdf", "Mandalay Bay Guest Receipt\nRoom Rate\nDate paid September 1, 2027\nAmount paid USD 100.00")]);
    assert.equal(api.getState().attachments[0].rowId, "", secondDay);
  }
});

test("Mandalay exhibitor and hotel aliases do not cross-match", async () => {
  const { api } = setup([
    "09/01 09/02 MB-EXHIBITOR SERVICES 3200 2388 US USD 100.00 09/01",
    "09/01 09/02 MBAY FRONT DESK 3200 2388 US USD 100.00 09/01"
  ].join("\n"));
  const expected = api.getState().rows.map(row => row.id);
  await api.autoMatchFiles([
    receipt("electrical.pdf", "Receipt\nexhibitorservices@mandalaybay.com\nPayment History\n09/01/2027 Master Card USD 100.00"),
    receipt("hotel.pdf", "Mandalay Bay Resort and Casino Guest Receipt\nRoom Rate\n2027-09-01 Mastercard USD 100.00")
  ]);
  assert.deepEqual(Array.from(api.getState().attachments, item => item.rowId), Array.from(expected));
});

test("Card working screenshots cannot match or block the actual receipt in the same batch", async () => {
  const { api } = setup();
  const expected = api.getState().rows[0].id;
  await api.autoMatchFiles([
    receipt("working-screen.pdf", "Card\n本期消費\n報帳金額\n附件複查區\nSAMPLE SHOP 2027-09-01 USD 100.00\n發票已找到"),
    receipt("real.pdf", "SAMPLE SHOP Official receipt — 2027-09-01 — total paid USD 100.00")
  ]);
  const result = api.getState().attachments;
  assert.equal(result[0].rowId, "");
  assert.match(result[0].matchReasons.join(" "), /工作畫面|非收據/);
  assert.equal(result[1].rowId, expected);
});

test("an explicit paid amount cannot be replaced by a matching line item or service-period date", async () => {
  const { api } = setup("09/01 09/02 RUNWAY 3200 2388 US USD 100.00 09/01");
  await api.autoMatchFiles([receipt("receipt.pdf", "Runway AI, Inc.\nDate paid September 1, 2027\nSubscription USD 100.00\nCredit USD 25.00\nAmount paid USD 75.00")]);
  assert.equal(api.getState().attachments[0].rowId, "");
});
