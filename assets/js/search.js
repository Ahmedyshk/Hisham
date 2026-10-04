/**
 * Arabic-first, forgiving, client-side search.
 *
 * Design notes
 * ------------
 * - Normalisation mirrors `tools/build-data.mjs` so the pre-built `k` key on
 *   each record can be matched directly — no per-keystroke normalisation of the
 *   corpus.
 * - Users should never need the exact title: alef/hamza/ta-marbuta/alef-maqsura
 *   are folded, diacritics and tatweel are stripped, the definite article and a
 *   leading "و" are indexed as extra stems, and a one-character typo is
 *   tolerated when a strict pass finds nothing.
 * - Arabic-Indic digits are folded to Latin so "٤٧" and "47" both work.
 */

/* Arabic diacritics (harakat, superscript alef, Quranic marks) + tatweel. */
const DIACRITIC_CHARS = 'ؐ-ًؚ-ٰٟۖ-ۭـ';
const DIACRITICS = new RegExp(`[${DIACRITIC_CHARS}]`, 'g');
/* Non-global twin: safe for .test() (a /g regex keeps lastIndex state). */
const IS_DIACRITIC = new RegExp(`[${DIACRITIC_CHARS}]`);

/** Fold a string to its searchable form. Length-changing steps are isolated. */
export function normalize(input) {
  return String(input ?? '')
    .replace(DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Normalise while keeping a map back to the original string's indices, so
 * matches can be highlighted on the untouched Arabic title.
 * Only called for the handful of cards actually on screen.
 */
export function normalizeWithMap(input) {
  const src = String(input ?? '');
  let out = '';
  const map = [];
  let pendingSpace = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (IS_DIACRITIC.test(ch)) continue;

    let mapped = ch;
    if ('آأإٱ'.includes(ch)) mapped = 'ا';
    else if (ch === 'ة') mapped = 'ه';
    else if (ch === 'ى') mapped = 'ي';
    else if (ch === 'ؤ') mapped = 'و';
    else if (ch === 'ئ') mapped = 'ي';
    else if (ch >= '٠' && ch <= '٩') mapped = String(ch.charCodeAt(0) - 0x0660);
    else if (ch >= '۰' && ch <= '۹') mapped = String(ch.charCodeAt(0) - 0x06f0);
    else if (/\s/.test(ch) || !/[\p{L}\p{N}]/u.test(ch)) mapped = ' ';

    if (mapped === ' ') {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      map.push(i);
      pendingSpace = false;
    }
    out += mapped.toLowerCase();
    map.push(i);
  }

  return { norm: out, map };
}

/** Strip the definite article / leading conjunction from a token. */
function stem(word) {
  let s = word;
  if (s.length > 3 && s.startsWith('و')) s = s.slice(1);
  if (s.length > 4 && s.startsWith('ال')) s = s.slice(2);
  return s;
}

/** Bounded Levenshtein: returns true when distance <= 1. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (la > lb) i += 1;
    else if (lb > la) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** Parse the raw input box value into a reusable query object. */
export function parseQuery(raw) {
  const norm = normalize(raw);
  const tokens = norm.split(' ').filter(Boolean);
  const digits = /^[0-9]+$/.test(norm) ? norm : null;
  return { raw: String(raw ?? ''), norm, tokens, digits, isEmpty: tokens.length === 0 };
}

/**
 * Score one record against a parsed query. Returns 0 when it does not match.
 * `fuzzy` enables the typo-tolerant fallback pass.
 */
function scoreExam(exam, query, fuzzy) {
  // Pure-number queries address a form by its number.
  if (query.digits) {
    const n = String(exam.n);
    if (n === query.digits) return 1000;
    if (n.startsWith(query.digits)) return 600;
    if (n.includes(query.digits)) return 300;
    // Fall through: a number may also appear inside a title.
  }

  const key = exam.k;
  const title = exam._t || (exam._t = normalize(exam.t));
  let score = 0;

  for (const token of query.tokens) {
    const t = stem(token);
    let hit = 0;

    if (title === token) hit = 500;
    else if (title.startsWith(`${token} `)) hit = 120;
    else if (key.includes(` ${token}`) || key.startsWith(token)) hit = 90;
    else if (key.includes(token)) hit = 45;
    else if (t !== token && key.includes(t)) hit = 40;
    else if (fuzzy && token.length >= 3) {
      const words = exam._w || (exam._w = key.split(' ').filter(Boolean));
      for (const w of words) {
        if (withinOneEdit(w, token) || withinOneEdit(stem(w), t)) {
          hit = 18;
          break;
        }
      }
    }

    if (!hit) return 0; // every token must match (AND)
    score += hit;
  }

  // Shorter titles that match are usually the more precise hit.
  return score + Math.max(0, 24 - title.length / 2);
}

/**
 * Search a list of exams. Runs a strict pass first, then a typo-tolerant pass
 * only if the strict pass found nothing.
 */
export function searchExams(exams, query) {
  if (query.isEmpty) return { results: exams.slice(), fuzzy: false };

  for (const fuzzy of [false, true]) {
    const scored = [];
    for (const exam of exams) {
      const s = scoreExam(exam, query, fuzzy);
      if (s > 0) scored.push({ exam, s });
    }
    if (scored.length) {
      scored.sort((a, b) => b.s - a.s || a.exam.n - b.exam.n);
      return { results: scored.map((r) => r.exam), fuzzy };
    }
  }

  return { results: [], fuzzy: true };
}

/**
 * Compute highlight ranges (on the ORIGINAL title) for a parsed query.
 * Returns a sorted, merged array of [start, end) index pairs.
 */
export function highlightRanges(title, query) {
  if (query.isEmpty || query.digits) return [];
  const { norm, map } = normalizeWithMap(title);
  const ranges = [];

  for (const token of query.tokens) {
    for (const needle of new Set([token, stem(token)])) {
      if (needle.length < 2) continue;
      let from = 0;
      let at = norm.indexOf(needle, from);
      while (at !== -1) {
        const start = map[at];
        const end = map[at + needle.length - 1] + 1;
        if (start !== undefined && end !== undefined) ranges.push([start, end]);
        from = at + needle.length;
        at = norm.indexOf(needle, from);
      }
    }
  }

  if (!ranges.length) return [];
  ranges.sort((a, b) => a[0] - b[0]);

  const merged = [ranges[0]];
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}
