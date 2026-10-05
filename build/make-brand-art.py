# Generates HydroRecon's app icon and NSIS installer art. Nothing in build/ is
# hand-edited: change this file and re-run it.
#
#   python build/make-brand-art.py          (from the repo root)
#
# Produces, all under build/:
#   icon.png              1024x1024 app icon (also the mac/linux source)
#   icon.ico              16, 32, 48, 64, 128, 256 — each size drawn at its own
#                         scale, not one 256 resampled, so the 16 px taskbar
#                         glyph keeps a whole-pixel stroke
#   installerSidebar.bmp  164x314, the Welcome/Finish page panel, built from
#                         art-src/valley.png (a 906x1735 dark topographic
#                         rendering, exactly 164:314, so it is downscaled and
#                         never cropped) with the wordmark over a faded foot
#   installerHeader.bmp   150x57, the strip on the interior pages
#
# The BMPs MUST be 24-bit RGB with no alpha channel or NSIS renders garbage —
# the script converts and then asserts the saved mode, because that is the
# single most common way this kind of art goes wrong.
#
# The mark: a longitudinal profile of a run-of-river scheme. An upper reach,
# the head drop, a lower reach — one stroke in the river accent on ink. It is
# the scheme the app draws for every click, reduced to the one thing that
# makes it worth building: the fall between two levels. Chosen over contour
# lines and a catchment outline because both dissolve at 16 px; a step reads
# at 2 px wide. No text, no gradient, no second colour.
#
# Colours are src/app.css's tokens — keep them in sync.
import os
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT = os.path.join(ROOT, "src", "assets", "fonts", "geist-sans.woff2")
VALLEY = os.path.join(HERE, "art-src", "valley.png")

INK = (14, 15, 17)        # --color-bg
PANEL_2 = (27, 30, 34)    # --color-panel-2, the chart-grid hairlines
LINE = (58, 63, 70)       # border / rule
FAINT = (109, 116, 124)   # --color-faint, the dimension line
MUTED = (154, 161, 169)   # --color-muted, captions
TEXT = (255, 255, 255)
RIVER = (79, 193, 216)    # --color-river, the only accent

# The profile in unit coordinates: upper reach, head drop, lower reach.
PROFILE = [(0.16, 0.37), (0.44, 0.37), (0.56, 0.65), (0.84, 0.65)]
STROKE = 0.115  # of the tile side


def geist(px, weight=500):
    f = ImageFont.truetype(FONT, px)
    f.set_variation_by_axes([weight])
    return f


def draw_profile(d, origin, scale, width, color, points=PROFILE):
    """One round-capped, round-joined stroke through the profile."""
    ox, oy = origin
    pts = [(ox + x * scale, oy + y * scale) for x, y in points]
    d.line(pts, fill=color, width=width, joint="curve")
    r = width / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def icon(size, ss=8):
    """Draw the icon at `size`, supersampled by `ss` and downsampled once."""
    S = size * ss
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    radius = S * 0.22
    border = max(1, round(size / 48)) * ss  # a hairline, like every border in the app
    # Tile: ink with a hairline border so it holds on a dark taskbar too.
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=LINE)
    d.rounded_rectangle(
        [border, border, S - 1 - border, S - 1 - border], radius=radius - border, fill=INK
    )
    # At 16 px the stroke is forced to exactly 2 device pixels; below that it
    # anti-aliases into a grey smear and the step disappears.
    stroke = max(2 * ss, round(S * STROKE))
    draw_profile(d, (0, 0), S, stroke, RIVER)
    return im.resize((size, size), Image.LANCZOS)


def tracked(d, xy, text, font, fill, tracking):
    """Pillow has no letter-spacing; lay the glyphs by hand."""
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + tracking
    return x - tracking


def tracked_width(d, text, font, tracking):
    return sum(d.textlength(ch, font=font) for ch in text) + tracking * (len(text) - 1)


def sidebar():
    """The valley, with the wordmark set into its foot.

    The first version drew the profile stroke over a ruled grid: one bold mark
    in the top third, a black void through the middle, type at the bottom. It
    read as unfinished. The replacement is a rendered Himalayan valley — grey
    ridges and contours on ink with one teal river threading top to bottom —
    which carries the scheme's whole argument (water falling through terrain)
    without a drawn mark competing with it. The river IS the accent; nothing
    else is coloured.
    """
    W, H = 164, 314
    with Image.open(VALLEY) as src:
        im = src.convert("RGB").resize((W, H), Image.LANCZOS)
    # A 5.5x LANCZOS downscale averages the contour hairlines into their
    # ground and flattens the tonal spread (luma stddev 16.9 -> 14.7). 1.15
    # restores the source's own contrast and no more, measured, not felt;
    # 1.3 hardens the ridges, and any brightness lift greys the black.
    im = ImageEnhance.Contrast(im).enhance(1.15)

    # Foot: the lower third fades into ink so the type sits on quiet ground.
    # The source already darkens from about 75% down; this extends that with a
    # smoothstep ramp from 0 at y0 to full ink at y1, so there is no band edge
    # and the river's bright run (which ends near y=210) stays above it.
    y0, y1 = 196, 292
    ramp = Image.new("L", (1, H), 0)
    px = ramp.load()
    for y in range(H):
        t = min(1.0, max(0.0, (y - y0) / (y1 - y0)))
        px[0, y] = round(255 * t * t * (3 - 2 * t))
    mask = ramp.resize((W, H), Image.NEAREST)
    im = Image.composite(Image.new("RGB", (W, H), INK), im, mask)

    # Wordmark over the foot: the same treatment as before, minus the rule,
    # which on terrain cut across the river's tail and anchored nothing.
    d = ImageDraw.Draw(im)
    d.text((16, 240), "HydroRecon", font=geist(20, 500), fill=TEXT)
    cap = geist(8, 500)
    tracked(d, (16, 272), "RUN-OF-RIVER", cap, MUTED, 1.0)
    tracked(d, (16, 284), "SCREENING · NEPAL", cap, MUTED, 1.0)
    return im.convert("RGB")


def header():
    W, H = 150, 57
    im = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(im)
    font = geist(15, 500)
    text = "HydroRecon"
    tw = d.textlength(text, font=font)
    glyph = 20
    gap = 8
    x0 = W - 14 - tw - gap - glyph
    # The bare profile stroke, no tile, as a glyph beside the wordmark.
    g = Image.new("RGBA", (glyph * 8, glyph * 8), (0, 0, 0, 0))
    draw_profile(ImageDraw.Draw(g), (0, 0), glyph * 8, round(glyph * 8 * STROKE), RIVER)
    g = g.resize((glyph, glyph), Image.LANCZOS)
    im.paste(g, (round(x0), (H - glyph) // 2), g)
    d.text((x0 + glyph + gap, H / 2), text, font=font, fill=TEXT, anchor="lm")
    return im.convert("RGB")


def main():
    os.chdir(HERE)
    big = icon(1024)
    big.save("icon.png")
    sizes = [16, 32, 48, 64, 128, 256]
    frames = [icon(s) for s in sizes]
    frames[-1].save(
        "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1]
    )
    sidebar().save("installerSidebar.bmp", "BMP")
    header().save("installerHeader.bmp", "BMP")

    # Done-checks. A wrong mode or size here is a broken installer later.
    with Image.open("icon.ico") as ico:
        got = sorted(ico.ico.sizes())
        assert got == [(s, s) for s in sizes], got
    for name, want in (("installerSidebar.bmp", (164, 314)), ("installerHeader.bmp", (150, 57))):
        with Image.open(name) as bmp:
            assert bmp.size == want, (name, bmp.size)
            assert bmp.mode == "RGB", (name, bmp.mode)
    with Image.open("icon.png") as png:
        assert png.size == (1024, 1024)
    print("icon.png 1024x1024 | icon.ico", sizes, "| installerSidebar.bmp 164x314 RGB | installerHeader.bmp 150x57 RGB")


if __name__ == "__main__":
    main()
