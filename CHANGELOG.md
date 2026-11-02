# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/); tags use the
repo's two-segment milestone scheme (`vX.Y`).

## [Unreleased]

## [v1.4] - 2026-06-11

### Added
- **Bird-Eye-View (M0–M2)** — camera-to-aerial-map projection: plumb-line
  fisheye calibration + ground homography proven against real anchors
  (spike `.planning/spikes/birdeye-m0/`), pure mapping module
  `birdeye-mapper.ts` (per-camera calibration registry, foot-point mapping,
  horizon/bounds guards; 9 oracle tests), and a live map page **`/live/karte`**:
  aerial photo with live detection positions (person/vehicle dots,
  age fade) fed by `GET /api/detections/birdeye`. The endpoint queries the
  Protect events REST API on demand and whitelist-copies positions only —
  the PII-free MQTT/MinimalEvent contract is untouched. A 30s circuit
  breaker plus client poll backoff protect the shared Protect client (and
  thus the night-watch event stream) from error storms.

### Added
- **Recognition seam + night-watch known-exemption** — Protect's face/plate
  matching now flows as a PII-free boolean stream on
  `ipcam/<cam>/recognition` (`{camera, kind, known, ts}`; names, plate text,
  `faceEmbed` biometrics die at a second structural gate). The night watch
  suppresses alarms for known faces (90s, global — a departure is a multi-cam
  event) and known vehicles (vehicle alarms only); unknown-face/-vehicle
  verdicts override their scope, and the alarm path holds a stepped 12s grace
  (verdicts land at event end) with the snapshot taken at detection time.
  Fail-open throughout: no verdict means the alarm fires as before.

### Changed
- **Night-watch window is now dusk-based** (operator request: fixed 22:00–06:00
  ignores the season — winter darkness starts ~17:00). Night = sun below -6°
  (civil twilight), computed locally (NOAA-simplified formula, verified ≤1.2 min
  against sunrise-sunset.org for summer and winter solstice). Home coordinates
  come from launchd env (`NIGHTWATCH_LAT`/`LON`, strictly parsed and
  range-checked — invalid/empty values fall back loudly to the fixed window,
  never to wrong coordinates); they are never committed. Heartbeat now fires at
  dusk (arm time) instead of 22:00.

### Fixed
- **Night-watch tuning v2** (first-night review: 9 alarms, 0 threats) — global
  90s incident window so one physical event fires ONE full alarm (new cameras
  add a short text-only follow-up instead of full silence; stale QoS1 replays
  never claim the window), per-camera score floor (Park ≥ 75, footpath-facing),
  safe test mode (random mqtt clientId + `clean:true`, outbox/data redirect),
  flood-cap no longer counts failed sends. Hardened per Codex refute review.

## [v1.3] — 2026-06-11

### Added
- **Lean Detection pipeline** — local-first tap on UniFi Protect's smart
  detections: self-healing long-lived Protect websocket (`ProtectConnection`,
  cursor-fresh reconnect, backoff + jitter, silence watchdog), `DetectionTap`
  FSM turning raw events into finalized, PII-free `MinimalEvent`s
  (confirm/end, per-camera cooldown, TTL reaper), `DetectionPublisher` MQTT
  egress (`ipcam/<cam>/detection`, retained health + LWT), boot wiring into
  the scheduler, and read-only status/SSE routes.
- **`/live` view** — live detection feed (SSE) with liveness banner
  (quiet ≠ dead), camera picker, ~1 fps live snapshot proxy and detection
  badge.
- **Night-watch alarm (Mac sidecar)** — `scripts/night-watch/night-watch.mjs`:
  nighttime (22:00–06:00) Telegram alerts with live snapshot for persons on
  outdoor cams / vehicles on driveway cams; per-camera cooldown, flood cap,
  animals + indoor never alert. Journals every confirmed event with its rule
  decision to `data/night-watch/` as the review queue for the vision-based
  self-tuning loop.
- **Debug platform** — per-camera debug health panel, go2rtc/ONVIF-bridge
  probes, codec + stream-rate metrics, homepage health strip, stream-health
  sampler (30 s) with phantom-adoption alert, InfluxDB v2 telemetry sink,
  `stream_health` snapshot table.

### Fixed
- Protect event camera id parsed from `camera` (not `cameraId`) — the tap now
  actually catches live detections.
- Self-heal silent websocket death via reset-before-rebootstrap; in-flight
  guard + connect timeout; health race closed; MQTT topic sanitized; stale
  cooldown-map entries pruned.
- `/live` stale detection badge (ticking clock, hides on `ended`).
- P22 stream semantics: Loxone-MJPEG on `exec:` pipeline (go2rtc 1.9.14
  shorthand broken), cam-direct vs hub-bridge MJPEG links, VAAPI cap 6→12,
  third-party noise hidden in `/kameras`.

## [v1.2] — 2026-05-02

Protect adoption debugging milestone (UAT closed 2026-05-15): source-bug
fixes around adoption flow, MJPEG one-view-per-card, Protect port-1984
adoption semantics.

## [v1.1] — earlier

First production milestone on the VM (camera onboarding, go2rtc/LXC
provisioning, ONVIF bridge).

## [v1.0] — earlier

Initial release.
