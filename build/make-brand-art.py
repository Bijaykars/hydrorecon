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
#   installerSidebar.bmp  164x314, the Welcome/Finish page panel
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
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONT = os.path.join(ROOT, "src", "assets", "fonts", "geist-sans.woff2")

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
    W, H = 164, 314
    ss = 4
    im = Image.new("RGB", (W * ss, H * ss), INK)
    d = ImageDraw.Draw(im)
    # Level hairlines, the grid every chart in the app sits on.
    for y in range(40, 206, 14):
        d.line([(0, y * ss), (W * ss, y * ss)], fill=PANEL_2, width=ss)
    # The profile, bleeding off both edges: the river continues past the scheme.
    scale = W * ss * 1.45
    ox = -(scale * PROFILE[0][0]) - 10 * ss
    oy = 96 * ss - scale * PROFILE[0][1]
    pts = [(ox + x * scale, oy + y * scale) for x, y in PROFILE]
    y_top, y_bot = pts[0][1], pts[-1][1]
    pts[0] = (-20 * ss, y_top)
    pts[-1] = (W * ss + 20 * ss, y_bot)
    d.line(pts, fill=RIVER, width=7 * ss, joint="curve")
    # The head, dimensioned: extension line from the upper reach, a vertical
    # dimension line with end ticks. The measurement is the product.
    xd = 128 * ss
    d.line([(pts[1][0] + 10 * ss, y_top), (xd + 6 * ss, y_top)], fill=LINE, width=ss)
    d.line([(xd, y_top), (xd, y_bot)], fill=FAINT, width=ss)
    for y in (y_top, y_bot):
        d.line([(xd - 4 * ss, y), (xd + 4 * ss, y)], fill=FAINT, width=ss)
    im = im.resize((W, H), Image.LANCZOS)

    d = ImageDraw.Draw(im)
    d.line([(16, 228), (W - 16, 228)], fill=LINE, width=1)
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
