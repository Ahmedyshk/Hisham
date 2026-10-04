# Regenerating the self-hosted fonts

The site self-hosts **IBM Plex Sans Arabic** (SIL Open Font License 1.1) instead of
linking to Google Fonts, so there is no third-party request, no extra DNS/TLS
handshake, and no dependency on fonts.googleapis.com being reachable.

`assets/fonts/` contains eight IBM Plex files — Arabic and Latin, at weights 400/500/600/700 — plus the two brand faces in step 4.
They are **not** the stock Google files: the Latin faces have been subset. Redownloading
them without repeating step 2 would add ~40 KB back.

## 1. Fetch the woff2 sources

Google Fonts serves woff2 only to a modern user agent:

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
curl -A "$UA" "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"
```

From the response take the `arabic` and `latin` `@font-face` blocks for each weight
and download those eight `.woff2` files into `assets/fonts/`, named:

```
plex-ar-400.woff2   plex-lat-400.woff2
plex-ar-500.woff2   plex-lat-500.woff2
plex-ar-600.woff2   plex-lat-600.woff2
plex-ar-700.woff2   plex-lat-700.woff2
```

The `cyrillic-ext` and `latin-ext` blocks are not used and should be skipped.

## 2. Subset the Latin faces

The Latin faces exist almost entirely to draw digits (`301`, `3,913`, `13`, `47`) and
the occasional Latin word such as “Google Forms”. Full Latin coverage is ~20 KB per
weight; the subset is ~9 KB.

```bash
pip install fonttools brotli

KEEP="U+0020-007E,U+00A0,U+2010-2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+202A-202E,U+200E-200F,U+066A-066C,U+060C,U+2212"

for w in 400 500 600 700; do
  pyftsubset "assets/fonts/plex-lat-$w.woff2" \
    --unicodes="$KEEP" \
    --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize \
    --output-file="assets/fonts/plex-lat-$w.woff2.sub"
  mv "assets/fonts/plex-lat-$w.woff2.sub" "assets/fonts/plex-lat-$w.woff2"
done
```

**Do not subset the Arabic faces.** Their glyph coverage has to survive future exam
titles, which can contain any Arabic character; the full Arabic block is the safe
choice and the `unicode-range` declarations in `assets/css/base.css` already stop the
browser downloading them for a Latin-only page.

## 3. Check

```bash
npm start
```

Open the site and confirm the Arabic text and the digits both render in Plex rather
than a system fallback. `assets/css/base.css` declares the `unicode-range` for every
face; if a face is renamed, update it there too.

## 4. The brand faces: Amiri (the verse) and Lalezar (the wordmark)

Both are subset to Arabic only and declared in `assets/css/base.css`. Amiri keeps every
Arabic letter, the vocalisation marks and the ornate parentheses ﴿ ﴾ so any future verse or
phrase still renders; Lalezar keeps the Arabic letters only.

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
curl -A "$UA" "https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Lalezar&display=swap"
# download the two `arabic` woff2 files from the response, then:

pyftsubset amiri-arabic-700.woff2 \
  --unicodes="U+0020,U+0021,U+0028-0029,U+002C-002E,U+003A,U+005B-005D,U+00A0,U+060C,U+061B,U+061F,U+0621-063A,U+0640-0652,U+0654-0655,U+0660-0669,U+0670,U+06DD,U+06DE,U+06E9,U+200C-200F,U+FD3E-FD3F" \
  --flavor=woff2 --layout-features='*' --no-hinting --output-file=assets/fonts/amiri-700-sub.woff2

pyftsubset lalezar-arabic.woff2 \
  --unicodes="U+0020,U+002E,U+060C,U+0621-063A,U+0640-064A,U+0660-0669,U+200C-200F" \
  --flavor=woff2 --layout-features='*' --no-hinting --output-file=assets/fonts/lalezar-sub.woff2
```

`--layout-features='*'` is not optional for Amiri: without the mark-positioning features the
vowel marks of the verse collide with the letters.
