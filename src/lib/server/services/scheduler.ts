import { scanUdmLogs } from './udm-logs';
import { storeEvents, cleanupOldEvents, storeHealthEvent } from './events';
import { getSettings, getSetting } from './settings';
import { cleanupExpiredSessions } from './auth';
import { getProtectStatus } from './protect';
import { cleanupOldUpdateLogs } from './update-history';
import { startBambuSubscribers, stopBambuSubscribers } from './bambu-mqtt';
import { startDetectionPipeline, stopDetectionPipeline } from './detection-pipeline';
import { db } from '$lib/server/db/client';
import { cameras, protectHubBridges } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

let logScanInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let protectPollInterval: ReturnType<typeof setInterval> | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let updateLogCleanupInterval: ReturnType<typeof setInterval> | null = null;
// v1.3 Phase 21 — Protect Hub reconcile tick. Fires every 5min when
// settings.protect_hub_enabled === 'true'. Silent no-op when disabled
// per HUB-RCN-01 + L-5.
let protectHubReconcileInterval: ReturnType<typeof setInterval> | null = null;
// v1.3 Phase 21 — 2-strike threshold for the bridge health probe per
// D-CAP-03 + HUB-OPS-05. A single transient blip no longer flips bridge
// status to unhealthy; recovery on a single success is forgiving.
let bridgeFailureCount = 0;

export function startScheduler(): void {
	// SSH log scan every 60s — only if UDM/UniFi is configured
	if (!logScanInterval) {
		logScanInterval = setInterval(async () => {
			try {
				// Check if UniFi host is configured before attempting SSH
				const settings = await getSettings('unifi_');
				if (!settings.unifi_host) return; // silently skip — not configured yet

				const events = await scanUdmLogs();
				if (events.length > 0) {
					storeEvents(
						events.map((e) => ({
							cameraId: null,
							cameraName: e.cameraName || null,
							eventType: e.eventType,
							severity: e.severity,
							message: e.message,
							source: e.source as 'ssh_logs',
							timestamp: e.timestamp
						}))
					);
				}
			} catch (err) {
				// Log once, don't spam — SSH key might not be set up yet
				console.error('[scheduler] SSH log scan failed:', (err as Error).message);
			}
		}, 60_000);
	}

	// Cleanup old events + expired sessions once per hour
	if (!cleanupInterval) {
		cleanupInterval = setInterval(() => {
			try {
				cleanupOldEvents();
				cleanupExpiredSessions();
			} catch (err) {
				console.error('[scheduler] Cleanup failed:', err);
			}
		}, 3600_000);
	}

	// Pre-load Protect status every 30s (fills the 30s cache in protect.ts)
	if (!protectPollInterval) {
		protectPollInterval = setInterval(async () => {
			try {
				const settings = await getSettings('unifi_');
				if (!settings.unifi_host) return;
				await getProtectStatus(); // fills the cache
			} catch { /* ignore — will retry next cycle */ }
		}, 30_000);
	}

	// Container health checks every 5 minutes
	if (!healthCheckInterval) {
		healthCheckInterval = setInterval(async () => {
			try {
				const allCameras = db.select().from(cameras).all();
				const withContainer = allCameras.filter((c) => c.containerIp);

				for (const cam of withContainer) {
					// Check go2rtc API.
					// Adaptive-mode Bambu cameras intentionally stop go2rtc when
					// the printer is idle (gcode_state=FINISH/IDLE/PAUSE) to free
					// CPU/RAM in the LXC. Logging "unreachable" for that expected
					// dormant state spams the operator with non-issues — the bambu
					// MQTT subscriber will start go2rtc back up the moment the
					// printer transitions to RUNNING. So skip the check entirely
					// when adaptive + idle is the live config.
					const isAdaptiveIdle =
						cam.cameraType === 'bambu' &&
						(cam.streamMode ?? 'adaptive') === 'adaptive' &&
						(cam.printState === 'FINISH' ||
							cam.printState === 'IDLE' ||
							cam.printState === 'PAUSE' ||
							cam.printState === 'FAILED' ||
							cam.printState === null);

					if (!isAdaptiveIdle) {
						try {
							const controller = new AbortController();
							const timeout = setTimeout(() => controller.abort(), 3000);
							await fetch(`http://${cam.containerIp}:1984/api/streams`, {
								signal: controller.signal
							});
							clearTimeout(timeout);
						} catch {
							storeHealthEvent(
								cam.id,
								cam.name,
								`go2rtc unreachable on ${cam.containerIp}:1984`,
								'warning'
							);
						}
					}

					// Check ONVIF server
					try {
						const controller = new AbortController();
						const timeout = setTimeout(() => controller.abort(), 2000);
						await fetch(`http://${cam.containerIp}:8899`, {
							signal: controller.signal
						});
						clearTimeout(timeout);
					} catch (err: unknown) {
						// ECONNRESET means server is running (resets HTTP but accepts ONVIF)
						const isReset =
							err instanceof Error &&
							(err.message?.includes('ECONNRESET') ||
								(('cause' in err) && (err.cause as { code?: string })?.code === 'ECONNRESET'));
						if (!isReset) {
							storeHealthEvent(
								cam.id,
								cam.name,
								`ONVIF server unreachable on ${cam.containerIp}:8899`,
								'warning'
							);
						}
					}
				}
				// Bridge health probe (HUB-BRG-08; P21 extends with 2-strike threshold
				// + recovery per D-CAP-03 + HUB-OPS-05). The probe runs against both
				// 'running' and 'unhealthy' bridges so a recovered bridge can flip
				// back to 'running' on the next single success.
					const bridge = db.select().from(protectHubBridges).get();
					if (
						bridge &&
						bridge.containerIp &&
						(bridge.status === 'running' || bridge.status === 'unhealthy')
					) {
						try {
							const controller = new AbortController();
							const timeout = setTimeout(() => controller.abort(), 3000);
							const res = await fetch(`http://${bridge.containerIp}:1984/api/streams`, {
								signal: controller.signal
							});
							clearTimeout(timeout);
							if (!res.ok) throw new Error(`bridge HTTP ${res.status}`);

							// Success: reset 2-strike counter; recover from unhealthy.
							bridgeFailureCount = 0;
							if (bridge.status === 'unhealthy') {
								db.update(protectHubBridges)
									.set({
										status: 'running',
										updatedAt: new Date().toISOString(),
										lastHealthCheckAt: new Date().toISOString()
									})
									.where(eq(protectHubBridges.id, bridge.id))
									.run();
								storeHealthEvent(
									0,
									'Protect Hub Bridge',
									`go2rtc recovered on ${bridge.containerIp}:1984`,
									'info'
								);
							} else {
								db.update(protectHubBridges)
									.set({ lastHealthCheckAt: new Date().toISOString() })
									.where(eq(protectHubBridges.id, bridge.id))
									.run();
							}
						} catch {
							bridgeFailureCount++;
							if (bridgeFailureCount >= 2 && bridge.status !== 'unhealthy') {
								db.update(protectHubBridges)
									.set({
										status: 'unhealthy',
										updatedAt: new Date().toISOString()
									})
									.where(eq(protectHubBridges.id, bridge.id))
									.run();
								storeHealthEvent(
									0,
									'Protect Hub Bridge',
									`go2rtc unreachable 2x on ${bridge.containerIp}:1984 — marked unhealthy`,
									'warning'
								);
							}
						}
					}
			} catch (err) {
				console.error('[scheduler] Health check failed:', err);
			}
		}, 5 * 60_000);
	}

	// Update log cleanup — once per 24h, drop entries + files older than 30 days
	if (!updateLogCleanupInterval) {
		const runCleanup = async () => {
			try {
				const { entriesDropped, filesRemoved } = await cleanupOldUpdateLogs(30);
				if (entriesDropped > 0 || filesRemoved > 0) {
					console.log(
						`[scheduler] update log cleanup: dropped ${entriesDropped} entries, removed ${filesRemoved} files`
					);
				}
			} catch (err) {
				console.error('[scheduler] update log cleanup failed:', (err as Error).message);
			}
		};
		// Run shortly after boot so orphans left from previous lifetimes get swept,
		// then once per 24h.
		setTimeout(runCleanup, 60_000);
		updateLogCleanupInterval = setInterval(runCleanup, 86_400_000);
	}

	// Start Bambu MQTT subscribers (Adaptive Stream Mode driven by print.gcode_state)
	startBambuSubscribers().catch((err) =>
		console.error('[scheduler] bambu-mqtt startup failed:', err)
	);

	// Boot-wire the local-first detection pipeline (DetectionService → DetectionPublisher).
	// Fire-and-forget + creds-guarded internally: no Protect creds ⇒ neither half starts
	// (no reconnect storm, /live stays disconnected). A throw here can never block boot.
	startDetectionPipeline().catch((err) =>
		console.error('[scheduler] detection pipeline startup failed:', (err as Error).message)
	);

	// v1.3 Phase 21 — Protect Hub 5min reconcile tick (HUB-RCN-01 + L-5).
	// Gated on settings.protect_hub_enabled='true'. Disabled state is silent
	// per HUB-RCN-01 (no log spam, no DB hit). Dynamic import keeps the
	// scheduler module load-cycle clean — reconcile.ts pulls in the SSH +
	// Protect lib transitive graph which we don't want at boot if the Hub
	// is off.
	if (!protectHubReconcileInterval) {
		protectHubReconcileInterval = setInterval(async () => {
			try {
				const enabled = await getSetting('protect_hub_enabled');
				if (enabled !== 'true') return; // silent per HUB-RCN-01

				const bridge = db
					.select()
					.from(protectHubBridges)
					.where(eq(protectHubBridges.status, 'running'))
					.limit(1)
					.get();
				if (!bridge) return;

				const { reconcile } = await import(
					'$lib/server/orchestration/protect-hub/reconcile'
				);
				await reconcile(bridge.id, 'tick');
			} catch (err) {
				console.error(
					'[scheduler] protect hub reconcile tick failed:',
					(err as Error).message
				);
			}
		}, 5 * 60_000);
	}

	// v1.3 Phase 21 — Start the Protect WebSocket reconnect manager when the
	// Hub is enabled. Fire-and-forget so startScheduler() stays sync; a
	// failure here just logs (the 5min reconcile tick still drives discovery
	// even if WS never comes up).
	void (async () => {
		try {
			const enabled = await getSetting('protect_hub_enabled');
			if (enabled !== 'true') return;
			const { startWs } = await import(
				'$lib/server/orchestration/protect-hub/ws-manager'
			);
			await startWs();
		} catch (err) {
			console.error('[scheduler] startWs failed:', (err as Error).message);
		}
	})();

	console.log('[scheduler] Started: event cleanup (1h), SSH log scan (60s), Protect poll (30s), health checks (5m), update log cleanup (24h), bambu MQTT, protect hub reconcile (5m), detection pipeline');
}

export function stopScheduler(): void {
	if (logScanInterval) {
		clearInterval(logScanInterval);
		logScanInterval = null;
	}
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
	if (protectPollInterval) {
		clearInterval(protectPollInterval);
		protectPollInterval = null;
	}
	if (healthCheckInterval) {
		clearInterval(healthCheckInterval);
		healthCheckInterval = null;
	}
	stopBambuSubscribers();
	// Tear down the detection pipeline (publisher.stop() flushes retained `offline`
	// health + ends MQTT, then service.stop() closes the Protect ws). Fire-and-forget
	// so the SIGTERM-sensitive shutdown path is not blocked on the async MQTT end —
	// mirrors the fire-and-forget stopWs() IIFE below. The broker LWT covers a
	// hard-kill regardless.
	void stopDetectionPipeline();
	if (updateLogCleanupInterval) {
		clearInterval(updateLogCleanupInterval);
		updateLogCleanupInterval = null;
	}
	// v1.3 Phase 21 — clear the reconcile tick + reset 2-strike counter so a
	// future startScheduler() begins from a clean slate. ws-manager stop is
	// fire-and-forget via dynamic import so we don't add the lib's transitive
	// graph to scheduler.ts's static import set.
	if (protectHubReconcileInterval) {
		clearInterval(protectHubReconcileInterval);
		protectHubReconcileInterval = null;
	}
	bridgeFailureCount = 0;
	void (async () => {
		try {
			const { stopWs } = await import(
				'$lib/server/orchestration/protect-hub/ws-manager'
			);
			stopWs();
		} catch {
			// ws-manager may have never been imported (Hub disabled at boot)
		}
	})();
}
