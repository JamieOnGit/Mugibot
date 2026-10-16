# Makes every logo and icon from the logo (brand/logo-original.webp): the site's header logo,
# favicons, the home-screen icon, the notification icon and the extension's icons.
# Run after changing the logo:  python3 scripts/make-icons.py
#
# The logo's white background is cut away (only the white touching the edges, so the robot's
# white face stays), with "white to transparent" on the soft edge so it looks right on the
# dark theme too. Needs Pillow (pip install pillow); the site itself needs nothing extra.

import os
import sys
from collections import deque
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'brand', 'logo-original.webp')


def cut(path):
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    px = im.load()
    white = lambda c: c[0] > 228 and c[1] > 228 and c[2] > 228
    bg = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white(px[x, y]) and not bg[y * w + x]:
                bg[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if white(px[x, y]) and not bg[y * w + x]:
                bg[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and white(px[nx, ny]):
                bg[ny * w + nx] = 1
                q.append((nx, ny))
    mask = Image.frombytes('L', (w, h), bytes(255 if b else 0 for b in bg))
    band = mask.filter(ImageFilter.MaxFilter(5)).load()
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            if mp[x, y]:
                px[x, y] = (255, 255, 255, 0)
            elif band[x, y]:
                r, g, b, _ = px[x, y]
                a = max(255 - r, 255 - g, 255 - b) / 255
                if a <= 0:
                    px[x, y] = (255, 255, 255, 0)
                else:
                    un = lambda c: max(0, min(255, round((c - 255 * (1 - a)) / a)))
                    px[x, y] = (un(r), un(g), un(b), round(a * 255))
    im = im.crop(im.getbbox())
    side = max(im.size)
    pad = round(side * 0.04)
    sq = Image.new('RGBA', (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
    sq.paste(im, ((side - im.size[0]) // 2 + pad, (side - im.size[1]) // 2 + pad), im)
    return sq


def save(im, size, *where, background=None):
    out = im.resize((size, size), Image.LANCZOS)
    if background:
        tile = Image.new('RGBA', out.size, background)
        tile.alpha_composite(out)
        out = tile.convert('RGB')
    path = os.path.join(ROOT, *where)
    out.save(path, optimize=True)
    print(f'{size:>4}px  {os.path.relpath(path, ROOT)}')


logo = cut(SRC)
save(logo, 512, 'web', 'img', 'logo-512.png')        # large uses (sharing, Discord app icon)
save(logo, 128, 'web', 'img', 'logo.png')            # the header logo on every page
save(logo, 192, 'web', 'img', 'icon-192.png')        # desktop notifications
save(logo, 64, 'web', 'img', 'favicon.png')          # the browser tab
save(logo, 180, 'web', 'img', 'apple-touch-icon.png', background=(255, 255, 255, 255))  # phones' home screens
logo.resize((48, 48), Image.LANCZOS).save(os.path.join(ROOT, 'web', 'img', 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)])
print('  ico  web/img/favicon.ico')
for size in (16, 48, 128):
    save(logo, size, 'extension', f'icon{size}.png')  # the extension (toolbar, extensions page, Web Store)
