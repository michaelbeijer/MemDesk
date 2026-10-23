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
# It is the top of the landing page, made smaller: the logo and the name,
# the heading, and the hero picture below them on the same violet. The
# name is APP_NAME and the words are the page's own heading (LINES, held
# to it), so run this again when the icon, the hero picture, the heading
# or the name changes.
#
# Three rules from the apps that show it:
# - 1200 × 630 (1.91 : 1), the size they all ask for;
# - everything that matters inside the middle 630 × 630, because WhatsApp
#   and some others sometimes show only that square;
# - under 300 KB, above which WhatsApp shows no picture at all.
# This script stops rather than write a picture that breaks one of them.
#
# Needs the Roboto fonts, which the website names first. Windows has them
# in C:\Windows\Fonts. tools/build-site.mjs puts the picture on the site
# as img/og-image.jpg.
# ─────────────────────────────────────────────────────────────────────
import io
import os
import re
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(REPO, 'images', 'og-image.jpg')
HERO = os.path.join(REPO, 'images', 'hero.jpg')
ICON = os.path.join(REPO, 'icons', 'icon-192.png')
PAGE = os.path.join(REPO, 'site', 'index.html')
NS = os.path.join(REPO, 'src', 'shared', 'ns.js')
FONTS = 'C:/Windows/Fonts'

W, H = 1200, 630
SQUARE = ((W - H) // 2 + 24, (W + H) // 2 - 24)  # the middle square, less a margin
MAX_BYTES = 300_000
S = 2  # drawn at twice the size and then reduced, for smooth edges

# The landing page's heading (its <h1>), where it reads best broken in two.
LINES = ['Your board, your notes', 'and your week, inside Gmail.']

# The landing page's .brand (a 34-pixel icon, a gap of 10, the name at 22,
# Roboto Medium) at BRAND times the size; the heading under it in
# Roboto Regular, the colour of the page's .intro p.
BRAND = 3.4
TAGLINE = 40
TAGLINE_COLOUR = (0xed, 0xe9, 0xfe)
TOP = 52           # above the logo
TAGLINE_GAP = 26   # from the logo to the first line's capitals
LINE_GAP = 52      # from one baseline to the next
SHOT_TOP = 340     # where the hero picture starts; it runs off the bottom
SHOT_WIDTH = 1000  # 1040 of the page's 1120 on the site; a little less here


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def found(pattern, path, what):
    with open(path, encoding='utf-8') as f:
        m = re.search(pattern, f.read())
    if not m:
        raise SystemExit(f'og-image: no {what} in {os.path.relpath(path, REPO)}')
    return m.group(1)


def heading_lines():
    """The landing page's heading, in the two lines LINES breaks it into."""
    heading = found(r'<h1>([^<]+)</h1>', PAGE, 'heading')
    if ' '.join(LINES) != ' '.join(heading.split()):
        raise SystemExit(f'og-image: the page\'s heading is now "{heading}": say in LINES where it breaks')
    return LINES


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


def rounded(size, box, radius):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask


def layer(base, colour, mask, opacity):
    base.paste(Image.new('RGB', base.size, colour), (0, 0), mask.point(lambda v: round(v * opacity)))


def draw():
    w, h = W * S, H * S
    img = background(w, h, S)

    # The hero picture as the page shows it (.shot img): rounded corners,
    # a deep soft shadow, a faint light edge.
    hero = Image.open(HERO).convert('RGB')
    sw = SHOT_WIDTH * S
    sh = round(hero.height * sw / hero.width)
    hero = hero.resize((sw, sh), Image.LANCZOS)
    x0, y0 = (w - sw) // 2, SHOT_TOP * S
    radius = round(16 * SHOT_WIDTH / 1040) * S
    box = (x0, y0, x0 + sw - 1, y0 + sh - 1)
    # box-shadow: 0 24px 60px rgba(20, 6, 50, .45) - a 60-pixel blur is a
    # Gaussian of 30.
    shadow = rounded((w, h), (box[0], box[1] + 24 * S, box[2], box[3] + 24 * S), radius)
    layer(img, (20, 6, 50), shadow.filter(ImageFilter.GaussianBlur(30 * S)), .45)
    # 0 0 0 1px rgba(255, 255, 255, .12)
    layer(img, (255, 255, 255), rounded((w, h), (box[0] - S, box[1] - S, box[2] + S, box[3] + S), radius + S), .12)
    img.paste(hero, (x0, y0), rounded((w, h), (0, 0, sw - 1, sh - 1), radius).crop((0, 0, sw, sh)))

    # The name beside the logo, its capitals centred on it as on the page.
    name = found(r"APP_NAME = '([^']+)'", NS, 'APP_NAME')
    pen = ImageDraw.Draw(img)
    icon = round(34 * BRAND)
    gap = round(10 * BRAND)
    name_font = font('Roboto-Medium.ttf', round(22 * BRAND) * S)
    name_width = name_font.getlength(name) / S
    left = round((W - (icon + gap + name_width)) / 2)
    cap = name_font.getbbox('M')
    cap_height = (cap[3] - cap[1]) / S
    middle = TOP + icon / 2
    pen.text(((left + icon + gap) * S, (middle + cap_height / 2) * S), name, font=name_font, fill=(255, 255, 255), anchor='ls')
    edges = [left, left + icon + gap + name_width]

    tag_font = font('Roboto-Regular.ttf', TAGLINE * S)
    tag_cap = (tag_font.getbbox('M')[3] - tag_font.getbbox('M')[1]) / S
    baseline = TOP + icon + TAGLINE_GAP + tag_cap
    for line in heading_lines():
        pen.text((W / 2 * S, baseline * S), line, font=tag_font, fill=TAGLINE_COLOUR, anchor='ms')
        width = tag_font.getlength(line) / S
        edges += [(W - width) / 2, (W + width) / 2]
        baseline += LINE_GAP
    if baseline - LINE_GAP + 12 > SHOT_TOP:
        raise SystemExit('og-image: the words run into the picture below them')
    if min(edges) < SQUARE[0] or max(edges) > SQUARE[1]:
        raise SystemExit(f'og-image: the words reach {min(edges):.0f} to {max(edges):.0f}, outside the middle square {SQUARE}')

    img = img.resize((W, H), Image.LANCZOS)

    # The logo last, at its full sharpness: the 192-pixel icon made smaller,
    # never larger.
    if icon > 192:
        raise SystemExit('og-image: the logo would be larger than icon-192.png')
    logo = Image.open(ICON).convert('RGBA').resize((icon, icon), Image.LANCZOS)
    img.paste(logo, (left, TOP), logo)
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
