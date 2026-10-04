#!/usr/bin/env node
/**
 * build-data.mjs
 * ---------------------------------------------------------------------------
 * Reads the ORIGINAL, untouched source export in `data/source/` and produces a
 * clean, validated, compact runtime model at `assets/data/exams.json`.
 *
 * The source file is never modified. Re-run this script after replacing the
 * source export:
 *
 *     npm run build:data
 *
 * Every record is validated. Records with an unusable link are excluded from
 * the site (they are never rendered as an active exam) and reported here, so a
 * bad row can never break the page.
 *
 * The export may be written in Arabic — «الفورمات», «الإصدار», «الرابط الكامل» —
 * or in English — "forms", "section", "url". Both are read directly, so the
 * teacher's sheet can be dropped in as it is, with no hand-editing step.
 *
 * An export with no forms yet is a supported state, not an error: the site
 * then shows its "coming soon" copy instead of the search and the grid (see
 * stampDataState below), and every page still builds and passes its tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'data', 'source');
const OUT_FILE = path.join(ROOT, 'assets', 'data', 'exams.json');
const REPORT_FILE = path.join(ROOT, 'data', 'build-report.json');
/** The teacher's shortlist of the versions he wants students to start with. */
const PRIORITY_FILE = path.join(SOURCE_DIR, 'priority.json');
/** Facts read from the live forms by tools/fetch-form-meta.mjs (question counts). */
const META_FILE = path.join(SOURCE_DIR, 'form-meta.json');
/** Every form title ends in the brand; it is stripped even if the export never names it. */
const DEFAULT_PROJECT = 'دفرنة في القدرات والتحصيلي';
const EOL = '\n';

/* -------------------------------------------------------------------------- */
/* Arabic text normalisation — shared with the client (assets/js/search.js).   */
/* Keep the two implementations in sync; the client re-uses the keys built here.*/
/* -------------------------------------------------------------------------- */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

function normalizeArabic(input) {
  return String(input ?? '')
    .replace(DIACRITICS, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠-٩ -> 0-9
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Extra recall key: drop the definite article and leading conjunction. */
function stemKey(normalized) {
  return normalized
    .split(' ')
    .map((w) => {
      let s = w;
      if (s.length > 3 && s.startsWith('و')) s = s.slice(1); // و
      if (s.length > 4 && s.startsWith('ال')) s = s.slice(2); // ال
      return s;
    })
    .filter(Boolean)
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Reading the export                                                          */
/*                                                                             */
/* Keys are matched after stripping diacritics and collapsing spaces, so        */
/* «المعلّم» and «المعلم» are the same key whichever way the sheet spelled it.   */
/* -------------------------------------------------------------------------- */

const keyOf = (name) => String(name).replace(DIACRITICS, '').replace(/\s+/g, ' ').trim();

/** First present value among `names`, matched loosely on the key spelling. */
function pick(object, ...names) {
  if (!object || typeof object !== 'object') return undefined;
  const wanted = names.map(keyOf);
  for (const [name, value] of Object.entries(object)) {
    if (wanted.includes(keyOf(name)) && value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Forms are titled «<الإصدار> — دفرنة في القدرات والتحصيلي». The brand is
 * already the site, the header and the card's own frame, so repeating it on
 * every card is noise: the trailing segment is dropped whenever it is part of
 * the project name, leaving «الإصدار الحادي عشر».
 */
function cleanTitle(title, project) {
  const parts = String(title).split(/\s+[—–-]\s+/);
  if (parts.length < 2 || !project) return String(title).trim();
  const projectKey = normalizeArabic(project);
  while (parts.length > 1) {
    const tail = normalizeArabic(parts[parts.length - 1]);
    if (!tail || !projectKey.includes(tail)) break;
    parts.pop();
  }
  return parts.join(' — ').trim();
}

/* -------------------------------------------------------------------------- */
/* Link validation                                                             */
/* -------------------------------------------------------------------------- */

const GOOGLE_FORM_RE =
  /^https:\/\/docs\.google\.com\/forms\/d\/e\/([A-Za-z0-9_-]{20,})\/viewform(?:\?.*)?$/;
const SHORT_RE = /^https:\/\/forms\.gle\/([A-Za-z0-9]{5,})$/;

function safeHttpsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Hero stat stamping                                                          */
/*                                                                             */
/* index.html ships with em-dash placeholders that the app fills in on boot.    */
/* On a phone that turns a one-line stats row into two lines and shifts the      */
/* whole page. Writing the real values into the markup at build time removes     */
/* the shift entirely, and means the hero states real numbers even before the    */
/* script runs. The values match what app.js renders.                            */
/* -------------------------------------------------------------------------- */

const arabicNumber = (n) => new Intl.NumberFormat('ar-EG-u-nu-latn').format(n);
const PLURAL = new Intl.PluralRules('ar');

const UNIT_NOUNS = {
  exam: { zero: 'إصدارات', one: 'إصدار', two: 'إصداران', few: 'إصدارات', many: 'إصدارًا', other: 'إصدار' },
  question: { zero: 'أسئلة', one: 'سؤال', two: 'سؤالان', few: 'أسئلة', many: 'سؤالًا', other: 'سؤال' },
};

function unitNoun(n, unit) {
  const table = UNIT_NOUNS[unit];
  return table[PLURAL.select(n)] || table.other;
}

function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Replace the text inside one tag carrying a known data-* marker. */
function fillMarker(html, attr, value) {
  const pattern = new RegExp(
    `(<(?:b|span|time)[^>]*${attr}[^>]*>)([^<]*)(</(?:b|span|time)>)`,
  );
  if (!pattern.test(html)) {
    console.warn(`   ! marker not found in index.html: ${attr}`);
    return html;
  }
  return html.replace(pattern, (_m, open, _old, close) => `${open}${value}${close}`);
}

/**
 * Blocks marked data-when="ready" need published forms (search, stats, tiles,
 * grid); blocks marked data-when="empty" are the "coming soon" copy. Writing
 * the `hidden` attribute at build time means the first paint is already right
 * — no flash of an empty search box, and crawlers read the same page a
 * student sees. assets/js/app.js makes the same choice again at runtime.
 */
function stampDataState(html, mode) {
  return html.replace(/<([a-z]+)([^>]*data-when="(ready|empty)"[^>]*)>/g, (_m, tag, attrs, when) => {
    const clean = attrs.replace(/\s+hidden(?=[\s>]|$)/g, '');
    return `<${tag}${clean}${when === mode ? '' : ' hidden'}>`;
  });
}

function stampHero(meta) {
  const file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) return;

  let html = fs.readFileSync(file, 'utf8');
  const before = html;

  html = stampDataState(html, meta.total > 0 ? 'ready' : 'empty');
  html = fillMarker(html, 'data-stat="total"', arabicNumber(meta.total));
  html = fillMarker(html, 'data-unit="exam"', unitNoun(meta.total, 'exam'));

  // Written every time, even when absent, so a figure from an earlier build
  // never lingers in the markup.
  const questions = meta.totalQuestions ?? 0;
  html = fillMarker(html, 'data-stat="questions"', arabicNumber(questions));
  html = fillMarker(html, 'data-unit="question"', unitNoun(questions, 'question'));

  html = fillMarker(html, 'data-stat="priority"', arabicNumber(meta.priority?.count ?? 0));
  html = fillMarker(html, 'data-unit="priority"', meta.priority?.label ?? DEFAULT_PRIORITY_LABEL);

  if (meta.generated) {
    html = fillMarker(html, 'data-stat="updated"', formatDate(meta.generated));
    html = html.replace(
      /(<time[^>]*data-stat="updated"[^>]*datetime=")[^"]*(")/,
      `$1${meta.generated}$2`,
    );
    if (!/datetime="/.test(html.match(/<time[^>]*data-stat="updated"[^>]*>/)?.[0] || '')) {
      html = html.replace(
        /<time([^>]*)data-stat="updated"/,
        `<time$1datetime="${meta.generated}" data-stat="updated"`,
      );
    }
  }

  if (meta.generated) {
    // Freshness signal for search engines and AI crawlers.
    html = html.replace(/("dateModified":\s*")[^"]*(")/, `$1${meta.generated}$2`);
  }

  if (html !== before) {
    fs.writeFileSync(file, html, 'utf8');
    console.log('hero        : stamped totals into index.html');
  } else {
    console.log('hero        : index.html already current');
  }
}

/**
 * llms.txt — the plain-text brief that AI crawlers and assistants read
 * (llmstxt.org). It leads with the teacher, because the site is his: the
 * platform is one of the things he offers. Figures come from the dataset so
 * they can never drift; the site URL is stamped later by set-site-url.mjs.
 */
function writeLlmsTxt(meta) {
  const total = meta.total;
  const questions = meta.totalQuestions ?? 0;
  const perForm = meta.questionsPerForm;
  const updated = meta.generated ?? meta.builtAt;
  const key = meta.priority;

  const formsSection = total
    ? [
        `- عدد الإصدارات: ${total} ${unitNoun(total, 'exam')} على Google Forms.`,
        questions
          ? perForm
            ? `- عدد أسئلة كل إصدار: ${perForm} (بإجمالي ${questions} ${unitNoun(questions, 'question')}).`
            : `- عدد الأسئلة: ${questions} ${unitNoun(questions, 'question')} موزّعة على ${total} ${unitNoun(total, 'exam')}، ومعظم الإصدارات ${meta.questionsTypical} ${unitNoun(meta.questionsTypical ?? 0, 'question')}.`
          : null,
        '- لكل سؤال أربعة اختيارات، والإجابة إجبارية.',
        '- الإصدارات من إعداد المستر ولطلابه: تبدأ صفحة كل إصدار بكلمة مرور تُؤخذ منه، ثم اسم الطالب ورقم جواله.',
        '- بحث بالاسم أو بالرقم، وتصفية، ومتابعة تقدّم محفوظة على جهاز الطالب.',
        key
          ? `- ${key.count} ${unitNoun(key.count, 'exam')} منها مُعلَّمة بأنها «${key.label}»، ولها مفتاح تصفية مستقل: __SITE_URL__?key=1`
          : null,
        `- آخر تحديث للبيانات: ${updated}`,
      ]
        .filter(Boolean)
        .join('\n')
    : `- الإصدارات الإلكترونية قيد الإعداد وتُنشر على الموقع تباعًا (آخر تحديث: ${updated}).`;

  const text = `# مستر هشام خليل — مدرب قدرات كمي، دفرنة في القدرات والتحصيلي (Hisham Khalil — Quantitative Qudurat/GAT trainer)

> مستر هشام خليل مدرب قدرات كمي، ومدرب معتمد من المركز العربي للتدريب والتنمية البشرية، يقدّم ملفاته وإصداراته التدريبية في القسم الكمي من اختبار القدرات العامة تحت اسم «دفرنة في القدرات والتحصيلي».

## من هو

- الاسم: هشام خليل، ويُكتب: مستر هشام خليل، أو الأستاذ هشام خليل.
- مدرب قدرات كمي.
- مدرب معتمد — المركز العربي للتدريب والتنمية البشرية.
- صاحب «دفرنة في القدرات والتحصيلي»: ملفاته المجمّعة وإصداراته الإلكترونية.
- شعاره الآية الكريمة: ﴿يُرِيدُ اللَّهُ بِكُمُ الْيُسْرَ وَلَا يُرِيدُ بِكُمُ الْعُسْرَ﴾ (البقرة: 185).

## التواصل

- واتساب واتصال: 0508145231 (‎+966 50 814 5231) — https://wa.me/966508145231
- الموقع: __SITE_URL__teacher.html

## موقعه: دفرنة في القدرات والتحصيلي

${formsSection}
- الموقع لا يتطلّب تسجيل دخول، ويمكن تثبيته على الجوال أو الكمبيوتر كتطبيق.

## الصفحات

- [مستر هشام خليل — مدرب قدرات كمي](__SITE_URL__teacher.html): نبذته وطرق التواصل معه وأسئلة شائعة عنه.
- [إصدارات دفرنة في القدرات والتحصيلي](__SITE_URL__): كل الإصدارات مع البحث والتصفية ومتابعة التقدّم.
- [عن المنصة](__SITE_URL__about.html): طريقة الاستخدام، وكلمة مرور الإصدارات، وتثبيت الموقع كتطبيق، وأسئلة شائعة.

## ملاحظات

- «دفرنة في القدرات والتحصيلي» اسم ملفات مستر هشام خليل وموقعه وحده، ولا علاقة له بأي شخص أو جهة أخرى تحمل اسمًا مشابهًا.
- «قياس» هو المركز الوطني للقياس؛ الموقع تدريبي وليس تابعًا له ولا معتمدًا منه.
- الموقع لا يجمع أي بيانات عن الطلاب، والإجابات تُسجَّل داخل Google Forms.

## English summary

Hisham Khalil (مستر هشام خليل) is a trainer for the quantitative section of the Saudi
General Aptitude Test (Qudurat / GAT) and a certified trainer of the Arab Center for
Training and Human Development (المركز العربي للتدريب والتنمية البشرية). He publishes his
study files and practice forms under the name "دفرنة في القدرات والتحصيلي". ${
    total
      ? `This site lists ${total} of his online practice forms${questions ? ` (${questions} questions in total)` : ''}, last updated ${updated}. Each question is multiple choice with four options and is compulsory; every form opens with a password his students get from him, so the set is his own material for his own students.`
      : `His online practice forms are being prepared and will be listed on this site as they are published.`
  }
He is not affiliated with, employed by, or endorsed by Qiyas, the national assessment centre.
Enquiries: WhatsApp or phone +966 50 814 5231.
`;

  fs.writeFileSync(path.join(ROOT, 'llms.txt'), text, 'utf8');
  console.log('llms.txt    : written from the dataset');
}

/**
 * sitemap.xml — regenerated on every build so <lastmod> can never drift from
 * the dataset, and so his portrait is offered to Google Images next to the
 * pages it appears on (an image sitemap is the only place a static site can
 * declare that link). The site URL is stamped later by set-site-url.mjs,
 * exactly as in llms.txt.
 */
function writeSitemap(meta) {
  const updated = meta.generated ?? meta.builtAt;
  const portrait = {
    loc: '__SITE_URL__assets/img/teacher-portrait.jpg',
    title: 'مستر هشام خليل — مدرب قدرات كمي',
  };
  const standing = {
    loc: '__SITE_URL__assets/img/teacher-standing-720.webp',
    title: 'مستر هشام خليل، مدرب قدرات كمي ومدرب معتمد — دفرنة في القدرات والتحصيلي',
  };
  const emblem = {
    loc: '__SITE_URL__assets/img/logo-256.png',
    title: 'شعار دفرنة في القدرات والتحصيلي — مستر هشام خليل',
  };

  const pages = [
    { loc: '__SITE_URL__', changefreq: 'weekly', priority: '1.0', images: [emblem, portrait] },
    {
      loc: '__SITE_URL__teacher.html',
      changefreq: 'monthly',
      priority: '0.9',
      images: [standing, portrait],
    },
    { loc: '__SITE_URL__about.html', changefreq: 'monthly', priority: '0.5', images: [] },
  ];

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
  ];

  for (const page of pages) {
    lines.push('  <url>');
    lines.push(`    <loc>${page.loc}</loc>`);
    lines.push(`    <lastmod>${updated}</lastmod>`);
    lines.push(`    <changefreq>${page.changefreq}</changefreq>`);
    lines.push(`    <priority>${page.priority}</priority>`);
    for (const img of page.images) {
      lines.push('    <image:image>');
      lines.push(`      <image:loc>${img.loc}</image:loc>`);
      lines.push(`      <image:title>${escapeXml(img.title)}</image:title>`);
      lines.push('    </image:image>');
    }
    lines.push('  </url>');
  }
  lines.push('</urlset>');

  const xml = lines.join(EOL) + EOL;
  // A rebuild must never un-deploy the sitemap, so an already-stamped absolute
  // URL is kept instead of being reverted to the placeholder.
  const site = readStampedSiteUrl();
  const next = site ? xml.split('__SITE_URL__').join(site) : xml;

  const target = path.join(ROOT, 'sitemap.xml');
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (next === before) {
    console.log('sitemap.xml : already current');
    return;
  }
  fs.writeFileSync(target, next, 'utf8');
  console.log('sitemap.xml : written from the dataset');
}

/** The URL set-site-url.mjs stamped last, if this checkout has been deployed. */
function readStampedSiteUrl() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'data', '.site-url'), 'utf8').trim();
    return /^https?:\/\/\S+$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------------------- */
/* Priority shortlist                                                          */
/*                                                                             */
/* `data/source/priority.json` carries the version numbers the teacher wants    */
/* students to start with. It is a separate file on purpose: the forms export   */
/* is a machine dump that gets replaced wholesale, while this list is his        */
/* editorial judgement and is revised on its own schedule. Updating it is a      */
/* one-file edit plus `npm run build:data` — never a code change, and deleting   */
/* the file is a supported state: every affordance built on it hides itself.     */
/* -------------------------------------------------------------------------- */

const DEFAULT_PRIORITY_LABEL = 'ابدأ بهذه';

function readPriority() {
  const empty = { label: DEFAULT_PRIORITY_LABEL, blurb: null, updated: null, numbers: new Set() };
  if (!fs.existsSync(PRIORITY_FILE)) return empty;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PRIORITY_FILE, 'utf8'));
  } catch (error) {
    // A malformed shortlist must not take the whole site down: the build
    // continues without it, loudly.
    console.warn(`   ! priority.json is not valid JSON — ignored (${error.message})`);
    return empty;
  }

  const listed = Array.isArray(raw?.sections) ? raw.sections : [];
  const numbers = new Set();
  for (const value of listed) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) numbers.add(n);
  }

  return {
    label:
      typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim() : DEFAULT_PRIORITY_LABEL,
    blurb: typeof raw?.blurb === 'string' && raw.blurb.trim() ? raw.blurb.trim() : null,
    updated: typeof raw?.updated === 'string' ? raw.updated : null,
    numbers,
    listed: listed.length,
  };
}

function findSourceFile() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Source directory not found: ${SOURCE_DIR}`);
  }
  const candidates = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => path.join(SOURCE_DIR, f))
    // The shortlist and the fetched form facts live here too; neither is an export.
    .filter((f) => f !== PRIORITY_FILE && f !== META_FILE);

  // No export yet is the state before the first forms are published.
  if (!candidates.length) return null;
  // Prefer the largest file — that is the full export.
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

/**
 * A Google Forms *edit* URL hands write access to the live form to anyone who
 * opens it. The teacher's exports sometimes carry one per row («رابط التعديل»),
 * and this repository is public and published whole, so the build refuses to
 * run rather than copy one into the site. Keep those links out of the export.
 */
function assertNoEditLinks(sourceFile, text) {
  const found = text.match(/https:\/\/docs\.google\.com\/forms\/d\/[A-Za-z0-9_-]+\/edit/g);
  if (!found) return;
  console.error(
    `FAILED: ${path.relative(ROOT, sourceFile)} contains ${found.length} Google Forms edit link(s).\n` +
      '        Those grant write access to the live forms and this repository is public.\n' +
      '        Remove every "رابط التعديل" from the export and re-run.',
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Arabic ordinals, both ways.                                                 */
/*                                                                             */
/* The teacher's export lists forms by name only — «الإصدار الحادي والعشرون» —  */
/* with no number field, so the number is read back out of the ordinal in the   */
/* name (and cross-checked against the row's position). The same table names a */
/* form the export left untitled, spelled out so the search finds it by word   */
/* and by number.                                                              */
/* -------------------------------------------------------------------------- */

const ORDINAL_UNITS = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع'];
const ORDINAL_TENS = ['', 'العاشر', 'العشرون', 'الثلاثون', 'الأربعون', 'الخمسون', 'الستون', 'السبعون', 'الثمانون', 'التسعون'];

function ordinal(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  if (n < 10) return ORDINAL_UNITS[n];
  if (n === 10) return 'العاشر';
  if (n < 20) return `${n === 11 ? 'الحادي' : ORDINAL_UNITS[n - 10]} عشر`;
  const unit = n % 10;
  const tens = ORDINAL_TENS[Math.floor(n / 10)];
  return unit ? `${unit === 1 ? 'الحادي' : ORDINAL_UNITS[unit]} و${tens}` : tens;
}

const defaultTitle = (n) => `الإصدار ${ordinal(n) ?? n}`;

/** normalised ordinal phrase -> number, longest phrases first («الحادي عشر» before «الحادي»). */
const ORDINAL_LOOKUP = Array.from({ length: 99 }, (_, i) => [normalizeArabic(ordinal(i + 1)), i + 1]).sort(
  (a, b) => b[0].length - a[0].length,
);

/** «الإصدار الحادي والعشرون — …» -> 21; a plain digit in the title works too. */
function numberFromTitle(title) {
  const text = normalizeArabic(title);
  const digits = /(?:^|\s)(\d{1,4})(?:\s|$)/.exec(text);
  if (digits) return Number(digits[1]);
  for (const [phrase, n] of ORDINAL_LOOKUP) {
    if (new RegExp(`(?:^|\\s)${phrase}(?:\\s|$)`).test(text)) return n;
  }
  return null;
}

/** Question counts read from the live forms, keyed by Google Form id. */
function readFormMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8')).forms ?? {};
  } catch {
    return {};
  }
}

function main() {
  const sourceFile = findSourceFile();
  const sourceText = sourceFile ? fs.readFileSync(sourceFile, 'utf8') : '{"forms": []}';
  if (sourceFile) assertNoEditLinks(sourceFile, sourceText);
  const raw = JSON.parse(sourceText);
  const priority = readPriority();

  // Re-exports tend to carry it; it is never copied into the site, but it has
  // no business sitting in the repository either (tools/test-seo.mjs fails on it).
  if (pick(raw, 'كلمة المرور', 'password') !== undefined) {
    console.warn('   ! the export still carries the access code — remove «كلمة المرور» from it');
  }

  const project = pick(raw, 'المشروع', 'project') ?? DEFAULT_PROJECT;
  const sourceForms = Array.isArray(raw) ? raw : pick(raw, 'الفورمات', 'الإصدارات', 'النماذج', 'forms');
  if (!Array.isArray(sourceForms)) {
    throw new Error('Source JSON has no forms array («الفورمات» / «الإصدارات» / "forms").');
  }
  const formMeta = readFormMeta();
  const orderNotes = [];

  const exams = [];
  const issues = [];
  const seenUrl = new Map();
  const seenNumber = new Map();

  for (const [index, row] of sourceForms.entries()) {
    const rawTitle = String(pick(row, 'الاسم', 'العنوان', 'title', 'name') ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    // An explicit number wins; otherwise the ordinal in the name; otherwise the
    // row's position. A name that disagrees with its position is reported, so
    // a mis-ordered export is visible without being silently renumbered.
    const explicit = pick(row, 'الإصدار', 'رقم الإصدار', 'النموذج', 'الرقم', 'section', 'number');
    const fromTitle = numberFromTitle(rawTitle);
    const rawNumber = explicit ?? fromTitle ?? index + 1;
    const where = `#${index + 1} (رقم ${rawNumber ?? '?'})`;
    if (explicit === undefined && fromTitle !== null && fromTitle !== index + 1) {
      orderNotes.push(`row ${index + 1} is titled as number ${fromTitle}`);
    }

    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number <= 0) {
      issues.push({ where, reason: 'invalid-version-number', value: rawNumber });
      continue;
    }
    const title = cleanTitle(rawTitle, project) || defaultTitle(number);
    if (!title) {
      issues.push({ where, reason: 'missing-title' });
      continue;
    }

    const rawUrl = pick(row, 'الرابط الكامل', 'الرابط', 'url', 'link');
    const canonical = safeHttpsUrl(rawUrl);
    if (!canonical) {
      issues.push({ where, reason: 'invalid-or-insecure-url', value: rawUrl });
      continue;
    }

    const short = safeHttpsUrl(pick(row, 'الرابط المختصر', 'short'));

    // Store the Google Form id when the URL is canonical — it keeps the payload
    // small. Anything else is kept verbatim (still https-validated).
    const formMatch = canonical.match(GOOGLE_FORM_RE);
    const shortMatch = short ? short.match(SHORT_RE) : null;

    if (seenNumber.has(number)) {
      issues.push({ where, reason: 'duplicate-version-number', value: number });
      continue;
    }
    seenNumber.set(number, true);

    if (seenUrl.has(canonical)) {
      issues.push({
        where,
        reason: 'duplicate-url',
        value: `also used by رقم ${seenUrl.get(canonical)}`,
      });
      continue;
    }
    seenUrl.set(canonical, number);

    const norm = normalizeArabic(title);
    const stem = stemKey(norm);

    const record = { n: number, t: title, k: stem === norm ? norm : `${norm} ${stem}` };

    // The forms are not all the same length, so the count travels with the
    // record rather than being a single figure in meta the card would have to
    // assume applies to it. The export's own figure wins; otherwise the count
    // read from the live form by tools/fetch-form-meta.mjs.
    const exported = pick(row, 'عدد الأسئلة', 'questions');
    const fetched = formMatch ? formMeta[formMatch[1]]?.questions : undefined;
    const questions = Number(exported ?? fetched);
    if (Number.isInteger(questions) && questions > 0) record.q = questions;
    else if (exported !== undefined) {
      issues.push({ where, reason: 'invalid-question-count', value: exported });
    }

    if (formMatch) record.f = formMatch[1];
    else record.u = canonical;
    if (shortMatch) record.s = shortMatch[1];
    else if (short) record.su = short;
    // One flag byte rather than a second array the client would have to join.
    if (priority.numbers.has(number)) record.p = 1;

    exams.push(record);
  }

  exams.sort((a, b) => a.n - b.n);

  const numbers = exams.map((e) => e.n);
  const min = numbers.length ? Math.min(...numbers) : 0;
  const max = numbers.length ? Math.max(...numbers) : 0;

  // Contiguous batches derived from the real numbering — not invented. The step
  // follows the size of the set so the quick-jump chips stay a single readable
  // row: four or five chips, whether the export holds 42 rows or 400.
  const BATCH = max > 150 ? 50 : max > 60 ? 20 : 10;
  const ranges = [];
  for (let start = Math.floor((min - 1) / BATCH) * BATCH + 1; start <= max; start += BATCH) {
    const end = Math.min(start + BATCH - 1, max);
    const count = numbers.filter((n) => n >= start && n <= end).length;
    if (count > 0) ranges.push({ from: start, to: end, count });
  }

  // A short trailing batch (e.g. "41–42") is noise as its own chip — fold it
  // into the previous one so the quick-jump chips stay evenly weighted.
  if (ranges.length > 1) {
    const tail = ranges[ranges.length - 1];
    if (tail.count <= BATCH / 4) {
      const prev = ranges[ranges.length - 2];
      prev.to = tail.to;
      prev.count += tail.count;
      ranges.pop();
    }
  }

  // Per-form counts: one figure in meta only if every form really carries it.
  const counts = exams.map((e) => e.q).filter((q) => Number.isInteger(q));
  const complete = counts.length === exams.length && exams.length > 0;
  const uniform = complete && counts.every((q) => q === counts[0]);
  const totalQuestions = complete
    ? counts.reduce((sum, q) => sum + q, 0)
    : Number(pick(raw, 'إجمالي الأسئلة', 'total_questions')) || null;
  const questionsTypical = complete
    ? Number(
        [...counts]
          .sort(
            (a, b) =>
              counts.filter((q) => q === b).length - counts.filter((q) => q === a).length || b - a,
          )[0],
      )
    : null;

  // A number on the shortlist that no published form answers to is a typo in
  // the shortlist, not a reason to fail: it is dropped and reported.
  const published = new Set(exams.map((e) => e.n));
  const priorityUnknown = [...priority.numbers].filter((n) => !published.has(n)).sort((a, b) => a - b);
  const priorityCount = exams.filter((e) => e.p).length;

  // The export carries no date of its own, so the file's own mtime is the
  // dataset's date: it changes exactly when the data changes, and never on a
  // rebuild that changed nothing.
  const generated =
    String(pick(raw, 'التاريخ', 'generated') ?? '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0] ??
    (sourceFile ? fs.statSync(sourceFile).mtime : new Date()).toISOString().slice(0, 10);

  const payload = {
    meta: {
      project,
      teacher: pick(raw, 'المعلم', 'teacher') ?? null,
      generated,
      note: pick(raw, 'ملاحظة', 'note') ?? null,
      questionsPerForm: uniform ? counts[0] : null,
      questionsTypical,
      total: exams.length,
      totalQuestions,
      first: min,
      last: max,
      ranges,
      priority: priorityCount
        ? {
            label: priority.label,
            blurb: priority.blurb,
            count: priorityCount,
            updated: priority.updated,
          }
        : null,
      builtAt: new Date().toISOString().slice(0, 10),
    },
    exams,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload), 'utf8');

  stampHero(payload.meta);
  writeLlmsTxt(payload.meta);
  writeSitemap(payload.meta);

  const report = {
    sourceFile: sourceFile ? path.relative(ROOT, sourceFile).replace(/\\/g, '/') : null,
    sourceRecords: sourceForms.length,
    published: exams.length,
    excluded: issues.length,
    issues,
    questions: {
      total: totalQuestions,
      perForm: payload.meta.questionsPerForm,
      typical: questionsTypical,
      counted: counts.length,
    },
    priority: {
      label: priority.label,
      listed: priority.listed ?? 0,
      flagged: priorityCount,
      unknown: priorityUnknown,
    },
    outputBytes: fs.statSync(OUT_FILE).size,
    ranges,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

  console.log(`source      : ${report.sourceFile}`);
  console.log(`records     : ${sourceForms.length}`);
  console.log(`published   : ${exams.length}`);
  console.log(`excluded    : ${issues.length}`);
  for (const i of issues) console.log(`   ! ${i.where} — ${i.reason} ${i.value ?? ''}`);
  for (const note of orderNotes) console.log(`   ! ${note} — numbered by its name, not its position`);
  console.log(
    `form facts  : ${Object.keys(formMeta).length ? `question counts from ${path.relative(ROOT, META_FILE)}` : 'none (run npm run fetch:meta)'}`,
  );
  console.log(
    `questions   : ${totalQuestions ?? '—'} total` +
      (payload.meta.questionsPerForm ? ` (${payload.meta.questionsPerForm} each)` : ` (${questionsTypical} typical)`),
  );
  console.log(`priority    : ${priorityCount} flagged "${priority.label}"`);
  for (const n of priorityUnknown) console.log(`   ! priority ${n} — no published form with that number`);
  console.log(`ranges      : ${ranges.map((r) => `${r.from}-${r.to}(${r.count})`).join(' ')}`);
  console.log(`dataset date: ${generated}`);
  console.log(`output      : assets/data/exams.json  (${(report.outputBytes / 1024).toFixed(1)} KB)`);

  if (exams.length === 0) {
    // Not a failure: the pages switch to their "coming soon" copy.
    console.warn(
      sourceForms.length
        ? '   ! no publishable forms — every row was excluded (see above); the site shows "coming soon"'
        : 'forms       : none published yet — the site shows its "coming soon" state',
    );
  }
}

main();
