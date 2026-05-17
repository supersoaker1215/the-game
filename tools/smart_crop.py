#!/usr/bin/env python3
"""
Smart-crop card portraits.

The naive top-bias crop (used everywhere before this) cropped a fixed
fraction off the top of the source, which left empty void above
figures whose subject didn't fill the top portion of their source
image (Anakin Skywalker 2 was the catalyst — the source had ~30% of
empty blue sky above his head). The user direction:

  "make a new rule for the art to resize it and have the subject be in
  full view if possible without any part of their body cut off"

This module detects the subject's bounding box via per-row + per-column
brightness-variance thresholding (background is flat → low std,
subject creates variation → high std), pads the bbox by 5% so hair /
arm tips at the threshold edge stay safe, then extends the bbox to
match the target 3:4 aspect WITHOUT cropping into the subject. If the
source image isn't wide / tall enough to fit, the canvas is
letterboxed with a dark card-body color so the subject still shows in
full and the card chrome bleeds into the padding instead of clipping
the figure.

Usage:
    python3 tools/smart_crop.py SRC.jpg DEST.png
or as an import:
    from tools.smart_crop import smart_crop
    smart_crop('Foo.jpg', 'audio/cards/art/Foo.png')

The output is always 360x472 (the canonical card-portrait size,
matching ART_BOX_FULL produced by extract_card_art.py).
"""

from PIL import Image
import numpy as np
import sys


# Background color used when letterboxing (matches the in-game card
# body so the padding bleeds into the card frame cleanly).
LETTERBOX_FILL = (8, 12, 22)

# Target aspect — locked to 3:4 (360:472, the canonical portrait size).
TARGET_W = 360
TARGET_H = 472
TARGET_ASPECT = TARGET_W / TARGET_H  # ≈ 0.7627


def find_subject_bbox(img, std_threshold=15):
    """Return (x1, y1, x2, y2) bounding box of the subject by
    detecting rows + columns whose grayscale std exceeds the
    background's flat-tone variance. Works for AI portraits with
    mostly-uniform backdrops (blue void, foggy forest, starfield
    etc.) — the subject's edge contrast lifts row/col std above the
    threshold while flat background stays below.
    """
    arr = np.array(img.convert('RGB')).astype(np.float32)
    gray = arr.mean(axis=2)
    row_std = gray.std(axis=1)
    col_std = gray.std(axis=0)
    rows = np.where(row_std > std_threshold)[0]
    cols = np.where(col_std > std_threshold)[0]
    if len(rows) == 0 or len(cols) == 0:
        # No subject detected — return full image so caller falls back
        # to a center-crop instead of an empty result.
        return (0, 0, arr.shape[1], arr.shape[0])
    return (int(cols[0]), int(rows[0]), int(cols[-1] + 1), int(rows[-1] + 1))


def smart_crop(src, dest, pad_pct=0.05, std_threshold=15):
    """Open `src`, detect the subject, crop + extend to target aspect
    while keeping the subject fully in frame, save to `dest` at
    360x472. Returns the final PIL Image."""
    img = Image.open(src).convert('RGB')
    W, H = img.size

    x1, y1, x2, y2 = find_subject_bbox(img, std_threshold)
    bw = x2 - x1
    bh = y2 - y1

    # Pad the bbox by `pad_pct` so we don't shave hair / arm tips
    # that sit right at the std threshold.
    pad_x = int(bw * pad_pct)
    pad_y = int(bh * pad_pct)
    x1 = max(0, x1 - pad_x); y1 = max(0, y1 - pad_y)
    x2 = min(W, x2 + pad_x); y2 = min(H, y2 + pad_y)
    bw = x2 - x1
    bh = y2 - y1

    # Extend bbox to target aspect WITHOUT touching the subject. If
    # the bbox is narrower than target, grow horizontally; if taller,
    # grow vertically with a 35/65 top/bottom split so heads stay
    # well-clear of the top edge (chrome lives there).
    cur_aspect = bw / bh
    if cur_aspect < TARGET_ASPECT:
        target_w = int(round(bh * TARGET_ASPECT))
        cx = (x1 + x2) // 2
        x1 = max(0, cx - target_w // 2)
        x2 = x1 + target_w
        if x2 > W:
            x2 = W
            x1 = max(0, x2 - target_w)
    else:
        target_h = int(round(bw / TARGET_ASPECT))
        extra = target_h - bh
        grow_up = int(extra * 0.35)
        grow_dn = extra - grow_up
        y1_new = max(0, y1 - grow_up)
        y2_new = min(H, y2 + grow_dn)
        # If one edge clamped, push the remainder to the other side.
        if y2_new - y1_new < target_h:
            if y1_new == 0:
                y2_new = min(H, y1_new + target_h)
            elif y2_new == H:
                y1_new = max(0, y2_new - target_h)
        y1, y2 = y1_new, y2_new

    bw = x2 - x1
    bh = y2 - y1
    cropped = img.crop((x1, y1, x2, y2))

    # If the source wasn't wide / tall enough to reach target aspect,
    # letterbox with the card-body fill so we never crop into the
    # subject just to hit aspect.
    cur_aspect = bw / bh
    if abs(cur_aspect - TARGET_ASPECT) > 0.01:
        if cur_aspect < TARGET_ASPECT:
            new_w = int(round(bh * TARGET_ASPECT))
            pad_l = (new_w - bw) // 2
            canvas = Image.new('RGB', (new_w, bh), LETTERBOX_FILL)
            canvas.paste(cropped, (pad_l, 0))
        else:
            new_h = int(round(bw / TARGET_ASPECT))
            pad_t = (new_h - bh) // 2
            canvas = Image.new('RGB', (bw, new_h), LETTERBOX_FILL)
            canvas.paste(cropped, (0, pad_t))
        cropped = canvas

    out = cropped.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    out.save(dest, optimize=True)
    return out


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} SRC.jpg DEST.png')
        sys.exit(1)
    smart_crop(sys.argv[1], sys.argv[2])
    print(f'Saved → {sys.argv[2]}')
