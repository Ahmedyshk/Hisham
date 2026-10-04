/**
 * Device-local progress store.
 *
 * The dataset carries no per-student state, so "done", "favourite" and
 * "opened" live only in this browser's localStorage. Every storage call is
 * wrapped: storage throws in some private windows and when site data is
 * blocked, and in that case the store keeps working in memory for the rest of
 * the visit.
 */

const KEY = 'difrana:v1';

/**
 * A brand-new state object. Built by a function rather than spread from a
 * shared constant: a shallow copy would share the nested maps, so "clearing"
 * would hand back the very objects that still hold the old progress.
 */
const fresh = () => ({ v: 1, done: {}, fav: {}, opened: {}, last: 0 });

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isExamNumber = (value) => Number.isInteger(value) && value > 0;

/** Keep only positive-integer keys; values become 1 (flags) or a timestamp. */
function cleanMap(value, timestamps = false) {
  const out = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const n = Number(key);
    if (!isExamNumber(n)) continue;
    if (timestamps) {
      const at = Number(raw);
      if (at > 0) out[n] = at;
    } else if (raw) {
      out[n] = 1;
    }
  }
  return out;
}

/** Parse a stored entry defensively: anything malformed is dropped, not trusted. */
function parse(raw) {
  const parsed = JSON.parse(raw);
  const next = fresh();
  if (!isRecord(parsed)) return next;
  next.done = cleanMap(parsed.done);
  next.fav = cleanMap(parsed.fav);
  next.opened = cleanMap(parsed.opened, true);
  next.last = isExamNumber(parsed.last) ? parsed.last : 0;
  return next;
}

let available = true;
let cache = null;

function read() {
  if (cache) return cache;
  cache = fresh();

  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    available = false; // blocked storage: stay in memory
    return cache;
  }

  if (raw) {
    try {
      cache = parse(raw);
    } catch {
      /* corrupted entry: start clean; the next write replaces it */
    }
  }
  return cache;
}

let flushHandle = 0;

function flush() {
  clearTimeout(flushHandle);
  flushHandle = 0;
  if (!available || !cache) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    available = false;
  }
}

/** Coalesce bursts of changes; `flush()` runs early whenever the page is hidden. */
function write() {
  if (!available) return;
  clearTimeout(flushHandle);
  flushHandle = setTimeout(flush, 120);
}

const listeners = new Set();

if (typeof window !== 'undefined') {
  // Opening an exam hides this tab, and mobile browsers may discard a hidden
  // tab without warning — so never leave a change sitting in the debounce.
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // Another tab of the portal changed progress: drop the stale copy and let
  // the page repaint from the fresh one instead of overwriting it later.
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY && event.key !== null) return;
    clearTimeout(flushHandle);
    flushHandle = 0;
    cache = null;
    listeners.forEach((fn) => fn());
  });
}

export const store = {
  get isAvailable() {
    read();
    return available;
  },

  isDone(n) {
    return Boolean(read().done[n]);
  },

  isFav(n) {
    return Boolean(read().fav[n]);
  },

  /** @returns {boolean} the new state */
  setDone(n, on) {
    const s = read();
    if (on) s.done[n] = 1;
    else delete s.done[n];
    write();
    return Boolean(on);
  },

  /** @returns {boolean} the new state */
  toggleDone(n) {
    return this.setDone(n, !this.isDone(n));
  },

  /** @returns {boolean} the new state */
  toggleFav(n) {
    const s = read();
    const next = !s.fav[n];
    if (next) s.fav[n] = 1;
    else delete s.fav[n];
    write();
    return next;
  },

  /** Record that a form was opened (the resume point and the "opened…" hint). */
  markOpened(n, now = Date.now()) {
    const s = read();
    s.opened[n] = now;
    s.last = n;
    write();
  },

  get lastOpened() {
    return read().last;
  },

  openedAt(n) {
    return read().opened[n] || 0;
  },

  /** An independent deep copy, for undo. */
  snapshot() {
    return JSON.parse(JSON.stringify(read()));
  },

  restore(snapshot) {
    cache = parse(JSON.stringify(snapshot));
    write();
  },

  /**
   * Forget completion history — done marks, opened times and the resume point —
   * but keep favourites, which the student chose on purpose.
   */
  resetProgress() {
    const fav = { ...read().fav };
    cache = { ...fresh(), fav };
    write();
  },

  /** Wipe everything, favourites included. */
  clear() {
    clearTimeout(flushHandle);
    flushHandle = 0;
    cache = fresh();
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* the in-memory state is already clean */
    }
  },

  /** Save any unsaved change, then drop the in-memory copy so the next read comes from storage. */
  reload() {
    if (flushHandle) flush();
    cache = null;
  },

  /** Called after another tab changes the stored progress. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Write immediately (used by tests and before navigation). */
  flush,
};
