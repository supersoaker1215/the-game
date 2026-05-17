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


# NOTE: letterboxing was previously a fallback when the source image
# couldn't be extended to target aspect without cropping into the
# subject. User direction made that fallback obsolete — we now always
# crop into the figure (preferring legs over head) instead of showing
# pad bars. The constant is left here as documentation of the previous
# pad color in case letterbox is ever reintroduced.
# LETTERBOX_FILL = (8, 12, 22)

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

    # Extend bbox to target aspect. Two strategies depending on the
    # bbox's current aspect vs target:
    #
    #   bbox NARROWER than target  → grow horizontally (pull in side
    #                                background). If the source image
    #                                isn't wide enough, fall back to
    #                                cropping the bbox SHORTER from
    #                                the bottom (cut legs).
    #   bbox WIDER than target     → grow vertically with 35/65 top/
    #                                bottom split (head-room first).
    #                                If the source image isn't tall
    #                                enough, fall back to narrowing
    #                                the bbox (cut sides equally).
    #
    # User direction: "i dont want any black to show so if thats the
    # case always default to cutting off the legs first" — the
    # letterbox fallback is gone; we'd rather lose figure pixels
    # (preferring legs over head / face) than show pad bars.
    cur_aspect = bw / bh
    if cur_aspect < TARGET_ASPECT:
        target_w = int(round(bh * TARGET_ASPECT))
        cx = (x1 + x2) // 2
        x1 = max(0, cx - target_w // 2)
        x2 = min(W, x1 + target_w)
        x1 = max(0, x2 - target_w)  # re-anchor if clamped at right
        if x2 - x1 < target_w:
            # Source isn't wide enough — keep full width, shorten the
            # bbox height from the BOTTOM (cuts legs, preserves head +
            # face + torso).
            new_bh = int(round((x2 - x1) / TARGET_ASPECT))
            y2 = y1 + new_bh
            # Clamp at image bottom if needed.
            if y2 > H:
                y2 = H
    else:
        target_h = int(round(bw / TARGET_ASPECT))
        extra = target_h - bh
        grow_up = int(extra * 0.35)
        grow_dn = extra - grow_up
        y1_new = max(0, y1 - grow_up)
        y2_new = min(H, y2 + grow_dn)
        if y2_new - y1_new < target_h:
            # Couldn't grow vertically enough — narrow the bbox
            # horizontally (cut sides equally so face stays centered).
            new_bw = int(round((y2_new - y1_new) * TARGET_ASPECT))
            cx = (x1 + x2) // 2
            x1 = max(0, cx - new_bw // 2)
            x2 = min(W, x1 + new_bw)
            x1 = max(0, x2 - new_bw)
        y1, y2 = y1_new, y2_new

    cropped = img.crop((x1, y1, x2, y2))

    out = cropped.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    out.save(dest, optimize=True)
    return out


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} SRC.jpg DEST.png')
        sys.exit(1)
    smart_crop(sys.argv[1], sys.argv[2])
    print(f'Saved → {sys.argv[2]}')
