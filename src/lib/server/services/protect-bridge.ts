// v1.3 Phase 19 — lib boundary for new Protect read paths.
// Hand-rolled `protect.ts` STAYS UNTOUCHED for legacy v1.0 paths (per D-LIB-01).
//
// This module wraps the typed `unifi-protect@4.29.0` lib so that:
//   - higher layers never construct `ProtectApi` themselves
//   - bootstrap fetch returns a tagged Result instead of throwing
//   - classification logic is one place (per amended D-CLASS-01)
//   - the TLS scheme is locked to a single import-time const (per D-TLS-02)
//
// Note on `server-only`: SvelteKit treats `src/lib/server/**` as server-only
// at the framework level — importing the npm `server-only` shim is unnecessary
// (and not installed in this repo). All sibling services (protect.ts, settings.ts,
// etc.) follow the same convention.
import { ProtectApi, type ProtectCameraConfig } from 'unifi-protect';
import { getSettings } from './settings';

// ────────────────────────────────────────────────────────────────────────────
// TLS scheme — locked by P19-01 spike against UDM 192.0.2.1 (2026-05-06).
// Findings: .planning/research/v1.3/spikes/p19-tls-rtspx.md
// DO NOT change this without re-running the spike against the same UDM firmware.
//
// `rtspx://` is a UniFi-internal URL convention that ffmpeg does NOT register
// as a protocol ("Protocol not found"). Real ffmpeg consumers (go2rtc) must
// use `rtsps://`. Bonus finding: the UDM's certificate currently passes
// ffmpeg 8.0's default TLS validation, but `tls_verify=0` is set defensively
// for portability across firmware versions.
// ────────────────────────────────────────────────────────────────────────────
export type TlsScheme = 'rtspx' | 'rtsps-tls-verify-0';
export const TLS_SCHEME: TlsScheme = 'rtsps-tls-verify-0';

// ────────────────────────────────────────────────────────────────────────────
// Lib client singleton (mirrors the session-TTL pattern from the legacy
// hand-rolled protect.ts — 8 min refresh window).
// ────────────────────────────────────────────────────────────────────────────
let _client: ProtectApi | null = null;
let _loginExpiresAt = 0;
const LOGIN_TTL_MS = 8 * 60 * 1000;

export async function getProtectClient(): Promise<ProtectApi> {
	if (_client && Date.now() < _loginExpiresAt) return _client;

	const settings = await getSettings('unifi_');
	const host = settings.unifi_host;
	const username = settings.unifi_username;
	const password = settings.unifi_password;

	if (!host) throw new Error('UniFi host not configured. Set unifi_host in Settings.');
	if (!username || !password) throw new Error('UniFi credentials not configured.');

	const client = new ProtectApi();
	const ok = await client.login(host, username, password);
	if (!ok) throw new Error('Protect login failed (lib reported false).');

	_client = client;
	_loginExpiresAt = Date.now() + LOGIN_TTL_MS;
	return client;
}

// Reset on credential change — wired into settings save flow in P20+.
export function resetProtectClient(): void {
	_client = null;
	_loginExpiresAt = 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap fetch — typed wrapper, returns tagged Result instead of throwing.
// Network errors fold to `controller_unreachable`; auth-config errors fold to
// `auth_failed`; everything else folds to `unknown` with the underlying Error.
// ────────────────────────────────────────────────────────────────────────────
export type BootstrapResult =
	| { ok: true; cameras: ProtectCameraConfig[] }
	| { ok: false; reason: 'controller_unreachable' | 'auth_failed' | 'unknown'; error: Error };

export async function fetchBootstrap(): Promise<BootstrapResult> {
	try {
		const client = await getProtectClient();
		const ok = await client.getBootstrap();
		if (!ok) {
			return { ok: false, reason: 'unknown', error: new Error('getBootstrap returned false') };
		}
		const cameras = client.bootstrap?.cameras ?? [];
		const cams = cameras.filter((c) => c.modelKey === 'camera') as ProtectCameraConfig[];
		return { ok: true, cameras: cams };
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		if (e.message.includes('not configured')) {
			return { ok: false, reason: 'auth_failed', error: e };
		}
		if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ENOTFOUND/i.test(e.message)) {
			return { ok: false, reason: 'controller_unreachable', error: e };
		}
		return { ok: false, reason: 'unknown', error: e };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Classification — first/third/unknown (per amended D-CLASS-01).
// The lib's `isThirdPartyCamera` boolean is the verified discriminator
// (protect-types.ts:788). The original D-CLASS-01 referenced a `manufacturer`
// field that does NOT exist on the typed interface — DO NOT add a regex
// fallback on `manufacturer`/`Ubiquiti`/`UniFi`; trust the boolean.
// ────────────────────────────────────────────────────────────────────────────
export type CameraKind = 'first-party' | 'third-party' | 'unknown';

export function classifyKind(camera: ProtectCameraConfig): CameraKind {
	if (camera.isThirdPartyCamera === false) return 'first-party';
	if (camera.isThirdPartyCamera === true) return 'third-party';
	return 'unknown'; // defensive — handles undefined/null
}

export function deriveManufacturerHint(camera: ProtectCameraConfig, kind: CameraKind): string {
	if (kind === 'first-party') return 'Ubiquiti';
	if (kind === 'third-party') {
		const token = camera.marketName?.split(/\s+/)[0];
		return token && token.length > 0 ? token : 'Unknown';
	}
	return 'Unknown';
}

// ────────────────────────────────────────────────────────────────────────────
// URL + MAC helpers
// ────────────────────────────────────────────────────────────────────────────
export function protectStreamUrl(host: string, rtspAlias: string): string {
	return TLS_SCHEME === 'rtspx'
		? `rtspx://${host}:7441/${rtspAlias}?enableSrtp`
		: `rtsps://${host}:7441/${rtspAlias}?enableSrtp`;
}

export function normalizeMac(mac: string): string {
	return mac.toLowerCase().replace(/[:-]/g, '');
}
