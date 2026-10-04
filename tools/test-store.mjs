#!/usr/bin/env node
/**
 * Progress store tests. Run with `npm test`.
 *
 * The store is browser code, so this file gives it the three things it touches
 * — localStorage, window and document — as small in-memory stand-ins. Each case
 * that needs a clean module imports its own copy (`?case=…`), because the store
 * keeps its state at module level exactly as it does in the page.
 */

const KEY = 'difrana:v1';

let pass = 0;
let fail = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

/* ---- browser stand-ins ---------------------------------------------------- */

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.broken = false;
  }
  getItem(key) {
    if (this.broken) throw new Error('SecurityError');
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.broken) throw new Error('SecurityError');
    this.map.set(key, String(value));
  }
  removeItem(key) {
    if (this.broken) throw new Error('SecurityError');
    this.map.delete(key);
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });

const saved = () => JSON.parse(localStorage.getItem(KEY));
const load = (name) => import(`../assets/js/store.js?case=${name}`).then((m) => m.store);
const seed = (value) => localStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));

/* ---- cases ---------------------------------------------------------------- */

console.log('\nreset really resets (regression)');
{
  localStorage.map.clear();
  const store = await load('reset');
  store.setDone(3, true);
  store.toggleFav(7);
  store.clear();
  assert('done mark is gone after clear()', store.isDone(3) === false);
  assert('favourite is gone after clear()', store.isFav(7) === false);
  store.setDone(1, true);
  store.flush();
  assert('the next save carries no old progress', JSON.stringify(saved().done) === '{"1":1}');
  assert('…and no old favourites', JSON.stringify(saved().fav) === '{}');
}

console.log('\nresetProgress keeps favourites');
{
  localStorage.map.clear();
  const store = await load('reset-progress');
  store.toggleFav(9);
  store.markOpened(4, 1000);
  store.setDone(4, true);
  store.resetProgress();
  store.flush();
  assert('done cleared', store.isDone(4) === false);
  assert('opened cleared', store.openedAt(4) === 0 && store.lastOpened === 0);
  assert('favourite kept', store.isFav(9) === true);
  assert('persisted the same way', saved().fav[9] === 1 && Object.keys(saved().done).length === 0);
}

console.log('\nopening a form');
{
  localStorage.map.clear();
  const store = await load('opened');
  store.markOpened(5, 1234);
  assert('records the resume point', store.lastOpened === 5);
  assert('records when it was opened', store.openedAt(5) === 1234);
  store.markOpened(5, 2000);
  assert('re-opening updates the time', store.openedAt(5) === 2000);
  assert('opening alone does not decide "done" (the page does)', store.isDone(5) === false);
  store.setDone(5, true);
  store.setDone(5, false);
  assert('undo leaves the opened record in place', store.openedAt(5) === 2000 && !store.isDone(5));
  assert('setDone reports the new state', store.setDone(6, true) === true && store.setDone(6, false) === false);
}

console.log('\ndata saved by the earlier "did you finish?" version');
{
  localStorage.map.clear();
  seed({ v: 1, done: { 1: 1 }, fav: {}, opened: { 5: 10 }, last: 5, pending: { n: 5, at: 10 } });
  const store = await load('legacy-pending');
  store.setDone(2, true);
  store.flush();
  assert('keeps the real progress', store.isDone(1) && store.lastOpened === 5);
  assert('drops the obsolete pending field on the next save', !('pending' in saved()));
}

console.log('\nundo snapshot');
{
  localStorage.map.clear();
  const store = await load('snapshot');
  store.setDone(1, true);
  store.toggleFav(2);
  const snap = store.snapshot();
  store.setDone(1, false);
  store.toggleFav(2);
  assert('snapshot is independent of later changes', snap.done[1] === 1 && snap.fav[2] === 1);
  store.restore(snap);
  assert('restore brings everything back', store.isDone(1) && store.isFav(2));
  snap.done[99] = 1;
  assert('restored state is independent of the snapshot', store.isDone(99) === false);
}

console.log('\nhostile or corrupted storage');
{
  localStorage.map.clear();
  seed({
    done: { 2: 1, 3: 0, '-4': 1, abc: 1, 1.5: 1 },
    fav: [1, 2],
    opened: { 3: 'soon', 4: 99 },
    last: 'hi',
  });
  const store = await load('hostile');
  assert('keeps valid done marks only', store.isDone(2) && !store.isDone(3) && !store.isDone(-4));
  assert('rejects an array as favourites', store.isFav(1) === false);
  assert('drops non-numeric timestamps', store.openedAt(3) === 0 && store.openedAt(4) === 99);
  assert('rejects a non-numeric last', store.lastOpened === 0);
}
{
  // Written as raw JSON: an object literal would swallow "__proto__" itself.
  localStorage.map.clear();
  seed('{"__proto__":{"polluted":1},"done":{"__proto__":{"polluted":1},"7":1},"fav":{"constructor":1}}');
  const store = await load('proto');
  store.setDone(8, true);
  store.flush();
  assert('__proto__ keys are ignored, real marks kept', store.isDone(7) && store.isDone(8));
  assert('no prototype pollution', ({}).polluted === undefined && Object.prototype.polluted === undefined);
  assert('nothing but exam numbers is saved', Object.keys(saved().done).join() === '7,8' && Object.keys(saved().fav).length === 0);
}
{
  localStorage.map.clear();
  seed('{not json');
  const store = await load('corrupted');
  assert('corrupted JSON starts clean', store.isDone(1) === false && store.isAvailable);
  store.setDone(8, true);
  store.flush();
  assert('and is overwritten by the next save', saved().done[8] === 1);
}

console.log('\nstorage blocked (private window)');
{
  localStorage.map.clear();
  localStorage.broken = true;
  const store = await load('blocked');
  store.setDone(1, true);
  store.toggleFav(2);
  store.flush();
  assert('reports unavailable', store.isAvailable === false);
  assert('still works in memory', store.isDone(1) && store.isFav(2));
  localStorage.broken = false;
}

console.log('\nanother tab changes progress');
{
  localStorage.map.clear();
  const store = await load('cross-tab');
  store.setDone(1, true);
  store.flush();
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  seed({ v: 1, done: { 1: 1, 2: 1 }, fav: { 5: 1 }, opened: {}, last: 2 });
  window.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
  assert('subscribers are told', notified === 1);
  assert('the fresh copy is read', store.isDone(2) && store.isFav(5) && store.lastOpened === 2);
  window.dispatchEvent(Object.assign(new Event('storage'), { key: 'some-other-key' }));
  assert('unrelated keys are ignored', notified === 1);
}

console.log('\nsaving before the tab is hidden');
{
  localStorage.map.clear();
  const store = await load('hidden');
  store.setDone(12, true);
  assert('a change is debounced at first', localStorage.getItem(KEY) === null);
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  document.visibilityState = 'visible';
  assert('hiding the page writes it at once', saved()?.done?.[12] === 1);
  store.toggleFav(3);
  window.dispatchEvent(new Event('pagehide'));
  assert('pagehide writes it at once', saved()?.fav?.[3] === 1);
  store.setDone(13, true);
  store.reload();
  assert('reload() keeps unsaved changes', store.isDone(13) === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
// Pending debounce timers would otherwise keep the process alive briefly.
process.exit(fail ? 1 : 0);
