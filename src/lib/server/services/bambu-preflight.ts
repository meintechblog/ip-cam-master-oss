import net from 'node:net';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';
import { BAMBU_USERNAME } from './bambu-credentials';
import { PRINTER_CAPABILITIES } from './bambu-discovery';
import { checkTls6000Real, type Tls6000Fail } from './bambu-a1-camera';

/**
 * Bambu pre-flight handler — runs sequential connectivity checks
 * against a Bambu printer and returns a structured verdict.
 *
 * Ground truth (H2C):   .planning/research/H2C-FIELD-NOTES.md
 * Ground truth (A1):    .planning/phases/18-bambu-a1-camera-integration/
 *                         18-RESEARCH.md + 18-CONTEXT.md D-05
 *                       .planning/spikes/003-a1-mqtt-lan (TUTK field)
 *                       .planning/spikes/004-a1-stream-fallback (TLS:6000)
 *
 * Never run checks in parallel — H2C has a single-connection limit
 * (PITFALLS.md §1). Every external call has a hard timeout.
 *
 * Phase 18 / BAMBU-A1-04: `runBambuPreflight` now branches on the
 * `cameraTransport` capability from PRINTER_CAPABILITIES. H2C retains the
 * existing RTSPS:322 + MQTT sequence; A1 skips RTSPS and runs a TLS:6000
 * auth probe plus a TUTK pushall check to surface cloud-mode state
 * (`A1_CLOUD_MODE_ACTIVE`). Default `model = 'H2C'` preserves backward-
 * compat for callers that don't pass the third argument.
 */

export type PreflightError =
	| 'PRINTER_UNREACHABLE'
	| 'LAN_MODE_OFF'
	| 'WRONG_ACCESS_CODE'
	| 'A1_CAMERA_DISABLED'
	| 'RTSPS_HANDSHAKE_HUNG'
	| 'A1_CLOUD_MODE_ACTIVE';

export type PreflightResult =
	| { ok: true }
	| { ok: false; error: PreflightError; hint: string };

export const PREFLIGHT_HINTS_DE: Record<PreflightError, string> = {
	PRINTER_UNREACHABLE:
		'Drucker nicht erreichbar. IP-Adresse und Netzwerkverbindung prüfen.',
	LAN_MODE_OFF:
		'LAN Mode scheint deaktiviert. Am Drucker: Einstellungen → Netzwerk → LAN Mode aktivieren.',
	WRONG_ACCESS_CODE:
		'Access Code abgelehnt. Am Drucker-Display aktuellen Code ablesen (Einstellungen → Netzwerk → Access Code).',
	A1_CAMERA_DISABLED:
		'Access Code OK, aber die Kamera ist am Drucker deaktiviert (ipcam_dev=0). Beim A1 Mini liegt der Toggle in der Bambu Handy App: Gerät → Kamera-Tab → LiveView aktivieren.',
	RTSPS_HANDSHAKE_HUNG:
		'RTSPS-Server antwortet nicht (Live555 hängt). Drucker bitte kurz aus- und wieder einschalten.',
	A1_CLOUD_MODE_ACTIVE:
		'Cloud-Modus ist aktiv. Bambu Handy App → Gerät → "LAN Mode only" aktivieren und Cloud-Verbindung deaktivieren.'
};

export interface PreflightInput {
	ip: string;
	serialNumber: string;
	accessCode: string;
}

export type CheckOk = { ok: true };
export type TcpFail = { ok: false; reason: 'REFUSED' | 'TIMEOUT' | 'UNREACHABLE' };
export type RtspsFail = { ok: false; reason: 'AUTH' | 'TIMEOUT' | 'REFUSED' };
export type MqttFail = { ok: false; reason: 'AUTH' | 'TIMEOUT' };
export type TutkFail = { ok: false; reason: 'ENABLED' | 'TIMEOUT' };

// Re-export so other modules can import both the interface and the
// failure shape from one place.
export type { Tls6000Fail };

export interface PreflightDeps {
	checkTcp(ip: string, port: number, timeoutMs: number): Promise<CheckOk | TcpFail>;
	checkRtsps(ip: string, accessCode: string, timeoutMs: number): Promise<CheckOk | RtspsFail>;
	checkMqtt(ip: string, accessCode: string, timeoutMs: number): Promise<CheckOk | MqttFail>;
	checkTls6000(
		ip: string,
		accessCode: string,
		timeoutMs: number
	): Promise<CheckOk | Tls6000Fail>;
	checkTutkDisabled(
		ip: string,
		accessCode: string,
		serial: string,
		timeoutMs: number
	): Promise<CheckOk | TutkFail>;
}

function fail(error: PreflightError): PreflightResult {
	return { ok: false, error, hint: PREFLIGHT_HINTS_DE[error] };
}

/**
 * Run preflight for a Bambu printer.
 *
 * Backward-compat contract: `runBambuPreflight(input, deps)` without a model
 * argument preserves the pre-Phase-18 H2C flow. Callers that want the A1
 * branch pass `model = 'A1'`; unknown/absent model values fall back to H2C
 * so we never crash on a PRINTER_CAPABILITIES miss.
 *
 * Flow (model-keyed via PRINTER_CAPABILITIES[model].cameraTransport):
 *   1. checkTcp(8883, 3000)                           [universal]
 *   2a. H2C path (rtsps-322):   checkTcp(322) + checkRtsps
 *   2b. A1 path  (jpeg-tls-6000): checkTls6000(6000)
 *   3. checkMqtt(8883)                                [universal]
 *   4a. H2C path: done
 *   4b. A1 path:  checkTutkDisabled (cloud-mode guard per CONTEXT D-05)
 */
export async function runBambuPreflight(
	input: PreflightInput,
	deps: PreflightDeps,
	model: string = 'H2C'
): Promise<PreflightResult> {
	const caps = PRINTER_CAPABILITIES[model] ?? PRINTER_CAPABILITIES['H2C'];

	// Phase 1: MQTT TCP reachability — universal. Covers "printer powered off"
	// or "network unreachable" before we spend time on the camera-transport
	// probe.
	const tcpMqtt = await deps.checkTcp(input.ip, 8883, 3000);
	if (!tcpMqtt.ok) return fail('PRINTER_UNREACHABLE');

	// Phase 2: camera-transport-specific probe
	if (caps.cameraTransport === 'rtsps-322') {
		// H2C path — existing sequence preserved (port 322 probe + full RTSPS
		// handshake via ffprobe).
		const tcp = await deps.checkTcp(input.ip, 322, 3000);
		if (!tcp.ok) {
			// ECONNREFUSED on :322 = printer is on the network but the RTSPS
			// port is closed = LAN Mode disabled.
			if (tcp.reason === 'REFUSED') return fail('LAN_MODE_OFF');
			return fail('PRINTER_UNREACHABLE');
		}
		const rtsps = await deps.checkRtsps(input.ip, input.accessCode, 12000);
		if (!rtsps.ok) {
			if (rtsps.reason === 'AUTH') return fail('WRONG_ACCESS_CODE');
			if (rtsps.reason === 'REFUSED') return fail('LAN_MODE_OFF');
			return fail('RTSPS_HANDSHAKE_HUNG');
		}
	} else if (caps.cameraTransport === 'jpeg-tls-6000') {
		// A1 path — TLS:6000 auth probe. Three outcomes worth distinguishing
		// (see bambu-a1-camera.ts checkTls6000Real for the live signatures):
		//   - AUTH_REJECTED    = printer FINs within ms after auth  → wrong code
		//   - CAMERA_DISABLED  = socket stays open with zero data    → ipcam_dev=0
		//   - REFUSED/TIMEOUT  = port closed or unreachable
		const tls6000 = await deps.checkTls6000(input.ip, input.accessCode, 6000);
		if (!tls6000.ok) {
			if (tls6000.reason === 'REFUSED') return fail('PRINTER_UNREACHABLE');
			if (tls6000.reason === 'AUTH_REJECTED') return fail('WRONG_ACCESS_CODE');
			if (tls6000.reason === 'CAMERA_DISABLED') return fail('A1_CAMERA_DISABLED');
			// TLS_HANDSHAKE / TIMEOUT → treat as unreachable (conservative).
			return fail('PRINTER_UNREACHABLE');
		}
	}

	// Phase 3: MQTT auth — universal. Even if the camera-transport probe
	// passed, we still need a valid MQTT session (control-plane + adaptive
	// stream mode) before adoption proceeds.
	const mqttResult = await deps.checkMqtt(input.ip, input.accessCode, 5000);
	if (!mqttResult.ok) {
		if (mqttResult.reason === 'AUTH') return fail('WRONG_ACCESS_CODE');
		return fail('LAN_MODE_OFF');
	}

	// Phase 4: A1-only TUTK cloud-mode guard (CONTEXT D-05).
	// Reads `print.ipcam.tutk_server` from one pushall response. If the
	// printer is in cloud mode, camera RTSP is relayed through Bambu cloud
	// and the LXC ingestion script cannot reach it — surface this as a
	// first-class error with an actionable German hint.
	if (caps.cameraTransport === 'jpeg-tls-6000') {
		const tutk = await deps.checkTutkDisabled(
			input.ip,
			input.accessCode,
			input.serialNumber,
			5000
		);
		if (!tutk.ok) return fail('A1_CLOUD_MODE_ACTIVE');
	}

	return { ok: true };
}

// ---------------------------------------------------------------------------
// Real check implementations — wired into realDeps below.
// Tests use dep-injected mocks, so these are NOT exercised in CI.
// ---------------------------------------------------------------------------

async function checkTcpReal(
	ip: string,
	port: number,
	timeoutMs: number
): Promise<CheckOk | TcpFail> {
	return new Promise((resolve) => {
		const sock = net.connect({ host: ip, port });
		let settled = false;
		const finish = (result: CheckOk | TcpFail): void => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				/* noop */
			}
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: 'TIMEOUT' }), timeoutMs);
		timer.unref();
		sock.once('connect', () => {
			clearTimeout(timer);
			finish({ ok: true });
		});
		sock.once('error', (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			// Printer alive on the network but the port has no listener =
			// LAN Mode disabled. Distinguishing this from a genuinely
			// unreachable host makes the preflight hint actionable.
			if (err && err.code === 'ECONNREFUSED') return finish({ ok: false, reason: 'REFUSED' });
			finish({ ok: false, reason: 'UNREACHABLE' });
		});
	});
}

async function checkRtspsReal(
	ip: string,
	accessCode: string,
	timeoutMs: number
): Promise<CheckOk | RtspsFail> {
	// URL template confirmed working — H2C-FIELD-NOTES.md §Recommendations #2.
	// Flags per same section. External SIGKILL wrapper because ffmpeg's
	// own -timeout/-rw_timeout are version-dependent.
	const url = `rtsps://${BAMBU_USERNAME}:${encodeURIComponent(accessCode)}@${ip}:322/streaming/live/1`;
	return new Promise((resolve) => {
		const proc = spawn('ffprobe', [
			'-hide_banner',
			'-loglevel',
			'error',
			'-rtsp_transport',
			'tcp',
			'-tls_verify',
			'0',
			'-i',
			url
		]);
		let stderr = '';
		let settled = false;
		const finish = (r: CheckOk | RtspsFail): void => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		proc.stderr.on('data', (b) => {
			stderr += b.toString('utf8');
		});
		const timer = setTimeout(() => {
			try {
				proc.kill('SIGKILL');
			} catch {
				/* noop */
			}
			finish({ ok: false, reason: 'TIMEOUT' });
		}, timeoutMs);
		timer.unref();
		proc.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) return finish({ ok: true });
			const lower = stderr.toLowerCase();
			if (lower.includes('401') || lower.includes('unauthorized')) {
				return finish({ ok: false, reason: 'AUTH' });
			}
			if (lower.includes('connection refused') || lower.includes('econnrefused')) {
				return finish({ ok: false, reason: 'REFUSED' });
			}
			// Unknown non-zero exit → treat as hang class (safer than AUTH).
			finish({ ok: false, reason: 'TIMEOUT' });
		});
		proc.on('error', () => {
			clearTimeout(timer);
			finish({ ok: false, reason: 'TIMEOUT' });
		});
	});
}

async function checkMqttReal(
	ip: string,
	accessCode: string,
	timeoutMs: number
): Promise<CheckOk | MqttFail> {
	// Use Node mqtt pkg per H2C-FIELD-NOTES §Recommendations #5 —
	// mosquitto_sub 2.0.21 on Debian 13 cannot negotiate the H2C self-signed
	// cert. rejectUnauthorized:false is mandatory. reconnectPeriod:0 keeps
	// this a one-shot probe (PITFALLS §7).
	try {
		const client = await mqtt.connectAsync(`mqtts://${ip}:8883`, {
			username: BAMBU_USERNAME,
			password: accessCode,
			rejectUnauthorized: false,
			connectTimeout: timeoutMs,
			reconnectPeriod: 0
		});
		await client.endAsync(true);
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
		if (
			msg.includes('not authorized') ||
			msg.includes('bad user name') ||
			msg.includes('bad username') ||
			msg.includes('connack')
		) {
			return { ok: false, reason: 'AUTH' };
		}
		return { ok: false, reason: 'TIMEOUT' };
	}
}

/**
 * Phase 18 / BAMBU-A1-05: TUTK cloud-mode guard.
 *
 * Opens a one-shot MQTT session, subscribes to `device/<SN>/report`, publishes
 * a pushall request, and reads the first message. If `print.ipcam.tutk_server
 * === 'enable'`, the printer is in cloud mode (Bambu Handy App relays the
 * camera through TUTK) and the LXC ingestion script cannot pull frames
 * directly from port 6000. Returns `{ok:false, reason:'ENABLED'}` in that
 * case; timeout (no message in `timeoutMs`) → `{ok:false, reason:'TIMEOUT'}`
 * so the caller maps to `A1_CLOUD_MODE_ACTIVE` conservatively.
 *
 * Pattern mirrors `checkMqttReal` above (connectAsync + reconnectPeriod:0 +
 * rejectUnauthorized:false). Access code flows through function args and
 * mqtt options only — never logged.
 *
 * A message arriving with `tutk_server` undefined or any value other than
 * `'enable'` (e.g., `'disable'`) is treated as a pass — some firmware
 * revisions omit the field on non-camera pushall replies; we only fail on
 * the explicit enable signal.
 */
async function checkTutkDisabledReal(
	ip: string,
	accessCode: string,
	serial: string,
	timeoutMs: number
): Promise<CheckOk | TutkFail> {
	return new Promise((resolve) => {
		const client = mqtt.connect(`mqtts://${ip}:8883`, {
			username: BAMBU_USERNAME,
			password: accessCode,
			rejectUnauthorized: false,
			connectTimeout: timeoutMs,
			reconnectPeriod: 0
		});
		let settled = false;
		const finish = (r: CheckOk | TutkFail): void => {
			if (settled) return;
			settled = true;
			try {
				client.end(true);
			} catch {
				/* noop */
			}
			resolve(r);
		};
		const timer = setTimeout(() => finish({ ok: false, reason: 'TIMEOUT' }), timeoutMs);
		timer.unref();
		client.on('connect', () => {
			client.subscribe(`device/${serial}/report`, () => {
				client.publish(
					`device/${serial}/request`,
					JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } })
				);
			});
		});
		client.on('message', (_topic, payload) => {
			let msg: { print?: { ipcam?: { tutk_server?: string } } };
			try {
				msg = JSON.parse(payload.toString());
			} catch {
				// Not a parseable JSON payload — keep waiting for the next msg
				// until the timer fires.
				return;
			}
			const tutk = msg?.print?.ipcam?.tutk_server;
			if (typeof tutk === 'string' && tutk !== 'enable') {
				clearTimeout(timer);
				return finish({ ok: true });
			}
			if (tutk === 'enable') {
				clearTimeout(timer);
				return finish({ ok: false, reason: 'ENABLED' });
			}
			// Field absent — could be a delta that doesn't carry ipcam.
			// Keep waiting for the authoritative pushall reply.
		});
		client.on('error', () => {
			clearTimeout(timer);
			finish({ ok: false, reason: 'TIMEOUT' });
		});
	});
}

export const realDeps: PreflightDeps = {
	checkTcp: checkTcpReal,
	checkRtsps: checkRtspsReal,
	checkMqtt: checkMqttReal,
	checkTls6000: checkTls6000Real,
	checkTutkDisabled: checkTutkDisabledReal
};
