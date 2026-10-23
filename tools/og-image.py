#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────
# The picture a link to memdesk.app shows
#
#   pip install pillow numpy && python tools/og-image.py
#
# Writes images/og-image.jpg, the og:image and twitter:image of every
# page on the website: what WhatsApp, LinkedIn, Slack, iMessage and X
# show when someone pastes a link to it. Without a picture of the right
# shape they stretch the 192-pixel icon, which looks blurred.
#
# It is the logo alone, large, on the landing page's violet. WhatsApp's
# small preview is the middle square of the picture shrunk to about 115
# pixels and saved as a rough JPEG: the first version, the top of the
# landing page made smaller, came out as a small logo and words too
# small to read. The apps print the page's title beside the picture, so
# the name is there anyway. Run this again when the icon changes
# (icons/icon-512.png, from tools/make-icons.mjs).
#
# Two rules from the apps that show it:
# - 1200 × 630 (1.91 : 1), the size they all ask for;
# - under 300 KB, above which WhatsApp shows no picture at all.
# This script stops rather than write a picture that breaks one of them.
# tools/build-site.mjs puts the picture on the site as img/og-image.jpg.
# ─────────────────────────────────────────────────────────────────────
import io
import os
import numpy as np
from PIL import Image

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(REPO, 'images', 'og-image.jpg')
ICON = os.path.join(REPO, 'icons', 'icon-512.png')

W, H = 1200, 630
MARK = 500         # the icon's box; its circle is 7/8 of it, 437 pixels
MAX_BYTES = 300_000
S = 2  # the background is worked out at twice the size and then reduced


def background(w, h, s):
    """The page's .hero: two soft glows over a violet diagonal, and its dots.
    Worked out the way a browser draws the CSS, with sizes in CSS pixels
    (times s)."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float64) + 0.5
    # linear-gradient(135deg, #2e1065 0%, #4c1d95 45%, #6d28d9 100%)
    t = ((x - w / 2) + (y - h / 2)) / (w + h) + 0.5
    stops = [0, .45, 1]
    colours = [(0x2e, 0x10, 0x65), (0x4c, 0x1d, 0x95), (0x6d, 0x28, 0xd9)]
    rgb = np.stack([np.interp(t, stops, [c[i] for c in colours]) for i in range(3)], axis=-1)
    # radial-gradient(RX RY at X Y, rgba(colour, .45), transparent 60%),
    # the lower one listed last, so drawn first.
    for rx, ry, cx, cy, colour in [(900, 600, 0, 1.10, (99, 102, 241)), (1200, 500, .85, -.10, (196, 181, 253))]:
        d = np.hypot((x - cx * w) / (rx * s), (y - cy * h) / (ry * s))
        a = (0.45 * np.clip(1 - d / 0.6, 0, 1))[..., None]
        rgb = rgb * (1 - a) + np.array(colour) * a
    # .hero::before: a white dot every 22 pixels, solid to 1 px and gone by
    # 1.4, at .9 and then the layer's .18.
    r = np.hypot((x / s) % 22 - 11, (y / s) % 22 - 11)
    a = (0.18 * 0.9 * np.clip((1.4 - r) / 0.4, 0, 1))[..., None]
    rgb = rgb * (1 - a) + 255 * a
    return Image.fromarray(np.round(rgb).astype(np.uint8), 'RGB')


def draw():
    img = background(W * S, H * S, S).resize((W, H), Image.LANCZOS)
    # The logo in the middle, at its full sharpness: the 512-pixel icon
    # made smaller, never larger.
    icon = Image.open(ICON).convert('RGBA')
    if MARK > icon.width:
        raise SystemExit(f'og-image: the logo would be larger than {os.path.basename(ICON)}')
    logo = icon.resize((MARK, MARK), Image.LANCZOS)
    img.paste(logo, ((W - MARK) // 2, (H - MARK) // 2), logo)
    return img


img = draw()
# 4:4:4, so that white on violet keeps its edges. Made in memory first, so
# that a picture too large never replaces the one there is.
jpeg = io.BytesIO()
img.save(jpeg, 'JPEG', quality=88, subsampling=0, optimize=True)
size = jpeg.tell()
if size >= MAX_BYTES:
    raise SystemExit(f'og-image: {size:,} bytes, over the {MAX_BYTES:,} WhatsApp takes; nothing written')
with open(OUT, 'wb') as f:
    f.write(jpeg.getvalue())
print(f'Wrote {os.path.relpath(OUT, REPO)}: {img.width} x {img.height}, {size:,} bytes')
