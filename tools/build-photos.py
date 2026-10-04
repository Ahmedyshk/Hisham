#!/usr/bin/env python3
"""
build-photos.py — every image the site ships, from the untouched originals in
data/source/ to the web-ready files in assets/img/.

    python tools/build-photos.py

Needs Pillow, numpy and scipy. Run it only when an original changes — the
outputs are committed.

1. mark-*.webp / mark-*.png / logo-256.png / favicons / maskable icons
   Source: data/source/brand/logo-source.jpg — the emblem as it was delivered.
   That file is a JPEG with a grey-and-white checkerboard *painted into it*
   (the "transparent" preview of an image generator), so there is no alpha to
   read. The checkerboard is recognised by colour (two neutral greys, nothing
   saturated), the part of it connected to the image border becomes real
   transparency, and the part enclosed by the emblem's rings becomes the
   brand's warm paper colour. Edge pixels, which are a blend of ink and checker,
   are un-mixed against the local checker colour so no grey fringe survives.

2. teacher-portrait-*.webp / teacher-portrait.jpg  (square, shown as a circle)
   Source: data/source/photos/teacher-source.jpg — head and shoulders. The
   room is removed with rembg (u2net_human_seg; `pip install "rembg[cpu]"`,
   the model downloads once) and he is placed on the emblem's navy.

3. teacher-standing-*.webp  (4:5, for the arch frame)
   The same photograph, framed wider and left exactly as it was taken.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source"
OUT = ROOT / "assets" / "img"

# Sampled from the emblem itself (tools/build-photos.py --sample prints them).
NAVY = (34, 62, 91)  # #223e5b
GOLD = (186, 154, 104)  # #ba9a68
PAPER = (255, 253, 248)  # --paper-50, the fill inside the rings
CREAM = (246, 242, 233)  # --paper-200, the page

# --- helpers -------------------------------------------------------------------


def norm_blur(values, weight, radius):
    """Gaussian blur of `values` counting only pixels where `weight` is set."""
    w = ndimage.gaussian_filter(weight.astype(np.float64), radius)
    out = np.empty_like(values)
    for c in range(values.shape[-1]):
        out[..., c] = ndimage.gaussian_filter(values[..., c] * weight, radius)
    return out / np.maximum(w, 1e-6)[..., None], w


def circle_mask(size, supersample=4, inset=0.0):
    big = size * supersample
    pad = inset * supersample
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((pad, pad, big - 1 - pad, big - 1 - pad), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def as_circle(square, size, inset=0.0):
    img = square.convert("RGB").resize((size, size), Image.LANCZOS)
    out = img.convert("RGBA")
    out.putalpha(circle_mask(size, inset=inset))
    return out


# --- 1. The emblem --------------------------------------------------------------


def extract_emblem():
    """The emblem on real transparency, its interior filled with paper."""
    src = Image.open(SRC / "brand" / "logo-source.jpg").convert("RGB")
    img = np.asarray(src).astype(np.float64)
    hi, lo = img.max(-1), img.min(-1)

    # The painted checkerboard: neutral (no saturation) and light. Its two
    # tones sample at ~#cacaca and ~#f8f8f8; nothing in the artwork is both
    # that pale and that grey — the palest artwork colour, the sky blue, is
    # 60 points away from neutral.
    checker = ((hi - lo) < 24) & (lo > 168)
    checker = ndimage.binary_opening(checker, iterations=1)

    # Cores: pixels that are certainly one thing or the other.
    bg_core = ndimage.binary_erosion(checker, iterations=2)
    fg_core = ndimage.binary_erosion(~checker, iterations=2)

    # Local colour of the checker square behind each pixel, and of the ink in
    # front of it, so a blended edge pixel can be split into the two.
    bg_col, _ = norm_blur(img, bg_core, 2.5)
    fg_col, _ = norm_blur(img, fg_core, 2.5)

    diff = fg_col - bg_col
    denom = np.maximum((diff * diff).sum(-1), 1.0)
    a = np.clip(((img - bg_col) * diff).sum(-1) / denom, 0, 1)
    a[bg_core] = 0.0
    a[fg_core] = 1.0

    # Outside = checker connected to the image border.
    labels, _ = ndimage.label(checker)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    outside_ids = np.unique(border[border > 0])
    outside = np.isin(labels, outside_ids)
    # Edge pixels hugging the outside belong to the silhouette's edge.
    near_out = ndimage.binary_dilation(outside, iterations=4) & ~outside

    paper = np.array(PAPER, dtype=np.float64)
    fg = np.where(a[..., None] > 0, fg_col, img)
    rgb = a[..., None] * fg + (1 - a[..., None]) * paper  # composite on paper
    rgb[fg_core] = img[fg_core]  # untouched where it is plainly artwork

    alpha = np.ones(a.shape)
    alpha[outside] = 0.0
    alpha[near_out] = a[near_out]
    rgb[near_out] = fg[near_out]

    out = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)
    emblem = Image.fromarray(out, "RGBA")
    return emblem.crop(emblem.getbbox())


def square_canvas(emblem, pad_ratio=0.0):
    """Centre the emblem on a transparent square."""
    side = round(max(emblem.size) * (1 + 2 * pad_ratio))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(emblem, ((side - emblem.width) // 2, (side - emblem.height) // 2), emblem)
    return canvas


def on_colour(square, size, bg, pad_ratio):
    canvas = Image.new("RGB", (size, size), bg)
    inner = round(size * (1 - 2 * pad_ratio))
    mark = square.resize((inner, inner), Image.LANCZOS)
    canvas.paste(mark, ((size - inner) // 2, (size - inner) // 2), mark)
    return canvas


def build_mark():
    emblem = extract_emblem()
    square = square_canvas(emblem)

    for size in (720, 360, 144):
        square.resize((size, size), Image.LANCZOS).save(
            OUT / f"mark-{size}.webp", "WEBP", quality=90, method=6
        )
    square.resize((256, 256), Image.LANCZOS).save(OUT / "logo-256.png", "PNG", optimize=True)

    # Icons are drawn on a flat colour: transparency renders as grey or black in
    # most tab bars and launchers.
    on_colour(square, 32, PAPER, 0.0).save(OUT / "favicon-32.png", "PNG", optimize=True)
    on_colour(square, 180, PAPER, 0.06).save(OUT / "apple-touch-icon.png", "PNG", optimize=True)
    # Maskable icons keep the safe zone: the emblem spans 74% of the width so a
    # circle or squircle mask never clips the ring.
    on_colour(square, 192, PAPER, 0.13).save(OUT / "maskable-192.png", "PNG", optimize=True)
    on_colour(square, 512, PAPER, 0.13).save(OUT / "maskable-512.png", "PNG", optimize=True)
    on_colour(square, 512, PAPER, 0.04).save(OUT / "icon-512.png", "PNG", optimize=True)

    ico = [on_colour(square, s, PAPER, 0.0) for s in (16, 32, 48)]
    ico[2].save(
        ROOT / "favicon.ico", "ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[:2]
    )
    return square


# --- 2. Portrait -----------------------------------------------------------------

# On the original (720 x 705): the head with headroom, closing at the chest so
# the circle reads as a portrait rather than a cut-off head.
PORTRAIT_BOX = (187, 48, 543, 404)


def navy_stage(size):
    """The brand's navy, lit from behind his head — the emblem's own colours."""
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.sqrt((xx / size - 0.5) ** 2 + (yy / size - 0.36) ** 2)
    t = np.clip((d - 0.05) / 0.62, 0, 1)[..., None]
    centre = np.array([52, 92, 132])  # navy, lifted
    rim = np.array([16, 34, 56])  # navy, deepened
    return Image.fromarray((centre * (1 - t) + rim * t).astype(np.uint8), "RGB")


def build_cutout():
    """Him, with the room behind him removed (the wall carries an ornament and
    a painting that a tight circle would frame instead of his face)."""
    from rembg import new_session, remove

    src = Image.open(SRC / "photos" / "teacher-source.jpg").convert("RGB")
    cut = remove(src, session=new_session("u2net_human_seg"), post_process_mask=True)
    alpha = np.asarray(cut.split()[-1]).astype(np.float64) / 255.0
    rgb = np.asarray(src).astype(np.float64)

    # Tighten the matte slightly and take the wall colour out of the soft edge,
    # so the white thobe does not carry a beige outline onto the navy.
    alpha = np.clip((alpha - 0.1) / 0.9, 0, 1)
    wall, _ = norm_blur(rgb, (alpha < 0.02), 18)
    a = alpha[..., None]
    edge = (a > 0.02) & (a < 0.98)
    fg = np.clip(np.where(edge, (rgb - (1 - a) * wall) / np.maximum(a, 0.05), rgb), 0, 255)
    return Image.fromarray(np.dstack([fg, alpha * 255]).astype(np.uint8), "RGBA")


def build_portrait():
    subject = build_cutout().crop(PORTRAIT_BOX)
    square = navy_stage(subject.width)
    square.paste(subject, (0, 0), subject)

    for size in (720, 360, 144):
        square.resize((size, size), Image.LANCZOS).save(
            OUT / f"teacher-portrait-{size}.webp", "WEBP", quality=86, method=6
        )

    # JPEG twin for crawlers and link previews that expect one. It may be shown
    # square, so the circle sits on the page's cream inside a gold ring.
    size, ring = 720, 10
    avatar = Image.new("RGB", (size, size), CREAM)
    ImageDraw.Draw(avatar).ellipse((4, 4, size - 5, size - 5), fill=GOLD)
    inner = size - 2 * (ring + 4)
    disc = as_circle(square, inner, inset=1.0)
    avatar.paste(disc, (ring + 4, ring + 4), disc)
    avatar.save(OUT / "teacher-portrait.jpg", "JPEG", quality=88, optimize=True, progressive=True)
    return square


# --- 3. Standing photo -----------------------------------------------------------

# 4:5, head to knee. Pushed left of centre to keep the painting on the right-
# hand wall out of the frame; the arch's rounded top trims the wall ornament.
STANDING_BOX = (52, 55, 588, 725)


def build_standing():
    src = Image.open(SRC / "photos" / "teacher-source.jpg").convert("RGB")
    box = (STANDING_BOX[0], STANDING_BOX[1], STANDING_BOX[2], min(STANDING_BOX[3], src.height))
    out = src.crop(box)
    for w in (720, 400):
        h = round(w * out.height / out.width)
        out.resize((w, h), Image.LANCZOS).save(
            OUT / f"teacher-standing-{w}.webp", "WEBP", quality=86, method=6
        )
    return out


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    m = build_mark()
    print("mark     :", m.size, "->", [f.name for f in sorted(OUT.glob("mark-*"))])
    p = build_portrait()
    print("portrait :", p.size, "->", [f.name for f in sorted(OUT.glob("teacher-portrait*"))])
    s = build_standing()
    print("standing :", s.size, "->", [f.name for f in sorted(OUT.glob("teacher-standing*"))])
