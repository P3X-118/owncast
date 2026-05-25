#!/usr/bin/env bash
# Regenerate self-contained 20s fMP4 test segments for the PoC (no external
# media needed). Uses the okast image's ffmpeg so a host ffmpeg isn't required.
# Output: media/init.mp4 + media/seg-N.m4s + media/stream.m3u8
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media
IMAGE="${OKAST_IMAGE:-legitservices/okast:0.2.2-7}"
DURATION="${DURATION:-120}"   # total seconds
SEG="${SEG:-20}"              # seconds per segment
FPS=30
GOP=$((SEG * FPS))            # keyframe per segment so chunks split cleanly

docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/media":/out -w /out \
  --entrypoint ffmpeg "$IMAGE" \
  -f lavfi -i "testsrc2=duration=${DURATION}:size=640x360:rate=${FPS}" \
  -f lavfi -i "sine=frequency=440:duration=${DURATION}" \
  -c:v libx264 -pix_fmt yuv420p -profile:v main -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
  -c:a aac -ac 2 -shortest \
  -f hls -hls_time "$SEG" -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename 'seg-%d.m4s' -hls_playlist_type vod stream.m3u8

echo "Generated:"; ls -la media
