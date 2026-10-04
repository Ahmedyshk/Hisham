#!/usr/bin/env node
/**
 * Search + data tests. Run with `npm test`.
 *
 * Two parts:
 *  1. The published dataset (assets/data/exams.json) is checked for integrity.
 *     It may legitimately be empty — before the first forms are published the
 *     site shows its "coming soon" state — so every check holds for zero
 *     records too.
 *  2. The Arabic search itself is exercised against a fixed fixture of 60
 *     forms titled the way the build titles an untitled form («النموذج الحادي
 *     عشر»). Search behaviour must not depend on what the export happens to
 *     contain this week.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuery, searchExams, highlightRanges, normalize } from '../assets/js/search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/exams.json'), 'utf8'));
const { exams, meta } = data;

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

/* ---------------------------------------------------------------- dataset */

console.log(`\ndataset (${exams.length} published)`);
assert('exams is an array', Array.isArray(exams));
assert('meta.total matches', meta.total === exams.length);
assert('every exam has a number', exams.every((e) => Number.isInteger(e.n) && e.n > 0));
assert('every exam has a title', exams.every((e) => typeof e.t === 'string' && e.t.trim()));
assert('every exam has a link source', exams.every((e) => e.f || e.u));
assert('numbers are unique', new Set(exams.map((e) => e.n)).size === exams.length);
assert('form ids are unique', new Set(exams.map((e) => e.f || e.u)).size === exams.length);
assert('form ids are url-safe', exams.every((e) => !e.f || /^[A-Za-z0-9_-]+$/.test(e.f)));
assert('explicit urls are https', exams.every((e) => !e.u || e.u.startsWith('https://')));
assert(
  'question counts, where given, add up to meta.totalQuestions',
  !exams.every((e) => Number.isInteger(e.q)) ||
    exams.length === 0 ||
    exams.reduce((sum, e) => sum + e.q, 0) === meta.totalQuestions,
);
assert(
  'the brand is not repeated inside every title',
  exams.length === 0 || !exams.every((e) => e.t.includes('دفرنة')),
);
assert('every record carries a search key', exams.every((e) => typeof e.k === 'string' && e.k));

/* ---------------------------------------------------------------- fixture */

const UNITS = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع'];
const TENS = ['', 'العاشر', 'العشرون', 'الثلاثون', 'الأربعون', 'الخمسون', 'الستون'];
function ordinal(n) {
  if (n < 10) return UNITS[n];
  if (n === 10) return 'العاشر';
  if (n < 20) return `${n === 11 ? 'الحادي' : UNITS[n - 10]} عشر`;
  const unit = n % 10;
  return unit ? `${unit === 1 ? 'الحادي' : UNITS[unit]} و${TENS[Math.floor(n / 10)]}` : TENS[n / 10];
}

const stem = (text) =>
  text
    .split(' ')
    .map((w) => {
      let s = w;
      if (s.length > 3 && s.startsWith('و')) s = s.slice(1);
      if (s.length > 4 && s.startsWith('ال')) s = s.slice(2);
      return s;
    })
    .join(' ');

const fixture = Array.from({ length: 60 }, (_, i) => {
  const n = i + 1;
  const t = `النموذج ${ordinal(n)}`;
  const norm = normalize(t);
  return { n, t, k: `${norm} ${stem(norm)}`, f: `fixture${String(n).padStart(20, '0')}`, q: 24 };
});

const q = (text) => searchExams(fixture, parseQuery(text));

console.log('\nexact and partial matching (fixture)');
assert('exact title', q(fixture[0].t).results[0]?.n === 1);
assert('word without the definite article', q('نموذج').results.length === fixture.length);
assert('multi-word AND', q('الحادي عشر').results[0]?.n === 11);
assert('compound ordinal', q('الخامس والعشرون').results[0]?.n === 25);
assert('an ordinal that no form carries', q('السبعون').results.length === 0);

console.log('\nnumber lookup');
assert('exact number wins', q('11').results[0]?.n === 11);
const arabicIndic = (n) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
assert('arabic-indic digits', q(arabicIndic(60)).results[0]?.n === 60);
assert('number prefix expands', q('1').results.some((e) => e.n > 9));
assert('out-of-range number', q('9999').results.length === 0);

console.log('\nforgiveness');
assert('hamza folded', q('النموذج الاول').results[0]?.n === 1);
assert('diacritics in the query', q('النَّموذجُ الأوَّل').results[0]?.n === 1);
assert('punctuation is ignored', q('النموذج (الأول)').results[0]?.n === 1);
{
  const r = q('النموذح الاول'); // one letter wrong
  assert('single-character typo recovers', r.results.some((e) => e.n === 1) && r.fuzzy);
}
assert('ta-marbuta folded', normalize('القدرة') === normalize('القدره'));
assert('alef-maqsura folded', normalize('مستوى') === normalize('مستوي'));
assert('tatweel folded', normalize('النمـــوذج') === normalize('النموذج'));

console.log('\nedge cases');
assert('blank query returns everything', q('   ').results.length === fixture.length);
assert('symbols-only query returns everything', q('!!!###').results.length === fixture.length);
assert('nonsense returns nothing', q('zzzzqqq').results.length === 0);
assert('very long query does not throw', q('ا'.repeat(500)).results.length >= 0);
assert('empty dataset is searchable', searchExams([], parseQuery('11')).results.length === 0);

console.log('\nhighlighting maps back to the original title');
{
  const target = fixture[0];
  const ranges = highlightRanges(target.t, parseQuery('الاول'));
  assert(
    'folded characters keep correct indices',
    ranges.length === 1 && target.t.slice(ranges[0][0], ranges[0][1]) === 'الأول',
    JSON.stringify(ranges),
  );
}
{
  const target = fixture[10];
  const ranges = highlightRanges(target.t, parseQuery('حادي'));
  assert(
    'highlights the plain word',
    ranges.length > 0 && ranges.every(([a, b]) => target.t.slice(a, b).includes('حادي')),
    JSON.stringify(ranges),
  );
}
assert('number queries do not highlight', highlightRanges('النموذج الحادي عشر', parseQuery('11')).length === 0);

console.log('\nperformance');
{
  const queries = ['النموذج', 'ا', 'الحادي عشر', '11', 'zzz', 'النموذج الاول'];
  const big = Array.from({ length: 400 }, (_, i) => ({ ...fixture[i % 60], n: i + 1 }));
  const start = performance.now();
  const runs = 300;
  for (let i = 0; i < runs; i += 1) searchExams(big, parseQuery(queries[i % queries.length]));
  const ms = performance.now() - start;
  console.log(`  ${runs} searches over ${big.length} records in ${ms.toFixed(1)}ms`);
  assert('average search under 5ms', ms / runs < 5, `${(ms / runs).toFixed(2)}ms`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
