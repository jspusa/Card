import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "./app-harness.mjs";

const statement = [
  "09/01 09/02 SYNTHETIC LODGING 3200 2388 US USD 100.00 09/01",
  "09/02 09/03 SYNTHETIC LODGING 6400 2388 US USD 200.00 09/02",
  "09/03 09/04 SYNTHETIC LODGING 9600 2388 US USD 300.00 09/03"
].join("\n");

// These are failure-injection regressions, not evidence that a real receipt
// took forever. Run the shipped upload handler and matching/manual-review UI;
// only browser image I/O, third-party OCR, and elapsed time are substituted.
function setupOcr({ initialization = "ok", recognition = "reject", termination = "ok", initializationProgress, recognizedTexts = [] } = {}) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const calls = { create: 0, parameters: 0, recognize: 0, terminate: 0 };
  const createdOptions = [];
  const schedule = (callback, milliseconds = 0) => {
    const id = ++sequence;
    timers.set(id, { callback, due: now + Math.max(0, Number(milliseconds) || 0) });
    return id;
  };
  const cancel = (id) => timers.delete(id);
  const never = () => new Promise(() => {});
  class SyntheticImage {
    naturalWidth = 1170;
    naturalHeight = 1550;
    set src(_) { this.onload(); }
  }
  const worker = {
    async setParameters() { calls.parameters += 1; },
    recognize() {
      calls.recognize += 1;
      if (recognition === "pending") return never();
      if (recognition === "reject") return Promise.reject(new Error("Synthetic OCR read failure"));
      return Promise.resolve({ data: { text: recognizedTexts.shift() ?? "Synthetic lodging receipt without a reliable payment amount" } });
    },
    terminate() {
      calls.terminate += 1;
      return termination === "pending" ? never() : Promise.resolve();
    }
  };
  const page = setup(statement, {
    globals: {
      Image: SyntheticImage,
      setTimeout: schedule,
      clearTimeout: cancel,
      console: { error() {}, warn() {}, log() {} }
    },
    windowProperties: {
      setTimeout: schedule,
      clearTimeout: cancel,
      Tesseract: {
        OEM: { LSTM_ONLY: 1 },
        PSM: { AUTO: 3 },
        createWorker(_languages, _mode, options) {
          calls.create += 1;
          createdOptions.push(options);
          if (initializationProgress) options.logger(initializationProgress);
          if (initialization === "pending") return never();
          if (initialization === "reject") return Promise.reject(new Error("Synthetic OCR initialization failure"));
          return Promise.resolve(worker);
        }
      }
    }
  });
  const createElement = page.document.createElement;
  page.document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "canvas") element.getContext = () => ({ drawImage() {} });
    return element;
  };
  const files = [1, 2, 3].map((number) => new File(
    [`Synthetic JPEG boundary ${number}; no private receipt data`],
    `synthetic-receipt-${number}.jpg`,
    { type: "image/jpeg" }
  ));
  return {
    ...page,
    calls,
    files,
    worker,
    createdOptions,
    elapsed: () => now,
    async completeWithinDeadline(promise) {
      let completed = false;
      let failure;
      promise.then(() => { completed = true; }, error => { failure = error; completed = true; });
      // Five minutes of virtual time lets a conservative per-file timeout run
      // for all three files, but consumes no wall-clock wait in the suite.
      for (let turn = 0; turn < 100 && !completed; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
        if (completed) break;
        const next = [...timers.entries()].sort((left, right) => left[1].due - right[1].due)[0];
        if (!next || next[1].due > 300_000) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].callback();
      }
      await new Promise(resolve => setImmediate(resolve));
      if (failure) throw failure;
      assert.equal(completed, true,
        `receipt batch must finish within a bounded deadline; actual UI: ${page.elements.get("#receiptProgress").textContent}`);
    }
  };
}

async function assertRecoverableBatch(page, promise = page.api.autoMatchFiles(page.files)) {
  await page.completeWithinDeadline(promise);
  assert.ok(page.calls.create > 0, "the real image path must reach OCR initialization");
  const initial = page.api.getState();
  assert.equal(initial.attachments.length, 3);
  assert.ok(initial.attachments.every(item => item.status !== "processing"));
  assert.ok(initial.attachments.every(item => !item.rowId), "failed OCR cannot confirm a purchase");
  assert.ok(initial.attachments.every(item => item.matchReasons.length > 0), "each retained receipt needs an actionable review reason");
  assert.equal(page.elements.get("#receiptPickButton").disabled, false);
  assert.equal(page.elements.get("#cardTailSelect").disabled, false);
  assert.doesNotMatch(page.elements.get("#receiptProgress").textContent, /正在讀取第|正在辨識/);

  for (const [index, attachment] of initial.attachments.entries()) {
    const card = { dataset: { attachmentId: attachment.id } };
    const select = { value: initial.rows[index].id, closest: () => card };
    page.elements.get("#reviewGrid").listeners.get("change")({ target: { closest: () => select } });
  }
  const after = page.api.getState();
  assert.ok(after.attachments.every((item, index) => item.rowId === after.rows[index].id && item.matchLevel === "manual"),
    "all three existing attachments must remain manually assignable without re-upload");
  assert.ok(after.rows.every(row => row.invoiceFound));

  await page.api.exportReceiptZip();
  const archivedFiles = Object.values(page.archives[0].files);
  assert.equal(archivedFiles.length, page.files.length);
  for (const file of page.files) assert.ok(archivedFiles.includes(file), "ZIP must retain each exact original File object");
}

test("receipt OCR initialization that never settles leaves three original files available for manual review", async () => {
  await assertRecoverableBatch(setupOcr({ initialization: "pending" }));
});

test("receipt OCR language initialization displays the real loading stage and percentage instead of a frozen file counter", async () => {
  const page = setupOcr({
    initialization: "pending",
    initializationProgress: { status: "loading language traineddata", progress: 0.5 }
  });
  // The external engine is still legitimately loading, not failing. The
  // progress event must be visible before initialization has completed.
  page.api.autoMatchFiles(page.files);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.calls.create, 1, "the real image path must reach OCR initialization");
  const message = page.elements.get("#receiptProgress").textContent;
  assert.match(message, /載入|初始化|準備/, "initialization must not remain indistinguishable from an idle first file");
  assert.match(message, /50\s*%/, "the engine's real progress must reach the UI");
});

test("receipt OCR recognition that never settles leaves three original files available for manual review", async () => {
  await assertRecoverableBatch(setupOcr({ recognition: "pending" }));
});

test("receipt OCR initialization rejection leaves three original files available for manual review", async () => {
  await assertRecoverableBatch(setupOcr({ initialization: "reject" }));
});

test("receipt OCR recognition rejection leaves three original files available for manual review", async () => {
  const page = setupOcr();
  await assertRecoverableBatch(page);
  assert.equal(page.calls.recognize, 3, "one unreadable image must not skip later images");
});

test("unresponsive OCR cleanup cannot keep completed receipts locked", async () => {
  await assertRecoverableBatch(setupOcr({ recognition: "ok", termination: "pending" }));
});

test("stop button promptly unlocks all three pending images without discarding or re-uploading files", async () => {
  const page = setupOcr({ initialization: "pending" });
  const pending = page.api.autoMatchFiles(page.files);
  await new Promise(resolve => setImmediate(resolve));
  const stopButton = page.elements.get("#receiptStopButton");
  assert.notEqual(stopButton.style.display, "none");
  stopButton.click();
  await assertRecoverableBatch(page, pending);
  assert.equal(page.elapsed(), 0, "stop must resolve immediately rather than waiting for the timeout");
  assert.equal(stopButton.style.display, "none");
  assert.ok(page.api.getState().attachments.every(item => item.matchLevel === "manual"));
});

for (const firstJobResult of ["orphaned", "rejects"]) {
  test(`an asynchronous OCR errorHandler affects only the failed image when its job promise ${firstJobResult}`, async () => {
    const page = setupOcr({ recognition: "ok" });
    let rejectFirstJob;
    page.worker.recognize = () => {
      page.calls.recognize += 1;
      if (page.calls.recognize === 1) return new Promise((_, reject) => { rejectFirstJob = reject; });
      const day = page.calls.recognize;
      return Promise.resolve({ data: { text: `SYNTHETIC LODGING Official receipt 2027-09-0${day} paid USD ${day}00.00` } });
    };
    const pending = page.api.autoMatchFiles(page.files);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.calls.recognize, 1);
    const failure = new Error("Synthetic asynchronous single-image failure");
    page.createdOptions[0].errorHandler(failure);
    if (firstJobResult === "rejects") rejectFirstJob(failure);
    await page.completeWithinDeadline(pending);

    const state = page.api.getState();
    assert.equal(page.elapsed(), 0, "worker errors must not need the 90-second timeout");
    assert.equal(page.calls.recognize, 3, "one image failure must not abort later readable images");
    assert.equal(page.calls.terminate, 1);
    assert.equal(state.attachments.length, 3);
    assert.equal(state.attachments[0].rowId, "");
    assert.match(state.attachments[0].matchReasons.join(" "), /讀取|辨識/);
    assert.equal(state.attachments[1].rowId, state.rows[1].id);
    assert.equal(state.attachments[2].rowId, state.rows[2].id);
    const card = { dataset: { attachmentId: state.attachments[0].id } };
    const select = { value: state.rows[0].id, closest: () => card };
    page.elements.get("#reviewGrid").listeners.get("change")({ target: { closest: () => select } });
    assert.ok(page.api.getState().rows.every(row => row.invoiceFound));
    await page.api.exportReceiptZip();
    const originals = Object.values(page.archives[0].files);
    assert.ok(page.files.every(file => originals.includes(file)), "single-image failure cannot discard any original");
  });
}

test("a canceled initialization releases its late worker without configuring it or changing a new batch", async () => {
  const page = setupOcr({ recognition: "pending" });
  let resolveFirstWorker;
  let firstOptions;
  let secondOptions;
  let initializations = 0;
  const abandoned = { parameters: 0, recognition: 0, termination: 0 };
  const lateWorker = {
    async setParameters() { abandoned.parameters += 1; },
    async recognize() { abandoned.recognition += 1; return { data: { text: "stale synthetic result" } }; },
    async terminate() { abandoned.termination += 1; }
  };
  page.window.Tesseract.createWorker = (_languages, _mode, options) => {
    if (++initializations === 1) {
      firstOptions = options;
      return new Promise(resolve => { resolveFirstWorker = resolve; });
    }
    secondOptions = options;
    return Promise.resolve(page.worker);
  };
  const first = page.api.autoMatchFiles(page.files);
  await new Promise(resolve => setImmediate(resolve));
  page.elements.get("#receiptStopButton").click();
  await page.completeWithinDeadline(first);
  const oldAttachments = page.api.getState().attachments;

  const nextFiles = [new File(["new synthetic image"], "next-batch.jpg", { type: "image/jpeg" })];
  const second = page.api.autoMatchFiles(nextFiles);
  await new Promise(resolve => setImmediate(resolve));
  secondOptions.logger({ status: "recognizing text", progress: 0.4 });
  const currentMessage = page.elements.get("#receiptProgress").textContent;
  const currentState = page.api.getState();
  firstOptions.logger({ status: "loading language traineddata", progress: 0.99 });
  resolveFirstWorker(lateWorker);
  await new Promise(resolve => setImmediate(resolve));
  firstOptions.errorHandler(new Error("late error from abandoned worker"));

  assert.equal(page.elements.get("#receiptProgress").textContent, currentMessage, "stale progress must not overwrite current progress");
  assert.deepEqual(page.api.getState(), currentState, "stale worker callbacks cannot modify either batch");
  assert.deepEqual(page.api.getState().attachments.slice(0, 3), oldAttachments, "completed earlier receipts remain unchanged");
  assert.equal(page.elements.get("#receiptPickButton").disabled, true, "old error must not cancel the active batch");
  assert.equal(abandoned.termination, 1, "late initialized worker must be released exactly once");
  assert.equal(abandoned.parameters, 0, "a canceled worker must not receive new configuration after termination");
  assert.equal(abandoned.recognition, 0);

  page.elements.get("#receiptStopButton").click();
  await page.completeWithinDeadline(second);
  assert.equal(page.elapsed(), 0);
});

test("normal three-image OCR still supports a mixture of unique automatic matches and manual review", async () => {
  const page = setupOcr({ recognition: "ok", recognizedTexts: [
    "SYNTHETIC LODGING Official receipt 2027-09-01 paid USD 100.00",
    "Unreadable synthetic lodging image",
    "SYNTHETIC LODGING Official receipt 2027-09-03 paid USD 300.00"
  ] });
  await page.completeWithinDeadline(page.api.autoMatchFiles(page.files));
  const state = page.api.getState();
  assert.equal(page.calls.create, 1, "one worker is reused for the normal batch");
  assert.equal(page.calls.recognize, 3);
  assert.equal(page.calls.terminate, 1);
  assert.equal(page.elapsed(), 0);
  assert.equal(state.attachments[0].rowId, state.rows[0].id);
  assert.equal(state.attachments[0].matchLevel, "high");
  assert.equal(state.attachments[1].rowId, "");
  assert.equal(state.attachments[2].rowId, state.rows[2].id);
  assert.equal(state.attachments[2].matchLevel, "high");
  const card = { dataset: { attachmentId: state.attachments[1].id } };
  const select = { value: state.rows[1].id, closest: () => card };
  page.elements.get("#reviewGrid").listeners.get("change")({ target: { closest: () => select } });
  assert.ok(page.api.getState().rows.every(row => row.invoiceFound));
  await page.api.exportReceiptZip();
  assert.equal(Object.keys(page.archives[0].files).length, 3);
});

test("recognition completing after cancellation cannot overwrite manual assignments or a later batch's progress", async () => {
  const page = setupOcr({ recognition: "pending" });
  let resolveStaleRecognition;
  page.worker.recognize = () => new Promise(resolve => { resolveStaleRecognition = resolve; });
  const first = page.api.autoMatchFiles(page.files);
  await new Promise(resolve => setImmediate(resolve));
  page.elements.get("#receiptStopButton").click();
  await assertRecoverableBatch(page, first);
  const manuallyReviewed = page.api.getState();
  const previousOptions = page.createdOptions[0];

  let currentOptions;
  page.window.Tesseract.createWorker = (_languages, _mode, options) => {
    currentOptions = options;
    return Promise.resolve({
      async setParameters() {},
      recognize: () => new Promise(() => {}),
      async terminate() {}
    });
  };
  const next = page.api.autoMatchFiles([new File(["next image"], "late-result-check.jpg", { type: "image/jpeg" })]);
  await new Promise(resolve => setImmediate(resolve));
  currentOptions.logger({ status: "recognizing text", progress: 0.25 });
  const progress = page.elements.get("#receiptProgress").textContent;
  resolveStaleRecognition({ data: { text: "SYNTHETIC LODGING Official receipt 2027-09-03 paid USD 300.00" } });
  previousOptions.logger({ status: "recognizing text", progress: 1 });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(page.elements.get("#receiptProgress").textContent, progress);
  assert.deepEqual(page.api.getState().rows, manuallyReviewed.rows);
  assert.deepEqual(page.api.getState().attachments.slice(0, 3), manuallyReviewed.attachments);
  assert.equal(page.elements.get("#receiptPickButton").disabled, true);
  page.elements.get("#receiptStopButton").click();
  await page.completeWithinDeadline(next);
  assert.equal(page.elapsed(), 0);
});
