import tls from 'node:tls';
import { BAMBU_USERNAME } from './bambu-credentials';
import { buildAuth } from './bambu-a1-auth';

/**
 * Bambu A1 JPEG-over-TLS helpers (Phase 18 / BAMBU-A1-04).
 *
 * The A1 diverges from H2C at the camera-ingestion port: it has no RTSPS on
 * port 322; instead it exposes a proprietary JPEG-over-TLS stream on port
 * 6000 that requires an 80-byte auth handshake before any frames are sent.
 *
 * Ground truth: .planning/spikes/004-a1-stream-fallback/README.md + probe.mjs
 * (validated 2026-04-20 against the real A1 at 192.0.2.195). The 0x3000
 * vs 0x30 silent-fail trap lives in buildAuth (Plan 18-02); this module
 * consumes it.
 *
 * Trust boundary: LAN-only. `rejectUnauthorized: false` mirrors the existing
 * H2C MQTT/RTSPS paths (self-signed BBL cert per RESEARCH §Security Threat
 * Model). Access code flows through function args and buildAuth only —
 * NEVER logged, NEVER written to error messages.
 *
 * Promise pattern mirrors `checkTcpReal` / `checkRtspsReal` in
 * bambu-preflight.ts:91-184 — settled-guard, timer.unref, resolve-once.
 */

export type CheckOk = { ok: true };
export type Tls6000Fail = {
	ok: false;
	reason: 'REFUSED' | 'TIMEOUT' | 'AUTH_REJECTED' | 'CAMERA_DISABLED' | 'TLS_HANDSHAKE';
};

/**
 * Preflight probe for A1 port-6000 JPEG-over-TLS auth.
 *
 * Three observed printer behaviours after we send the auth packet (see live
 * tcpdump on real A1 + A1 Mini hardware, 2026-04-29):
 *   - data arrives                 → AUTH OK, camera streaming  → ok: true
 *   - server closes within <1s     → AUTH REJECTED (real wrong code)
 *   - socket stays open, no bytes  → AUTH OK BUT CAMERA DISABLED
 *     (`ipcam_dev: "0"` in the printer's MQTT report — user has the
 *     Liveview / camera switch turned off in the printer's display menu)
 *
 * Earlier versions collapsed the latter two into AUTH_SILENT_DROP and
 * surfaced them as WRONG_ACCESS_CODE, which sent users hunting for a code
 * that was actually correct. Splitting the two is essential for an
 * actionable hint.
 *
 * Failure classification:
 *   - ECONNREFUSED                          → REFUSED (port closed)
 *   - ETIMEDOUT                             → TIMEOUT (network unreachable)
 *   - timer before `secureConnect`          → TLS_HANDSHAKE
 *   - `close` after auth, no data           → AUTH_REJECTED
 *   - timer after `secureConnect`, no data, socket still open → CAMERA_DISABLED
 *   - other `error` events                  → TLS_HANDSHAKE (catch-all)
 */
export async function checkTls6000Real(
	ip: string,
	accessCode: string,
	timeoutMs: number
): Promise<CheckOk | Tls6000Fail> {
	return new Promise((resolve) => {
		const socket = tls.connect({
			host: ip,
			port: 6000,
			rejectUnauthorized: false,
			timeout: timeoutMs
		});
		let authSent = false;
		let settled = false;
		let dataSeen = false;
		const finish = (r: CheckOk | Tls6000Fail): void => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				/* noop */
			}
			resolve(r);
		};
		const timer = setTimeout(
			() =>
				finish(
					authSent
						? { ok: false, reason: 'CAMERA_DISABLED' }
						: { ok: false, reason: 'TLS_HANDSHAKE' }
				),
			timeoutMs
		);
		timer.unref();
		socket.on('secureConnect', () => {
			socket.write(buildAuth(BAMBU_USERNAME, accessCode));
			authSent = true;
		});
		socket.on('data', () => {
			dataSeen = true;
			clearTimeout(timer);
			finish({ ok: true });
		});
		socket.on('close', () => {
			clearTimeout(timer);
			// Server-side close before any data and after auth was sent =
			// printer rejected the credential. Confirmed live: wrong code →
			// FIN within 6ms; right code → connection stays open even when
			// the camera switch is off.
			if (authSent && !dataSeen) {
				finish({ ok: false, reason: 'AUTH_REJECTED' });
			} else {
				finish({ ok: false, reason: 'TLS_HANDSHAKE' });
			}
		});
		socket.on('error', (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err?.code === 'ECONNREFUSED') return finish({ ok: false, reason: 'REFUSED' });
			if (err?.code === 'ETIMEDOUT') return finish({ ok: false, reason: 'TIMEOUT' });
			finish({ ok: false, reason: 'TLS_HANDSHAKE' });
		});
	});
}

/**
 * One-shot snapshot fetch: connect → auth → read first 16-byte header +
 * N-byte JPEG → destroy socket. Returns null on timeout, bad frame size,
 * non-JPEG payload, or any socket error.
 *
 * Frame format (spike 004 README §Stream protocol):
 *   - 16-byte frame header; first u32 LE is payload size
 *   - N-byte JPEG payload starting `FF D8`, ending `FF D9`
 *
 * Used by `/api/cameras/:id/a1-snapshot` (Plan 18-06) — kept in this module
 * so preflight + snapshot share one TLS probe implementation.
 */
export async function fetchA1SnapshotJpeg(
	ip: string,
	accessCode: string,
	timeoutMs = 8000
): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const socket = tls.connect({
			host: ip,
			port: 6000,
			rejectUnauthorized: false,
			timeout: timeoutMs
		});
		let buf = Buffer.alloc(0);
		let settled = false;
		const finish = (r: Buffer | null): void => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				/* noop */
			}
			resolve(r);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref();
		socket.on('secureConnect', () => {
			socket.write(buildAuth(BAMBU_USERNAME, accessCode));
		});
		socket.on('data', (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length < 16) return;
			const size = buf.readUInt32LE(0);
			// Guard against bogus frame sizes — real frames observed at ~100-300 KB.
			if (size === 0 || size > 5_000_000) {
				clearTimeout(timer);
				return finish(null);
			}
			if (buf.length < 16 + size) return;
			const jpeg = buf.subarray(16, 16 + size);
			clearTimeout(timer);
			if (jpeg[0] === 0xff && jpeg[1] === 0xd8) {
				finish(Buffer.from(jpeg));
			} else {
				finish(null);
			}
		});
		socket.on('error', () => {
			clearTimeout(timer);
			finish(null);
		});
	});
}
