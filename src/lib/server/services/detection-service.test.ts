// DetectionService — behavior tests. Mirrors the C1/C2 test style: deterministic,
// no real ProtectApi, no real timers. We drive the service with lightweight fakes
// for C1 (ConnectionLike) and C2 (TapLike) so we can assert composition behavior
// (wiring, state passthrough, recent-buffer bounding, graceful no-creds status)
// WITHOUT a controller or network. The disconnected/no-creds path is the
// load-bearing assertion (constraint: status MUST be graceful with no creds).

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// C1's module transitively imports ./settings → db/client, which touches a real
// SQLite file at import time (no `cameras` table in the test env). The service
// under test drives only injected fakes, so we stub ./settings to keep the real
// DB out of the import graph — mirroring protect-connection.test.ts.
vi.mock('./settings', () => ({
	getSettings: vi.fn(async () => ({}))
}));

import {
	DetectionService,
	DEFAULT_RECENT_LIMIT,
	type ConnectionLike,
	type TapLike
} from './detection-service';
import type { MinimalEvent } from './detection-tap';
import type { ConnState } from './protect-connection-fsm';
import type { StartResult } from './protect-connection';

// ── fakes ───────────────────────────────────────────────────────────────────────

// Fake C1: an EventEmitter that exposes the ConnectionLike surface plus the
// onPacket seam C2.attach() needs. State is settable so tests can simulate the
// FSM moving without a real reconnect cycle.
class FakeConnection extends EventEmitter implements ConnectionLike {
	state: ConnState = 'disconnected';
	startResult: StartResult = { ok: true };
	startCalls = 0;
	stopCalls = 0;

	getState(): ConnState {
		return this.state;
	}
	onStateChange(listener: (state: ConnState) => void): void {
		this.on('state', listener);
	}
	onPacket(listener: (packet: unknown) => void): void {
		this.on('packet', listener);
	}
	async start(): Promise<StartResult> {
		this.startCalls++;
		return this.startResult;
	}
	async stop(): Promise<void> {
		this.stopCalls++;
		this.state = 'disconnected';
	}
	// test helpers
	setState(s: ConnState): void {
		this.state = s;
		this.emit('state', s);
	}
}

// Fake C2: records attach()/stop() and lets tests fire 'detection' directly,
// bypassing packet parsing (that is covered by detection-tap-fsm.test.ts).
class FakeTap extends EventEmitter implements TapLike {
	attached: { onPacket(l: (p: unknown) => void): void } | null = null;
	stopCalls = 0;

	onDetection(listener: (event: MinimalEvent) => void): void {
		this.on('detection', listener);
	}
	attach(connection: { onPacket(l: (p: unknown) => void): void }): void {
		this.attached = connection;
	}
	stop(): void {
		this.stopCalls++;
	}
	// test helper
	fire(event: MinimalEvent): void {
		this.emit('detection', event);
	}
}

function ev(over: Partial<MinimalEvent> = {}): MinimalEvent {
	return {
		camera: over.camera ?? 'cam-A',
		type: over.type ?? 'person',
		phase: over.phase ?? 'confirmed',
		score: over.score ?? 80,
		ts: over.ts ?? 1000
	};
}

function makeService(over: { recentLimit?: number; now?: () => number } = {}) {
	const conn = new FakeConnection();
	const tap = new FakeTap();
	const svc = new DetectionService({
		connection: conn,
		tap,
		recentLimit: over.recentLimit,
		now: over.now
	});
	return { svc, conn, tap };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DetectionService — no-creds / disconnected path (load-bearing)', () => {
	it('status() returns disconnected + empty buffer WITHOUT start() and never throws', () => {
		const { svc } = makeService();
		const s = svc.status();
		expect(s.connectionState).toBe('disconnected');
		expect(s.started).toBe(false);
		expect(s.lastEventAt).toBeNull();
		expect(s.recent).toEqual([]);
	});

	it('start() with no creds resolves to a tagged auth_failed and stays disconnected (graceful)', async () => {
		const { svc, conn } = makeService();
		conn.startResult = { ok: false, reason: 'auth_failed' };
		conn.state = 'disconnected';

		const res = await svc.start();
		expect(res).toEqual({ ok: false, reason: 'auth_failed' });

		const s = svc.status();
		// started flips true (we attempted), but the connection is still disconnected
		// and the surface is intact — no throw, empty buffer.
		expect(s.started).toBe(true);
		expect(s.connectionState).toBe('disconnected');
		expect(s.recent).toEqual([]);
	});
});

describe('DetectionService — wiring & composition', () => {
	it('does NOT open the connection on construction (no auto-start on import)', () => {
		const { conn, tap } = makeService();
		expect(conn.startCalls).toBe(0);
		expect(tap.attached).toBeNull();
	});

	it('wire() attaches the tap to the connection and is idempotent', () => {
		const { svc, conn, tap } = makeService();
		svc.wire();
		expect(tap.attached).toBe(conn);
		const firstAttached = tap.attached;
		svc.wire(); // second call must not re-wire / swap the attachment
		expect(tap.attached).toBe(firstAttached);
		expect(conn.startCalls).toBe(0); // wiring never opens the ws
	});

	it('start() wires then opens the connection exactly once', async () => {
		const { svc, conn, tap } = makeService();
		const res = await svc.start();
		expect(res).toEqual({ ok: true });
		expect(conn.startCalls).toBe(1);
		expect(tap.attached).toBe(conn);
		expect(svc.status().started).toBe(true);
	});

	it('re-emits connection state transitions on its own state seam', async () => {
		const { svc, conn } = makeService();
		const seen: ConnState[] = [];
		svc.onStateChange((s) => seen.push(s));
		await svc.start();
		conn.setState('connected');
		conn.setState('degraded');
		expect(seen).toEqual(['connected', 'degraded']);
		// status() reflects the latest live FSM read
		expect(svc.status().connectionState).toBe('degraded');
	});
});

describe('DetectionService — recent-event buffer', () => {
	it('records detections newest-first and tracks lastEventAt', async () => {
		let t = 5000;
		const { svc, tap } = makeService({ now: () => t });
		await svc.start();

		t = 5001;
		tap.fire(ev({ type: 'person', ts: 100 }));
		t = 5002;
		tap.fire(ev({ type: 'vehicle', ts: 200 }));

		const s = svc.status();
		expect(s.recent.map((e) => e.type)).toEqual(['vehicle', 'person']); // newest-first
		expect(s.lastEventAt).toBe(5002);
	});

	it('re-emits each detection on its own detection seam', async () => {
		const { svc, tap } = makeService();
		const seen: string[] = [];
		svc.onDetection((e) => seen.push(e.type));
		await svc.start();
		tap.fire(ev({ type: 'animal' }));
		expect(seen).toEqual(['animal']);
	});

	it('bounds the buffer at recentLimit (oldest evicted)', async () => {
		const { svc, tap } = makeService({ recentLimit: 3 });
		await svc.start();
		for (let i = 0; i < 6; i++) tap.fire(ev({ type: `t${i}` }));
		const types = svc.status().recent.map((e) => e.type);
		expect(types).toHaveLength(3);
		// newest-first: last three fired were t5,t4,t3
		expect(types).toEqual(['t5', 't4', 't3']);
	});

	it('status().recent is a defensive copy (callers cannot mutate internal state)', async () => {
		const { svc, tap } = makeService();
		await svc.start();
		tap.fire(ev({ type: 'person' }));
		const first = svc.status().recent;
		first.push(ev({ type: 'injected' }));
		first[0].type = 'mutated';
		const second = svc.status().recent;
		expect(second).toHaveLength(1);
		expect(second[0].type).toBe('person');
	});

	it('uses the default recent limit when none is injected', () => {
		const { svc } = makeService();
		expect(DEFAULT_RECENT_LIMIT).toBe(50);
		// sanity: no events yet
		expect(svc.status().recent).toEqual([]);
	});
});

describe('DetectionService — stop()', () => {
	it('stops both halves and clears started, leaving the buffer readable', async () => {
		const { svc, conn, tap } = makeService();
		await svc.start();
		tap.fire(ev({ type: 'person' }));
		await svc.stop();
		expect(tap.stopCalls).toBe(1);
		expect(conn.stopCalls).toBe(1);
		const s = svc.status();
		expect(s.started).toBe(false);
		expect(s.recent).toHaveLength(1); // final read still works
	});
});
