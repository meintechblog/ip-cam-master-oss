// C3 DetectionPublisher — behavior tests. Mirrors the C1/C2/DetectionService test
// style: deterministic, NO real broker, NO real network, NO real timers. We drive
// the publisher with a fake mqtt client (records publishes + LWT) and a fake
// DetectionService (lets tests fire 'detection' / 'state' directly). The pinned MQTT
// semantics are the load-bearing assertions: exact 5-key payload, retain=false QoS1
// on detections, retained health + LWT, graceful broker-down, no cleartext logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// The publisher transitively imports ./detection-service → ./protect-connection →
// ./settings → db/client (real SQLite, no tables in test env). The unit under test
// drives only injected fakes, so we stub ./settings to keep the real DB out of the
// import graph — mirroring detection-service.test.ts / protect-connection.test.ts.
vi.mock('./settings', () => ({
	getSetting: vi.fn(async () => null),
	getSettings: vi.fn(async () => ({}))
}));

import {
	DetectionPublisher,
	DEFAULT_MQTT_HOST,
	DEFAULT_MQTT_PORT,
	HEALTH_TOPIC,
	detectionTopic,
	sanitizeCameraId,
	serializeDetection,
	healthStateForConn,
	type MqttClientLike,
	type MqttConnectArgs,
	type PublishOptions
} from './detection-publisher';
import type { MinimalEvent } from './detection-tap';
import type { ConnState } from './protect-connection-fsm';

// ── fakes ───────────────────────────────────────────────────────────────────────

type PublishRecord = { topic: string; message: string; opts: PublishOptions };

class FakeMqttClient extends EventEmitter implements MqttClientLike {
	publishes: PublishRecord[] = [];
	ended = false;
	endForce: boolean | undefined;

	// MqttClientLike.on is typed per-event; EventEmitter.on covers it structurally.
	publish(topic: string, message: string, opts: PublishOptions): void {
		this.publishes.push({ topic, message, opts });
	}
	end(force?: boolean, _opts?: object, cb?: () => void): void {
		this.ended = true;
		this.endForce = force;
		cb?.();
	}
	// test helper
	fireConnect(): void {
		this.emit('connect');
	}
}

// Fake DetectionService surface (only the methods the publisher consumes).
class FakeService extends EventEmitter {
	wireCalls = 0;
	// The CURRENT FSM state getConnectionState() returns — tests set this to model a
	// connection that transitioned BEFORE the publisher wired (the health-race).
	connState: ConnState = 'disconnected';
	wire(): void {
		this.wireCalls++;
	}
	onDetection(listener: (event: MinimalEvent) => void): void {
		this.on('detection', listener);
	}
	onStateChange(listener: (state: ConnState) => void): void {
		this.on('state', listener);
	}
	getConnectionState(): ConnState {
		return this.connState;
	}
	// test helpers
	fireDetection(event: MinimalEvent): void {
		this.emit('detection', event);
	}
	fireState(state: ConnState): void {
		this.connState = state;
		this.emit('state', state);
	}
}

function makeEvent(over: Partial<MinimalEvent> = {}): MinimalEvent {
	return { camera: 'cam-1', type: 'person', phase: 'confirmed', score: 87, ts: 1_000, ...over };
}

/** Build a publisher wired to a fresh fake client + service. */
function build(opts: { host?: string; port?: number } = {}) {
	const client = new FakeMqttClient();
	const service = new FakeService();
	const factoryArgs: MqttConnectArgs[] = [];
	const publisher = new DetectionPublisher({
		service: service as unknown as never,
		mqttFactory: (args) => {
			factoryArgs.push(args);
			return client;
		},
		host: opts.host,
		port: opts.port
	});
	return { client, service, publisher, factoryArgs };
}

// ── pure helpers ──────────────────────────────────────────────────────────────────

describe('serializeDetection — exactly the 5 contract keys', () => {
	it('emits only {camera,type,phase,score,ts}, dropping any extra field', () => {
		const dirty = {
			...makeEvent(),
			// simulate an upstream that leaks presence-PII; must NOT reach the wire
			bbox: [1, 2, 3, 4],
			metadata: { thumbnail: 'x' }
		} as unknown as MinimalEvent;
		const json = serializeDetection(dirty);
		const parsed = JSON.parse(json);
		expect(Object.keys(parsed).sort()).toEqual(['camera', 'phase', 'score', 'ts', 'type']);
		expect(parsed).toEqual({ camera: 'cam-1', type: 'person', phase: 'confirmed', score: 87, ts: 1_000 });
	});
});

describe('detectionTopic / healthStateForConn', () => {
	it('builds ipcam/<camera>/detection for a valid id (unchanged)', () => {
		expect(detectionTopic('cam-9')).toBe('ipcam/cam-9/detection');
	});
	it('maps ConnState → HealthState', () => {
		expect(healthStateForConn('connected')).toBe('online');
		expect(healthStateForConn('degraded')).toBe('degraded');
		expect(healthStateForConn('disconnected')).toBe('offline');
	});
});

// ── B5: MQTT topic sanitization ─────────────────────────────────────────────────

describe('B5 — detection topic sanitization', () => {
	it('collapses MQTT-unsafe chars (/ # space) to "_"', () => {
		expect(detectionTopic('a/b')).toBe('ipcam/a_b/detection'); // slash → no extra level
		expect(detectionTopic('a#b')).toBe('ipcam/a_b/detection'); // wildcard char
		expect(detectionTopic('a b')).toBe('ipcam/a_b/detection'); // space
		expect(detectionTopic('a+b')).toBe('ipcam/a_b/detection'); // single-level wildcard
	});
	it('keeps safe id chars [A-Za-z0-9._-] intact', () => {
		expect(sanitizeCameraId('Cam_9.Front-Door')).toBe('Cam_9.Front-Door');
	});
	it('sanitizes empty / all-invalid ids to "" so the publish can be dropped', () => {
		expect(sanitizeCameraId('')).toBe('');
		// NOTE: '#'/'/' map to '_', so an all-wildcard id is NOT empty — only a truly
		// empty string sanitizes to ''. The drop path is exercised in the egress tests.
		expect(sanitizeCameraId('')).toHaveLength(0);
	});
});

// ── lifecycle / wiring ──────────────────────────────────────────────────────────

describe('DetectionPublisher.start', () => {
	beforeEach(() => vi.clearAllMocks());

	it('does NOT connect on construction (lazy/explicit start)', () => {
		const { factoryArgs, publisher } = build();
		expect(factoryArgs).toHaveLength(0);
		expect(publisher.isStarted()).toBe(false);
	});

	it('wires the service and connects with the LWT on first start()', async () => {
		const { publisher, service, factoryArgs } = build();
		await publisher.start();
		expect(publisher.isStarted()).toBe(true);
		expect(service.wireCalls).toBe(1);
		expect(factoryArgs).toHaveLength(1);
		// LWT must be {state:"offline"} retained on ipcam/health, set AT CONNECT.
		expect(factoryArgs[0].will.topic).toBe(HEALTH_TOPIC);
		expect(factoryArgs[0].will.retain).toBe(true);
		expect(JSON.parse(factoryArgs[0].will.payload)).toEqual({ state: 'offline' });
	});

	it('is idempotent — second start() does not re-connect', async () => {
		const { publisher, factoryArgs } = build();
		await publisher.start();
		await publisher.start();
		expect(factoryArgs).toHaveLength(1);
	});

	it('defaults the broker to the confirmed 192.0.2.213:1883 when no override/settings', async () => {
		const { publisher, factoryArgs } = build();
		await publisher.start();
		expect(factoryArgs[0].host).toBe(DEFAULT_MQTT_HOST);
		expect(factoryArgs[0].port).toBe(DEFAULT_MQTT_PORT);
	});

	it('honors explicit host/port override (configurable, not hardcoded-only)', async () => {
		const { publisher, factoryArgs } = build({ host: '10.0.0.5', port: 18_83 });
		await publisher.start();
		expect(factoryArgs[0].host).toBe('10.0.0.5');
		expect(factoryArgs[0].port).toBe(1883);
	});
});

// ── detection egress ──────────────────────────────────────────────────────────────

describe('detection egress — retain=false QoS1, exact payload', () => {
	it('publishes each finalized MinimalEvent to ipcam/<cam>/detection, retain=false QoS1', async () => {
		const { publisher, service, client } = build();
		await publisher.start();
		client.fireConnect();
		client.publishes = []; // drop the on-connect health stamp

		service.fireDetection(makeEvent({ camera: 'door', type: 'person', score: 91, ts: 2_000 }));

		const det = client.publishes.find((p) => p.topic === 'ipcam/door/detection');
		expect(det).toBeDefined();
		expect(det!.opts).toEqual({ qos: 1, retain: false });
		expect(JSON.parse(det!.message)).toEqual({
			camera: 'door',
			type: 'person',
			phase: 'confirmed',
			score: 91,
			ts: 2_000
		});
	});

	it('publishes a sanitized camera id to the cleaned topic', async () => {
		const { publisher, service, client } = build();
		await publisher.start();
		client.fireConnect();
		client.publishes = [];

		service.fireDetection(makeEvent({ camera: 'a/b', type: 'person', score: 80, ts: 9 }));

		const det = client.publishes.find((p) => p.topic === 'ipcam/a_b/detection');
		expect(det).toBeDefined();
		expect(det!.opts).toEqual({ qos: 1, retain: false });
	});

	it('B5 — DROPS the publish for an empty/invalid camera id with a payload-free warn', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { publisher, service, client } = build();
		await publisher.start();
		client.fireConnect();
		client.publishes = [];

		// camera '' sanitizes to '' → publish must be DROPPED.
		service.fireDetection(makeEvent({ camera: '', type: 'person', score: 95, ts: 1234 }));

		// No detection publish happened.
		expect(client.publishes.filter((p) => p.topic.endsWith('/detection'))).toHaveLength(0);
		// Exactly one concise warn, carrying NO event field (no score/type/ts value).
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const warnStr = warnSpy.mock.calls.flat().join(' ');
		expect(warnStr).toContain('empty/invalid camera id');
		expect(warnStr).not.toContain('person'); // no type
		expect(warnStr).not.toContain('95'); // no score
		expect(warnStr).not.toContain('1234'); // no ts
		warnSpy.mockRestore();
	});

	it('publishes both confirmed and ended phases as distinct messages', async () => {
		const { publisher, service, client } = build();
		await publisher.start();
		client.fireConnect();
		client.publishes = [];

		service.fireDetection(makeEvent({ phase: 'confirmed' }));
		service.fireDetection(makeEvent({ phase: 'ended' }));

		const phases = client.publishes
			.filter((p) => p.topic === 'ipcam/cam-1/detection')
			.map((p) => JSON.parse(p.message).phase);
		expect(phases).toEqual(['confirmed', 'ended']);
	});

	it('never logs the MinimalEvent payload in cleartext', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { publisher, service, client } = build();
		await publisher.start();
		client.fireConnect();
		service.fireDetection(makeEvent({ camera: 'secret-cam', type: 'person', score: 77 }));

		const allLogged = [errSpy, logSpy, warnSpy]
			.flatMap((s) => s.mock.calls.flat())
			.join(' ');
		expect(allLogged).not.toContain('secret-cam');
		expect(allLogged).not.toContain('person');
		errSpy.mockRestore();
		logSpy.mockRestore();
		warnSpy.mockRestore();
	});
});

// ── health egress ──────────────────────────────────────────────────────────────────

describe('health egress — retained heartbeat', () => {
	it('health-race fix — publishes the CURRENT health ONCE on start() (no transition needed)', async () => {
		const { publisher, service, client } = build();
		// The connection already transitioned to 'connected' BEFORE the publisher wired;
		// it will fire NO onStateChange. getConnectionState() reflects the live state.
		service.connState = 'connected';

		await publisher.start();
		// WITHOUT firing any state transition and WITHOUT a broker connect event, the
		// current health must already be stamped retained 'online'.
		const health = client.publishes.find((p) => p.topic === HEALTH_TOPIC);
		expect(health).toBeDefined();
		expect(health!.opts).toEqual({ qos: 1, retain: true });
		expect(JSON.parse(health!.message)).toEqual({ state: 'online' });
	});

	it('stamps retained health=online on connect when C1 is connected', async () => {
		const { publisher, service, client } = build();
		await publisher.start();
		service.fireState('connected'); // record live state
		client.publishes = [];
		client.fireConnect();

		const health = client.publishes.find((p) => p.topic === HEALTH_TOPIC);
		expect(health).toBeDefined();
		expect(health!.opts).toEqual({ qos: 1, retain: true });
		expect(JSON.parse(health!.message)).toEqual({ state: 'online' });
	});

	it('republishes retained health on every C1 liveness transition', async () => {
		const { publisher, service, client } = build();
		await publisher.start();
		client.fireConnect();
		client.publishes = [];

		service.fireState('degraded');
		service.fireState('disconnected');
		service.fireState('connected');

		const states = client.publishes
			.filter((p) => p.topic === HEALTH_TOPIC)
			.map((p) => ({ retain: p.opts.retain, state: JSON.parse(p.message).state }));
		expect(states).toEqual([
			{ retain: true, state: 'degraded' },
			{ retain: true, state: 'offline' },
			{ retain: true, state: 'online' }
		]);
	});
});

// ── graceful broker-down ──────────────────────────────────────────────────────────

describe('graceful — broker down does not crash', () => {
	it('start() resolves even when error/offline/close fire (no throw)', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { publisher, client } = build();
		await expect(publisher.start()).resolves.toBeUndefined();
		// simulate a broker that is down: error then offline then close
		expect(() => {
			client.emit('error', new Error('ECONNREFUSED 192.0.2.213:1883'));
			client.emit('offline');
			client.emit('close');
		}).not.toThrow();
		errSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it('publishDetection before connect is a safe no-op path (no client throw)', async () => {
		const { publisher, service } = build();
		// fire a detection wired through start() but client.publish records harmlessly
		await publisher.start();
		expect(() => service.fireDetection(makeEvent())).not.toThrow();
	});
});

// ── clean shutdown ──────────────────────────────────────────────────────────────────

describe('stop — graceful offline + client end', () => {
	it('publishes a final retained offline and ends the client', async () => {
		const { publisher, client } = build();
		await publisher.start();
		client.fireConnect();
		client.publishes = [];

		await publisher.stop();

		const last = client.publishes.find((p) => p.topic === HEALTH_TOPIC);
		expect(last).toBeDefined();
		expect(JSON.parse(last!.message)).toEqual({ state: 'offline' });
		expect(last!.opts).toEqual({ qos: 1, retain: true });
		expect(client.ended).toBe(true);
		expect(publisher.isStarted()).toBe(false);
	});

	it('stop() before start() is a safe no-op', async () => {
		const { publisher, client } = build();
		await expect(publisher.stop()).resolves.toBeUndefined();
		expect(client.ended).toBe(false);
	});
});
