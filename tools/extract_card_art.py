#!/usr/bin/env python3
"""
Extract card portraits from the V2 Photoshop card-template PSDs.

The original PSDs were built as printable game cards — full layout
(painted artwork + character title + cost diamond + stats panel +
text panel) all in one file. The in-game card already renders the
title, cost, stats, and ability text from cards.js, so all we want
out of each PSD is the PAINTED ARTWORK alone.

Pipeline:
  1. Open each PSD with psd-tools.
  2. Hide every TypeLayer (rasterizes vector text out of the
     composite). Note: some titles in the V2 set were flattened
     into PixelLayers years ago and can't be hidden by type alone —
     ART_BOX_NO_TITLE crops below the deepest observed title bottom
     to skip those too.
  3. Composite the visible layers into a flat PIL image.
  4. Crop to the artwork region (constants below — measured from
     the V2 template once and verified to match every PSD in the set).
  5. Resize to a game-ready 360px-wide PNG (cards render small;
     360px gives 3× retina headroom plus a buffer for hover-magnify).
  6. Save into audio/cards/art/<exact-card-name>.png — the JS in
     ui.js looks up portraits by exact card name.

Re-run this script whenever PSDs are added/edited. To add a new
character, drop the PSD in SRC_DIR and add an entry to PSD_TO_CARD
mapping its filename to the in-game card name (must match cards.js).
"""

from psd_tools import PSDImage
from PIL import Image
import os
import re

# ---------- CONFIG ----------
SRC_DIR = '/Users/henrytagleiv/Desktop/Marvel Game V2'
OUT_DIR = '/Users/henrytagleiv/The Game/audio/cards/art'

# Crop region inside the 825x1425 V2 template. We crop from y=80 (top
# of the painted artwork zone, just below the card-frame edge) down to
# y=1060 (above the text panel which starts at y=1070). The titles
# that lived in the upper portion of the original artwork are hidden
# layer-by-layer below (see hide_titles), so we don't need a y-inset
# to skip them — we get the FULL painted artwork from this crop.
ART_BOX_FULL = (40, 80, 788, 1060)

# Fallback crop for PSDs with no parseable layers (fully flattened).
# Skips the title text visually by starting at y=310 (below the
# deepest observed title bottom). Used for Grinch.psd, which has
# all chrome flattened into a single image.
ART_BOX_NO_TITLE = (40, 310, 788, 1060)

# Per-card crop overrides for flat PSDs whose figure head sits HIGHER
# than the y=310 default. Without an override, the head gets cut off
# at the top. Only flat PSDs use these — layered PSDs get the full
# ART_BOX_FULL crop with title hidden via layer manipulation.
# Map: in-game card name → (x1, y1, x2, y2) crop in original PSD coords.
CARD_CROP_OVERRIDES = {
    # Grinch's PSD has TWO baked title rasters — the obvious one at
    # the very top (y=140-180) AND a stylized "THE GRINCH" decorative
    # title halfway down the artwork (rows y=840-980 of the original
    # PSD, sitting between his feet and the stats panel). The previous
    # crop ended at y=1080 and included that second title, which read
    # as "the figure's name plate stamped on the painting" in the
    # codex. Tightening the bottom to y=820 cuts just above the second
    # title strip. The resulting 748×580 crop is wider than the 3:4
    # display box, so the alpha-padding step adds transparent rows top
    # + bottom to keep the figure centered inside the portrait frame.
    'The Grinch': (40, 240, 788, 820),
}

# Game-ready width (height auto-derived to preserve aspect ratio).
TARGET_W = 360

# PSD filename → in-game card name. The card name MUST match cards.js
# exactly (case, hyphens, periods, spaces). Add new entries here when
# new PSDs come in.
PSD_TO_CARD = {
    'Anti Venom.psd': 'Anti-Venom',
    'Batman 2 (1).psd': 'Batman',
    'Black Panther.psd': 'Black Panther',
    'Captain.psd': 'Captain America',
    'Darksied.psd': 'Darkseid',
    'Deadpool.psd': 'Deadpool',
    'Deathstroke.psd': 'Deathstroke',
    'Dormammu (1).psd': 'Dormammu',
    'Dr. Strange.psd': 'Dr. Strange',
    'Flash (1).psd': 'The Flash',
    'Gojo.psd': 'Gojo',
    'Gorr.psd': 'Gorr',
    'Green Lantern.psd': 'Green Lantern',
    'Grinch.psd': 'The Grinch',
    'Hulk.psd': 'Hulk',
    'Invisible Woman.psd': 'Invisible Woman',
    'Jigsaw.psd': 'Jigsaw',
    'Joker.psd': 'Joker',
    'Juggernaut.psd': 'Juggernaut',
    'Knull (1).psd': 'Knull',
    'Loki.psd': 'Loki',
    'Luke.psd': 'Luke Skywalker',
    'Optimus Prime.psd': 'Optimus Prime',
    'Peacemaker.psd': 'Peacemaker',
    'Poison Ivy.psd': 'Poison Ivy',
    'Prof X.psd': 'Professor X',
    'Red Hulk.psd': 'Red Hulk',
    'Scarlet  witch 2.psd': 'Scarlet Witch',  # double space in filename is intentional
    'Silver Surfer.psd': 'Silver Surfer',
    'Symbiote Spiderman.psd': 'Symbiote Spider-Man',
    'Thanos 2.psd': 'Thanos',
    'Thor.psd': 'Thor',
    'Venom (1).psd': 'Venom',
    'Winter Soilder.psd': 'Winter Soldier',  # typo in filename is intentional
    'ant man.psd': 'Ant-Man',
    'galactus (1).psd': 'Galactus',
    'gobbie.psd': 'Green Goblin',
    'groot.psd': 'Groot',
    # Added 2026-05-09 — second batch of PSDs dropped into the folder.
    'Superman.psd': 'Superman',
    'Wolverine.psd': 'Wolverine',
    'Jango.psd': 'Jango Fett',
    'Dr. Manhattan.psd': 'Dr. Manhattan',
    'Trigon.psd': 'Trigon',
    'Michael%20Myers.psd': 'Michael Myers',
    'Dr%20Doom.psd': 'Dr. Doom',
    # Added 2026-05-09 — third batch.
    'Darth Vader.psd': 'Darth Vader',
    'Scream (1).psd': 'Ghostface',  # "Scream" PSD → Ghostface in cards.js
    'Magneto.psd': 'Magneto',
    'Mahoraga%20%281%29.psd': 'Mahoraga',  # URL-encoded 'Mahoraga (1).psd'
    'Iron%20Mn.psd': 'Iron Man',  # filename typo "Iron Mn"
    'Homelander.psd': 'Homelander',
    'Spiderman.psd': 'Spider-Man',
    'Xeno 2.psd': 'Xenomorph',
    'Man Bat.psd': 'Man-Bat',
    # Added 2026-05-10 — fourth batch.
    'Bane.psd': 'Bane',
    'Black Widow.psd': 'Black Widow',
    'Gamora.psd': 'Gamora',
    'Jason.psd': 'Jason Voorhees',
    'Predator.psd': 'Predator',
    'Red Skull.psd': 'Red Skull',
    'Ritual.psd': 'Moder',  # PSD layer is ' Moder ' — file named after the spell
    'Star%20Lord.psd': 'Star-Lord',
    # Added 2026-05-10 — fifth batch.
    'Ahsoka 2.psd': 'Ahsoka',
    'Anakin Skywalker.psd': 'Anakin Skywalker',
    'Obi Wan.psd': 'Obi-Wan',  # filename has space, card name has hyphen
    'Ultron.psd': 'Ultron',
    # Added 2026-05-12 — sixth batch. User direction: "replace WW, Raven
    # and Harley with these new pictures" and "more card art to add."
    # Three of the entries below REPLACE earlier mappings whose source
    # filenames no longer exist in the V2 folder (the previous filenames
    # — 'Wonderwoman.psd', 'Harley%20Quinn%20%282%29.psd', 'Raven.psd' —
    # were dropped from the drop folder when the new art landed).
    'Wonder Woman.psd': 'Wonder Woman',
    'Harley Quinn.psd': 'Harley Quinn',
    'Raven WIP.psd':    'Raven',
    # New cards — first time these have art.
    'Batman Who Laughs.psd': 'The Batman Who Laughs',
    'Catwoman.psd':          'Catwoman',
    'Emperor pic.psd':       'Emperor Palpatine',
    'Hela WIP.psd':          'Hela',
    'Mr Freeze WIP.psd':     'Mr. Freeze',
    'The Thing.psd':         'The Thing',
}


def normalize_name(name):
    """Strip case + non-alphanumerics so 'Ant Man' / 'Ant-Man' / 'antman'
    all collapse to the same comparable key."""
    return re.sub(r'[^a-z0-9]', '', (name or '').lower())


def is_title_companion(layer):
    """Heuristic for the 'Layer 52' / 'Layer 15' decoration sitting
    behind the title (drop-shadow / glow / stroke). The original
    print-card template had each card-name title flanked by a
    companion layer at a similar bbox. We identify these by:
      • Generic 'Layer NN' / 'Layer NN copy' name (so we don't catch
        artwork layers like 'Layer 66' which extend down past 1000)
      • bbox fully contained in the upper 'title strip' (y2 ≤ 400)
    Artwork layers always extend down through the body of the card
    (y2 ≥ 800-1000), so the strip-containment guard prevents this
    from accidentally hiding the painted figure.
    """
    name = layer.name or ''
    if not re.match(r'^Layer\s+\d+(\s*copy(\s*\d+)?)?$', name, re.I):
        return False
    bbox = getattr(layer, 'bbox', None)
    if not bbox or bbox == (0, 0, 0, 0):
        return False
    _, y1, _, y2 = bbox
    return y1 >= 30 and y2 <= 400


def is_side_title_strip(layer):
    """Vertical title layer on the LEFT or RIGHT side of the card.
    Most V2 PSDs use a horizontal title bar at the top, but some
    cards (Mahoraga) use Japanese-stylized vertical titles down
    both sides instead. The vertical 'General' layer in Mahoraga's
    PSD is bbox=(62, 72, 196, 484) — narrow, tall, hugs the left
    edge, doesn't extend past mid-card. Detect by:
      • PixelLayer or SmartObjectLayer
      • Tall + narrow (height > width × 1.5, width < 250)
      • At the LEFT edge (x1 < 100) OR RIGHT edge (x2 > 725)
      • Doesn't extend past mid-card (y2 < 700) — full-height
        layers are artwork, not title decoration
    """
    cls = type(layer).__name__
    if cls not in ('PixelLayer', 'SmartObjectLayer'):
        return False
    bbox = getattr(layer, 'bbox', None)
    if not bbox or bbox == (0, 0, 0, 0):
        return False
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    if width >= 250 or height < width * 1.5:
        return False
    if not (x1 < 100 or x2 > 725):
        return False
    if y2 > 700:
        return False
    return True


def is_bottom_title_strip(layer):
    """Stylized name graphic baked into the BOTTOM portion of the
    artwork zone. Harley Quinn, Hela, and Raven all carry a wide
    PixelLayer (Layer 45 / Layer 43) painting the character's name
    in decorative type across the lower painted area:
      • Harley 'Layer 45': bbox=(78, 822, 746, 995)
      • Hela    'Layer 45': bbox=(182, 782, 642, 994)
      • Raven  'Layer 43': bbox=(126, 766, 699, 998)
    These don't match is_title_strip_layer (which only catches the
    UPPER title strip y2 ≤ 320) and they're not TypeLayers so the
    TypeLayer-hide pass also skips them. Detect by position +
    proportions:
      • PixelLayer or SmartObjectLayer
      • y1 in the lower-art band (700-860)
      • y2 just above the stats-panel chrome (940-1020)
      • Wider than 400 px (full-width title)
      • NOT the full-canvas background (height < ~280 — title strips
        are short; artwork layers like 'Layer 44' span 1000+ px tall
        and pass the y1 guard so we add this thinness check)
    """
    cls = type(layer).__name__
    if cls not in ('PixelLayer', 'SmartObjectLayer'):
        return False
    bbox = getattr(layer, 'bbox', None)
    if not bbox or bbox == (0, 0, 0, 0):
        return False
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    if not (700 <= y1 <= 860 and 940 <= y2 <= 1020):
        return False
    if width < 400:
        return False
    if height > 280:
        return False
    return True


def is_title_strip_layer(layer):
    """Belt-and-suspenders title detection — a layer that's fully
    contained in the upper title strip (y2 ≤ 320, wider than 400px).
    Catches title rasters where the layer name doesn't match the card
    name (e.g. Winter Soldier's PSD has 'Winter Soilder' — a typo
    that doesn't normalize-match the card name 'Winter Soldier').
    Now covers PixelLayer AND SmartObjectLayer (Wolverine's PSD has
    a SmartObject '_ (9) copy' as its title art). AdjustmentLayer
    and ShapeLayer are excluded — those are background chrome we
    want to KEEP (gradients, ellipses).
    """
    cls = type(layer).__name__
    if cls not in ('PixelLayer', 'SmartObjectLayer'):
        return False
    bbox = getattr(layer, 'bbox', None)
    if not bbox or bbox == (0, 0, 0, 0):
        return False
    x1, y1, x2, y2 = bbox
    # Must be fully contained in the upper title strip
    if not (y1 >= 30 and y2 <= 320):
        return False
    # Must span most of the card width — title lettering is wide
    width = x2 - x1
    if width < 400:
        return False
    return True


def hide_titles(layer, card_name_norm, file_name_norm):
    """Recursively hide all layers that carry the title (text + raster):
      1. Every TypeLayer  — vector text titles (Joker, Hulk style PSDs)
      2. Any layer whose normalized name matches the card name OR the
         PSD filename base — catches rasterized titles where the layer
         was given the character's name. Filename match catches typos:
         Winter Soldier's PSD layer is 'Winter Soilder' matching the
         filename 'Winter Soilder.psd'.
      3. Any wide PixelLayer fully inside the upper title strip —
         belt-and-suspenders for cases where neither name matches.
      4. Any 'Layer NN' contained in the upper title strip — catches
         the companion glow/stroke layer behind the title.
    The art layers (Layer 17 / Layer 37 / Layer 66 etc.) extend through
    the entire card height, so they pass the y2 ≤ 400 guard and stay
    visible.
    """
    try:
        for sub in layer:
            cls = type(sub).__name__
            sub_name_norm = normalize_name(sub.name)
            if cls == 'TypeLayer':
                sub.visible = False
            elif sub_name_norm and (sub_name_norm == card_name_norm or sub_name_norm == file_name_norm):
                sub.visible = False
            elif is_title_companion(sub):
                sub.visible = False
            elif is_title_strip_layer(sub):
                sub.visible = False
            elif is_side_title_strip(sub):
                sub.visible = False
            elif is_bottom_title_strip(sub):
                sub.visible = False
            hide_titles(sub, card_name_norm, file_name_norm)
    except (TypeError, AttributeError):
        pass


def render_card_art(src_path, dest_path, card_name, target_w=TARGET_W):
    """Open a PSD, render its visible composite, crop, scale, save.

    For PSDs that have at least one parseable layer, hide the title
    + chrome and crop with the FULL art box (y=80 → y=1060). For
    flattened PSDs with zero parseable layers (Grinch.psd is the
    one observed in the V2 set), fall back to the safe-inset crop
    (y=310 → y=1060) which skips the title text baked into the
    raster image at the top of the card. Then for any output that
    doesn't match the target 3:4 aspect (the box's display ratio),
    pad with transparent pixels so the painting always shows IN
    FULL via background-size:cover instead of getting cropped on
    the long axis.
    """
    psd = PSDImage.open(src_path)
    file_base = os.path.splitext(os.path.basename(src_path))[0]
    # Strip trailing variant tags from the filename for matching:
    # 'Batman 2 (1)' → 'Batman 2', 'Knull (1)' → 'Knull'.
    file_base_clean = re.sub(r'\s*\(\s*\d+\s*\)\s*', '', file_base).strip()
    file_name_norm = normalize_name(file_base_clean)
    # Empty PSD (flattened to a single composite, no parseable layers) →
    # we can't hide the title via layer manipulation. Use the safe
    # inset crop that skips the title visually.
    has_layers = any(True for _ in psd)
    if has_layers:
        hide_titles(psd, normalize_name(card_name), file_name_norm)
        composite = psd.composite()
        art = composite.crop(ART_BOX_FULL)
    else:
        composite = psd.composite()
        # Per-card override for flat PSDs where the default y=310
        # inset clips important detail (e.g. The Grinch's head).
        crop_box = CARD_CROP_OVERRIDES.get(card_name, ART_BOX_NO_TITLE)
        art = composite.crop(crop_box)
        # Flat-PSD crops are square-ish (748×750) which gets side-
        # cropped when displayed in the 3:4 portrait box. Pad to 3:4
        # with transparent pixels so the figure shows in full and the
        # dark card body bleeds through where the padding sits. RGBA
        # mode is required for transparency — convert if RGB.
        target_aspect = 360 / 472  # box's display aspect (≈ 0.7627)
        cur_w, cur_h = art.size
        cur_aspect = cur_w / cur_h
        if cur_aspect > target_aspect + 0.02:
            # Image is too wide — add transparent rows top + bottom
            # to make it taller, hitting target aspect. Centered so
            # the figure stays in the middle of the final box.
            target_h = int(round(cur_w / target_aspect))
            pad_total = target_h - cur_h
            pad_top = pad_total // 2
            pad_bottom = pad_total - pad_top
            if art.mode != 'RGBA':
                art = art.convert('RGBA')
            padded = Image.new('RGBA', (cur_w, target_h), (0, 0, 0, 0))
            padded.paste(art, (0, pad_top))
            art = padded
    if art.size[0] != target_w:
        target_h = int(round(art.size[1] * target_w / art.size[0]))
        art = art.resize((target_w, target_h), Image.LANCZOS)
    # Strip alpha if the result is RGBA — JPEG-style flatten on black
    # would lose the painted background. We save PNG so RGBA is fine,
    # but make sure we have a consistent mode.
    if art.mode not in ('RGB', 'RGBA'):
        art = art.convert('RGB')
    art.save(dest_path)
    return art.size


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    ok, missing, fail = 0, 0, 0
    for psd_name, card_name in PSD_TO_CARD.items():
        src = os.path.join(SRC_DIR, psd_name)
        dest = os.path.join(OUT_DIR, f'{card_name}.png')
        if not os.path.exists(src):
            print(f'  MISSING SRC  {psd_name}')
            missing += 1
            continue
        try:
            size = render_card_art(src, dest, card_name)
            print(f'  OK  {card_name:30s}  {size}')
            ok += 1
        except Exception as e:
            print(f'  FAIL  {card_name}: {e}')
            fail += 1

    print(f'\nDone. {ok} OK, {missing} missing, {fail} failed.')
    print(f'Artwork written to: {OUT_DIR}')


if __name__ == '__main__':
    main()
