import { startScheduler } from '$lib/server/services/scheduler';
import { validateSession, isYoloMode, getUser } from '$lib/server/services/auth';
import {
	ensureUpdateScriptInstalled,
	ensureUpdaterUnitInstalled
} from '$lib/server/services/update-runner';
import { reconcileRunningEntries } from '$lib/server/services/update-history';
import { initUpdateStateStore } from '$lib/server/services/update-state-store';
import { startUpdateChecker } from '$lib/server/services/update-checker';
import { startMetricsFlusher, stopMetricsFlusher, recordMetric } from '$lib/server/services/metrics';
import { startStreamHealthSampler, stopStreamHealthSampler } from '$lib/server/services/stream-health-sampler';
import { isPublicPath } from '$lib/config/routes';
// v1.3 Phase 21 (L-14 + P21-#13) — wait briefly on the Protect Hub
// reconciler before exiting so an in-flight atomic tmp+rename SSH push
// finishes cleanly. The atomic write makes a hard-kill safe (the bridge
// keeps the OLD or NEW yaml — never partial), but giving the reconciler
// 30 s grace lets normal restarts log a tidy 'idle' shutdown line.
import { isReconcilerBusy } from '$lib/server/orchestration/protect-hub/reconcile';
import type { Handle } from '@sveltejs/kit';

initUpdateStateStore();
startScheduler();
ensureUpdateScriptInstalled().catch((err) =>
	console.error('[update] script install failed', err)
);
ensureUpdaterUnitInstalled().catch((err) =>
	console.error('[update] updater unit install failed', err)
);
reconcileRunningEntries()
	.then((n) => {
		if (n > 0) console.log(`[update] reconciled ${n} orphaned running entries`);
	})
	.catch((err) => console.error('[update] reconcile failed', err));
startUpdateChecker();
startMetricsFlusher();
recordMetric({
	measurement: 'app_boot',
	fields: { count_total: 1, message: 'ip-cam-master starting' }
});
startStreamHealthSampler();

// Respond to SIGTERM so systemd restarts finish in seconds, not 90s (the default
// TimeoutStopSec before SIGKILL). Without this, `systemctl restart ip-cam-master`
// triggered from Phase 09's self-update hangs during the stop phase.
//
// v1.3 Phase 21 (L-14 + P21-#13): poll isReconcilerBusy() for up to 30 s
// before exiting so an in-flight Protect Hub reconcile finishes its
// atomic tmp+rename SSH push. The 30 s budget fits well within systemd's
// default TimeoutStopSec=90 s; a hard-kill is still safe because the
// atomic write inside the bridge LXC leaves the existing YAML intact.
const SHUTDOWN_RECONCILE_GRACE_MS = 30_000;
const SHUTDOWN_POLL_INTERVAL_MS = 250;

const shutdown = async (signal: string): Promise<void> => {
	console.log(`[shutdown] received ${signal}, draining...`);

	const deadline = Date.now() + SHUTDOWN_RECONCILE_GRACE_MS;
	while (Date.now() < deadline) {
		let busy = false;
		try {
			busy = isReconcilerBusy();
		} catch {
			busy = false;
		}
		if (!busy) break;
		await new Promise<void>((r) => setTimeout(r, SHUTDOWN_POLL_INTERVAL_MS));
	}

	let stillBusy = false;
	try {
		stillBusy = isReconcilerBusy();
	} catch {
		stillBusy = false;
	}
	console.log(
		`[shutdown] exiting (reconciler ${stillBusy ? 'STILL BUSY (timeout)' : 'idle'})`
	);
	stopStreamHealthSampler();
	stopMetricsFlusher();
	process.exit(0);
};

// Node accepts async listeners; the event loop does not await them, but
// process.exit(0) inside the handler short-circuits the rest of shutdown.
process.on('SIGTERM', () => {
	void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
	void shutdown('SIGINT');
});

export const handle: Handle = async ({ event, resolve }) => {
	if (isPublicPath(event.url.pathname)) {
		return resolve(event);
	}

	// YOLO mode skips all auth (per D-23)
	if (isYoloMode()) {
		return resolve(event);
	}

	// No user exists -> redirect to setup (per D-22)
	const user = getUser();
	if (!user) {
		return new Response(null, { status: 303, headers: { location: '/setup' } });
	}

	// Check session cookie
	const sessionId = event.cookies.get('session');
	if (!sessionId) {
		return new Response(null, { status: 303, headers: { location: '/login' } });
	}

	const session = validateSession(sessionId);
	if (!session) {
		event.cookies.delete('session', { path: '/' });
		return new Response(null, { status: 303, headers: { location: '/login' } });
	}

	// Attach user to locals for downstream use
	event.locals.user = session;
	return resolve(event);
};
