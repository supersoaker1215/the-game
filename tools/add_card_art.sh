#!/bin/bash
# ============================================================
# ADD CARD ART — one source image → every tier the game reads.
#
#   tools/add_card_art.sh ~/Desktop/whatever.png "Battle Droid"
#
# A card's portrait is not one file. The renderer picks a tier by surface:
# art/ (360x472) for desktop, art-md/ for mid, art-sm/ (204x256) for phones —
# and a card present in art/ but missing from art-sm/ renders BLANK on mobile,
# which is a bug you only find on a phone. Doing all three by hand is how that
# happens, so this does all three.
#
# The original is kept in art-originals/ (gitignored) so a crop can be redone
# later without going back to the source.
# ============================================================
set -euo pipefail

SRC="${1:-}"
NAME="${2:-}"
if [ -z "$SRC" ] || [ -z "$NAME" ]; then
  echo "Usage: tools/add_card_art.sh SRC_IMAGE \"Card Name\"" >&2
  exit 1
fi
[ -f "$SRC" ] || { echo "No such file: $SRC" >&2; exit 1; }

cd "$(dirname "$0")/.."

mkdir -p art-originals audio/cards/art audio/cards/art-md audio/cards/art-sm

# 1. Keep the original untouched.
cp "$SRC" "art-originals/$NAME.png"

# 2. Full tier — smart_crop finds the subject and fits it to 3:4 WITHOUT
#    cutting into it, letterboxing rather than clipping when the source is the
#    wrong shape. (A naive top-crop would take the droid's antennae off.)
python3 tools/smart_crop.py "$SRC" "audio/cards/art/$NAME.png"

# 3. The two smaller tiers, derived from the full one so all three agree.
#    Conventions read off the existing 200-odd files, not invented here:
#    the tiers are HEIGHT-driven (512 and 256) and art-md is JPEG while
#    art-sm is PNG. Guessing either one produces files the renderer's path
#    builder never asks for.
python3 - "$NAME" <<'PY'
import sys
from PIL import Image
name = sys.argv[1]
src = Image.open(f'audio/cards/art/{name}.png').convert('RGB')
for folder, height, ext, opts in (
        ('art-md', 512, 'jpg', {'quality': 88, 'optimize': True}),
        ('art-sm', 256, 'png', {'optimize': True})):
    w = round(src.width * height / src.height)
    out = f'audio/cards/{folder}/{name}.{ext}'
    src.resize((w, height), Image.LANCZOS).save(out, **opts)
    print(f'  {folder}/{name}.{ext}  {w}x{height}')
PY

echo "Done. $NAME is in all three tiers."
echo "Next: bump the art cache-buster in index.html and commit."
