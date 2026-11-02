// v1.3 Phase 22 Plan 02 Task 3 — POST /api/protect-hub/wizard/complete atomicity.
//
// Verifies HUB-WIZ-10 + T-22-07 mitigation: saveSetting MUST be called before
// completePointer; if saveSetting throws, completePointer MUST NOT be called.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSaveSetting = vi.fn();
const mockCompletePointer = vi.fn();

vi.mock('$lib/server/services/settings', () => ({
	saveSetting: (...args: unknown[]) => mockSaveSetting(...args)
}));
vi.mock('$lib/server/orchestration/protect-hub/wizard-state', () => ({
	completePointer: () => mockCompletePointer()
}));

describe('POST /api/protect-hub/wizard/complete (atomicity)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('happy path — both saveSetting and completePointer called once, in order, returns 200', async () => {
		mockSaveSetting.mockResolvedValue(undefined);
		mockCompletePointer.mockReturnValue(undefined);
		const { POST } = await import('./+server');
		const res = (await POST({} as Parameters<typeof POST>[0])) as Response;
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(mockSaveSetting).toHaveBeenCalledTimes(1);
		expect(mockSaveSetting).toHaveBeenCalledWith('protect_hub_enabled', 'true');
		expect(mockCompletePointer).toHaveBeenCalledTimes(1);
		// Order: saveSetting must be invoked before completePointer
		expect(mockSaveSetting.mock.invocationCallOrder[0]).toBeLessThan(
			mockCompletePointer.mock.invocationCallOrder[0]
		);
	});

	it('saveSetting throws → 500 returned, completePointer NOT called (un-flipped both ways)', async () => {
		mockSaveSetting.mockRejectedValue(new Error('db boom'));
		const { POST } = await import('./+server');
		const res = (await POST({} as Parameters<typeof POST>[0])) as Response;
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.error).toBe('db boom');
		expect(mockSaveSetting).toHaveBeenCalledTimes(1);
		expect(mockCompletePointer).not.toHaveBeenCalled();
	});

	it('completePointer throws → 500 returned, saveSetting WAS called (idempotent retry path)', async () => {
		mockSaveSetting.mockResolvedValue(undefined);
		mockCompletePointer.mockImplementation(() => {
			throw new Error('pointer write failed');
		});
		const { POST } = await import('./+server');
		const res = (await POST({} as Parameters<typeof POST>[0])) as Response;
		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body.ok).toBe(false);
		expect(body.error).toBe('pointer write failed');
		// saveSetting was called — its effect (settings.protect_hub_enabled='true')
		// is persisted; user retries `complete` → saveSetting is a no-op upsert,
		// completePointer succeeds → pointer reaches terminal state.
		expect(mockSaveSetting).toHaveBeenCalledTimes(1);
		expect(mockCompletePointer).toHaveBeenCalledTimes(1);
	});
});
