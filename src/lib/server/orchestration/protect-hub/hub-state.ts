// v1.3 Phase 22 Plan 02 — Derived hub_state machine (per L-18 + RESEARCH §A1).
//
// Pure read-compose of three signals — no DB writes, no side effects:
//   - settings.protect_hub_enabled (string 'true' / unset)
//   - protect_hub_bridges.status   (running | provisioning | stopped | failed | pending)
//   - hub_onboarding_state pointer (presence + step + status + error)
//
// Returns the 5-state enum L-18: disabled | starting | enabled | stopping | error.
//
// Toggle UI gates the toggle-disabled state on { starting, stopping } and shows
// the inline "Vorgang läuft…" + separate Abbrechen button per L-18.
// Status-panel reads `error` to surface failure copy.
//
// Resolution of RESEARCH Open Question 1 + Pitfall #3: derive in code, do NOT
// add a `hub_state` column. Single source of truth = the three input signals;
// any cached column would drift. Pure function = trivially testable.
import { getSetting } from '$lib/server/services/settings';
import { getBridgeStatus } from '$lib/server/orchestration/protect-hub/bridge-lifecycle';
import { getPointer } from '$lib/server/orchestration/protect-hub/wizard-state';

export type HubState = 'disabled' | 'starting' | 'enabled' | 'stopping' | 'error';

/**
 * Compute the current hub state. Async because `getSetting` is async (settings
 * service hits SQLite + decrypt path). Bridge + pointer reads are synchronous.
 *
 * Priority order (first match wins):
 *   1. error      — bridge.status='failed' OR pointer.error set
 *   2. starting   — bridge.status='provisioning' OR pointer in_progress at step 1..5
 *   3. enabled    — protect_hub_enabled='true' AND bridge.status='running'
 *   4. stopping   — protect_hub_enabled='true' AND bridge.status != 'running' (no active pointer)
 *   5. disabled   — fallthrough
 *
 * Note: step=6 with status='in_progress' is a transient render race after
 * Plan 04 Step 6 redirect; we treat it as NOT 'starting' so the `/kameras`
 * partition + Hub-Tab status panel reflect the post-completion world cleanly.
 * The `wizard/complete` endpoint flips status to 'completed' in the same
 * handler call (Plan 02 Task 3).
 */
export async function getHubState(): Promise<HubState> {
	const enabled = (await getSetting('protect_hub_enabled')) === 'true';
	const bridge = getBridgeStatus();
	const pointer = getPointer();

	// 1. error has highest priority — surface the bad state regardless of others
	if (bridge?.status === 'failed') return 'error';
	if (pointer?.error) return 'error';

	// 2. starting: provisioning OR wizard in-progress mid-flight (steps 1..5)
	if (bridge?.status === 'provisioning') return 'starting';
	if (
		pointer &&
		pointer.status === 'in_progress' &&
		pointer.step >= 1 &&
		pointer.step <= 5
	) {
		return 'starting';
	}

	// 3. enabled: feature flag on AND bridge running
	if (enabled && bridge?.status === 'running') return 'enabled';

	// 4. stopping: feature flag was on, bridge no longer running, no active wizard
	//    (Full stop-lifecycle is owned by P23; in P22 we just surface the in-between.)
	if (enabled && bridge && bridge.status !== 'running') return 'stopping';

	// 5. fallthrough → disabled
	return 'disabled';
}
