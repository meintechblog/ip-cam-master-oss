// v1.3 Phase 22 Plan 02 Task 4 — getEvents() source-filter smoke test.
//
// Verifies the additive `source?: string` filter (added in this plan) appends
// `eq(events.source, value)` to the WHERE conditions. Mocks the drizzle chain
// and asserts the .where() builder receives a non-empty `and(...)` argument
// when source is supplied; receives no condition when omitted.
//
// The previous getEvents() shape (cameraId/severity/eventType/since/until/limit)
// is exercised across the existing test suite via storeEvent paths; this test
// targets the new branch only.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const whereSpy = vi.fn();
const fakeRows: any[] = [
	{
		id: 1,
		cameraId: null,
		cameraName: 'Protect Hub',
		eventType: 'reconcile_deployed',
		severity: 'info',
		message: 'reconcile abc deployed',
		source: 'protect_hub',
		timestamp: '2026-05-07T12:00:00Z'
	}
];

const selectChain: any = {
	from: () => selectChain,
	where: (cond: any) => {
		whereSpy(cond);
		return selectChain;
	},
	orderBy: () => selectChain,
	limit: () => selectChain,
	offset: () => selectChain,
	all: () => fakeRows,
	get: () => ({ count: fakeRows.length })
};

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => selectChain
	}
}));

vi.mock('$lib/server/db/schema', () => ({
	events: {
		id: 'id',
		cameraId: 'cameraId',
		severity: 'severity',
		eventType: 'eventType',
		source: 'source',
		timestamp: 'timestamp'
	}
}));

describe('getEvents() — Phase 22 source-filter extension', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('passes a non-undefined where-clause when source is supplied', async () => {
		const { getEvents } = await import('./events');
		const result = getEvents({ source: 'protect_hub', limit: 50 });
		expect(result.events.length).toBe(1);
		expect(result.total).toBe(1);
		// where() receives the and(...) result. Without a filter, getEvents
		// passes `undefined` to .where(); with one or more filters it passes
		// an `and(...)` expression. Either way the spy was called once per
		// SELECT; we assert the first call's arg is defined.
		expect(whereSpy).toHaveBeenCalled();
		const firstCallArg = whereSpy.mock.calls[0][0];
		expect(firstCallArg).toBeDefined();
	});

	it('passes undefined where-clause when no filters are supplied', async () => {
		const { getEvents } = await import('./events');
		getEvents({});
		// First WHERE call (rows query) gets undefined when conditions array is empty
		expect(whereSpy.mock.calls[0][0]).toBeUndefined();
	});
});
