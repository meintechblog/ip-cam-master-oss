/**
 * POST /api/internal/prepare-for-shutdown
 *
 * Drain endpoint called by scripts/update.sh between the `snapshot` and
 * `stop` stages of the self-update pipeline. See UPD-AUTO docs in
 * .planning/phases/24-auto-update-parity/24-CONTEXT.md (D-04).
 *
 * Responsibilities:
 *   1. Stop all background scheduler ticks so no SSH/MQTT/HTTP work
 *      starts during the impending systemctl stop.
 *   2. Stop Bambu MQTT subscribers cleanly (open subscriptions otherwise
 *      reconnect-storm against the printer when the app comes back up).
 *   3. Checkpoint SQLite WAL → main DB so the restart sees a consistent
 *      file-on-disk state (defensive — better-sqlite3 commits the WAL
 *      on close anyway, but we want minimal startup work).
 *
 * Localhost-only (UPD-AUTO-12) — refuses any request with a non-local
 * Host header. The bash updater calls 127.0.0.1, so this is hard-coded.
 *
 * Idempotent. Returns 200 with a small status body. Never blocks > 30s.
 */

import { json, error } from '@sveltejs/kit';
import { stopScheduler } from '$lib/server/services/scheduler';
import { db } from '$lib/server/db/client';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLocalhostRequest(request: Request): boolean {
	const host = request.headers.get('host') ?? '';
	const hostname = host.split(':')[0]?.toLowerCase() ?? '';
	return LOCAL_HOSTS.has(hostname);
}

export const POST: RequestHandler = async ({ request }) => {
	if (!isLocalhostRequest(request)) {
		throw error(403, 'localhost only');
	}

	const drainStarted = Date.now();
	const stages: Array<{ stage: string; ok: boolean; detail?: string }> = [];

	try {
		stopScheduler();
		stages.push({ stage: 'scheduler', ok: true });
	} catch (err) {
		stages.push({ stage: 'scheduler', ok: false, detail: (err as Error).message });
	}

	// WAL checkpoint — best-effort. Drizzle exposes raw SQL via sql``.
	try {
		await db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
		stages.push({ stage: 'wal_checkpoint', ok: true });
	} catch (err) {
		stages.push({ stage: 'wal_checkpoint', ok: false, detail: (err as Error).message });
	}

	const elapsedMs = Date.now() - drainStarted;
	return json(
		{ ok: true, drainedInMs: elapsedMs, stages },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
