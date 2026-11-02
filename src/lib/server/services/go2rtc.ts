import type { StreamInfo } from '$lib/types';

/**
 * Credentials that enable RTSP auth on go2rtc's port 8554.
 * When present, the generated go2rtc.yaml includes an `rtsp:` block
 * that requires clients (including UniFi Protect adoption) to
 * authenticate. Single quoted-YAML so `$ " \` etc. pass through literally.
 */
export type RtspAuth = { username: string; password: string };

function yamlSingleQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

function rtspServerBlock(auth?: RtspAuth): string {
	if (!auth) return '';
	return `
rtsp:
  listen: ":8554"
  username: ${yamlSingleQuote(auth.username)}
  password: ${yamlSingleQuote(auth.password)}
`;
}

export interface Go2rtcConfigParams {
	streamName: string;
	cameraIp: string;
	username: string;
	password: string;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	streamPath?: string; // deprecated — HTTP MJPEG URL is now generated automatically
	rtspAuth?: RtspAuth;
}

/**
 * Generates go2rtc YAML config with VAAPI hardware transcoding.
 * Works for both Mobotix (HTTP MJPEG + RTSP audio) and Loxone (nginx proxy, no audio).
 */
export function generateGo2rtcConfig(params: Go2rtcConfigParams): string {
	const { streamName, cameraIp, username, password, width, height, fps, bitrate, rtspAuth } = params;
	const bufsize = bitrate * 2;
	const sourceUrl = `http://${username}:${password}@${cameraIp}/control/faststream.jpg?stream=full&fps=${fps}&needlength`;
	const vaapiBase = `#video=h264#raw=-g ${fps}#hardware=vaapi#raw=-reconnect 1#raw=-reconnect_streamed 1#raw=-reconnect_delay_max 5`;

	// HQ: full resolution + audio passthrough
	const hqVideo = `ffmpeg:${sourceUrl}${vaapiBase}#width=${width}#height=${height}#raw=-maxrate ${bitrate}k#raw=-bufsize ${bufsize}k`;
	const audioSource = `ffmpeg:rtsp://${username}:${password}@${cameraIp}:554/stream0/mobotix.mjpeg#raw=-vn#audio=copy#raw=-rtsp_transport tcp`;

	// LQ: alias to HQ via local restream. Protect 1.20.7 only uses one stream
	// and sometimes picks LQ — by pointing it at HQ, we guarantee full
	// resolution regardless of which ONVIF profile Protect selects.
	// go2rtc bypasses RTSP auth for localhost, so the loopback needs no creds.
	return `streams:
  ${streamName}:
    - ${hqVideo}
    - ${audioSource}
  ${streamName}-low:
    - rtsp://127.0.0.1:8554/${streamName}
${rtspServerBlock(rtspAuth)}
ffmpeg:
  bin: ffmpeg

log:
  level: info
`;
}

/**
 * Generates a systemd unit file for go2rtc.
 */
export function generateSystemdUnit(): string {
	return `[Unit]
Description=go2rtc streaming server
After=network.target
# StartLimitIntervalSec=0 disables the 5-restarts-in-10s rate limit that
# would otherwise leave go2rtc stopped after a run of quick failures
# (seen during live config-reload cycles — OOM under memory pressure, or
# a bad exec: producer that exits fast). We want the service always up;
# if it genuinely loops, logs surface the cause separately.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/local/bin/go2rtc -config /etc/go2rtc/go2rtc.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Returns shell commands to install ffmpeg and go2rtc in an LXC container.
 *
 * When `forBambuA1` is true, appends the NodeSource Node 22 install so the
 * A1 ingestion script (lxc-assets/bambu-a1-camera.mjs) spawned via
 * `exec:node ...` can run. Without this hoist, first-time A1 adoption fails
 * with "node: command not found" because Node is otherwise only installed by
 * `getOnvifInstallCommands()` which runs AFTER `configureGo2rtc()`
 * (Phase 18 RESEARCH §Pitfall 5 / §Open Question 1).
 *
 * H2C, Mobotix, and Loxone paths call this with the default `false` — no
 * behavior change for pre-Phase-18 adoptions.
 */
export function getInstallCommands(forBambuA1 = false): string[] {
	const base = [
		// Debian 13 (Trixie) ships intel-media-va-driver 25.x with Arrow Lake+ support
		'apt-get update -qq && apt-get install -y -qq ffmpeg intel-media-va-driver wget',
		'wget -q https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_linux_amd64 -O /usr/local/bin/go2rtc && chmod +x /usr/local/bin/go2rtc',
		'mkdir -p /etc/go2rtc'
	];
	if (forBambuA1) {
		// A1 ingestion script runs under `exec:node /opt/ipcm/bambu-a1-camera.mjs`.
		// Installed here (not in getOnvifInstallCommands) because configureGo2rtc
		// runs before configureOnvif in the provision flow.
		base.push(
			'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs'
		);
	}
	return base;
}

/**
 * Generates go2rtc YAML config for a Loxone Intercom (reads from local nginx proxy, no audio).
 */
export function generateGo2rtcConfigLoxone(params: {
	streamName: string;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	rtspAuth?: RtspAuth;
}): string {
	const { streamName, width, height, fps, bitrate, rtspAuth } = params;
	const bufsize = bitrate * 2;
	const sourceUrl = `http://localhost:8081/mjpg/video.mjpg`;
	// Loxone Intercom natively streams at 25fps. Cap to 15fps — a doorbell
	// camera doesn't need 20+fps, and fewer frames = less VAAPI encode work.
	const cappedFps = Math.min(fps, 15);
	const vaapiBase = `#video=h264#raw=-r ${cappedFps}#raw=-g ${cappedFps}#hardware=vaapi#raw=-reconnect 1#raw=-reconnect_streamed 1#raw=-reconnect_delay_max 5`;

	return `streams:
  ${streamName}:
    - ffmpeg:${sourceUrl}${vaapiBase}#width=${width}#height=${height}#raw=-maxrate ${bitrate}k#raw=-bufsize ${bufsize}k
  ${streamName}-low:
    - rtsp://127.0.0.1:8554/${streamName}
${rtspServerBlock(rtspAuth)}
ffmpeg:
  bin: ffmpeg

log:
  level: info
`;
}

/**
 * Generates go2rtc YAML config for a Bambu Lab printer (H2C and future models).
 * Uses `rtspx://` scheme to skip TLS verification for the printer's self-signed
 * cert (per .planning/research/H2C-FIELD-NOTES.md). No VAAPI transcode — the
 * H2C already serves H.264, so `#video=copy` is sufficient (field notes
 * confirmed passthrough works cleanly at 1680x1080 30fps).
 */
export function generateGo2rtcConfigBambu(params: {
	streamName: string;
	printerIp: string;
	accessCode: string;
	rtspAuth?: RtspAuth;
}): string {
	const { streamName, printerIp, accessCode, rtspAuth } = params;
	const sourceUrl = `rtspx://bblp:${accessCode}@${printerIp}:322/streaming/live/1`;
	// HQ: passthrough (no transcode, 1680x1080 h264 as-is from printer).
	// LQ: VAAPI-accelerated downscale to 840x540 for Protect grid thumbnails.
	// Both share one RTSPS connection to the printer (go2rtc pulls HQ once,
	// LQ re-encodes from the local HQ restream via localhost:8554).
	return `streams:
  ${streamName}:
    - ${sourceUrl}#video=copy#audio=copy#reconnect_timeout=30
  ${streamName}-low:
    - ffmpeg:rtsp://127.0.0.1:8554/${streamName}#raw=-rtsp_transport tcp#video=h264#hardware=vaapi#width=840#height=540#raw=-g 30#raw=-maxrate 500k#raw=-bufsize 1000k
${rtspServerBlock(rtspAuth)}
ffmpeg:
  bin: ffmpeg

log:
  level: info
`;
}

/**
 * Generates go2rtc YAML for a Bambu Lab A1 printer.
 *
 * Unlike H2C (which exposes RTSPS on :322), A1 uses a proprietary JPEG-over-TLS
 * stream on port 6000. We spawn the ingestion Node script
 * (lxc-assets/bambu-a1-camera.mjs → /opt/ipcm/bambu-a1-camera.mjs inside the
 * LXC) via go2rtc's `exec:` pipe transport; the script emits raw concatenated
 * JPEGs on stdout, and go2rtc's `magic.Open()` auto-detects MJPEG from the
 * FF D8 SOI bytes (RESEARCH §Gap 1).
 *
 * `#killsignal=15#killtimeout=5` is MANDATORY — go2rtc's 2024-era default
 * is SIGKILL, which leaves the printer holding a stale TLS session for ~30s
 * (RESEARCH §Gap 4 / Pitfall 2). SIGTERM gives the Node script's shutdown
 * handler a chance to close the socket cleanly.
 *
 * Access code is passed via env var, NOT CLI arg, so it does not leak via
 * `ps ax` on the LXC (RESEARCH §Anti-Pattern 4 / Threat T-18-07).
 *
 * Script deployment: lxc-assets/bambu-a1-camera.mjs → /opt/ipcm/bambu-a1-camera.mjs
 * via `pushFileToContainer()` in onboarding.ts `configureGo2rtc` A1 branch.
 */
export function generateGo2rtcConfigBambuA1(params: {
	streamName: string;
	printerIp: string;
	accessCode: string;
	rtspAuth?: RtspAuth;
}): string {
	const { streamName, printerIp, accessCode, rtspAuth } = params;
	// Phase 18 / CR-01: Belt-and-braces — the route handler
	// (src/routes/api/onboarding/bambu/save-camera/+server.ts) is the primary
	// validation gate, but enforce the same invariants here so any future
	// caller that bypasses the route cannot reintroduce the injection sink.
	// Access codes are exactly 8 digits; IPs are IPv4 dotted-quads. Both are
	// interpolated into a shell-like go2rtc exec: string, so whitespace or
	// shell/YAML meta-characters must be rejected before the concat happens.
	if (!/^[0-9]{8}$/.test(accessCode)) {
		throw new Error('A1 access code must be exactly 8 digits');
	}
	if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(printerIp)) {
		throw new Error('A1 printer IP must be IPv4 dotted-quad');
	}
	const octetsOk = printerIp.split('.').every((o) => {
		const n = Number(o);
		return Number.isInteger(n) && n >= 0 && n <= 255;
	});
	if (!octetsOk) {
		throw new Error('A1 printer IP octets must be 0-255');
	}
	// Single-stream exec: pipeline. The /opt/ipcm/a1-transcode.sh wrapper
	// (deployed alongside the .mjs by onboarding.ts) runs:
	//
	//   node .mjs --ip=<ip>  →  cat  →  ffmpeg -f mpegts -
	//
	// Why a shell wrapper instead of go2rtc's native `ffmpeg:stream_name`
	// chaining:
	//   - go2rtc's `ffmpeg:exec:...` merges the exec command into ffmpeg's
	//     argv, so our `--ip=...` flag is rejected as an unknown ffmpeg
	//     option.
	//   - Two-stream chaining (exec raw + ffmpeg: transcode) requires the
	//     internal ffmpeg to pull via go2rtc's RTSP server back into itself.
	//     Even with credentials embedded in the URL, that loopback pull
	//     consistently timed out in live testing.
	//   - A single exec: that emits mpegts on stdout sidesteps both problems.
	//     go2rtc auto-detects mpegts from the magic bytes and re-serves the
	//     stream over RTSP. The transcoder script is simple bash + ffmpeg,
	//     easy to debug outside go2rtc with `A1_ACCESS_CODE=... ./a1-transcode.sh <ip>`.
	//
	// Lifecycle modifiers:
	//   #killsignal=15      → SIGTERM on shutdown (script forwards to .mjs + ffmpeg)
	//   #killtimeout=5      → 5s grace before SIGKILL
	const execCmd =
		`exec:env A1_ACCESS_CODE=${accessCode} ` +
		`/opt/ipcm/a1-transcode.sh ${printerIp}` +
		`#killsignal=15#killtimeout=5`;
	return `streams:
  ${streamName}:
    - ${execCmd}
${rtspServerBlock(rtspAuth)}
log:
  level: info
`;
}

/**
 * Generates nginx config for Loxone Intercom auth-proxy.
 */
export function generateNginxConfig(intercomIp: string, username: string, password: string): string {
	const authBase64 = Buffer.from(`${username}:${password}`).toString('base64');

	return `worker_processes 1;

events {
    worker_connections 1024;
}

http {
    server {
        listen 127.0.0.1:8081;

        location /mjpg/ {
            proxy_pass http://${intercomIp}/mjpg/;
            proxy_set_header Authorization "Basic ${authBase64}";
            proxy_set_header Host $host;
            proxy_set_header Connection "";
            proxy_http_version 1.1;
            proxy_buffering off;
        }
    }
}
`;
}

/**
 * Returns shell commands to install nginx in an LXC container.
 */
export function getNginxInstallCommands(): string[] {
	return [
		'apt-get install -y -qq nginx'
	];
}

/**
 * Returns shell commands to install the ONVIF server in an LXC container.
 */
export function getOnvifInstallCommands(): string[] {
	// Single combined command to minimize SSH roundtrips (saves ~2 min)
	return [
		'apt-get install -y -qq git curl && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs && cd /root && git clone https://github.com/daniela-hase/onvif-server.git && cd /root/onvif-server && npm install --production'
	];
}

/**
 * Generates ONVIF server config.yaml for a camera stream.
 */
export function generateOnvifConfig(params: {
	streamName: string;
	cameraName: string;
	mac: string;
	uuid: string;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	onvifPort?: number;
}): string {
	const {
		streamName,
		cameraName,
		mac,
		uuid,
		width,
		height,
		fps,
		bitrate,
		onvifPort = 8899
	} = params;

	const lqWidth = Math.round(width / 2);
	const lqHeight = Math.round(height / 2);
	const lqBitrate = Math.max(500, Math.round(bitrate / 5));

	return `onvif:
  - mac: ${mac}
    ports:
      server: ${onvifPort}
      rtsp: 8556
      snapshot: 8580
    name: ${cameraName}
    uuid: ${uuid}
    highQuality:
      rtsp: /${streamName}
      snapshot: /api/frame.jpeg?src=${streamName}
      width: ${width}
      height: ${height}
      framerate: ${fps}
      bitrate: ${bitrate}
      quality: 4
    lowQuality:
      rtsp: /${streamName}
      snapshot: /api/frame.jpeg?src=${streamName}
      width: ${width}
      height: ${height}
      framerate: ${fps}
      bitrate: ${bitrate}
      quality: 1
    target:
      hostname: localhost
      ports:
        rtsp: 8554
        snapshot: 1984
`;
}

/**
 * Generates a systemd unit file for the ONVIF server.
 */
export function generateOnvifSystemdUnit(): string {
	return `[Unit]
Description=ONVIF Server
After=go2rtc.service network-online.target

[Service]
Type=simple
WorkingDirectory=/root/onvif-server
ExecStartPre=/bin/sleep 12
ExecStartPre=/root/onvif-server/update-mac.sh
ExecStart=/usr/bin/node /root/onvif-server/main.js /root/onvif-server/config.yaml
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Returns a Node.js script that patches the ONVIF server to advertise
 * AudioSourceConfiguration + G.711 AudioEncoderConfiguration in profiles.
 * This makes UniFi Protect enable the mic toggle and receive audio.
 */
export function getOnvifAudioPatch(): string {
	return `const fs = require('fs');
const path = '/root/onvif-server/src/onvif-server.js';
let code = fs.readFileSync(path, 'utf8');

if (code.includes('AudioSourceConfiguration')) {
  console.log('Already patched');
  process.exit(0);
}

// Add audioSource after videoSource
code = code.replace(
  "this.profiles = [",
  \`this.audioSource = {
            attributes: { token: 'audio_src_token' },
            Channels: 1
        };

        this.profiles = [\`
);

// Audio config block for profiles
const audioConfig = \`                AudioSourceConfiguration: {
                    Name: 'AudioSource',
                    UseCount: 2,
                    attributes: { token: 'audio_src_config_token' },
                    SourceToken: 'audio_src_token'
                },
                AudioEncoderConfiguration: {
                    attributes: { token: 'audio_encoder_config_token' },
                    Name: 'G711',
                    UseCount: 1,
                    Encoding: 'G711',
                    Bitrate: 64,
                    SampleRate: 8,
                    SessionTimeout: 'PT1000S'
                },\`;

// Insert into MainStream profile
code = code.replace(
  \`                VideoEncoderConfiguration: {
                    attributes: {
                        token: 'encoder_hq_config_token'
                    },\`,
  audioConfig + \`
                VideoEncoderConfiguration: {
                    attributes: {
                        token: 'encoder_hq_config_token'
                    },\`
);

// Insert into SubStream profile
code = code.replace(
  \`                    VideoEncoderConfiguration: {
                        attributes: {
                            token: 'encoder_lq_config_token'
                        },\`,
  audioConfig.replace(/^/gm, '    ') + \`
                    VideoEncoderConfiguration: {
                        attributes: {
                            token: 'encoder_lq_config_token'
                        },\`
);

// Add GetAudioSources handler
code = code.replace(
  "GetProfiles: (args) =>",
  \`GetAudioSources: (args) => {
                        return { AudioSources: this.audioSource };
                    },
                    GetAudioEncoderConfigurations: (args) => {
                        return {
                            Configurations: {
                                attributes: { token: 'audio_encoder_config_token' },
                                Name: 'G711',
                                UseCount: 1,
                                Encoding: 'G711',
                                Bitrate: 64,
                                SampleRate: 8,
                                SessionTimeout: 'PT1000S'
                            }
                        };
                    },
                    GetProfiles: (args) =>\`
);

fs.writeFileSync(path, code);
console.log('ONVIF audio patch applied');
`;
}

/**
 * Generates go2rtc YAML for the Protect Hub bridge container.
 * Includes the idempotency stamp (L-8) and hello-world test stream.
 * API binds to 0.0.0.0:1984 with editor disabled (D-API-BIND-01).
 */
export function generateBridgeConfig(): string {
	const reconcileId = crypto.randomUUID();
	const ts = new Date().toISOString();
	return `# managed by ip-cam-master, reconcile-id ${reconcileId}, ts ${ts}
api:
  listen: "0.0.0.0:1984"
  ui_editor: false

streams:
  test: exec:ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=10 -c:v libx264 -f rtsp {output}

ffmpeg:
  bin: ffmpeg

log:
  level: info
`;
}

/**
 * Generates a systemd unit for go2rtc on the bridge container.
 * Identical to camera unit but adds LimitNOFILE=4096 (L-25).
 */
export function generateBridgeSystemdUnit(): string {
	return `[Unit]
Description=go2rtc streaming server
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/local/bin/go2rtc -config /etc/go2rtc/go2rtc.yaml
Restart=always
RestartSec=5
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Checks stream health via go2rtc HTTP API.
 */
export async function checkStreamHealth(
	containerIp: string,
	streamName: string
): Promise<StreamInfo> {
	try {
		const response = await fetch(`http://${containerIp}:1984/api/streams`);
		const data = await response.json();

		const stream = data[streamName];
		if (!stream) {
			return { active: false, codec: null, audioCodec: null, producers: 0, resolution: null };
		}

		const producers = Array.isArray(stream.producers) ? stream.producers.length : 0;
		const audioProducer = stream.producers?.find((p: any) =>
			p.medias?.some((m: string) => m.includes('audio'))
		);
		const audioCodec = audioProducer?.medias
			?.find((m: string) => m.includes('audio'))
			?.match(/audio,\s*\w+,\s*(.+)/)?.[1] || null;

		return {
			active: producers > 0,
			codec: stream.producers?.[0]?.codec || null,
			audioCodec,
			producers,
			resolution: stream.producers?.[0]?.resolution || null
		};
	} catch {
		return { active: false, codec: null, audioCodec: null, producers: 0, resolution: null };
	}
}

/**
 * Returns a Node.js script that replaces daniela-hase/onvif-server's
 * soap.listen-based handling with a minimal custom SOAP responder.
 *
 * Why: the bundled node-soap@1.1.5 does not resolve the WSDL's remote
 * <wsdl:import>, so definitions.messages stays empty and every incoming
 * SOAP request crashes with "Cannot read properties of undefined
 * (reading 'description')". The crash occurs before requests reach our
 * GetDeviceInformation / GetProfiles / GetStreamUri handlers, so
 * UniFi Protect's adoption flow fails at the credential-validation step.
 *
 * The patch swaps the HTTP+SOAP plumbing for a tiny handler that reads
 * the request body, extracts the method name via regex, calls the
 * matching handler already defined on this.onvif, and serialises the
 * result back out as a SOAP 1.2 envelope. WS-Discovery on UDP/3702 and
 * the /snapshot.png endpoint are left untouched.
 *
 * Idempotent: no-ops on already-patched files.
 */
export function getOnvifSoapPatch(): string {
	return `const fs = require('fs');
const src = '/root/onvif-server/src/onvif-server.js';
let code = fs.readFileSync(src, 'utf8');

if (code.includes('_handleSoap(req, res')) {
  console.log('Already patched');
  process.exit(0);
}

const newStartServer = \`startServer() {
        const urlMod = require('url');
        const self = this;

        this.server = http.createServer((req, res) => {
            const pathname = urlMod.parse(req.url).pathname;
            if (pathname === '/snapshot.png') {
                const image = fs.readFileSync('./resources/snapshot.png');
                res.writeHead(200, {'Content-Type': 'image/png'});
                res.end(image, 'binary');
                return;
            }
            if (req.method === 'POST' && pathname === '/onvif/device_service') {
                return self._handleSoap(req, res, self.onvif.DeviceService.Device, 'tds', 'http://www.onvif.org/ver10/device/wsdl');
            }
            if (req.method === 'POST' && pathname === '/onvif/media_service') {
                return self._handleSoap(req, res, self.onvif.MediaService.Media, 'trt', 'http://www.onvif.org/ver10/media/wsdl');
            }
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('404 Not Found\\\\n');
        });
        this.server.listen(this.config.ports.server, this.config.hostname);
    }

    _handleSoap(req, res, handlers, prefix, ns) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const m = body.match(/<(?:[A-Za-z0-9]+:)?Body[^>]*>\\\\s*<(?:[A-Za-z0-9]+:)?([A-Z][A-Za-z0-9]+)/);
            if (!m) { res.writeHead(400); res.end('Bad SOAP'); return; }
            const methodName = m[1];
            const handler = handlers[methodName];
            const args = this._parseArgs(body);
            let result = {};
            if (typeof handler === 'function') {
                try { result = handler(args) || {}; } catch (e) { result = {}; }
            }
            const inner = this._serialize(result, prefix);
            const respBody = \\\`<\\\${prefix}:\\\${methodName}Response xmlns:\\\${prefix}="\\\${ns}" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns="\\\${ns}">\\\${inner}</\\\${prefix}:\\\${methodName}Response>\\\`;
            const envelope = \\\`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><soap:Body>\\\${respBody}</soap:Body></soap:Envelope>\\\`;
            res.writeHead(200, {'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(envelope)});
            res.end(envelope);
        });
        req.on('error', () => { try { res.writeHead(500); res.end(); } catch (e) {} });
    }

    _parseArgs(body) {
        const args = {};
        const picks = ['Category', 'ProfileToken', 'IncludeCapability', 'StreamSetup'];
        for (const tag of picks) {
            const r = new RegExp('<(?:[A-Za-z0-9]+:)?' + tag + '[^>]*>([^<]*)<', 'i');
            const match = body.match(r);
            if (match) args[tag] = match[1];
        }
        return args;
    }

    _escapeXml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _renderAttrs(obj) {
        if (!obj || typeof obj !== 'object' || !obj.attributes) return '';
        const a = obj.attributes;
        return Object.keys(a).map(k => ' ' + k + '="' + this._escapeXml(a[k]) + '"').join('');
    }

    _serialize(obj, prefix) {
        if (obj === null || obj === undefined) return '';
        if (typeof obj !== 'object') return this._escapeXml(obj);
        if (Array.isArray(obj)) return obj.map(i => this._serialize(i, prefix)).join('');
        let xml = '';
        for (const key of Object.keys(obj)) {
            if (key === 'attributes') continue;
            const v = obj[key];
            if (v === undefined || v === null) continue;
            const tag = prefix + ':' + key;
            if (Array.isArray(v)) {
                for (const item of v) {
                    if (item !== null && typeof item === 'object') {
                        const a = this._renderAttrs(item);
                        const inner = this._serialize(item, prefix);
                        xml += inner === '' ? ('<' + tag + a + '/>') : ('<' + tag + a + '>' + inner + '</' + tag + '>');
                    } else {
                        xml += '<' + tag + '>' + this._escapeXml(item) + '</' + tag + '>';
                    }
                }
            } else if (typeof v === 'object') {
                const a = this._renderAttrs(v);
                const inner = this._serialize(v, prefix);
                xml += inner === '' ? ('<' + tag + a + '/>') : ('<' + tag + a + '>' + inner + '</' + tag + '>');
            } else {
                xml += '<' + tag + '>' + this._escapeXml(v) + '</' + tag + '>';
            }
        }
        return xml;
    }

    enableDebugOutput() { /* no-op: soap-library specific */ }\`;

const re = /startServer\\(\\) \\{[\\s\\S]*?enableDebugOutput\\(\\) \\{[\\s\\S]*?\\}\\s*(?=startDiscovery\\(\\))/;
if (!re.test(code)) { console.error('startServer block not found — aborting'); process.exit(1); }
code = code.replace(re, newStartServer + '\\n\\n    ');
fs.writeFileSync(src, code);
console.log('onvif-server.js patched with custom SOAP responder');
`;
}
