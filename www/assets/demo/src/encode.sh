#!/usr/bin/env bash
# Encode the Impri killer demo frames (produced by capture-killer.mjs) into
# mp4/webm/gif/poster deliverables. Run from this directory.
set -euo pipefail
cd "$(dirname "$0")"

OUT=../
mkdir -p "$OUT"

encode_one() {
  local frames_dir="$1" name="$2" poster_t="$3"
  echo "=== encoding $name from $frames_dir ==="

  # H.264 mp4 — target < 2.5MB, faststart for web playback
  ffmpeg -y -framerate 30 -i "$frames_dir/frame_%05d.png" \
    -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart \
    "$OUT/$name.mp4"

  # VP9 webm — smaller alt format
  ffmpeg -y -framerate 30 -i "$frames_dir/frame_%05d.png" \
    -c:v libvpx-vp9 -b:v 0 -crf 34 \
    "$OUT/$name.webm"

  # Poster jpg at poster_t seconds
  ffmpeg -y -ss "$poster_t" -i "$frames_dir/frame_%05d.png" -frames:v 1 -q:v 3 \
    "$OUT/$name-poster.jpg"

  # GIF: palette-based, 960px wide, 12fps, capped size
  ffmpeg -y -framerate 30 -i "$frames_dir/frame_%05d.png" \
    -vf "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
    "$OUT/$name.gif"

  echo "--- sizes for $name ---"
  du -h "$OUT/$name.mp4" "$OUT/$name.webm" "$OUT/$name-poster.jpg" "$OUT/$name.gif"
}

encode_one frames-killer killer-demo 1.5
encode_one frames-killer-short killer-demo-short 1.0
