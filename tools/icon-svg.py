#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────
# The icon's master drawing
#
#   pip install fonttools && python3 tools/icon-svg.py
#
# Writes icons/icon.svg: "Sm" in white on a violet circle - the same
# circle, gradient direction and letters (Arial Bold: a large S, a smaller
# m) as the Supervertaler icons, in a colour of its own. The letters are
# turned into paths here, from Liberation Sans Bold (Arial's shapes and
# metrics), so the icon looks the same everywhere without the font.
# tools/make-icons.mjs then renders it to the PNGs.
# ─────────────────────────────────────────────────────────────────────
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

FONT = os.environ.get('ICON_FONT', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons', 'icon.svg')
DARK, LIGHT = '#6D28D9', '#9F67FA'   # the gradient, top left to bottom right
RUNS = [('S', 67.5, 0), ('m', 56, 1)]  # letter, size, baseline shift - as the Sv icon
CX, BASELINE, MAX_WIDTH = 64, 89, 82   # "Sm" is wider than "Sv": scaled to fit

font = TTFont(FONT)
glyphs, cmap, upm, hmtx = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm, font['hmtx']
num = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')

def layout(scale):
    x, items, lo, hi = 0, [], 1e9, -1e9
    for ch, size, dy in RUNS:
        name, k = cmap[ord(ch)], size * scale / upm
        bounds = BoundsPen(glyphs); glyphs[name].draw(bounds)
        lo, hi = min(lo, x + bounds.bounds[0] * k), max(hi, x + bounds.bounds[2] * k)
        items.append((name, k, x, dy * scale))
        x += hmtx[name][0] * k
    return items, lo, hi

items, lo, hi = layout(1)
if hi - lo > MAX_WIDTH:
    items, lo, hi = layout(MAX_WIDTH / (hi - lo))
shift = CX - (lo + hi) / 2  # centre the ink, not the advance widths
d = []
for name, k, x, dy in items:
    pen = SVGPathPen(glyphs, ntos=num)
    glyphs[name].draw(TransformPen(pen, (k, 0, 0, -k, x + shift, BASELINE + dy)))
    d.append(pen.getCommands())

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="sm" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{DARK}"/>
      <stop offset="1" stop-color="{LIGHT}"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="56" fill="url(#sm)"/>
  <path fill="#fff" d="{' '.join(d)}"/>
</svg>
'''
with open(OUT, 'w') as f:
    f.write(svg)
print(f'Wrote {os.path.relpath(OUT)} ({len(svg)} bytes)')
