#!/usr/bin/env node
/**
 * fetch-form-meta.mjs — reads every live form and records what the export
 * does not carry: how many questions each one asks, its real title, and what
 * its first page asks for.
 *
 *     npm run fetch:meta
 *
 * Writes data/source/form-meta.json, keyed by the Google Form id. The build
 * (tools/build-data.mjs) reads the question counts from it, so every card can
 * say «48 سؤالًا» and the hero can total them — figures taken from the forms
 * themselves rather than typed by hand.
 *
 * Run it after replacing the export, or after the teacher edits a form. It is
 * deliberately not part of `npm run verify` or CI: it makes one request per
 * form to Google. The build works without the file; cards then simply omit
 * the count.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'data', 'source');
const OUT_FILE = path.join(SOURCE_DIR, 'form-meta.json');
const NOT_EXPORTS = new Set(['priority.json', 'form-meta.json']);
const CONCURRENCY = 6;

/** Google Forms item types that are questions a student answers. */
const QUESTION_TYPES = new Set([2, 3, 4, 5, 7, 9, 10]); // choice, dropdown, checkbox, scale, grid, date, time
const SHORT_ANSWER = 0;
const PAGE_BREAK = 8;

function findExport() {
  const files = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json') && !NOT_EXPORTS.has(f))
    .map((f) => path.join(SOURCE_DIR, f));
  return files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null;
}

function urlsOf(raw) {
  const rows = Array.isArray(raw) ? raw : raw.forms ?? raw['الفورمات'] ?? raw['الإصدارات'] ?? raw['النماذج'] ?? [];
  return rows
    .map((row) => row.url ?? row['الرابط الكامل'] ?? row['الرابط'] ?? row.link)
    .filter((u) => typeof u === 'string' && u.startsWith('https://'));
}

const formId = (url) => /\/forms\/d\/e\/([A-Za-z0-9_-]+)\//.exec(url)?.[1] ?? null;

async function inspect(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (form-meta)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
  const html = await response.text();
  const match = html.match(/FB_PUBLIC_LOAD_DATA_ = (.*?);<\/script>/s);
  if (!match) {
    const closed = /no longer accepting|لم يعد يقبل|تم إغلاق/i.test(html);
    return { ok: false, error: closed ? 'not accepting responses' : 'form data not found' };
  }
  const data = JSON.parse(match[1]);
  const items = data?.[1]?.[1] ?? [];
  const firstBreak = items.findIndex((item) => item[3] === PAGE_BREAK);
  const firstPage = (firstBreak === -1 ? [] : items.slice(0, firstBreak))
    .filter((item) => item[3] === SHORT_ANSWER)
    .map((item) => String(item[1] ?? '').trim());
  return {
    ok: true,
    title: String(data?.[1]?.[8] ?? '').trim(),
    questions: items.filter((item) => QUESTION_TYPES.has(item[3])).length,
    firstPage,
  };
}

async function main() {
  const file = findExport();
  if (!file) {
    console.log('no export in data/source — nothing to fetch');
    return;
  }
  const urls = urlsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(`reading ${urls.length} forms from ${path.relative(ROOT, file)} …`);

  const forms = {};
  const problems = [];
  const queue = urls.map((url, index) => ({ url, index }));
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const { url, index } = queue.shift();
        const id = formId(url);
        try {
          const result = await inspect(url);
          if (!result.ok) problems.push(`#${index + 1} ${result.error}`);
          else if (id) forms[id] = { title: result.title, questions: result.questions, firstPage: result.firstPage };
        } catch (error) {
          problems.push(`#${index + 1} request failed (${error.name})`);
        }
      }
    }),
  );

  const ordered = Object.fromEntries(
    urls.map(formId).filter((id) => id && forms[id]).map((id) => [id, forms[id]]),
  );
  fs.writeFileSync(
    OUT_FILE,
    `${JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), forms: ordered }, null, 2)}\n`,
    'utf8',
  );

  const counts = Object.values(ordered).map((f) => f.questions);
  console.log(`read        : ${counts.length} of ${urls.length}`);
  console.log(`questions   : ${counts.reduce((a, b) => a + b, 0)} total (${[...new Set(counts)].join(', ')} per form)`);
  const pages = [...new Set(Object.values(ordered).map((f) => f.firstPage.join(' / ')))];
  console.log(`first page  : ${pages.join(' | ') || '—'}`);
  for (const p of problems) console.log(`   ! ${p}`);
  console.log(`output      : ${path.relative(ROOT, OUT_FILE)}`);
  if (problems.length) process.exitCode = 1;
}

main();
