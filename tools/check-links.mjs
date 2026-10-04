#!/usr/bin/env node
/**
 * Link checker for the published dataset.
 *
 *   node tools/check-links.mjs --offline        structure only (used by `npm run verify`)
 *   node tools/check-links.mjs                  also probes every URL over the network
 *   node tools/check-links.mjs --limit 25       probe only the first N (quick sample)
 *
 * The network pass is deliberately NOT part of `npm run verify` or CI: 300+
 * outbound requests to Google Forms is slow and rate-limited. Run it manually
 * after replacing the source export.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { exams } = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/exams.json'), 'utf8'));

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const limitFlag = args.indexOf('--limit');
const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) : Infinity;
const CONCURRENCY = 8;

const fullUrl = (e) => e.u || (e.f ? `https://docs.google.com/forms/d/e/${e.f}/viewform` : null);
const shortUrl = (e) => e.su || (e.s ? `https://forms.gle/${e.s}` : null);

/* ---------------------------------- structure ---------------------------- */

console.log(`checking ${exams.length} records\n`);

const structural = [];
const seen = new Set();

for (const exam of exams) {
  const url = fullUrl(exam);
  const label = `#${exam.n}`;

  if (!url) {
    structural.push(`${label} has no resolvable URL`);
    continue;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    structural.push(`${label} builds an unparseable URL: ${url}`);
    continue;
  }
  if (parsed.protocol !== 'https:') structural.push(`${label} is not https: ${url}`);
  if (seen.has(url)) structural.push(`${label} duplicates an earlier URL`);
  seen.add(url);

  const short = shortUrl(exam);
  if (short) {
    try {
      if (new URL(short).protocol !== 'https:') structural.push(`${label} short link is not https`);
    } catch {
      structural.push(`${label} has an unparseable short link: ${short}`);
    }
  }
}

if (structural.length) {
  console.log('structural problems:');
  structural.forEach((m) => console.log(`  ! ${m}`));
} else {
  console.log('structure: all records resolve to a unique https URL');
}

if (offline) {
  console.log('\n(--offline: skipped the network pass)');
  process.exit(structural.length ? 1 : 0);
}

/* ---------------------------------- network ------------------------------ */

const targets = exams.slice(0, Number.isFinite(limit) ? limit : exams.length);
console.log(`\nprobing ${targets.length} URLs (concurrency ${CONCURRENCY})...\n`);

const failures = [];
let done = 0;

async function probe(exam) {
  const url = fullUrl(exam);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (link-check)' },
      signal: AbortSignal.timeout(20000),
    });
    // A retired Google Form still answers 200 but says so in the body.
    if (!response.ok) {
      failures.push(`#${exam.n} HTTP ${response.status} — ${exam.t}`);
    } else {
      const body = await response.text();
      if (/الاستمارة غير موجودة|Form not found|قد تم إغلاق|no longer accepting/i.test(body)) {
        failures.push(`#${exam.n} form appears closed or missing — ${exam.t}`);
      }
    }
  } catch (error) {
    failures.push(`#${exam.n} request failed (${error.name}) — ${exam.t}`);
  }
  done += 1;
  if (done % 25 === 0 || done === targets.length) {
    process.stdout.write(`  ${done}/${targets.length}\n`);
  }
}

const queue = targets.slice();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await probe(queue.shift());
  }),
);

console.log('');
if (failures.length) {
  console.log(`${failures.length} link problem(s):`);
  failures.forEach((m) => console.log(`  ! ${m}`));
} else {
  console.log('network: every probed form responded successfully');
}

process.exit(structural.length || failures.length ? 1 : 0);
