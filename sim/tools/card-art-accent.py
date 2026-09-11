#!/usr/bin/env python3
# =============================================================================
# CARD ART ACCENT — regenerates card-art-accent.js from audio/cards/art/
# =============================================================================
#   python3 sim/tools/card-art-accent.py          # rewrite card-art-accent.js
#   python3 sim/tools/card-art-accent.py --sheet  # + a side-by-side proof sheet
#
# Run this after adding or replacing card art. Needs Pillow.
#
# THE BORDER IS A NEON LINE ON BLACK, NOT A SWATCH OF THE PAINTING. Only the
# HUE comes from the art; saturation and lightness are set to what the Tron
# line-work needs, because a painting's own average colour is muddy by
# construction and a muddy line on black reads as dirt.
# =============================================================================
import os, sys, math, colorsys
from PIL import Image

ART = 'audio/cards/art'
OUT = 'card-art-accent.js'
NEUTRAL = (150, 170, 190)

def accent_for(path):
    im = Image.open(path).convert('RGB')
    im.thumbnail((96, 96))
    px = list(im.getdata())
    # Histogram over HUE, weighted by how much CHROMA that pixel actually carries.
    # Weighting by saturation alone lets a handful of screaming pixels in a dark
    # painting win; weighting by saturation * a value window keeps the vote with
    # the colours a viewer actually reads as "the colour of this picture".
    BINS = 36
    hist = [0.0] * BINS
    satsum = [0.0] * BINS
    valsum = [0.0] * BINS
    chroma_total = 0.0
    for (r, g, b) in px:
        h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        # ignore near-black and blown-out white: they carry no hue you can trust
        if v < 0.14 or s < 0.12:
            continue
        # a mid-value pixel is the most honest report of a hue; deep shadow and
        # specular highlight both lie about it
        window = 1.0 - abs(v - 0.62) * 1.25
        if window <= 0:
            continue
        w = s * window
        i = int(h * BINS) % BINS
        hist[i] += w
        satsum[i] += s * w
        valsum[i] += v * w
        chroma_total += w
    # HOW MUCH COLOUR IS ACTUALLY IN THIS PAINTING. Peak-share is the wrong
    # test for "is this art colourful": a black-and-white photo with a faint
    # warm cast has ONE hue, so its peak share is near 1.0 and it looks
    # supremely confident while carrying almost no colour at all. That is how
    # Art the Clown — a monochrome film still — got a confident orange border.
    # The honest question is what FRACTION of the picture carried chroma.
    chroma_frac = chroma_total / max(1, len(px))
    if chroma_total <= 0:
        return None, 0.0             # nothing but black and white
    # smooth across neighbouring bins so a hue straddling a boundary is not split
    sm = [hist[(i - 1) % BINS] * 0.5 + hist[i] + hist[(i + 1) % BINS] * 0.5 for i in range(BINS)]
    best = max(range(BINS), key=lambda i: sm[i])
    # sub-bin the peak using its neighbours, so 260 cards do not land on 36 hues
    a, b_, c = sm[(best - 1) % BINS], sm[best], sm[(best + 1) % BINS]
    denom = (a - 2 * b_ + c)
    off = 0.0 if denom == 0 else 0.5 * (a - c) / denom
    off = max(-0.5, min(0.5, off))
    hue = ((best + 0.5 + off) / BINS) % 1.0
    # how much of the picture actually agreed
    confidence = sm[best] / (sum(sm) or 1)
    return hue, chroma_frac

def neon(hue, chroma_frac=1.0):
    # The border is a NEON LINE ON BLACK, not a swatch of the painting. A
    # painting's own average is muddy by construction (it is an average), and a
    # muddy line on black reads as dirt. So the hue is the only thing taken from
    # the art; saturation and lightness are set to what the Tron line-work needs.
    #
    # Lightness is nudged by hue because equal L is not equal BRIGHTNESS: yellow
    # and cyan at L .62 glare, blue and violet at the same L go muddy against
    # black. This is a cheap luma correction, not a colour-science one.
    import math
    l = 0.62
    l -= 0.06 * math.cos((hue - 0.16) * 2 * math.pi)     # pull yellows down
    l += 0.05 * math.cos((hue - 0.70) * 2 * math.pi)     # lift blues/violets
    # SATURATION FOLLOWS HOW MUCH COLOUR THE ART ACTUALLY HAS, rather than a
    # cliff at some threshold. A vivid painting gets a vivid line; a moody,
    # nearly-grey one gets a muted tint OF ITS OWN HUE; a true black-and-white
    # still gets steel. Without this, monochrome art was handed a confident
    # neon — Art the Clown, a black-and-white film still, came out orange,
    # because one faint warm cast is still a 100% share of no colour at all.
    t = (chroma_frac - 0.02) / (0.14 - 0.02)
    t = max(0.0, min(1.0, t))
    sat = 0.12 + t * (0.86 - 0.12)
    if sat < 0.20:
        l = 0.70                     # steel reads better bright than mid
    r, g, b = colorsys.hls_to_rgb(hue, max(0.46, min(0.74, l)), sat)
    return (round(r * 255), round(g * 255), round(b * 255))


def rows():
    out, mono = [], 0
    # card-back.png is the back of every card, not any card's painting.
    files = sorted(f for f in os.listdir(ART)
                   if f.lower().endswith(('.png', '.jpg', '.jpeg')) and f != 'card-back.png')
    for f in files:
        try:
            hue, chroma = accent_for(os.path.join(ART, f))
        except Exception as e:
            print('  !! %s: %s' % (f, e)); continue
        out.append((f, NEUTRAL if hue is None else neon(hue, chroma)))
        if hue is None: mono += 1
    return out, mono


def write(rs, mono):
    L = []
    A = L.append
    A('// =============================================================================')
    A('// CARD ART ACCENT — GENERATED FILE, DO NOT HAND-EDIT')
    A('// =============================================================================')
    A('// One border colour per art file, taken from the painting itself. Replaces the')
    A('// four hard-coded cost tiers (1-3 green / 4-6 blue / 7-8 white / 9-10 gold),')
    A('// which gave the whole set of %d paintings exactly four borders.' % len(rs))
    A('// Owner: "get rid of the rarity neon highlights ... i want each card to have a')
    A('// border that compliments their card art."')
    A('//')
    A('// Regenerate with:  python3 sim/tools/card-art-accent.py')
    A('// The derivation, and why each step is there, is documented in that script.')
    A('//')
    A('// %d files, %d of them monochrome (steel %d,%d,%d).' % (len(rs), mono, NEUTRAL[0], NEUTRAL[1], NEUTRAL[2]))
    A('// Keyed by FILE, not by card name, so an art VARIANT gets its own border.')
    A('window.CARD_ART_ACCENT = {')
    for f, (r, g, b) in rs:
        A("  '%s': '%d,%d,%d'," % (f.replace('\\', '\\\\').replace("'", "\\'"), r, g, b))
    A('};')
    A('')
    open(OUT, 'w').write('\n'.join(L))
    print('wrote %s — %d files, %d monochrome' % (OUT, len(rs), mono))


def sheet(rs):
    """PROVE IT SIDE BY SIDE. Draws each painting with its proposed border
    around it, which is the only way to judge whether a colour 'complements'
    art — a hex value in a list tells you nothing."""
    from PIL import ImageDraw
    import random
    random.seed(7)
    pick = random.sample(rs, min(40, len(rs)))
    COLS, TW, TH, PAD, B = 8, 150, 197, 14, 5
    rows_n = (len(pick) + COLS - 1) // COLS
    sh = Image.new('RGB', (COLS * (TW + PAD * 2), rows_n * (TH + PAD * 2 + 16)), (0, 0, 0))
    d = ImageDraw.Draw(sh)
    for i, (fn, col) in enumerate(pick):
        im = Image.open(os.path.join(ART, fn)).convert('RGB')
        tr, ir = TW / TH, im.width / im.height
        if ir > tr:
            nw = int(im.height * tr); im = im.crop(((im.width - nw) // 2, 0, (im.width + nw) // 2, im.height))
        else:
            im = im.crop((0, 0, im.width, int(im.width / tr)))
        im = im.resize((TW, TH), Image.LANCZOS)
        cx = (i % COLS) * (TW + PAD * 2) + PAD
        cy = (i // COLS) * (TH + PAD * 2 + 16) + PAD
        sh.paste(im, (cx, cy))
        for b in range(B):
            d.rectangle([cx - 1 - b, cy - 1 - b, cx + TW + b, cy + TH + b], outline=col)
        d.text((cx, cy + TH + 4), fn.rsplit('.', 1)[0][:22], fill=(190, 200, 210))
    sh.save('card-art-accent-sheet.png')
    print('wrote card-art-accent-sheet.png')


if __name__ == '__main__':
    rs, mono = rows()
    write(rs, mono)
    if '--sheet' in sys.argv:
        sheet(rs)
