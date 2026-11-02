# IP-Cam-Master

One-click camera onboarding for UniFi Protect. Discover cameras in the network, and the app handles everything — container creation, stream transcoding, ONVIF wrapping, and Protect adoption.

Built for self-hosters who want to integrate non-ONVIF cameras (Mobotix, Loxone Intercom, Bambu Lab printers) into UniFi Protect without manual setup.

## Features

- **Auto-Discovery** — Scans the network for Mobotix cameras, Loxone Intercoms, and Bambu Lab printers (SSDP on UDP 2021); shows them with name, type, and live snapshot thumbnail
- **Bambu Lab H2C Integration** — Pre-flight handshake (TCP + RTSPS + MQTT) surfaces distinct error states; auto-provisions an LXC with go2rtc in pure H.264 passthrough (no transcode) so UniFi Protect gets a 1680×1080 30fps feed without touching the printer's fragile Live555 server directly
- **Credential Presets** — Store standard logins once, cameras are auto-matched during onboarding
- **5-Step Onboarding Wizard** — From credential entry to verified stream in UniFi Protect
- **Batch Onboarding** — "Alle hinzufügen" button processes all discovered cameras sequentially with live step-by-step progress, sub-steps, and snapshot thumbnails
- **Container Templates** — First onboarding creates a reusable LXC template; subsequent cameras clone from it (~30s instead of 3-5min)
- **Dual-Stream Output** — Each camera outputs HQ (full resolution + audio) and LQ (half resolution, lower bitrate) streams for UniFi Protect timeline/thumbnails
- **Native ONVIF Support** — Cameras with built-in ONVIF are registered without containers
- **Live Dashboard** — Snapshot preview, service pipeline status, LXC resources, UniFi Protect connection with real-time event logging
- **Camera Probing** — Live FPS, model (e.g., MOBOTIX S15D-Sec), firmware version, codec directly from camera
- **Container Management** — Start, stop, restart, delete LXC containers from the UI
- **Container Health Checks** — Automatic monitoring of go2rtc and ONVIF server status every 5 minutes with event logging on failure
- **Dynamic Proxmox Config** — Storage and bridge dropdowns loaded from Proxmox API with disk space info
- **Access Control** — Session-based login with setup wizard, or YOLO mode for homelab simplicity
- **Auto-Update** — Optional self-update from GitHub on a daily window (Europe/Berlin). 9-stage pipeline with two-stage rollback, ETag-cached check, dedicated systemd unit, conflict-aware install (skips when Hub bridge is starting/stopping). See [Auto-Update](#auto-update)
- **Responsive UI** — Hamburger menu on mobile, full sidebar on desktop

## How It Works

### Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────┐     ┌──────────────┐
│  Mobotix     │     │  LXC Container (Proxmox, 4GB/192MB)         │     │  UniFi       │
│  Camera      │     │                                              │     │  Protect     │
│              │     │  ┌─────────┐  ┌──────────┐  ┌────────────┐  │     │              │
│  MJPEG :554 ─┼────►│  │ go2rtc  │─►│ RTSP     │─►│ ONVIF      │──┼────►│  ONVIF       │
│              │     │  │ VAAPI   │  │ H.264    │  │ Server     │  │     │  Discovery   │
│              │     │  └─────────┘  └──────────┘  └────────────┘  │     │  + Adoption  │
└─────────────┘     └──────────────────────────────────────────────┘     └──────────────┘
```

### Three Camera Types

| Type | Example | Onboarding | Container | Stream Handling |
|------|---------|-----------|-----------|-----------------|
| **Pipeline** (no ONVIF) | Mobotix S15D, Loxone Intercom | Full 5-step wizard | Yes — go2rtc + ONVIF Server | MJPEG → H.264 **VAAPI transcode** |
| **Native ONVIF** | Mobotix S16B | Simple registration | No — direct Protect adoption | Protect pulls ONVIF directly |
| **Bambu Lab** (H2C, H2D) | Bambu Lab H2C | Pre-flight + auto-provision | Yes — go2rtc + ONVIF Server | **H.264 passthrough** (no transcode) |

### Bambu Lab H2C — Technical Details

Bambu printers expose their live camera as **RTSPS on TCP 322** in **LAN Mode Liveview**. The H2C stream is already H.264 High Profile (Level 4.1) at 1680×1080@30fps with **no audio** — which means the app uses go2rtc in **pure passthrough mode** (`#video=copy`), **no VAAPI transcoding required**. Each printer still gets its own LXC container so the architecture stays symmetric with Mobotix/Loxone cameras.

```
┌────────────────────────┐     ┌──────────────────────────────────────────────┐     ┌──────────────┐
│  Bambu Lab H2C         │     │  LXC Container (Proxmox, cloned from base)   │     │  UniFi       │
│  ─────────────────     │     │  ─────────────────────────────────────────    │     │  Protect     │
│  RTSPS :322   ─────────┼────►│  go2rtc                                       │     │              │
│    (self-signed cert)  │     │   ├─ producer: rtspx:// passthrough           │     │              │
│                        │     │   │   (one TCP conn → single-connection       │     │              │
│  MQTT :8883            │     │   │    limit respected)                       │     │              │
│    (Phase 14)          │     │   ├─ stream: <name>      (HQ, 1680x1080)      │     │              │
│                        │     │   └─ stream: <name>-low  (alias → HQ)         │     │              │
│  SSDP :2021 ───────────┼──►  │          │                                    │     │              │
│  (discovery broadcast) │     │          ▼                                    │     │              │
│                        │     │  RTSP :8554  ◄────────────────────────────────┼────►│  ONVIF grab  │
│                        │     │  ONVIF Server (WS-Discovery UDP 3702)         │     │  HQ + LQ     │
└────────────────────────┘     └──────────────────────────────────────────────┘     └──────────────┘
```

**Protocol details (ground truth from `.planning/research/H2C-FIELD-NOTES.md`):**

| What | Value | Notes |
|------|-------|-------|
| Discovery | SSDP NOTIFY on **UDP 2021** | URN `urn:bambulab-com:device:3dprinter:1`; printer identified by `DevModel.bambu.com: O1C2` (H2C's internal model code) |
| Auth | User `bblp` + **8-digit Access Code** from printer display | stored AES-256-GCM encrypted in SQLite |
| Live stream | `rtsps://bblp:<code>@<ip>:322/streaming/live/1` | H.264 High @ 1680x1080 30fps, no audio, Live555 server |
| TLS | Self-signed cert, CN = printer serial, issuer `BBL Device CA O1C2-V2` | go2rtc uses `rtspx://` scheme to skip verification |
| Transcode | **None** | `#video=copy` passthrough — same bytes in as out |
| MQTT | TCP 8883 TLS, topic `device/<serial>/report` | used for Phase 14 Adaptive Mode; not needed for basic stream |
| Bird's-Eye (`live/2`) | **Not present on H2C** (404) | documented out of scope for v1.2 |

**Architectural guarantees:**

1. **go2rtc is the sole RTSPS consumer** of the printer — UniFi Protect only ever talks to go2rtc's :8554 restream, **never** to the printer's port 322 directly. This protects the printer's fragile Live555 server from multi-client load.
2. **Single TCP connection to the printer** — the `<name>-low` substream is a go2rtc-internal alias, not a second pull. One producer, two consumer endpoints.
3. **No credential leakage to UniFi Protect** — Protect authenticates against the LXC's ONVIF server (anonymous), not the printer. Access Code stays encrypted in the app's DB and in the container-local `/etc/go2rtc/go2rtc.yaml`.
4. **Same LXC template as Mobotix** — `ipcm-base` gets cloned; no Bambu-specific template. VAAPI passthrough stays configured (unused by Bambu, present for mixed-camera setups).

**Pre-flight before provisioning** — four distinct error states surfaced in the UI instead of one opaque failure:
- `LAN_MODE_OFF` — port 322 refused / MQTT unreachable on 8883
- `WRONG_ACCESS_CODE` — RTSPS 401 or MQTT auth reject
- `PRINTER_UNREACHABLE` — IP not responding
- `RTSPS_HANDSHAKE_HUNG` — Live555 wedged (recommend printer power-cycle)

MQTT handshake in pre-flight uses the `mqtt` npm package with `rejectUnauthorized: false` — `mosquitto_sub --insecure` is **broken** against the H2C's self-signed cert on Debian 13 (mosquitto-clients 2.0.21), confirmed during the Phase 10 hardware spike.

**Adaptive Stream Mode** — a long-lived MQTT subscriber (spawned per Bambu camera on app boot) watches `device/<serial>/report` for `print.gcode_state` transitions. On state-group changes, go2rtc is toggled via `systemctl` over SSH so the printer is not under a 24/7 RTSPS pull while idle (the H2C's Live555 server is known fragile). State groups:

| `print.gcode_state` | Mode | go2rtc |
|---------------------|------|--------|
| `RUNNING`, `PREPARE`, `PAUSE` | **Live** | running — Protect streams + records |
| `FINISH`, `IDLE`, `FAILED`    | **Snapshot** | stopped — printer left alone |

Per-camera override via `PATCH /api/cameras/:id/bambu-state {"streamMode": "always_live" | "always_snapshot" | "adaptive"}`. The ONVIF server inside the LXC stays running in both modes, so Protect keeps the device adopted and registered even during idle (stream just goes offline temporarily).

**Which mode should you pick?**

| Your situation | Recommended | Why |
|----------------|-------------|-----|
| H2C in a living-space, want to peek anytime + continuous Protect timeline | `always_live` | Drucker steht 24/7 unter RTSPS-Pull. Bei neueren H2C-Firmware (01.01.05+) unproblematisch — Live555 bleibt stabil. Gibt lückenlose Aufzeichnung |
| H2C an der Leistungsgrenze / ältere Firmware / Live555 ist schonmal abgestürzt | `adaptive` (default) | Schont den Drucker automatisch wenn kein Druck läuft — ~22 h/Tag keine Last; Protect zeigt "offline" zwischen Drucken |
| Du willst den Drucker komplett schonen (z.B. Nachtabschaltung) | `always_snapshot` | Go2rtc bleibt dauerhaft aus; Protect sieht nie Live. Brauchst dann einen anderen Monitoring-Weg |

Switch anytime without re-provisioning:
```bash
curl -X PATCH -H "Content-Type: application/json" \
  -d '{"streamMode":"always_live"}' \
  http://<ipcm-host>/api/cameras/<id>/bambu-state
```

Der Schalter ist sofort wirksam — beim nächsten MQTT-Event oder manuell: `always_live` erzwingt `systemctl start go2rtc`, `always_snapshot` → `stop`, `adaptive` → folgt wieder dem MQTT-`print.gcode_state`.

### Bambu Lab H2C — Setup Walkthrough

Before onboarding a Bambu H2C, the printer itself needs these three things enabled:

1. **LAN Mode Liveview** — on the printer display:
   `Settings → WLAN → LAN Mode = ON`
   This exposes RTSPS on TCP 322 and MQTT on TCP 8883.

2. **(Recommended) Developer Mode** — same menu tree; improves Live555 stability under observer load.

3. **Note the Access Code** — printer display:
   `Settings → WLAN → Access Code`  (8-digit, rotates when LAN Mode is toggled)

Then in the IP-Cam-Master web UI:
- The H2C appears in auto-discovery (SSDP broadcast; identified via `DevModel.bambu.com: O1C2`)
- Click **"Einrichten"** — wizard prefills Serial from SSDP
- Enter the 8-digit Access Code — pre-flight runs TCP + RTSPS + MQTT handshake
- On success, the app allocates a VMID, clones an LXC from the `ipcm-base` template, deploys `go2rtc.yaml` with `rtspx://` passthrough, starts go2rtc + ONVIF server
- UniFi Protect auto-discovers the new ONVIF device within ~1 min; click **Adopt** in Protect

**⚠ UniFi Protect adoption — Port 1984 beachten:**

When manually adding the camera in Protect (or re-adopting after a Protect update), use the **container IP with port 1984** (go2rtc's API port), not just the bare IP:

```
192.168.x.y:1984
```

Port 1984 is where go2rtc's ONVIF-compatible endpoint lives. Without the port, Protect may find the ONVIF server on port 8899 but fail to negotiate the stream correctly. If Protect loses the camera after a firmware update, remove it and re-add with `<container-ip>:1984`.

**⚠ Firmware caveats:**

- **Do not enable Bambu Studio concurrent LAN control** while the app is adopted — the H2C's Live555 server has a single-connection limit for the camera. Use Studio via the cloud pathway if you need both.
- **Bambu "Authorization Control"** (rolled out in a firmware update in 2025) can invalidate existing Access Codes on firmware upgrade. **Recommendation: disable auto-update on any adopted H2C** in `Settings → Firmware` and apply updates manually with a re-onboarding plan in hand.
- Bird's-Eye camera (`/streaming/live/2`) is **not exposed by the H2C** (confirmed 404 during hardware validation). Intentionally out of scope — keep deferred for a future Bambu model.

### Onboarding Flow

1. **Auto-Discovery** scans the network, identifies cameras by type (Mobotix/Loxone/ONVIF)
2. **Credential matching** — saved presets are tried automatically. If matched: IP, name, user, password are pre-filled
3. **Connection test** — probes camera RTSP stream, shows live snapshot
4. **Container creation** — Debian 12 LXC on Proxmox with VAAPI passthrough, named `cam-<name>`
5. **Service setup** — installs go2rtc (MJPEG→H.264 VAAPI), ONVIF server (with correct device naming), both as systemd services
6. **Stream verification** — go2rtc API health check, RTSP URL displayed

### Camera Dashboard

Each camera gets a full-width card with:

- **Live snapshot** (refreshes every 10s, directly from camera)
- **LXC panel** — CPU/RAM bars, IP, MAC address, hostname, start/stop/restart/delete buttons
- **Service pipeline** — Kamera ► go2rtc ► ONVIF ► UniFi Protect with green/red status indicators
- **Camera details** — Model (MOBOTIX S15D-Sec), firmware (MX-V4.4.2.73), live FPS, codec
- **go2rtc details** — Transcode info, VAAPI, bitrate, connected clients
- **UniFi Protect** — Connection status (detected via GStreamer user agent), active streams
- **Editable name** — Click pencil icon, updates DB + LXC hostname

## Tech Stack

- **Frontend:** SvelteKit 2 (Svelte 5 Runes), Tailwind CSS 4, Lucide icons
- **Backend:** SvelteKit server routes, SQLite (better-sqlite3), Drizzle ORM
- **Infrastructure:** Proxmox VE API, SSH via node-ssh (key-based), go2rtc, daniela-hase/onvif-server
- **Security:** AES-256-GCM encryption for all stored credentials
- **Runtime:** Node.js 22 LTS

## Installation

One command on your Proxmox host — creates a VM with everything ready:

```bash
curl -fsSL https://raw.githubusercontent.com/meintechblog/ip-cam-master/main/install.sh | bash
```

The installer:
- Creates a Debian 12 VM on your Proxmox host
- Installs Node.js, the app, and all dependencies
- Sets up API tokens and SSH keys (VM can manage Proxmox automatically)
- Starts the app as a systemd service on port 80

Same command for **updates** (detects existing VM, pulls latest, rebuilds) and **uninstall** (removes VM + tokens).

### After Installation

1. Open `http://<vm-ip>` — set up login or click "Ohne Passwort fortfahren" (YOLO mode)
2. **Settings → Proxmox** — already configured by installer, verify connection is green
3. **Settings → Credentials** — add standard camera logins (tried automatically during onboarding)
4. **Kameras → + Kamera hinzufuegen** — discovered cameras appear with pre-filled credentials
5. Click **Einrichten** → follow wizard → camera appears in UniFi Protect

### Prerequisites

- **Proxmox VE 8.x** host (x86_64 only — no ARM support)
- **Intel GPU with VAAPI** on the Proxmox host (`/dev/dri/renderD128` must exist)
- Debian 12 LXC template: `pveam download local debian-12-standard_12.12-1_amd64.tar.zst`

### Why Intel VAAPI? Why not Software / ARM / Nvidia?

IP-Cam-Master requires hardware video transcoding (MJPEG → H.264) via Intel VAAPI. This is a deliberate design decision, not a limitation we plan to remove:

| Platform | Supported | Why |
|----------|-----------|-----|
| **Intel** (Core 6th+, Atom, N95/N100/N200) | **Yes** | VAAPI via `/dev/dri/renderD128`, passthrough to LXC containers works out of the box |
| **Software transcoding (CPU)** | No | Too slow for real-time multi-camera transcoding. A single Mobotix stream at 1080p20 would max out a CPU core |
| **Raspberry Pi 4/5** | No | Proxmox is x86_64 only. RPi uses VideoCore (V4L2), not VAAPI — entirely different ffmpeg pipeline. RPi 5 dropped the H.264 hardware encoder |
| **Nvidia GPU** | No | Would require NVENC support in go2rtc configs, different device paths, nvidia-container-toolkit in LXC. Possible but not implemented |
| **AMD GPU** | No | VA-API exists on AMD but untested. LXC device passthrough differs from Intel. May work with community patches |

The entire pipeline (go2rtc config generation, LXC `/dev/dri` passthrough, ffmpeg flags) is built around Intel VAAPI. Supporting other platforms would require a separate transcoding backend per platform — not worth the complexity for a homelab tool.

**Recommended hardware:** Intel N100 or N200 mini PCs (fanless, ~10W TDP, ~€150) handle 6+ camera streams easily.

### Development

```bash
git clone https://github.com/meintechblog/ip-cam-master.git
cd ip-cam-master
npm install
cp .env.example .env  # Set DB_ENCRYPTION_KEY (min 32 characters)
npx drizzle-kit push   # Create SQLite tables
npm run dev -- --host 0.0.0.0
```

### Deploying to a test VM (git-push workflow)

For iterating against a running VM install, `scripts/dev-deploy.sh` pushes
the current `main` HEAD directly to `/opt/ip-cam-master` on the VM. A
server-side `post-receive` hook then runs `npm ci`, builds, and restarts
the service inline — the full hook output streams back on the push
connection.

One-time setup on the VM (idempotent, safe to re-run):

```bash
# On the VM:
cd /opt/ip-cam-master
git fetch origin && git reset --hard origin/main
bash scripts/migrate-install.sh
```

Setup on your workstation:

```bash
# Add an SSH alias for the VM in ~/.ssh/config, then:
./scripts/dev-deploy.sh
```

The script pushes to an automatically-configured `vm` git remote and
never relies on GitHub — uncommitted WIP is rejected, but
committed-but-unpublished commits deploy fine. Coordinates with the
in-app updater via an flock on `/run/ip-cam-master-deploy.lock`, so the
two never interleave.

### Container Specs

Each camera LXC container uses minimal resources:

| Resource | Value |
|----------|-------|
| RAM | 192 MB |
| Disk | 4 GB |
| CPU | 1 core |
| HQ Bitrate | 2000 kbit/s (default, configurable per camera) |
| LQ Bitrate | 400 kbit/s (auto: HQ/5) |
| Services | go2rtc + ONVIF server (systemd) |
| Hostname | `cam-<camera-name>` |
| VMID | Auto-assigned (next 1000 boundary) |

## Settings

### Proxmox

| Field | Description |
|-------|-------------|
| Host | Proxmox IP (port 8006 added automatically) |
| API Token ID | Format: `user@realm!tokenname` |
| API Token Secret | UUID token |
| Storage Target | Dropdown from Proxmox (shows free space) |
| Network Bridge | Dropdown from Proxmox |

### Credentials

Standard logins tried in priority order when onboarding cameras. Stored AES-256-GCM encrypted. Two credential types supported:

- **Mobotix/Loxone (HTTP Basic)** — username + password, used for camera discovery and go2rtc stream auth
- **Bambu Lab (Serial + Access Code)** — offered during H2C onboarding as a one-click pre-fill; the access code doubles as the RTSP password on the printer's container

### RTSP Stream Auth

Every container's go2rtc can lock its RTSP-Server (`:8554`) with the camera's own credentials. Enable per camera from the detail card ("RTSP-Auth aktivieren"):

- **Mobotix/Loxone:** container uses the camera's HTTP login as the RTSP user/pass
- **Bambu:** container uses the printer's serial as username and the access code as password

When enabled, the card shows the credentials you need in UniFi Protect's adoption dialog (ONVIF tab) and provides a one-click copy of the full `rtsp://user:pass@host:8554/stream` URL for VLC/ffmpeg testing. New onboardings opt in automatically; existing cameras require a manual re-adoption in Protect after flipping the switch.

### Auto-Update

`Settings → Version` lets the app keep itself in sync with `meintechblog/ip-cam-master` on GitHub:

- **Manual check + install** — "Jetzt prüfen" hits the GitHub commits API (ETag-cached, 5-min cooldown). "Jetzt updaten" opens a confirmation modal showing current → target SHA + commit metadata + any active flow conflicts (Hub bridge starting/stopping). Install runs through a 9-stage pipeline: preflight → snapshot → drain → stop → fetch → install → build → start → verify, with a live stage-stepper UI.
- **Auto-update** — Toggle on + pick a daily hour (Europe/Berlin, default 03:00). The app checks every 6h and applies updates inside the configured hour, skipping if a Hub bridge is starting/stopping or the last auto-update was less than 23h ago. Each run is logged in the **history table** with `manuell` vs `auto` trigger.
- **Two-stage rollback** — If `verify` fails (sha mismatch or `dbHealthy=false`), Stage 1 does `git reset --hard` to the previous SHA + reinstall; if Stage 1 itself fails, Stage 2 restores from the pre-install tarball snapshot. The rollback banner shows on the next page load until you ack it.
- **Reconnect overlay** — Mid-install when the service restarts, the UI shows a non-dismissable polling overlay (`/api/version` every 2s, 90s timeout) and auto-closes once the new SHA reports back with `dbHealthy=true`.
- **Where state lives** — `update_runs` SQLite table (run history, last 10 visible) + `.update-state/state.json` (transient: SHA, ETag, rollback fields, atomic via tmp+rename, shared between Node and the bash updater) + `update.autoUpdate*` keys in `settings`. The dedicated `ip-cam-master-updater.service` (oneshot) lives in a sibling cgroup so the `stop` stage doesn't kill its own driver.

## Background & References

This project automates the manual processes described in these blog posts on [meintechblog.de](https://meintechblog.de):

- **[Hardcore-Tech-Howto: Quasi jeden Uralt-Kamerastream in UniFi Protect nutzbar machen](https://meintechblog.de/2025/07/18/hardcore-tech-howto-quasi-jeden-uralt-kamerastream-in-unifi-protect-nutzbar-machen-nerdalarm/)** — Original Mobotix → go2rtc → ONVIF → UniFi Protect pipeline
- **[Howto: Loxone Intercom Videofeed in UniFi Protect einbinden](https://meintechblog.de/2025/10/07/howto-loxone-intercom-videofeed-in-unifi-protect-einbinden/)** — Loxone Intercom integration with nginx auth-proxy and ONVIF server setup
- **[Florian Rhomberg: Third-party camera integration](https://www.florian-rhomberg.net/2025/01/how-to-integrate-a-third-party-camera-into-unifi-protect/)** — General integration walkthrough

### What IP-Cam-Master Automates

| Manual (Blog) | IP-Cam-Master |
|---------------|---------------|
| Scan network manually for cameras | Auto-discovery with type detection |
| Remember and type credentials | Credential presets, auto-matched |
| SSH into Proxmox, create LXC | One click via Proxmox API + SSH |
| Install go2rtc, ffmpeg, Node.js | Automated in onboarding |
| Write go2rtc YAML config by hand | Generated from wizard inputs |
| Clone onvif-server, edit config | Auto-generated with MAC, UUID, stream mapping |
| Edit onvif-server.js for naming | Auto-patched (Manufacturer, Model, ONVIF name) |
| Check stream with separate tools | Live snapshot + service status dashboard |
| No overview of camera health | Dashboard with FPS, codec, model, UniFi connection |

## License

MIT
