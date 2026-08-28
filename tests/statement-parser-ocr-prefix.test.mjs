import assert from "node:assert/strict";
import test from "node:test";
import { parseStatementText } from "./parser-harness.mjs";

test("keeps transactions when OCR adds a short bullet before the date", () => {
  const result = parseStatementText([
    [
      "二 07/14 07/16 SAMPLE AI 2,222 2388 HK USB 69.00 07/14",
      "一 07/14 07/16 國外交易手續費(69.00 USD) 33 2388",
      "仁 07/21 07/27 SAMPLE STORE 66，556 2388"
    ].join("\n")
  ], 2026);

  assert.deepEqual(
    result.rows.map(({ transactionDate, description, amount }) => ({
      transactionDate,
      description,
      amount
    })),
    [
      { transactionDate: "2026-07-14", description: "SAMPLE AI", amount: 2222 },
      { transactionDate: "2026-07-21", description: "SAMPLE STORE", amount: 66556 }
    ]
  );
  assert.equal(result.excluded.filter((row) => row.reason === "fee").length, 1);
});
