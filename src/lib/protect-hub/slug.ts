// v1.3 Phase 22 Plan 02 — Stream slug + URL derivation (per L-22 + HUB-OUT-06).
//
// MUST stay byte-identical with `src/lib/server/orchestration/protect-hub/yaml-builder.ts`
// `deriveSlug()` (the on-disk YAML key go2rtc serves). The URL the user copies
// from the wizard / OutputsSubsection / ProtectHubGuide / all-urls page MUST
// match what the bridge actually streams. A parity test in `slug.test.ts`
// imports the server-side function and asserts identical output for 5 sample
// MACs × both output types.
//
// Browser-importable (no `$lib/server/*` imports) so it can be used in
// component code paths that ship to the browser.
export type OutputType = 'loxone-mjpeg' | 'frigate-rtsp';

/**
 * Derive the go2rtc stream slug for one (mac, outputType) pair.
 *
 * Convention (per D-PIPE-06 in P21 spec):
 *   - 'loxone-mjpeg' → '<mac>-low'   (640×360@10fps transcode)
 *   - 'frigate-rtsp' → '<mac>-high'  (passthrough copy)
 *
 * @param mac normalised MAC: lowercase hex, no separators (e.g. 'aabbccddeeff').
 *            Caller is responsible for normalisation; this function does not
 *            transform input — it only validates non-empty (Pitfall #9 guard).
 * @throws Error when `mac` is empty/falsy.
 */
export function deriveSlug(mac: string, outputType: OutputType): string {
	if (!mac) throw new Error('deriveSlug: mac is required');
	const suffix = outputType === 'loxone-mjpeg' ? 'low' : 'high';
	return `${mac}-${suffix}`;
}

/**
 * Build the user-copyable stream URL for one (bridgeIp, mac, outputType) tuple.
 *
 * Loxone-MJPEG → `http://<bridge>:1984/api/stream.mjpeg?src=<slug>`
 *   served by go2rtc's HTTP API; user pastes this into Loxone "Benutzerdefinierte Intercom".
 *
 * Frigate-RTSP → `rtsp://<bridge>:8554/<slug>`
 *   served by go2rtc's RTSP listener; user pastes into Frigate's `cameras.<name>.ffmpeg.inputs`.
 */
export function deriveStreamUrl(
	bridgeIp: string,
	mac: string,
	outputType: OutputType
): string {
	const slug = deriveSlug(mac, outputType);
	return outputType === 'loxone-mjpeg'
		? `http://${bridgeIp}:1984/api/stream.mjpeg?src=${slug}`
		: `rtsp://${bridgeIp}:8554/${slug}`;
}
