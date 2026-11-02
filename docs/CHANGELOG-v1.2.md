# v1.2 — Bambu Lab H2C Integration

Integrates Bambu Lab 3D printers (starting with the H2C) as a third camera type alongside Mobotix and Loxone, end-to-end from network discovery through UniFi Protect adoption.

## Highlights

- **Discovery**: SSDP listener on UDP 2021 identifies Bambu printers broadcasting `urn:bambulab-com:device:3dprinter:1`. Model allowlist covers `O1C2` (H2C's internal code), `H2C`, `H2D`, `X1C`, `P1S`, `A1` for forward-compat.
- **Credentials**: 8-digit Access Code from the printer display + Serial Number, both AES-256-GCM encrypted in SQLite.
- **Pre-flight**: three sequential TLS-aware checks (TCP 322 reachability → RTSPS handshake → MQTT handshake) surface four distinct error codes (`LAN_MODE_OFF`, `WRONG_ACCESS_CODE`, `PRINTER_UNREACHABLE`, `RTSPS_HANDSHAKE_HUNG`) instead of a single opaque failure.
- **Stream pipeline**: go2rtc pulls `rtspx://bblp:<code>@<ip>:322/streaming/live/1` with `#video=copy` passthrough. **No transcoding** — the H2C already serves H.264 High @ 1680×1080 30fps, so the stream bytes land in Protect unchanged.
- **Container strategy**: same `ipcm-base` LXC template as Mobotix/Loxone (no Bambu-specific template, VAAPI passthrough retained but unused for Bambu).
- **ONVIF adoption**: ONVIF server in the LXC advertises `BambuLabH2C` via WS-Discovery on UDP 3702; UniFi Protect auto-discovers and adopts. Protect never connects to the printer directly — go2rtc is the sole RTSPS consumer, protecting the printer's fragile Live555 server.
- **Adaptive Stream Mode**: long-lived MQTT subscriber (one per Bambu camera) watches `device/<serial>/report` for `print.gcode_state` transitions. On `RUNNING`/`PREPARE`/`PAUSE` → starts go2rtc; on `FINISH`/`IDLE`/`FAILED` → stops go2rtc via `systemctl` over SSH. Printer is left alone when idle.
- **Override**: per-camera `streamMode` via `PATCH /api/cameras/:id/bambu-state` (`adaptive` | `always_live` | `always_snapshot`).

## Ground-truth anchor

All H2C-specific protocol values (SSDP port, URN, RTSPS URL path, MQTT topic, cert issuer pattern, model code, state-group sentinels) are captured in `.planning/research/H2C-FIELD-NOTES.md`, derived from a real hardware validation spike (Phase 10) rather than extrapolated from X1C/P1S documentation. Phase 11-14 plans cite the field notes directly when they diverge from published Bambu examples.

## Notable decisions / non-obvious findings from the spike

- **SSDP fires on UDP 2021, not 1900 or 1990** — Bambu's `Host:` header advertises 1990 but actual traffic flows on 2021. STACK.md's initial guess of 1990 was wrong; field capture corrected it before Phase 11 code was written.
- **TLS cert CN = printer serial**, not IP — `rtspx://` (skip-verify) is mandatory; no SAN match is possible.
- **`mosquitto_sub --insecure` is broken on Debian 13** against H2C self-signed TLS (mosquitto-clients 2.0.21 emits `Protocol error`). Pre-flight MQTT check uses the `mqtt` npm package with `rejectUnauthorized: false` instead.
- **H2C has no Bird's-Eye camera** (`/streaming/live/2` returns 404). Out of scope for v1.2; deferred.
- **`print.print_type = 'cloud'`** is reported even in LAN-only mode — it's slicer-origin metadata, not a connection-mode signal. Do not use it to detect LAN mode.
- **Bambu TLS certs have model-versioned issuer CNs** (`BBL Device CA O1C2-V2`). Don't pin the issuer CN.

## Requirements coverage

- ✅ BAMBU-01..02 (Phase 10) — spike + field notes committed
- ✅ BAMBU-03..10 (Phase 11) — discovery, credentials, pre-flight
- ✅ BAMBU-11..14 (Phase 12) — go2rtc rtspx:// + LXC provisioning
- ✅ BAMBU-15 (Phase 13, primary) — end-to-end Protect adoption verified on real H2C
- 🟡 BAMBU-16..17 (Phase 13, partial) — dashboard per-state error badges + inline Access Code update UX deferred to a follow-up
- ✅ BAMBU-18..23 (Phase 14, primary) — Adaptive Mode + streamMode override API
- 🟡 BAMBU-24 (Phase 14 polish) — UI badge + override toggle on the camera card deferred
- ✅ BAMBU-25 (Phase 15, partial) — README walkthrough (LAN Mode / Access Code / firmware caveats) shipped
- ⏸ BAMBU-26 — one-line installer re-validated on a clean VM: pending manual verification

## Known limitations

- **Adaptive Mode toggle latency** ≈ 3–5s: go2rtc is brute-force stopped/started via `systemctl`, so Protect briefly sees the stream go offline on transition. A future refinement could use go2rtc's HTTP API to swap the producer source dynamically without restarting the service.
- **No UI for `streamMode` override** in this release — API-only (`PATCH /api/cameras/:id/bambu-state`).
- **Per-Bambu error-state badges** on the dashboard card not implemented — pre-flight errors surface distinctly in the wizard; post-provisioning errors still land in the generic offline state.

## Hardware validated against

Bambu Lab H2C, firmware `01.01.05.00`, DevModel `O1C2`, serial prefix `31B8BP*`, date 2026-04-15. Stream: h264 High Level 4.1 @ 1680×1080 30fps, no audio.

## Field experience note — streamMode recommendation

The `adaptive` mode was originally specified as the default because early X1C/P1S firmware had well-known Live555 stability issues under sustained RTSPS load. First-pass field testing on the H2C with firmware `01.01.05.00` showed no such issues during multi-hour continuous streaming — the printer handled a 24/7 go2rtc pull without Live555 wedging.

Practical consequence for single-printer home setups: **`always_live` is likely the better default**, because otherwise UniFi Protect goes offline between prints (often >22 h/day of idle) and timeline recording has large gaps. The API lets you flip without re-provisioning:

```
PATCH /api/cameras/<id>/bambu-state  {"streamMode": "always_live"}
```

`adaptive` stays useful as a safety net if you run an older firmware, see Live555 crashes, or operate multiple H2Cs where cumulative load matters. The README now documents this trade-off explicitly.
