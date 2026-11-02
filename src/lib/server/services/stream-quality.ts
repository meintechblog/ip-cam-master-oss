/**
 * stream-quality.ts — pure rate-math for the stream-health sampler.
 *
 * go2rtc's /api/streams exposes monotonically increasing byte/packet counters
 * per receiver, not a current bitrate. To get a live "is this stream actually
 * pushing bytes and at what rate" signal we derive the rate from the delta
 * between two consecutive sampler ticks.
 *
 * This is a PURE, total function (mirrors detectTransitions in
 * stream-health-sampler.ts): no DB/env/IO coupling, fully unit-testable.
 *
 * Achievable from go2rtc: current bitrate (kbps) + packet rate (pps).
 * NOT achievable from go2rtc and therefore deliberately NOT computed here:
 * frame-drops and IDR/keyframe interval — go2rtc does not report them. Do not
 * fabricate them.
 *
 * 🔴 SECURITY: this module never touches producer.source/url (clear-text camera
 * credentials). It only ever sees the safe scalar counters passed in.
 */

/** Monotonic counters captured for one stream at one tick. */
export interface StreamRateSample {
	/** Σ producer.bytes_recv across producers at this tick. */
	bytesRecv: number;
	/** Σ receivers[].packets across producers at this tick. */
	packets: number;
	/** Date.now() when this sample was taken (ms). */
	tsMs: number;
}

export interface StreamRates {
	/** Current bitrate in kilobits/s, or null when not derivable this tick. */
	bitrateKbps: number | null;
	/** Current packet rate in packets/s, or null when not derivable this tick. */
	packetRatePps: number | null;
}

const NULL_RATES: StreamRates = { bitrateKbps: null, packetRatePps: null };

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/**
 * Derive current bitrate + packet rate from two consecutive counter samples.
 *
 * Returns nulls (seed-only, no emit) when:
 *   - prev is missing (first observation / post-restart),
 *   - deltaMs <= 0 (clock skew / same-tick → no divide-by-zero, no Infinity),
 *   - any counter went backward (go2rtc/container restart → counter reset).
 *
 * On a normal forward delta:
 *   bitrateKbps   = (deltaBytes * 8) / deltaMs   (bits-per-ms === kilobits-per-s)
 *   packetRatePps = deltaPackets / (deltaMs / 1000)
 * Zero traffic over a positive interval → 0 kbps / 0 pps (not null).
 */
export function computeStreamRates(
	prev: StreamRateSample | null | undefined,
	next: StreamRateSample
): StreamRates {
	if (!prev) return NULL_RATES; // first observation / post-restart — seed silently

	const deltaMs = next.tsMs - prev.tsMs;
	if (deltaMs <= 0) return NULL_RATES; // no divide-by-zero / no Infinity

	const deltaBytes = next.bytesRecv - prev.bytesRecv;
	const deltaPackets = next.packets - prev.packets;
	if (deltaBytes < 0 || deltaPackets < 0) return NULL_RATES; // counter reset → no fabricated value

	// (deltaBytes * 8) bits over deltaMs ms === kilobits over seconds === kbps.
	const bitrateKbps = round1((deltaBytes * 8) / deltaMs);
	const packetRatePps = round1(deltaPackets / (deltaMs / 1000));

	return { bitrateKbps, packetRatePps };
}
