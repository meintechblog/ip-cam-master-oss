#!/bin/bash
# Bambu A1 JPEG-over-TLS → H264 MPEG-TS transcode pipeline.
#
# Deployed to /opt/ipcm/a1-transcode.sh and invoked by go2rtc via the
# exec: pipe transport (see generateGo2rtcConfigBambuA1). go2rtc detects
# mpegts from the stdout magic bytes and re-exposes the stream as RTSP
# :8554 with proper PTS/DTS timestamps.
#
# Phase 18 / Plan 18-03 / BAMBU-A1-09.
#
# Pipeline:
#   1. bambu-a1-camera.mjs reads TLS:6000 frames from the A1 printer,
#      rewrites the non-standard AVI1 APP0 marker to canonical JFIF,
#      and writes raw MJPEG bytes to stdout.
#   2. `cat` acts as an 8 KB pipe buffer. Without it, ffmpeg reads Node's
#      partial-frame flushes as short chunks and trips repeated
#      "unable to decode APP fields" warnings before a full JPEG arrives.
#      cat coalesces writes so ffmpeg sees whole frames atomically.
#   3. ffmpeg image2pipe/mjpeg demuxer + minterpolate motion-compensated
#      interpolation synthesises real between-frames from the A1's native
#      ~5 fps (printing) / ~0.5 fps (idle) source up to a smooth 10 fps
#      output. Previously used fps=10 which only duplicated frames and
#      made the live view feel frozen. `mi_mode=mci` + `mc_mode=aobmc`
#      trades a few % CPU for visibly smoother motion on slow-moving
#      print-head scenes. libx264 preset=ultrafast/tune=zerolatency keeps
#      latency low. Output format is mpegts on stdout so go2rtc's exec:
#      pipe auto-detects and re-serves.
#
# Security:
#   - A1 access code is passed via the A1_ACCESS_CODE env var (set in the
#     go2rtc yaml `exec:env A1_ACCESS_CODE=...` line), NEVER as a CLI arg,
#     because `ps ax` inside the LXC would otherwise leak it (RESEARCH §
#     Anti-Pattern 4 / Threat T-18-07).
#   - The only CLI arg is the printer IP, which is already known on the LAN.
#
# Usage:
#   A1_ACCESS_CODE=<code> /opt/ipcm/a1-transcode.sh <printer-ip>
set -euo pipefail
node /opt/ipcm/bambu-a1-camera.mjs --ip="$1" \
  | cat \
  | ffmpeg -nostdin -hide_banner -loglevel error \
      -probesize 5M -analyzeduration 5M \
      -f image2pipe -vcodec mjpeg -framerate 5 -i - \
      -vf "minterpolate=fps=10:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,format=yuv420p" \
      -c:v libx264 -preset ultrafast -tune zerolatency -g 20 \
      -f mpegts -
