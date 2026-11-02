// C3 DetectionPublisher — the MQTT egress edge of the local-first pipe
// C1 ProtectConnection → C2 DetectionTap → DetectionService (C5 liveness) → C3.
//
// This is the ONLY module that touches the Fleet-Mosquitto broker (192.0.2.213).
// It subscribes to the DetectionService's two read-only seams:
//   - onDetection(MinimalEvent)  → publishes the finalized detection (retain=false, QoS1)
//   - onStateChange(ConnState)   → republishes the retained health doc
// and owns the retained `ipcam/health` heartbeat plus the broker-set LWT that flips
// health to `offline` if THIS process dies without a clean disconnect.
//
// Ownership (LEAN-REBUILD-DESIGN v2 §MQTT): mqtt-master owns the broker/pipe,
// smart-home-master owns the `ipcam/*` topic SEMANTICS + rules (consumer). ip-cam is
// a pure publisher. We use a DIRECT mqtt client (not mqtt-master's HTTP publish API)
// precisely because the LWT on `ipcam/health` needs a real broker-side Last-Will,
// which an HTTP publish cannot register.
//
// Non-negotiable invariants (constraint, R31):
//   - Detection payload = EXACTLY the 5 MinimalEvent keys {camera,type,phase,score,ts}.
//   - Detection: topic `ipcam/<camera>/detection`, retain=FALSE, QoS 1.
//     (A retained detection would re-trigger a rule on every subscriber reconnect →
//      "light at 3am". Health is the only retained topic.)
//   - Health: topic `ipcam/health`, retain=TRUE; LWT `{state:"offline"}` set at CONNECT.
//   - NEVER log a MinimalEvent field in cleartext (presence-PII / log-redaction).
//   - Graceful: broker unreachable ⇒ no crash; rely on mqtt's auto-reconnect.
//   - Lazy/explicit start: constructing + importing is side-effect-free; nothing
//     connects to the broker until start() is called.
//
// Testability: the mqtt client is INJECTED via a factory (default = real mqtt.connect)
// and the DetectionService is injectable, so the whole module is unit-testable against
// a fake client with NO real broker and NO real network.

import mqtt from 'mqtt';
import type { MinimalEvent, RecognitionEvent } from './detection-tap';
import type { ConnState } from './protect-connection-fsm';
import { DetectionService, getDetectionService } from './detection-service';
import { getSetting } from './settings';

// CONFIRMED broker facts (2026-06-10): 192.0.2.213:1883, plain TCP, ANONYMOUS,
// mosquitto 2.0.21, `ipcam/#` free. Host/port are settings-overridable (mqtt_host /
// mqtt_port); these are the defaults — NOT hardcoded-only.
export const DEFAULT_MQTT_HOST = '192.0.2.213';
export const DEFAULT_MQTT_PORT = 1883;

export const HEALTH_TOPIC = 'ipcam/health';

/** The retained heartbeat doc on `ipcam/health`. `offline` is also the LWT body. */
export type HealthState = 'online' | 'degraded' | 'offline';

export interface HealthDoc {
	state: HealthState;
}

/**
 * MQTT topic-segment sanitizer. The camera id is foreign-system input that drives an
 * OUTWARD publish; an unsanitized `#`/`+`/`/`/space would mangle the topic tree (or
 * inject a wildcard segment). Collapse anything outside [A-Za-z0-9._-] to '_'. Returns
 * '' when nothing survives (empty or all-invalid id) so the caller can DROP the publish.
 */
export function sanitizeCameraId(camera: string): string {
	return camera.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Build the per-camera detection topic (camera id sanitized for MQTT). */
export function detectionTopic(camera: string): string {
	return `ipcam/${sanitizeCameraId(camera)}/detection`;
}

/** Build the per-camera recognition topic (camera id sanitized for MQTT). */
export function recognitionTopic(camera: string): string {
	return `ipcam/${sanitizeCameraId(camera)}/recognition`;
}

/**
 * Pin the recognition wire payload to EXACTLY its 4 contract keys — same
 * defensive stance as serializeDetection (no upstream growth ever leaks).
 */
export function serializeRecognition(event: RecognitionEvent): string {
	const wire = {
		camera: event.camera,
		kind: event.kind,
		known: event.known,
		ts: event.ts
	};
	return JSON.stringify(wire);
}

/**
 * Strip a MinimalEvent down to EXACTLY its 5 contract keys before serialization.
 * Defensive against an upstream that ever grows the type — the wire payload is
 * pinned regardless of what the in-process object carries (no bbox/metadata leak).
 */
export function serializeDetection(event: MinimalEvent): string {
	const wire = {
		camera: event.camera,
		type: event.type,
		phase: event.phase,
		score: event.score,
		ts: event.ts
	};
	return JSON.stringify(wire);
}

/**
 * Map the C1 connection liveness (ConnState) onto the published health state.
 * 'connected' ⇒ online; 'degraded' ⇒ degraded (tap alive but impaired);
 * 'disconnected' ⇒ offline (silent tap = safety signal for actuators).
 * NOTE: a broker LWT can independently flip the retained doc to `offline` if THIS
 * process dies — that is the stronger guarantee; this mapping covers the live path.
 */
export function healthStateForConn(state: ConnState): HealthState {
	switch (state) {
		case 'connected':
			return 'online';
		case 'degraded':
			return 'degraded';
		case 'disconnected':
		default:
			return 'offline';
	}
}

// ── injectable mqtt surface ─────────────────────────────────────────────────────
// We depend only on the slice of mqtt.MqttClient we actually use, so a test fake is
// trivial and we never touch a real socket.

export interface PublishOptions {
	qos?: 0 | 1 | 2;
	retain?: boolean;
}

export interface MqttClientLike {
	on(event: 'connect', listener: () => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'close', listener: () => void): void;
	on(event: 'offline', listener: () => void): void;
	publish(topic: string, message: string, opts: PublishOptions): void;
	end(force?: boolean, opts?: object, cb?: () => void): void;
}

export interface MqttConnectArgs {
	host: string;
	port: number;
	/** LWT: broker publishes this retained body on `ipcam/health` if we die uncleanly. */
	will: {
		topic: string;
		payload: string;
		qos: 0 | 1 | 2;
		retain: boolean;
	};
}

/** Factory the publisher uses to obtain a client. Default = real mqtt.connect. */
export type MqttClientFactory = (args: MqttConnectArgs) => MqttClientLike;

const defaultMqttFactory: MqttClientFactory = ({ host, port, will }) => {
	// Plain TCP, anonymous (no username/password) — confirmed broker facts.
	// reconnectPeriod>0 keeps mqtt's built-in auto-reconnect on (graceful: a broker
	// that is down at start() just retries; we never throw).
	return mqtt.connect({
		host,
		port,
		protocol: 'tcp',
		reconnectPeriod: 5_000,
		connectTimeout: 10_000,
		clean: true,
		clientId: `ipcam-pub-${Math.random().toString(16).slice(2, 10)}`,
		will: {
			topic: will.topic,
			payload: Buffer.from(will.payload),
			qos: will.qos,
			retain: will.retain
		}
	}) as unknown as MqttClientLike;
};

export type DetectionPublisherDeps = {
	/** DetectionService to subscribe to. Defaults to the process-wide singleton. */
	service?: Pick<DetectionService, 'onDetection' | 'onStateChange' | 'wire' | 'getConnectionState'> & Partial<Pick<DetectionService, 'onRecognition'>>;
	/** mqtt client factory. Defaults to the real mqtt.connect wrapper. */
	mqttFactory?: MqttClientFactory;
	/** Override broker host (else settings `mqtt_host`, else DEFAULT_MQTT_HOST). */
	host?: string;
	/** Override broker port (else settings `mqtt_port`, else DEFAULT_MQTT_PORT). */
	port?: number;
};

export class DetectionPublisher {
	private readonly service: Pick<DetectionService, 'onDetection' | 'onStateChange' | 'wire' | 'getConnectionState'> & Partial<Pick<DetectionService, 'onRecognition'>>;
	private readonly mqttFactory: MqttClientFactory;
	private readonly hostOverride?: string;
	private readonly portOverride?: number;

	private client: MqttClientLike | null = null;
	private started = false;
	// Last C1 state we observed — used to (a) publish the right health doc once the
	// broker connects, and (b) republish on liveness transitions.
	private lastConnState: ConnState = 'disconnected';

	constructor(deps: DetectionPublisherDeps = {}) {
		this.service = deps.service ?? getDetectionService();
		this.mqttFactory = deps.mqttFactory ?? defaultMqttFactory;
		this.hostOverride = deps.host;
		this.portOverride = deps.port;
	}

	/** True once start() has connected (or attempted to connect) this process. */
	isStarted(): boolean {
		return this.started;
	}

	/**
	 * Resolve broker host/port: explicit override → settings (mqtt_host/mqtt_port) →
	 * confirmed defaults. settings reads are graceful (missing keys fall through).
	 */
	private async resolveBroker(): Promise<{ host: string; port: number }> {
		let host = this.hostOverride;
		let port = this.portOverride;
		if (host === undefined) {
			host = (await getSetting('mqtt_host')) ?? DEFAULT_MQTT_HOST;
		}
		if (port === undefined) {
			const raw = await getSetting('mqtt_port');
			const parsed = raw ? Number.parseInt(raw, 10) : NaN;
			port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MQTT_PORT;
		}
		return { host, port };
	}

	/**
	 * Connect to the broker and wire the egress. Idempotent — a second call is a
	 * no-op. Wires the DetectionService observers and registers the LWT. Does NOT
	 * throw on an unreachable broker: mqtt buffers/retries; we just never crash.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		// Observe the service before opening the broker so no detection is dropped
		// in the wire→connect gap (publishes before connect are buffered by mqtt).
		this.service.wire();

		const { host, port } = await this.resolveBroker();

		// LWT: if THIS process dies uncleanly, the broker stamps `ipcam/health`
		// retained with {state:"offline"} so smart-home sees the tap is gone.
		const willPayload = JSON.stringify({ state: 'offline' } satisfies HealthDoc);
		this.client = this.mqttFactory({
			host,
			port,
			will: { topic: HEALTH_TOPIC, payload: willPayload, qos: 1, retain: true }
		});

		this.client.on('connect', () => {
			// On (re)connect, stamp the CURRENT liveness so a reconnect after an LWT
			// `offline` correctly restores the live state.
			this.publishHealth(healthStateForConn(this.lastConnState));
		});

		// Graceful: log the transport event (NO payloads), never throw. mqtt's own
		// reconnect loop handles recovery; we do not tear the client down.
		this.client.on('error', (err: Error) => {
			console.error(`[detection-publisher] mqtt error: ${err.message}`);
		});
		this.client.on('offline', () => {
			console.warn('[detection-publisher] mqtt offline — awaiting auto-reconnect');
		});
		this.client.on('close', () => {
			console.warn('[detection-publisher] mqtt connection closed — awaiting auto-reconnect');
		});

		// Detection egress: retain=false, QoS1, EXACTLY the 5 keys. NEVER log fields.
		this.service.onDetection((event) => this.publishDetection(event));

		// Recognition egress (known/unknown face & vehicle): retain=false, QoS1,
		// EXACTLY the 4 keys. Consumed by the Mac night-watch for known-exemption.
		// Optional-chained: test fakes without the seam stay valid (same stance as
		// the service's tap.onRecognition?.() wiring).
		this.service.onRecognition?.((event) => this.publishRecognition(event));

		// Liveness egress: republish the retained health doc on every C1 transition.
		this.service.onStateChange((state) => {
			this.lastConnState = state;
			this.publishHealth(healthStateForConn(state));
		});

		// Health-race fix: the connection may have already transitioned to its current
		// state BEFORE we wired onStateChange above (start ordering is not guaranteed).
		// Seed lastConnState from the live FSM and publish the CURRENT health ONCE so a
		// missed initial 'connected' cannot leave `ipcam/health` retained 'offline'.
		// (The on('connect') handler also stamps lastConnState on broker (re)connect —
		// both paths are idempotent retained publishes.)
		const current = this.service.getConnectionState();
		this.lastConnState = current;
		this.publishHealth(healthStateForConn(current));
	}

	/** Publish one PII-free recognition verdict. retain=false, QoS1. No cleartext logging. */
	publishRecognition(event: RecognitionEvent): void {
		if (!this.client) return;
		const safeCamera = sanitizeCameraId(event.camera);
		if (safeCamera === '') {
			console.warn('[detection-publisher] dropped recognition: empty/invalid camera id');
			return;
		}
		try {
			this.client.publish(recognitionTopic(event.camera), serializeRecognition(event), {
				qos: 1,
				retain: false
			});
		} catch (err) {
			console.error(
				`[detection-publisher] recognition publish failed: ${err instanceof Error ? err.message : 'unknown error'}`
			);
		}
	}

	/** Publish one finalized MinimalEvent. retain=false, QoS1. No cleartext logging. */
	publishDetection(event: MinimalEvent): void {
		if (!this.client) return;
		// B5 — drop a publish whose camera id sanitizes to empty (was '' or all-invalid
		// chars). Publishing to `ipcam//detection` would pollute the topic tree. The warn
		// carries NO event field (no score/type/ts) — presence-PII / log-redaction.
		const safeCamera = sanitizeCameraId(event.camera);
		if (safeCamera === '') {
			console.warn('[detection-publisher] dropped detection: empty/invalid camera id');
			return;
		}
		try {
			this.client.publish(detectionTopic(event.camera), serializeDetection(event), {
				qos: 1,
				retain: false
			});
		} catch (err) {
			// Defensive: a publish throw (e.g. client mid-teardown) must not crash the
			// process. Log the failure WITHOUT the payload (presence-PII redaction).
			console.error(
				`[detection-publisher] detection publish failed: ${err instanceof Error ? err.message : 'unknown'}`
			);
		}
	}

	/** Publish the retained health heartbeat. retain=true, QoS1. */
	publishHealth(state: HealthState): void {
		if (!this.client) return;
		try {
			this.client.publish(HEALTH_TOPIC, JSON.stringify({ state } satisfies HealthDoc), {
				qos: 1,
				retain: true
			});
		} catch (err) {
			console.error(
				`[detection-publisher] health publish failed: ${err instanceof Error ? err.message : 'unknown'}`
			);
		}
	}

	/**
	 * Clean shutdown: publish a final retained `offline` (so a graceful stop also
	 * marks the tap gone, not just the LWT path), then close the client.
	 */
	async stop(): Promise<void> {
		if (!this.client) {
			this.started = false;
			return;
		}
		this.publishHealth('offline');
		const client = this.client;
		this.client = null;
		this.started = false;
		await new Promise<void>((resolve) => {
			client.end(false, {}, () => resolve());
		});
	}
}

// ── module-level singleton (lazy, long-lived — NOT TTL'd, NO auto-connect) ─────────
let _publisher: DetectionPublisher | null = null;

/**
 * Lazy accessor for the process-wide DetectionPublisher. Constructing it is cheap
 * and side-effect-free — it does NOT connect to the broker on import. Whoever boots
 * the lean stack calls getDetectionPublisher().start() once, after / alongside
 * getDetectionService().start().
 */
export function getDetectionPublisher(): DetectionPublisher {
	if (!_publisher) {
		_publisher = new DetectionPublisher();
	}
	return _publisher;
}
