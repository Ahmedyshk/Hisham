#!/usr/bin/env node
/**
 * set-site-url.mjs
 * ---------------------------------------------------------------------------
 * Absolute URLs are required for canonical links, Open Graph images and the
 * sitemap, but the real URL is only known at deploy time (and differs between a
 * project page, a user page and a custom domain).
 *
 * Every HTML/XML/TXT file therefore ships with the literal placeholder
 * `__SITE_URL__`. This script substitutes the real origin — and can substitute
 * it again on a later deploy, because it also recognises a URL it wrote before.
 *
 *     node tools/set-site-url.mjs https://user.github.io/repo/
 *
 * The GitHub Actions workflow calls it automatically with the URL reported by
 * actions/configure-pages, so nothing has to be committed by hand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = '__SITE_URL__';
const MARKER_FILE = path.join(ROOT, 'data', '.site-url');
const TARGETS = ['index.html', 'about.html', 'teacher.html', 'sitemap.xml', 'llms.txt'];
const ROBOTS_FILE = path.join(ROOT, 'robots.txt');

function normalizeUrl(input) {
  if (!input) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  // Always end with exactly one slash so `${SITE}about.html` composes cleanly.
  let href = url.origin + url.pathname;
  if (!href.endsWith('/')) href += '/';
  return href;
}

function previousUrl() {
  try {
    return normalizeUrl(fs.readFileSync(MARKER_FILE, 'utf8').trim());
  } catch {
    return null;
  }
}

function main() {
  const input = process.argv[2];
  const site = normalizeUrl(input);

  if (!site) {
    console.error('Usage: node tools/set-site-url.mjs <https://example.com/base/>');
    console.error(`Received: ${input ?? '(nothing)'}`);
    process.exit(1);
  }

  const previous = previousUrl();
  let changedFiles = 0;
  let replacements = 0;

  for (const relative of TARGETS) {
    const file = path.join(ROOT, relative);
    if (!fs.existsSync(file)) {
      console.warn(`  skip  ${relative} (missing)`);
      continue;
    }

    const before = fs.readFileSync(file, 'utf8');
    let after = before.split(PLACEHOLDER).join(site);
    if (previous && previous !== site) after = after.split(previous).join(site);

    if (after !== before) {
      const count =
        before.split(PLACEHOLDER).length -
        1 +
        (previous && previous !== site ? before.split(previous).length - 1 : 0);
      fs.writeFileSync(file, after, 'utf8');
      changedFiles += 1;
      replacements += count;
      console.log(`  write ${relative} (${count} replacement${count === 1 ? '' : 's'})`);
    } else {
      console.log(`  ok    ${relative} (already current)`);
    }
  }

  // robots.txt: a Sitemap directive must be an absolute URL, so the committed
  // file carries none and the correct line is written (or rewritten) here.
  if (fs.existsSync(ROBOTS_FILE)) {
    const before = fs.readFileSync(ROBOTS_FILE, 'utf8');
    const body = before
      .split(/\r?\n/)
      .filter((line) => !/^\s*sitemap\s*:/i.test(line))
      .join('\n')
      .replace(/\n+$/, '');
    const after = `${body}\n\nSitemap: ${site}sitemap.xml\n`;
    if (after !== before) {
      fs.writeFileSync(ROBOTS_FILE, after, 'utf8');
      changedFiles += 1;
      replacements += 1;
      console.log('  write robots.txt (Sitemap directive)');
    } else {
      console.log('  ok    robots.txt (already current)');
    }
  }

  fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
  fs.writeFileSync(MARKER_FILE, `${site}\n`, 'utf8');

  console.log(`\nsite url: ${site}`);
  console.log(`updated ${changedFiles} file(s), ${replacements} replacement(s)`);
}

main();
