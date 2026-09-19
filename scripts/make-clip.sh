#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "usage: scripts/make-clip.sh <walk.webm> [outdir]" >&2
    exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "make-clip: ffmpeg is required but was not found in PATH" >&2
    exit 2
fi

input=$1
outdir=${2:-$(dirname "$input")}
if [ ! -f "$input" ]; then
    echo "make-clip: input file not found: $input" >&2
    exit 2
fi

mkdir -p "$outdir"
mp4=$outdir/walk.mp4
gif=$outdir/walk.gif
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/jevaluate-clip.XXXXXX")
trap 'rm -rf "$tmpdir"' 0 HUP INT TERM
palette=$tmpdir/palette.png

ffmpeg -hide_banner -loglevel error -y -i "$input" \
    -vf "fps=30,scale=1280:-2:flags=lanczos" -an \
    -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$mp4"

ffmpeg -hide_banner -loglevel error -y -i "$input" \
    -vf "fps=12,scale=800:-1:flags=lanczos,palettegen" "$palette"
ffmpeg -hide_banner -loglevel error -y -i "$input" -i "$palette" \
    -lavfi "fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse" -an "$gif"

printf '%s (%s bytes)\n' "$mp4" "$(wc -c < "$mp4" | tr -d ' ')"
printf '%s (%s bytes)\n' "$gif" "$(wc -c < "$gif" | tr -d ' ')"
