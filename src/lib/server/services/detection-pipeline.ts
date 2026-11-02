// detection-pipeline — the boot-wire lifecycle pair for the local-first detection
// pipe (C1 ProtectConnection → C2 DetectionTap → DetectionService → C3 Publisher).
//
// Why this thin module exists:
//   DetectionService and DetectionPublisher are lazy singletons whose start() was
//   never called — the shipped pipeline never opened the Protect ws nor the MQTT
//   egress. This module provides a small GUARDED start/stop pair that scheduler.ts
//   calls on boot/shutdown, mirroring startBambuSubscribers / stopBambuSubscribers.
//
// Creds-presence gate (truthful default — no detection_enabled flag):
//   startDetectionPipeline() only opens the connection when UniFi Protect creds are
//   configured (unifi_host && unifi_username && unifi_password all non-empty —
//   exactly protect-connection.loadCreds()'s rule). No creds ⇒ neither half starts,
//   the app still boots, /live stays gracefully 'disconnected', and there is NO
//   reconnect storm. An explicit `detection_enabled` settings flag is intentionally
//   NOT added now (KISS / R12): creds-presence already gives a truthful default
//   gate. Add an explicit disable flag only if a user actually asks for one.
//
// Why the publisher starts ONLY alongside DetectionService (i.e. only when creds
// present): when there is no Protect tap there is nothing to report. Publishing a
// retained `ipcam/health` `online`/`offline` doc with no real connection behind it
// would give smart-home a misleading "the tap is here" signal and add noise.
// Starting the publisher only when the real tap starts means the retained
// `ipcam/health` always reflects an ACTUAL connection — and the publisher's own
// state→health mapping + broker LWT then correctly report degraded/offline if that
// real connection later drops or this process dies.
//
// Local-first / R12 scope: this module wires NOTHING new on the wire. It only calls
// the already-shipped public start()/stop() of DetectionService / DetectionPublisher.
// No new external calls, no change to what is published (MinimalEvent + health only).
// NEVER logs an event or credential field (log-redaction constraint) — message-only.

import { getSettings as realGetSettings } from './settings';
import { getDetectionService, type DetectionService } from './detection-service';
import { getDetectionPublisher, type DetectionPublisher } from './detection-publisher';

/** Minimal C-layer surfaces the pipeline drives — lets tests inject fakes. */
type ServiceLike = Pick<DetectionService, 'start' | 'stop'>;
type PublisherLike = Pick<DetectionPublisher, 'start' | 'stop'>;

export type DetectionPipelineDeps = {
	/** Settings reader. Defaults to the real getSettings from ./settings. */
	getSettings?: (prefix: string) => Promise<Record<string, string>>;
	/** DetectionService. Defaults to the process-wide getDetectionService() singleton. */
	service?: ServiceLike;
	/** DetectionPublisher. Defaults to the process-wide getDetectionPublisher() singleton. */
	publisher?: PublisherLike;
};

// Module-scoped guard so a second startDetectionPipeline() does not redundantly
// re-read creds and re-invoke service.start(). Reset by stopDetectionPipeline().
let started = false;

/**
 * True iff UniFi Protect creds are fully configured — mirrors
 * protect-connection.loadCreds(): host && username && password all non-empty.
 */
export async function hasProtectCreds(deps: DetectionPipelineDeps = {}): Promise<boolean> {
	const getSettings = deps.getSettings ?? realGetSettings;
	const s = await getSettings('unifi_');
	return Boolean(s.unifi_host && s.unifi_username && s.unifi_password);
}

/**
 * Boot the pipeline IF Protect creds are present. Starts DetectionService FIRST
 * (opens the ws / liveness), then DetectionPublisher (MQTT egress + retained
 * health). Idempotent via the module guard. Fully crash-resilient: any throw from
 * either start() is caught + logged (message-only) and never rethrown, so a failure
 * here can never block the rest of startScheduler() / app boot. Invoked
 * fire-and-forget from the scheduler (`.catch(...)`), mirroring startBambuSubscribers.
 */
export async function startDetectionPipeline(deps: DetectionPipelineDeps = {}): Promise<void> {
	if (started) return;

	let credsPresent = false;
	try {
		credsPresent = await hasProtectCreds(deps);
	} catch (err) {
		console.error(
			`[detection-pipeline] creds check failed: ${err instanceof Error ? err.message : 'unknown'}`
		);
		return;
	}

	if (!credsPresent) {
		// No creds → leave both halves idle. /live shows 'disconnected', no ws,
		// no reconnect storm. App boot is unaffected.
		return;
	}

	// Mark started BEFORE the awaits so a concurrent fire-and-forget second call
	// (scheduler may be re-entered) cannot double-open while the first is in flight.
	started = true;

	const service = deps.service ?? getDetectionService();
	const publisher = deps.publisher ?? getDetectionPublisher();

	try {
		// Service FIRST: opens the Protect ws + liveness FSM. Graceful no-creds is
		// already handled above; a real connect_failed just degrades + self-heals.
		await service.start();
	} catch (err) {
		console.error(
			`[detection-pipeline] service start failed: ${err instanceof Error ? err.message : 'unknown'}`
		);
	}

	try {
		// Publisher SECOND: starts only alongside a real tap (see top-of-file rationale).
		await publisher.start();
	} catch (err) {
		console.error(
			`[detection-pipeline] publisher start failed: ${err instanceof Error ? err.message : 'unknown'}`
		);
	}
}

/**
 * Tear the pipeline down. Stops the PUBLISHER FIRST (flush retained `offline`
 * health + end MQTT) so smart-home sees the tap go away before the ws closes,
 * THEN the service (close the Protect ws). Each stop is independently try/caught
 * so one failing half never blocks the other. Resolves regardless. Invoked
 * fire-and-forget from stopScheduler() so the SIGTERM-sensitive shutdown path is
 * not blocked on the async MQTT end (the broker LWT covers a hard-kill anyway).
 */
export async function stopDetectionPipeline(deps: DetectionPipelineDeps = {}): Promise<void> {
	const service = deps.service ?? getDetectionService();
	const publisher = deps.publisher ?? getDetectionPublisher();

	try {
		await publisher.stop();
	} catch (err) {
		console.error(
			`[detection-pipeline] publisher stop failed: ${err instanceof Error ? err.message : 'unknown'}`
		);
	}

	try {
		await service.stop();
	} catch (err) {
		console.error(
			`[detection-pipeline] service stop failed: ${err instanceof Error ? err.message : 'unknown'}`
		);
	}

	started = false;
}

/** Test-only: reset the module guard between cases. NOT for production use. */
export function __resetDetectionPipelineForTests(): void {
	started = false;
}
