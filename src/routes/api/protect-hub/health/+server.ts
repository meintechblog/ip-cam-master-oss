// v1.3 Phase 22 Plan 02 — GET /api/protect-hub/health (composite readiness probe).
//
// Composes three signals into one response:
//   - bridge row (status, containerIp, lastReconciledAt, lastDeployedYamlHash)
//   - go2rtc reachability (HTTP probe to :1984/api/streams; 2000 ms timeout)
//   - reconciler-busy flag (synchronous — single-flight gate)
//
// Cadence: Plan 04 Step 5 polls this at 1500 ms (UI-SPEC §step-5-health-poll);
// Plan 05 HubStatusPanel polls at 10 s. The 2000 ms timeout keeps request
// pile-up bounded even at the 1500 ms cadence (T-22-05 mitigation).
//
// No-bridge stage: when no bridge row exists yet, return `{ ok: false,
// stage: 'no_bridge' }`. Plan 04's Step 2 hasn't run; downstream UI renders
// the wizard CTA instead of misleading "go2rtc not ready" copy.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';
import { isReconcilerBusy } from '$lib/server/orchestration/protect-hub/reconcile';

export const GET: RequestHandler = async () => {
	const bridge = getBridgeStatus();
	if (!bridge?.containerIp) {
		return json({ ok: false, stage: 'no_bridge', reconcilerBusy: false });
	}
	let go2rtcReady = false;
	let streamCount = 0;
	try {
		const res = await fetch(`http://${bridge.containerIp}:1984/api/streams`, {
			signal: AbortSignal.timeout(2000)
		});
		if (res.ok) {
			go2rtcReady = true;
			const streams = (await res.json()) as Record<string, unknown>;
			streamCount = Object.keys(streams).length;
		}
	} catch {
		// not ready — keep go2rtcReady=false, streamCount=0
	}

	// WR-08 fix — `ok: true` previously meant "request succeeded" even when
	// go2rtcReady=false, which conflates "request OK" with "bridge healthy".
	// Today no consumer reads `health.ok` directly (Step5 + HubStatusPanel
	// read individual fields), but to disambiguate for future callers we add
	// a derived `bridgeHealthy` boolean. `ok` is preserved for backward
	// compat: it stays `true` whenever the request itself succeeds (bridge
	// row exists and responded). The `no_bridge` early-return continues to
	// emit `ok: false` so wizard UI can detect "bridge not provisioned yet".
	const bridgeHealthy = go2rtcReady && bridge.status === 'running';
	return json({
		ok: true,
		bridgeHealthy,
		bridgeStatus: bridge.status,
		bridgeIp: bridge.containerIp,
		go2rtcReady,
		streamCount,
		reconcilerBusy: isReconcilerBusy(),
		lastReconciledAt: bridge.lastReconciledAt,
		lastDeployedYamlHash: bridge.lastDeployedYamlHash
	});
};
