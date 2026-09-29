import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return html.slice(start, end);
}

// Evaluate the page's real guide definitions, matching, and rendering functions.
// Only the DOM is replaced, so merchant matching is not duplicated in the tests.
const guideSource = [
  sourceBetween("      const SUBSCRIPTION_GUIDES = [", "      const $ ="),
  sourceBetween("      function formatInteger(", "      function cleanNumericInput("),
  sourceBetween("      function normalizeMatchText(", "      function compactMatchText("),
  sourceBetween("      function escapeHtml(", "      function attachmentCountForRow("),
  sourceBetween("      function slashDate(", "      function safeFilename(")
].join("\n");

function setup(rows = []) {
  const classes = new Set();
  const dom = {
    subscriptionPanel: {
      classList: {
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
        }
      }
    },
    subscriptionCount: { textContent: "" },
    subscriptionGrid: { innerHTML: "" }
  };
  const state = { rows };
  const api = new Function("state", "dom", `${guideSource}
    return { SUBSCRIPTION_GUIDES, getSubscriptionMatches, renderSubscriptionGuides };
  `)(state, dom);
  return { ...api, state, dom, classes };
}

function sampleRow(description, index = 1) {
  return {
    id: `synthetic-${index}`,
    transactionDate: `2027-01-${String(index).padStart(2, "0")}`,
    description,
    note: "",
    amount: 1000 + index,
    foreignAmount: 10 + index,
    currency: "USD"
  };
}

const mbName = "MB／Mandalay 展商服務";
const mbUrl = "https://www.mandalaybayexhibitorservices.com/";

test("receipt guide heading and accessible label cover non-subscription expenses", () => {
  const panel = sourceBetween(
    '    <section class="surface subscription-panel"',
    '    <section class="surface review-panel"'
  );
  assert.match(panel, /aria-label="收據／發票入口"/);
  assert.match(panel, /<h2>收據／發票入口<\/h2>/);
  assert.doesNotMatch(html, /訂閱發票捷徑|這些可能是訂閱/);
});

test("MB guide points to the official receipt flow and requires checking the payment", () => {
  const { SUBSCRIPTION_GUIDES } = setup();
  const guides = SUBSCRIPTION_GUIDES.filter((guide) => guide.name === mbName);
  assert.equal(guides.length, 1);
  const [guide] = guides;
  assert.deepEqual(guide.aliases, ["MB-EXHIBITOR SERVICES", "MB EXHIBITOR SERVICES"]);
  assert.equal(guide.url, mbUrl);
  for (const step of ["My Orders", "Print Receipt", "Payment History", "核對本次付款"]) {
    assert.ok(guide.steps.includes(step), `Missing receipt step: ${step}`);
  }
});

for (const merchant of ["MB-EXHIBITOR SERVICES", "MB EXHIBITOR SERVICES"]) {
  test(`${merchant} matches and renders one official MB guide`, () => {
    const row = sampleRow(merchant);
    const { getSubscriptionMatches, renderSubscriptionGuides, dom, classes } = setup([row]);
    const matches = getSubscriptionMatches();
    assert.equal(matches.length, 1);
    assert.equal(matches[0].guide.name, mbName);
    assert.equal(matches[0].guide.url, mbUrl);
    assert.deepEqual(matches[0].rows, [row]);

    renderSubscriptionGuides();
    assert.equal(classes.has("is-visible"), true);
    assert.equal(dom.subscriptionCount.textContent, "1 個捷徑");
    assert.equal((dom.subscriptionGrid.innerHTML.match(/<article\b/g) || []).length, 1);
    assert.ok(dom.subscriptionGrid.innerHTML.includes(`href="${mbUrl}"`));
    assert.ok(dom.subscriptionGrid.innerHTML.includes(merchant));
  });
}

test("MBAY FRONT DESK hotel rows do not match the MB exhibitor guide", () => {
  const hotel = sampleRow("MBAY FRONT DESK");
  const exhibitor = sampleRow("MB-EXHIBITOR SERVICES", 2);
  const { getSubscriptionMatches } = setup();
  assert.equal(getSubscriptionMatches([hotel]).some(({ guide }) => guide.name === mbName), false);
  const [match] = getSubscriptionMatches([hotel, exhibitor]);
  assert.equal(match.guide.name, mbName);
  assert.deepEqual(match.rows, [exhibitor]);
});

test("multiple exhibitor transactions share one guide while retaining all matched rows", () => {
  const rows = Array.from({ length: 4 }, (_, index) =>
    sampleRow(index % 2 ? "MB EXHIBITOR SERVICES" : "MB-EXHIBITOR SERVICES", index + 1)
  );
  const { getSubscriptionMatches, renderSubscriptionGuides, dom } = setup(rows);
  const matches = getSubscriptionMatches();
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].rows, rows);
  rows.forEach((row, index) => assert.equal(matches[0].rows[index], row));

  renderSubscriptionGuides();
  assert.equal((dom.subscriptionGrid.innerHTML.match(/<article\b/g) || []).length, 1);
  for (const row of rows.slice(0, 3)) {
    assert.ok(dom.subscriptionGrid.innerHTML.includes(row.transactionDate.replace(/-/g, "/")));
  }
  assert.match(dom.subscriptionGrid.innerHTML, /另有 1 筆/);
});

test("unknown merchants clear the rendered guide cards and hide the panel", () => {
  const { getSubscriptionMatches, renderSubscriptionGuides, state, dom, classes } = setup([
    sampleRow("MB-EXHIBITOR SERVICES")
  ]);
  renderSubscriptionGuides();
  assert.equal(classes.has("is-visible"), true);

  state.rows = [sampleRow("SYNTHETIC CORNER BOOKSHOP")];
  assert.deepEqual(getSubscriptionMatches(), []);
  renderSubscriptionGuides();
  assert.equal(classes.has("is-visible"), false);
  assert.equal(dom.subscriptionCount.textContent, "0 個捷徑");
  assert.equal(dom.subscriptionGrid.innerHTML, "");
});

test("GoDaddy receipt matching keeps its existing official destination", () => {
  const row = sampleRow("GODADDY SAMPLE-ORDER");
  const { getSubscriptionMatches } = setup();
  const matches = getSubscriptionMatches([row]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].guide.name, "GoDaddy 網域");
  assert.equal(matches[0].guide.url, "https://account.godaddy.com/receipts");
  assert.deepEqual(matches[0].rows, [row]);
});

test("APPA and Global Pet Expo still group under their existing guide", () => {
  const rows = [sampleRow("APPA INC SAMPLE"), sampleRow("GLOBAL PET EXPO SAMPLE", 2)];
  const { getSubscriptionMatches } = setup();
  const matches = getSubscriptionMatches(rows);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].guide.name, "APPA／Global Pet Expo");
  assert.deepEqual(matches[0].rows, rows);
});
