#!/usr/bin/env node
/**
 * SEO / AI-discoverability / identity checks. Run with `npm test`.
 *
 * Guards the things that silently rot when copy is edited: structured data that
 * no longer parses, FAQ markup that no longer matches what the page shows
 * (Google treats that as spam), pages missing from the sitemap, an llms.txt
 * whose figures drifted from the dataset — and the teacher's own identity:
 * his name, his number, his credentials and the verse on every page.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'teacher.html', 'about.html'];
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const NAME = 'هشام خليل';
const PHONE_E164 = '+966508145231';
const PHONE_LOCAL = '0508145231';
const PHONE_INTL = '+966 50 814 5231';
const WA = 'https://wa.me/966508145231';
const BRAND = 'دفرنة في القدرات والتحصيلي';
const VERSE = 'يُرِيدُ اللَّهُ بِكُمُ الْيُسْرَ وَلَا يُرِيدُ بِكُمُ الْعُسْرَ';

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

/** Visible text: drop scripts/styles and tags, collapse whitespace. */
const visibleText = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

const graphOf = (html) => {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const data = JSON.parse(match[1]);
  return data['@graph'] ?? [data];
};

for (const page of PAGES) {
  console.log(`\n${page}`);
  const html = read(page);

  let graph = [];
  try {
    graph = graphOf(html);
    assert('structured data parses', graph.length > 0);
  } catch (error) {
    assert('structured data parses', false, error.message);
  }

  const title = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? '';
  assert('title is present and not too long', title.length > 10 && title.length <= 75, `(${title.length})`);
  const description = html.match(/<meta\s+name="description"\s+content="([^"]+)"/)?.[1] ?? '';
  assert('meta description 70-230 chars', description.length >= 70 && description.length <= 230, `(${description.length})`);
  assert('canonical', /<link rel="canonical" href="__SITE_URL__/.test(html));
  assert('hreflang ar-sa + x-default', /hreflang="ar-sa"/.test(html) && /hreflang="x-default"/.test(html));
  assert('Open Graph title/description/image', /og:title/.test(html) && /og:description/.test(html) && /og:image"/.test(html));
  assert('exactly one h1', (html.match(/<h1[\s>]/g) || []).length === 1);
  assert('names the teacher in text', visibleText(html).includes(`مستر هشام خليل`));
  assert('names the brand in text', visibleText(html).includes(BRAND));
  assert('names his certification', visibleText(html).includes('المركز العربي للتدريب والتنمية البشرية'));
  assert('links the manifest (installable)', html.includes('rel="manifest" href="site.webmanifest"'));

  // The teacher asked for the verse to be seen often: the strip on top, the
  // footer, and at least one more place on each page.
  const verses = html.split(VERSE).length - 1;
  assert(`shows the verse at least 3 times (${verses})`, verses >= 3);
  assert('the verse strip opens the page', html.indexOf('class="verse-strip"') < html.indexOf('<header'));

  {
    const defined = new Set(graph.map((node) => node['@id']).filter(Boolean));
    const referenced = new Set();
    JSON.stringify(graph).replace(/\{"@id":"([^"]+)"\}/g, (match, id) => {
      referenced.add(id);
      return match;
    });
    const dangling = [...referenced].filter((id) => !defined.has(id));
    assert('every @id reference resolves on this page', dangling.length === 0, dangling.join(' | '));
  }

  assert(
    'every <img> declares width and height',
    [...html.matchAll(/<img\b[^>]*>/gs)].every((m) => /\bwidth=/.test(m[0]) && /\bheight=/.test(m[0])),
  );
  assert(
    'every target="_blank" link is rel="noopener noreferrer"',
    [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gs)].every((m) => /rel="noopener noreferrer"/.test(m[0])),
  );

  const faq = graph.find((node) => node['@type'] === 'FAQPage');
  if (faq) {
    // Compared without whitespace: inline tags (<bdi> around the phone number)
    // split the text without changing what a reader or a crawler sees.
    const text = visibleText(html).replace(/\s+/g, '');
    const has = (value) => text.includes(value.replace(/\s+/g, ''));
    const missing = faq.mainEntity.filter((q) => !has(q.name) || !has(q.acceptedAnswer.text));
    assert(
      `FAQ markup matches visible text (${faq.mainEntity.length} Q&A)`,
      missing.length === 0,
      missing.map((q) => q.name).join(' | '),
    );
  }
}

console.log('\nhome page data state');
{
  const html = read('index.html');
  const { meta } = JSON.parse(read('assets/data/exams.json'));
  const expected = meta.total > 0 ? 'ready' : 'empty';
  const blocks = [...html.matchAll(/<[a-z]+\b[^>]*data-when="(ready|empty)"[^>]*>/g)];
  const wrong = blocks.filter((m) => /\shidden(?=[\s>])/.test(m[0]) === (m[1] === expected));
  assert(`build stamped the "${expected}" state into the markup`, blocks.length > 0 && wrong.length === 0, wrong.map((m) => m[0].slice(0, 60)).join(' | '));
}

console.log('\ncross-page');
{
  const ids = new Map();
  for (const page of PAGES) {
    for (const node of graphOf(read(page))) {
      if (!node['@id']) continue;
      const seen = ids.get(node['@id']);
      if (!seen || Object.keys(node).length > Object.keys(seen).length) ids.set(node['@id'], node);
    }
  }
  const person = ids.get('__SITE_URL__teacher.html#person');
  assert('one Person entity for the teacher', person?.['@type'] === 'Person' && person.name === NAME);
  assert('he is a قدرات كمي trainer', person?.jobTitle === 'مدرب قدرات كمي');
  assert(
    'his certification names the awarding centre',
    person?.hasCredential?.recognizedBy?.name === 'المركز العربي للتدريب والتنمية البشرية',
  );
  assert('phone in E.164', person?.telephone === PHONE_E164);
  assert(
    'the contact point is the number the pages show',
    person?.contactPoint?.url === WA && person?.contactPoint?.telephone === person?.telephone,
  );
  assert(
    'no social profile is claimed that has not been verified',
    !person?.sameAs || (person.sameAs.length > 0 && person.sameAs.every((u) => u.startsWith('https://'))),
  );
  assert('a text-free portrait as the Person image', String(person?.image?.url || '').includes('teacher-portrait'));
  assert('training offered, with no price', Boolean(person?.makesOffer) && !JSON.stringify(person.makesOffer).includes('price'));
  assert('the site is published by him', JSON.stringify(ids.get('__SITE_URL__#website')).includes('teacher.html#person'));

  // Two pages, two copies of the full Person: they must agree word for word.
  {
    const full = PAGES.map((page) => graphOf(read(page)).find((n) => n['@id'] === '__SITE_URL__teacher.html#person'))
      .filter((n) => n && Object.keys(n).length > 6);
    assert(
      `the full Person is identical wherever it appears (${full.length})`,
      full.length >= 2 && full.every((n) => JSON.stringify(n) === JSON.stringify(full[0])),
    );
  }

  for (const page of PAGES) {
    for (const node of graphOf(read(page))) {
      const full = node['@id'] && ids.get(node['@id']);
      if (!full || full === node) continue;
      const clashes = Object.keys(node).filter(
        (key) => key !== '@id' && JSON.stringify(node[key]) !== JSON.stringify(full[key]),
      );
      const id = node['@id'].replace('__SITE_URL__', '/');
      assert(`${page}: ${id} agrees with its full definition`, clashes.length === 0, clashes.join(' | '));
    }
  }

  assert(
    'the Person disambiguates himself from same-named people',
    String(person?.disambiguatingDescription || '').includes('اسمًا مشابهًا'),
  );
  assert('the site is named after him first', String(ids.get('__SITE_URL__#website')?.name || '').startsWith('مستر هشام خليل'));

  for (const page of [...PAGES, 'llms.txt']) {
    assert(`${page} says the brand is his alone`, read(page).includes('اسمًا مشابهًا'));
  }

  for (const page of PAGES) {
    const html = read(page);
    assert(`${page} links to WhatsApp`, html.includes(WA));
    assert(`${page} links to a phone call`, html.includes(`tel:${PHONE_E164}`));
    assert(`${page} shows the local form of the number`, html.includes(PHONE_LOCAL));
    assert(`${page} shows the international form of the number`, html.includes(PHONE_INTL));
  }

  // Claims the owner did not make must never appear.
  const forbidden = [
    /أفضل/, /\bbest\b/i, /الأول في|رقم واحد/,
    /نضمن|مضمون|ضمان الدرجة|نتيجة مضمونة|guarantee/i,
    /معتمد\s*(من|لدى|في)\s*قياس|مدرب قياس|تابع لقياس|بالتعاون مع قياس/,
    /دروس خصوصية|مدرس خصوصي|درس خاص/,
    // The forms are his own material, for his students, so nothing may
    // advertise them as free.
    /مجان|\bfree\b/i,
    /\d+\s*(سنة|سنوات|عام|عامًا|عاما)\s*(من\s*)?(ال)?خبرة/, /خبرة\s*\d+\s*(سنة|سنوات|عام)/,
    /\d{2,}\s*(طالب|طالبة|متدرب|متدربة)/,
    /ريال|\bSAR\b|السعر|الأسعار/,
    // Names and numbers from the site this one was modelled on.
    /أسامه|حرحيره|المتميز|0567173752|966567173752/,
  ];
  for (const page of [...PAGES, '404.html', 'llms.txt', 'site.webmanifest']) {
    const text = read(page);
    const hit = forbidden.filter((pattern) => pattern.test(text)).map(String);
    assert(`${page} makes no unsupported claim`, hit.length === 0, hit.join(' | '));
  }

  const sitemap = read('sitemap.xml');
  // Locally the sitemap still carries the placeholder; after a deploy it carries
  // the real origin. Both must pass, so the page name is matched, not the base.
  const base = '(?:__SITE_URL__|https?://[^<]*?/)';
  for (const page of PAGES) {
    const loc = page === 'index.html' ? `<loc>${base}</loc>` : `<loc>${base}${page}</loc>`;
    assert(`sitemap lists ${page}`, new RegExp(loc).test(sitemap));
  }
  const urlCount = (sitemap.match(/<url>/g) || []).length;
  assert('sitemap closes every <url>', urlCount === (sitemap.match(/<\/url>/g) || []).length);
  assert(
    'sitemap dates every page',
    (sitemap.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || []).length === urlCount,
  );
  assert('sitemap declares the image namespace', sitemap.includes('sitemap-image/1.1'));
  assert('sitemap offers his portrait to image search', sitemap.includes('teacher-portrait.jpg'));
  assert(
    'every sitemap image is titled',
    (sitemap.match(/<image:loc>/g) || []).length === (sitemap.match(/<image:title>/g) || []).length,
  );

  // A Google Forms edit URL grants write access to the live form. None may ever
  // reach a published file — not a page, not the dataset, not the export.
  {
    const EDIT = /https:\/\/docs\.google\.com\/forms\/d\/[A-Za-z0-9_-]+\/edit/;
    const files = [...PAGES, 'llms.txt', 'assets/data/exams.json', 'sitemap.xml'];
    const sourceDir = path.join(ROOT, 'data', 'source');
    for (const name of fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : []) {
      if (name.toLowerCase().endsWith('.json')) files.push(`data/source/${name}`);
    }
    const leaking = files.filter((file) => EDIT.test(read(file)));
    assert('no Google Forms edit link is published anywhere', leaking.length === 0, leaking.join(' | '));
  }

  const robots = read('robots.txt');
  for (const bot of ['Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    assert(`robots.txt allows ${bot}`, new RegExp(`User-agent: ${bot}[ \\t]*\\r?\\nAllow: /`).test(robots));
  }
  assert('robots.txt disallows nothing', !/^\s*Disallow:\s*\S/m.test(robots));
}

console.log('\napp manifest');
{
  const manifest = JSON.parse(read('site.webmanifest'));
  assert('standalone display', manifest.display === 'standalone');
  assert('right-to-left Arabic', manifest.lang === 'ar' && manifest.dir === 'rtl');
  assert('has a 512px icon', manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert('has a maskable icon', manifest.icons.some((i) => i.purpose === 'maskable'));
  assert(
    'every icon file exists',
    manifest.icons.every((i) => fs.existsSync(path.join(ROOT, i.src))),
  );
  assert('service worker exists', fs.existsSync(path.join(ROOT, 'sw.js')));
}

console.log('\nhand-written figures');
{
  // The FAQs and the about page state the counts in prose, which no build
  // rewrites. If the export changes, these fail until the copy is re-read.
  const { exams, meta } = JSON.parse(read('assets/data/exams.json'));
  if (meta.total) {
    const sizes = [...new Set(exams.map((e) => e.q).filter(Boolean))];
    for (const page of ['teacher.html', 'about.html']) {
      const text = visibleText(read(page));
      assert(`${page} states the real form count (${meta.total})`, text.includes(`${meta.total} إصدارًا`));
      if (meta.totalQuestions) {
        assert(
          `${page} states the real question total (${meta.totalQuestions})`,
          text.includes(String(meta.totalQuestions)),
        );
      }
    }
    const about = visibleText(read('about.html'));
    assert(`about.html names every form length (${sizes.join(', ')})`, sizes.every((q) => about.includes(`${q} سؤالًا`)));
  } else {
    assert('no form count is claimed before forms exist', !/\d+\s*إصدار/.test(visibleText(read('about.html'))));
  }
}

console.log('\nllms.txt');
{
  const llms = read('llms.txt');
  const { meta } = JSON.parse(read('assets/data/exams.json'));
  assert('exists and starts with an H1', llms.startsWith('# '));
  assert('has a summary blockquote', /^> /m.test(llms));
  assert('leads with the teacher, not the platform', llms.split('\n')[0].includes('هشام خليل'));
  assert('gives his WhatsApp number', llms.includes(PHONE_INTL));
  assert('states his certification', llms.includes('المركز العربي للتدريب والتنمية البشرية'));
  assert(
    `form count matches the dataset (${meta.total})`,
    meta.total ? llms.includes(`عدد الإصدارات: ${meta.total}`) : !/عدد الإصدارات:/.test(llms),
  );
  assert(
    'question count matches the dataset',
    !meta.totalQuestions || llms.includes(String(meta.totalQuestions)),
  );
  assert('links every page', PAGES.every((p) => llms.includes(p === 'index.html' ? '(__SITE_URL__)' : `(__SITE_URL__${p})`)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
