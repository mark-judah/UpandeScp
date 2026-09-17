"""Split docs/design/icons.png into per-crop icon files, three tints each."""
import collections
from PIL import Image

SRC = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/docs/design/icons.png"
OUT = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/docs/design/icons"

# tile position in the 2x2 sheet -> crop key + accent
TILES = [
    ((0, 0), "coffee", (0x6f, 0x4a, 0x2f)),
    ((1, 0), "rose", (0xa3, 0x3a, 0x5b)),
    ((0, 1), "avocado", (0x5f, 0x7d, 0x33)),
    ((1, 1), "vegetables", (0xb4, 0x53, 0x1f)),
]
PAPER = (0xf4, 0xf3, 0xef)
INK = (0x16, 0x15, 0x14)

INSET = 10         # drop the tile seam before measuring anything


def background(tile):
    """Modal colour of the tile's outer frame."""
    w, h = tile.size
    band = 6
    px = tile.load()
    seen = collections.Counter()
    for y in range(h):
        for x in range(w):
            if x < band or y < band or x >= w - band or y >= h - band:
                seen[px[x, y]] += 1
    return seen.most_common(1)[0][0]


def otsu(hist):
    """Split a 256-bin histogram where the two sides are furthest apart."""
    total = sum(hist)
    sum_all = sum(i * n for i, n in enumerate(hist))
    run = wb = 0.0
    best, cut = -1.0, 1
    for t in range(256):
        wb += hist[t]
        if not wb:
            continue
        wf = total - wb
        if not wf:
            break
        run += t * hist[t]
        between = wb * wf * ((run / wb) - ((sum_all - run) / wf)) ** 2
        if between > best:
            best, cut = between, t
    return cut


def alpha_mask(tile):
    """Alpha = how far each pixel sits from the tile's background colour."""
    w, h = tile.size
    px = tile.load()
    bg = background(tile)
    dist = []
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            dist.append(max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])))
    hist = [0] * 256
    for d in dist:
        hist[d] += 1
    cut = max(otsu(hist), 6)
    lo = cut // 2                       # ramp below the cut keeps edges smooth
    span = max(cut - lo, 1)
    mask = Image.new("L", (w, h))
    mask.putdata([min(255, max(0, (d - lo) * 255 // span)) for d in dist])
    drawn = sum(1 for d in dist if d >= cut)
    return mask, bg, drawn * 100.0 / len(dist)


def trim(mask, pad_frac=0.08):
    box = mask.point(lambda v: 255 if v > 96 else 0).getbbox()
    if not box:
        return mask
    l, t, r, b = box
    side = max(r - l, b - t)
    side += int(side * pad_frac) * 2
    cx, cy = (l + r) // 2, (t + b) // 2
    return mask.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))


def tint(mask, colour, size):
    m = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), colour + (0,))
    out.putalpha(m)
    return out


strips = {"light": [], "accent": [], "ink": []}
sheet = Image.open(SRC).convert("RGB")
W, H = sheet.size
for (cx, cy), name, accent in TILES:
    tile = sheet.crop((cx * W // 2 + INSET, cy * H // 2 + INSET,
                       (cx + 1) * W // 2 - INSET, (cy + 1) * H // 2 - INSET))
    mask, bg, pct = alpha_mask(tile)
    mask = trim(mask)
    print(f"{name}: bg={bg} drawn={pct:.1f}% box={mask.size}")
    for tone, colour in (("light", PAPER), ("accent", accent), ("ink", INK)):
        for size, suffix in ((512, ""), (96, "-96")):
            img = tint(mask, colour, size)
            img.save(f"{OUT}/{name}-{tone}{suffix}.png")
        strips[tone].append(tint(mask, colour, 120))

for tone, imgs in strips.items():
    ground = INK if tone == "light" else PAPER
    strip = Image.new("RGB", (len(imgs) * 140, 140), ground)
    for i, img in enumerate(imgs):
        strip.paste(img, (i * 140 + 10, 10), img)
    strip.save(f"/tmp/icon-check-{tone}.png")
print("ok")
