/**
 * metrics.ts — InfluxDB v2 line-protocol writer.
 *
 * Buffers points in memory and flushes either when the queue hits
 * FLUSH_MAX_SIZE or every FLUSH_INTERVAL_MS. Drops on Influx outage so the
 * app never blocks on telemetry. No-op when INFLUX_URL / INFLUX_TOKEN
 * unset — safe to call from any code path.
 *
 * Conventions (per logging-master ownership; coordinated via Hulki 2026-05-28):
 *   - tag `service` = 'ip-cam-master' (auto)
 *   - tag `host` = INFLUX_HOST env or 'ip-cam-master' (auto)
 *   - measurement names: lowercase snake_case (`camera_state`, `rtsp_probe_rtt_ms`)
 *   - counters carry `_total` suffix, gauges are raw
 *
 * See: ~/.claude/projects/-Users-hulki-codex-ip-cam-master/memory/project_influx_logging.md
 */

import { env } from '$env/dynamic/private';

export type FieldValue = number | bigint | string | boolean;
export type Tags = Record<string, string | undefined>;
export type Fields = Record<string, FieldValue | undefined | null>;

export interface MetricPoint {
	measurement: string;
	tags?: Tags;
	fields: Fields;
	/** Nanoseconds since epoch. Defaults to Date.now()*1e6. */
	timestampNs?: bigint;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_MAX_SIZE = 100;
const QUEUE_CAP = 2_000;

let _queue: string[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _droppedSinceLastFlush = 0;

function escapeKey(s: string): string {
	return s.replace(/[ ,=]/g, '\\$&');
}
function escapeTagValue(s: string): string {
	return s.replace(/[ ,=]/g, '\\$&').replace(/\n/g, ' ');
}
function escapeStringField(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function formatField(v: FieldValue): string {
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return '0';
		return Number.isInteger(v) ? `${v}i` : `${v}`;
	}
	if (typeof v === 'bigint') return `${v.toString()}i`;
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	return `"${escapeStringField(v)}"`;
}

function toLineProtocol(p: MetricPoint): string | null {
	const tagPairs: string[] = [];
	const allTags: Tags = {
		service: 'ip-cam-master',
		host: env.INFLUX_HOST || 'ip-cam-master',
		...(p.tags ?? {})
	};
	const sortedKeys = Object.keys(allTags).sort();
	for (const k of sortedKeys) {
		const v = allTags[k];
		if (v === undefined || v === '') continue;
		tagPairs.push(`${escapeKey(k)}=${escapeTagValue(String(v))}`);
	}
	const fieldPairs: string[] = [];
	for (const [k, v] of Object.entries(p.fields)) {
		if (v === undefined || v === null) continue;
		fieldPairs.push(`${escapeKey(k)}=${formatField(v)}`);
	}
	if (fieldPairs.length === 0) return null;
	const ts = p.timestampNs ?? BigInt(Date.now()) * 1_000_000n;
	const prefix = tagPairs.length === 0 ? p.measurement : `${p.measurement},${tagPairs.join(',')}`;
	return `${prefix} ${fieldPairs.join(',')} ${ts.toString()}`;
}

/**
 * Queue a metric for the next flush. Fire-and-forget; safe to call from
 * any code path. No-op if Influx isn't configured.
 */
export function recordMetric(point: MetricPoint): void {
	if (!env.INFLUX_URL || !env.INFLUX_TOKEN) return;
	const line = toLineProtocol(point);
	if (!line) return;
	if (_queue.length >= QUEUE_CAP) {
		_droppedSinceLastFlush++;
		return;
	}
	_queue.push(line);
	if (_queue.length >= FLUSH_MAX_SIZE) {
		void flushNow().catch(() => {});
	}
}

/** Drain the queue once. Returns # lines written (or 0 on error / no Influx). */
export async function flushNow(): Promise<number> {
	if (_queue.length === 0) return 0;
	if (!env.INFLUX_URL || !env.INFLUX_TOKEN) {
		_queue = [];
		return 0;
	}
	const batch = _queue.splice(0, _queue.length);
	const drops = _droppedSinceLastFlush;
	_droppedSinceLastFlush = 0;
	const url = `${env.INFLUX_URL}/api/v2/write?org=${encodeURIComponent(env.INFLUX_ORG || 'meintechblog')}&bucket=${encodeURIComponent(env.INFLUX_BUCKET || 'default')}&precision=ns`;
	try {
		const r = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Token ${env.INFLUX_TOKEN}`,
				'Content-Type': 'text/plain; charset=utf-8'
			},
			body: batch.join('\n'),
			signal: AbortSignal.timeout(5_000)
		});
		if (!r.ok) {
			const txt = await r.text().catch(() => '');
			console.error(`[metrics] flush HTTP ${r.status}: ${txt.slice(0, 200)}`);
			return 0;
		}
		if (drops > 0) {
			console.warn(`[metrics] dropped ${drops} points during last interval (queue cap ${QUEUE_CAP})`);
		}
		return batch.length;
	} catch (err) {
		console.error('[metrics] flush error:', (err as Error).message);
		return 0;
	}
}

/** Idempotent. Starts the background flusher. */
export function startMetricsFlusher(): void {
	if (_flushTimer) return;
	if (!env.INFLUX_URL || !env.INFLUX_TOKEN) {
		console.log('[metrics] INFLUX_URL or INFLUX_TOKEN not set — metrics flusher disabled');
		return;
	}
	_flushTimer = setInterval(() => {
		void flushNow().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	console.log(`[metrics] flusher started (interval ${FLUSH_INTERVAL_MS}ms, max-batch ${FLUSH_MAX_SIZE}) → ${env.INFLUX_URL}`);
}

export function stopMetricsFlusher(): void {
	if (_flushTimer) {
		clearInterval(_flushTimer);
		_flushTimer = null;
	}
	void flushNow().catch(() => {});
}

/** Test-only: snapshot current queue size. */
export function _queueSize(): number {
	return _queue.length;
}
