import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function setup() {
  const source = html.match(/<script id="local-progress-store">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, 'local progress store is available');
  const context = vm.createContext({ window: {}, structuredClone });
  vm.runInContext(source, context);
  const data = new Map();
  const statuses = [];
  const database = {
    async read(key) { return structuredClone(data.get(key)); },
    async write(snapshot, revision) {
      const prior = data.get(snapshot.fingerprint);
      if ((prior?.revision || 0) !== revision) throw new Error('conflict');
      const saved = structuredClone({ ...snapshot, revision: revision + 1 });
      data.set(snapshot.fingerprint, saved);
      data.set('latest', snapshot.fingerprint);
      return saved.revision;
    },
    async remove(key) { data.delete(key); if (data.get('latest') === key) data.delete('latest'); }
  };
  return { data, database, statuses, create: () => context.window.CardLocalProgress.create(database, status => statuses.push(status)) };
}

test('reopening restores both cards and exact receipt bytes from the latest workspace', async () => {
  const { create } = setup();
  const snapshot = { fingerprint: 'synthetic', cardTail: '7802', cards: [
    ['2388', { rows: [{ id: 'a', note: 'office' }], attachments: [{ file: new Uint8Array([1, 2, 3]) }] }],
    ['7802', { rows: [{ id: 'b', note: 'travel' }], attachments: [] }]
  ] };
  await create().save(snapshot);
  const restored = await create().load();
  assert.equal(restored.cardTail, '7802');
  assert.equal(restored.cards[0][1].rows[0].note, 'office');
  assert.deepEqual([...restored.cards[0][1].attachments[0].file], [1, 2, 3]);
  assert.equal(restored.cards[1][1].rows[0].note, 'travel');
});

test('a failed save remains visibly unsaved until a retry succeeds', async () => {
  const { create, database, statuses } = setup();
  const write = database.write;
  let failNext = true;
  database.write = async (...args) => {
    if (failNext) {
      failNext = false;
      throw new Error('QuotaExceededError');
    }
    return write(...args);
  };
  const progress = create();
  const snapshot = { fingerprint: 'retry-synthetic', cards: [], note: 'not lost' };

  await assert.rejects(progress.save(snapshot), /QuotaExceededError/);
  assert.equal(progress.status().state, 'error');
  assert.equal(progress.status().failed, 1);
  assert.equal(progress.status().pending, 0);
  assert.equal(statuses.at(-1).state, 'error');

  await progress.save(snapshot);
  assert.equal(progress.status().state, 'saved');
  assert.equal(progress.status().failed, 0);
  assert.equal((await create().load()).note, 'not lost');
});

test('a queued save captures immutable rows and receipt bytes at the time of the request', async () => {
  const { create } = setup();
  const progress = create();
  const snapshot = {
    fingerprint: 'immutable-synthetic',
    cards: [['2388', { rows: [{ note: 'captured note' }], attachments: [{ file: new Uint8Array([7, 8, 9]) }] }]]
  };

  const saved = progress.save(snapshot);
  snapshot.cards[0][1].rows[0].note = 'later live edit';
  snapshot.cards[0][1].attachments[0].file[0] = 99;
  await saved;

  const restored = await create().load();
  assert.equal(restored.cards[0][1].rows[0].note, 'captured note');
  assert.deepEqual([...restored.cards[0][1].attachments[0].file], [7, 8, 9]);
});

test('rapid saves stay serialized and restore the latest requested version', async () => {
  const { create, database } = setup();
  const write = database.write;
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let first = true;
  database.write = async (...args) => {
    if (first) {
      first = false;
      markStarted();
      await gate;
    }
    return write(...args);
  };
  const progress = create();
  const older = progress.save({ fingerprint: 'serial-synthetic', note: 'older' });
  const latest = progress.save({ fingerprint: 'serial-synthetic', note: 'latest' });
  await started;
  assert.equal(progress.status().pending, 2);
  assert.equal(progress.status().state, 'saving');

  releaseFirst();
  await Promise.all([older, latest]);
  const restored = await create().load();
  assert.equal(restored.note, 'latest');
  assert.equal(restored.revision, 2);
  assert.equal(progress.status().state, 'saved');
});

test('a stale tab cannot overwrite newer progress and can recover after reloading it', async () => {
  const { create } = setup();
  const current = create();
  const stale = create();
  await current.save({ fingerprint: 'shared-synthetic', note: 'first' });
  await stale.load('shared-synthetic');
  await current.save({ fingerprint: 'shared-synthetic', note: 'newer reviewed note' });

  await assert.rejects(stale.save({ fingerprint: 'shared-synthetic', note: 'stale edit' }), /conflict/);
  assert.equal(stale.status().state, 'error');
  assert.equal((await create().load()).note, 'newer reviewed note');

  await stale.load('shared-synthetic');
  await stale.save({ fingerprint: 'shared-synthetic', note: 'reviewed after reload' });
  assert.equal((await create().load()).note, 'reviewed after reload');
  assert.equal(stale.status().state, 'saved');
});

test('clearing one statement preserves another and clearing the latest removes its restore pointer', async () => {
  const { create } = setup();
  const progress = create();
  await progress.save({ fingerprint: 'older-synthetic', note: 'older statement' });
  await progress.save({ fingerprint: 'latest-synthetic', note: 'latest statement' });

  await progress.remove('older-synthetic');
  assert.equal(await create().load('older-synthetic'), null);
  assert.equal((await create().load()).note, 'latest statement');

  await progress.remove('latest-synthetic');
  assert.equal(await create().load(), null);
  assert.equal(await create().load('latest-synthetic'), null);
  await progress.save({ fingerprint: 'latest-synthetic', note: 'new work after clear' });
  assert.equal((await create().load()).note, 'new work after clear');
});

test('clearing waits for an in-flight save so the pending write cannot restore the deleted copy', async () => {
  const { create, database } = setup();
  const write = database.write;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  database.write = async (...args) => {
    markStarted();
    await gate;
    return write(...args);
  };
  const progress = create();
  const save = progress.save({ fingerprint: 'clear-pending-synthetic', note: 'pending' });
  await started;
  const clear = progress.remove('clear-pending-synthetic');
  release();
  await Promise.all([save, clear]);

  assert.equal(await create().load(), null);
  assert.equal(await create().load('clear-pending-synthetic'), null);
  assert.equal(progress.status().state, 'saved');
});
