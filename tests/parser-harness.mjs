import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Missing parser function: ${name}`);
  const bodyStart = html.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < html.length; index += 1) {
    const character = html[index];
    const next = html[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated parser function: ${name}`);
}

const functionNames = [
  "cleanNumericInput",
  "makeId",
  "hammingDistance",
  "normalizeOcrDigits",
  "normalizeText",
  "parseDatePrefix",
  "findCardTail",
  "extractNumberTokens",
  "parseForeignReference",
  "chooseAmountWithoutTail",
  "parseRecord",
  "findHeaderTail",
  "collectPageRecords",
  "looksLikeCashback",
  "looksLikeFeeByText",
  "looksLikeStructuralFee",
  "inferYearDates",
  "parseStatementText"
];

const parserSource = `
  const CARD_TAIL = "2388";
  const CURRENCIES = [
    "TWD", "JPY", "USD", "EUR", "KRW", "SGD", "HKD", "CNY",
    "GBP", "AUD", "CAD", "THB", "VND", "MYR", "PHP", "NZD",
    "CHF", "SEK", "NOK", "DKK", "IDR"
  ];
  const COUNTRY_CURRENCY = {
    JP: "JPY", US: "USD", TW: "TWD", KR: "KRW", SG: "SGD", HK: "HKD",
    CN: "CNY", GB: "GBP", AU: "AUD", CA: "CAD", TH: "THB", VN: "VND",
    MY: "MYR", PH: "PHP", NZ: "NZD"
  };
  ${functionNames.map(extractFunction).join("\n")}
  return { parseStatementText };
`;

export const { parseStatementText } = new Function(parserSource)();
