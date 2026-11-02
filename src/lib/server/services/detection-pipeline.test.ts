// detection-pipeline — behavior tests for the boot-wire lifecycle pair.
//
// Pure unit tests: NO real connections, NO db, NO `$env`. We inject a fake
// `getSettings`, a fake `service` (vi.fn start/stop), and a fake `publisher`
// (vi.fn start/stop) so the guard / order / resilience / idempotency behavior is
// asserted deterministically. Call ORDER is asserted via mock.invocationCallOrder.
//
// Load-bearing assertions:
//   - no-creds guard: neither service.start() nor publisher.start() is called.
//   - start order: service.start() BEFORE publisher.start().
//   - stop order: publisher.stop() BEFORE service.stop().
//   - resilience: a throwing start/stop never rethrows out of the pipeline.
//   - idempotency: a second startDetectionPipeline() does not re-invoke start().

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test statically imports ./settings, ./detection-service and
// ./detection-publisher — each transitively pulls in db/client, which runs real
// SQLite migrations at import time (no `cameras` table in the test env). Every
// test injects its own fakes via DetectionPipelineDeps, so we stub these three
// modules to keep the real DB / mqtt / ProtectApi out of the import graph and the
// test fully pure — mirroring detection-service.test.ts's `vi.mock('./settings')`.
vi.mock('./settings', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./detection-service', () => ({ getDetectionService: vi.fn() }));
vi.mock('./detection-publisher', () => ({ getDetectionPublisher: vi.fn() }));

import {
	hasProtectCreds,
	startDetectionPipeline,
	stopDetectionPipeline,
	__resetDetectionPipelineForTests,
	type DetectionPipelineDeps
} from './detection-pipeline';

// ── fakes ───────────────────────────────────────────────────────────────────────

function fakeService() {
	return {
		start: vi.fn(async () => ({ ok: true as const })),
		stop: vi.fn(async () => {})
	};
}

function fakePublisher() {
	return {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {})
	};
}

function depsWith(
	settings: Record<string, string>,
	service = fakeService(),
	publisher = fakePublisher()
): { deps: DetectionPipelineDeps; service: typeof service; publisher: typeof publisher } {
	const deps: DetectionPipelineDeps = {
		getSettings: vi.fn(async () => settings),
		service,
		publisher
	};
	return { deps, service, publisher };
}

const FULL_CREDS = {
	unifi_host: '192.0.2.1',
	unifi_username: 'admin',
	unifi_password: 'secret'
};

beforeEach(() => {
	__resetDetectionPipelineForTests();
});

// ── hasProtectCreds ───────────────────────────────────────────────────────────

describe('hasProtectCreds', () => {
	it('returns true iff host + username + password are all non-empty', async () => {
		expect(await hasProtectCreds({ getSettings: async () => FULL_CREDS })).toBe(true);
	});

	it('returns false when settings are empty', async () => {
		expect(await hasProtectCreds({ getSettings: async () => ({}) })).toBe(false);
	});

	it('returns false when any one cred is missing/empty', async () => {
		expect(
			await hasProtectCreds({ getSettings: async () => ({ ...FULL_CREDS, unifi_password: '' }) })
		).toBe(false);
		expect(
			await hasProtectCreds({ getSettings: async () => ({ ...FULL_CREDS, unifi_username: '' }) })
		).toBe(false);
		expect(
			await hasProtectCreds({ getSettings: async () => ({ ...FULL_CREDS, unifi_host: '' }) })
		).toBe(false);
	});
});

// ── startDetectionPipeline — guard ──────────────────────────────────────────────

describe('startDetectionPipeline — creds guard', () => {
	it('no creds → neither service.start() nor publisher.start() is called, no throw', async () => {
		const { deps, service, publisher } = depsWith({});
		await expect(startDetectionPipeline(deps)).resolves.toBeUndefined();
		expect(service.start).not.toHaveBeenCalled();
		expect(publisher.start).not.toHaveBeenCalled();
	});

	it('creds present → both start() called, service BEFORE publisher', async () => {
		const { deps, service, publisher } = depsWith(FULL_CREDS);
		await startDetectionPipeline(deps);
		expect(service.start).toHaveBeenCalledTimes(1);
		expect(publisher.start).toHaveBeenCalledTimes(1);
		expect(service.start.mock.invocationCallOrder[0]).toBeLessThan(
			publisher.start.mock.invocationCallOrder[0]
		);
	});
});

// ── startDetectionPipeline — resilience ─────────────────────────────────────────

describe('startDetectionPipeline — resilience', () => {
	it('service.start() rejecting → no throw, function resolves', async () => {
		const service = fakeService();
		service.start.mockRejectedValueOnce(new Error('boom'));
		const { deps } = depsWith(FULL_CREDS, service);
		await expect(startDetectionPipeline(deps)).resolves.toBeUndefined();
	});

	it('publisher.start() rejecting → no throw, function resolves', async () => {
		const publisher = fakePublisher();
		publisher.start.mockRejectedValueOnce(new Error('broker down'));
		const { deps } = depsWith(FULL_CREDS, fakeService(), publisher);
		await expect(startDetectionPipeline(deps)).resolves.toBeUndefined();
	});
});

// ── startDetectionPipeline — idempotency ────────────────────────────────────────

describe('startDetectionPipeline — idempotency', () => {
	it('two calls → service.start() called once (guard flag)', async () => {
		const { deps, service, publisher } = depsWith(FULL_CREDS);
		await startDetectionPipeline(deps);
		await startDetectionPipeline(deps);
		expect(service.start).toHaveBeenCalledTimes(1);
		expect(publisher.start).toHaveBeenCalledTimes(1);
	});
});

// ── stopDetectionPipeline — order + resilience ──────────────────────────────────

describe('stopDetectionPipeline', () => {
	it('publisher.stop() BEFORE service.stop()', async () => {
		const { deps, service, publisher } = depsWith(FULL_CREDS);
		await startDetectionPipeline(deps);
		await stopDetectionPipeline(deps);
		expect(publisher.stop).toHaveBeenCalledTimes(1);
		expect(service.stop).toHaveBeenCalledTimes(1);
		expect(publisher.stop.mock.invocationCallOrder[0]).toBeLessThan(
			service.stop.mock.invocationCallOrder[0]
		);
	});

	it('a rejecting publisher.stop() still lets service.stop() run; resolves regardless', async () => {
		const publisher = fakePublisher();
		publisher.stop.mockRejectedValueOnce(new Error('end failed'));
		const { deps, service } = depsWith(FULL_CREDS, fakeService(), publisher);
		await startDetectionPipeline(deps);
		await expect(stopDetectionPipeline(deps)).resolves.toBeUndefined();
		expect(service.stop).toHaveBeenCalledTimes(1);
	});

	it('resets the started guard so a subsequent start re-invokes service.start()', async () => {
		const { deps, service } = depsWith(FULL_CREDS);
		await startDetectionPipeline(deps);
		await stopDetectionPipeline(deps);
		await startDetectionPipeline(deps);
		expect(service.start).toHaveBeenCalledTimes(2);
	});
});
