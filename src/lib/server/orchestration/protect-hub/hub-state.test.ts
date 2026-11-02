// v1.3 Phase 22 Plan 02 Task 2 — getHubState() truth table.
//
// Asserts the 5-state enum derivation across the 8 documented input combinations.
// Mocks the three input services (settings/bridge-lifecycle/wizard-state) and
// verifies the priority order: error > starting > enabled > stopping > disabled.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetSetting = vi.fn();
const mockGetBridgeStatus = vi.fn();
const mockGetPointer = vi.fn();

vi.mock('$lib/server/services/settings', () => ({
	getSetting: (...args: unknown[]) => mockGetSetting(...args)
}));
vi.mock('$lib/server/orchestration/protect-hub/bridge-lifecycle', () => ({
	getBridgeStatus: () => mockGetBridgeStatus()
}));
vi.mock('$lib/server/orchestration/protect-hub/wizard-state', () => ({
	getPointer: () => mockGetPointer()
}));

import { getHubState } from './hub-state';

describe('getHubState() — 5-state derivation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns 'disabled' when nothing is set", async () => {
		mockGetSetting.mockResolvedValue(null);
		mockGetBridgeStatus.mockReturnValue(null);
		mockGetPointer.mockReturnValue(null);
		expect(await getHubState()).toBe('disabled');
	});

	it("returns 'enabled' when flag='true' AND bridge.status='running'", async () => {
		mockGetSetting.mockResolvedValue('true');
		mockGetBridgeStatus.mockReturnValue({ status: 'running' });
		mockGetPointer.mockReturnValue(null);
		expect(await getHubState()).toBe('enabled');
	});

	it("returns 'starting' when bridge.status='provisioning'", async () => {
		mockGetSetting.mockResolvedValue(null);
		mockGetBridgeStatus.mockReturnValue({ status: 'provisioning' });
		mockGetPointer.mockReturnValue(null);
		expect(await getHubState()).toBe('starting');
	});

	it("returns 'starting' when pointer in_progress at step=3", async () => {
		mockGetSetting.mockResolvedValue(null);
		mockGetBridgeStatus.mockReturnValue({ status: 'pending' });
		mockGetPointer.mockReturnValue({ step: 3, status: 'in_progress', error: null });
		expect(await getHubState()).toBe('starting');
	});

	it("does NOT return 'starting' when pointer in_progress at step=6 (completion-redirect race)", async () => {
		mockGetSetting.mockResolvedValue(null);
		mockGetBridgeStatus.mockReturnValue({ status: 'running' });
		mockGetPointer.mockReturnValue({ step: 6, status: 'in_progress', error: null });
		// step=6 in_progress falls through past the step 1..5 starting branch.
		// flag is unset → not 'enabled' → not 'stopping' → 'disabled'.
		expect(await getHubState()).toBe('disabled');
	});

	it("returns 'error' when bridge.status='failed'", async () => {
		mockGetSetting.mockResolvedValue('true');
		mockGetBridgeStatus.mockReturnValue({ status: 'failed' });
		mockGetPointer.mockReturnValue(null);
		expect(await getHubState()).toBe('error');
	});

	it("returns 'error' when pointer.error is set", async () => {
		mockGetSetting.mockResolvedValue(null);
		mockGetBridgeStatus.mockReturnValue({ status: 'running' });
		mockGetPointer.mockReturnValue({ step: 4, status: 'in_progress', error: 'oops' });
		expect(await getHubState()).toBe('error');
	});

	it("returns 'stopping' when flag='true' AND bridge stopped (no active pointer)", async () => {
		mockGetSetting.mockResolvedValue('true');
		mockGetBridgeStatus.mockReturnValue({ status: 'stopped' });
		mockGetPointer.mockReturnValue(null);
		expect(await getHubState()).toBe('stopping');
	});
});
