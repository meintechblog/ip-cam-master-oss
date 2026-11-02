import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { db } from '$lib/server/db/client';
import { cameras } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from './crypto';
import { connectToProxmox, executeOnContainer } from './ssh';

// Adaptive Stream Mode: MQTT-driven go2rtc toggle for Bambu printers.
// Reads print.gcode_state from device/<serial>/report, maps to live/idle group,
// starts/stops go2rtc on state-group transitions so the printer's Live555 server
// is left alone while idle.

const LIVE_STATES = new Set(['RUNNING', 'PREPARE', 'PAUSE']);
const IDLE_STATES = new Set(['FINISH', 'IDLE', 'FAILED']);

type StreamMode = 'adaptive' | 'always_live' | 'always_snapshot';

function groupForState(gcodeState: string): 'live' | 'idle' | 'unknown' {
	if (LIVE_STATES.has(gcodeState)) return 'live';
	if (IDLE_STATES.has(gcodeState)) return 'idle';
	return 'unknown';
}

type BambuConnectionError =
	| 'WRONG_ACCESS_CODE'
	| 'LAN_MODE_OFF'
	| 'PRINTER_UNREACHABLE'
	| 'MQTT_DISCONNECTED'
	| 'A1_CLOUD_MODE_ACTIVE';

/**
 * Narrow subscriber shape for the pure `handleMqttMessage` helper. Exported so
 * the MQTT message handler can be unit-tested without spinning up a full MQTT
 * client or touching the DB. The live `Subscriber` interface extends this with
 * connection-lifecycle fields (client, serial, lastGroup, reconnectAttempts).
 */
export interface SubscriberLike {
	cameraId: number;
	/**
	 * Canonical Bambu model (e.g. 'A1', 'H2C'). Drives the TUTK cloud-mode
	 * guard: `A1_CLOUD_MODE_ACTIVE` is only set for A1-family printers whose
	 * camera transport is jpeg-tls-6000 — H2C also reports `tutk_server`
	 * in its MQTT deltas but its camera rides RTSPS on port 322, which is
	 * unaffected by TUTK. Gating here prevents a false-positive error flag
	 * on H2C's UI status.
	 */
	model: string;
	lastError: BambuConnectionError | null;
	lastMessageAt: number;
}

interface Subscriber {
	cameraId: number;
	serial: string;
	model: string;
	client: MqttClient;
	lastGroup: 'live' | 'idle' | 'unknown';
	reconnectAttempts: number;
	lastError: BambuConnectionError | null;
	lastMessageAt: number;
}

const subscribers = new Map<number, Subscriber>();

async function toggleGo2rtc(vmid: number, action: 'start' | 'stop'): Promise<void> {
	const ssh = await connectToProxmox();
	try {
		await executeOnContainer(ssh, vmid, `systemctl ${action} go2rtc`);
	} finally {
		ssh.dispose();
	}
}

function resolveDesiredGroup(streamMode: StreamMode, mqttGroup: 'live' | 'idle' | 'unknown'): 'live' | 'idle' {
	if (streamMode === 'always_live') return 'live';
	if (streamMode === 'always_snapshot') return 'idle';
	// adaptive: follow MQTT; fall back to live on unknown so we don't cut the stream
	// based on incomplete data
	return mqttGroup === 'idle' ? 'idle' : 'live';
}

async function handleStateChange(
	sub: Subscriber,
	newGcodeState: string
): Promise<void> {
	const camRow = db.select().from(cameras).where(eq(cameras.id, sub.cameraId)).get() as any;
	if (!camRow) return;

	const mqttGroup = groupForState(newGcodeState);
	const streamMode = (camRow.streamMode ?? 'adaptive') as StreamMode;
	const desiredGroup = resolveDesiredGroup(streamMode, mqttGroup);

	// Persist the observed state regardless (useful for UI + debugging)
	if (camRow.printState !== newGcodeState) {
		db.update(cameras)
			.set({ printState: newGcodeState, updatedAt: new Date().toISOString() })
			.where(eq(cameras.id, sub.cameraId))
			.run();
	}

	// No-op if group unchanged
	if (desiredGroup === sub.lastGroup) return;
	sub.lastGroup = desiredGroup;

	if (!camRow.vmid || camRow.vmid === 0) return; // not provisioned yet

	try {
		await toggleGo2rtc(camRow.vmid, desiredGroup === 'live' ? 'start' : 'stop');
		console.log(`[bambu-mqtt] cam=${sub.cameraId} state=${newGcodeState} → ${desiredGroup} (vmid=${camRow.vmid})`);
	} catch (err) {
		console.error(`[bambu-mqtt] cam=${sub.cameraId} go2rtc toggle failed:`, err);
	}
}

/**
 * Pure message handler: mutates `sub` based on the inbound MQTT payload.
 *
 * Reads two fields from the printer's `device/<serial>/report` topic:
 *  - `print.gcode_state` — drives adaptive-mode go2rtc toggling (unchanged)
 *  - `print.ipcam.tutk_server` — runtime TUTK watch (D-06 / BAMBU-A1-06)
 *
 * Edge-trigger semantics for `tutk_server`:
 *  - `disable → enable` (or first-seen-as-enable) sets `lastError = 'A1_CLOUD_MODE_ACTIVE'`
 *  - `enable → disable` clears `lastError` ONLY when the current value is
 *    `A1_CLOUD_MODE_ACTIVE` (never clobbers other errors)
 *  - Steady-state repeat of the same value is a no-op (no log spam)
 *  - Delta messages without `ipcam.tutk_server` do not toggle the flag
 *
 * Conditional reset: `lastError = null` on message arrival fires only for
 * transient connection errors (WRONG_ACCESS_CODE, LAN_MODE_OFF, etc.). The
 * printer-state error `A1_CLOUD_MODE_ACTIVE` must persist across regular
 * messages — it's cleared only by explicit `tutk_server='disable'`.
 *
 * Exported for unit testing (`SubscriberLike` is the narrow contract).
 */
export function handleMqttMessage(sub: SubscriberLike, payload: Buffer | string): void {
	sub.lastMessageAt = Date.now();
	// Conditional clear — preserve printer-state errors (TUTK) across message arrival;
	// only transient connection errors auto-clear on successful message.
	if (sub.lastError && sub.lastError !== 'A1_CLOUD_MODE_ACTIVE') {
		sub.lastError = null;
	}
	let msg: any;
	try {
		msg = JSON.parse(typeof payload === 'string' ? payload : payload.toString());
	} catch {
		return;
	}

	// Existing: gcode_state → adaptive-mode state machine.
	// Only invoked for live Subscribers (has the extra fields `handleStateChange`
	// needs). Pure-handler callers use SubscriberLike and never set gcode_state.
	const gcodeState = msg?.print?.gcode_state;
	if (typeof gcodeState === 'string' && gcodeState) {
		void handleStateChange(sub as Subscriber, gcodeState);
	}

	// NEW (Phase 18 / D-06 / BAMBU-A1-06): TUTK cloud-mode runtime watch.
	// Edge-trigger only — logs and flips lastError only on transitions.
	// Gated to A1-family: H2C also reports tutk_server in its MQTT stream but
	// its camera is RTSPS-on-322, which is unaffected by TUTK routing, so
	// firing A1_CLOUD_MODE_ACTIVE on H2C is a UI false-positive.
	if (sub.model === 'A1') {
		const tutkServer = msg?.print?.ipcam?.tutk_server;
		if (typeof tutkServer === 'string') {
			if (tutkServer === 'enable' && sub.lastError !== 'A1_CLOUD_MODE_ACTIVE') {
				sub.lastError = 'A1_CLOUD_MODE_ACTIVE';
				console.log(`[bambu-mqtt] cam=${sub.cameraId} tutk_server=enable → CLOUD_MODE_ACTIVE`);
			} else if (tutkServer === 'disable' && sub.lastError === 'A1_CLOUD_MODE_ACTIVE') {
				sub.lastError = null;
				console.log(`[bambu-mqtt] cam=${sub.cameraId} tutk_server=disable → cleared`);
			}
		}
	}
}

function attachHandlers(sub: Subscriber): void {
	const { client, serial, cameraId } = sub;

	client.on('connect', () => {
		sub.reconnectAttempts = 0;
		sub.lastError = null;
		client.subscribe(`device/${serial}/report`, (err) => {
			if (err) console.error(`[bambu-mqtt] cam=${cameraId} subscribe error:`, err.message);
		});
	});

	client.on('message', (_topic, payload) => {
		handleMqttMessage(sub, payload);
	});

	client.on('error', (err: Error & { code?: number | string }) => {
		const msg = err.message.toLowerCase();
		// Phase 18 / WR-04: Prefer the mqtt library's numeric CONNACK return code
		// over substring matching. Codes 4 (bad username/password) and 5 (not
		// authorized) both indicate wrong access code for the A1 LAN broker.
		// Fall back to narrow substring matches on 'bad user'/'not authorized'
		// for brokers that surface only a textual reason. The old broad match
		// against 'connack' + '4'/'5' was prone to matching MQTT v5 broker
		// strings like "connack version 5" unrelated to authentication.
		const code = typeof err.code === 'number' ? err.code : undefined;
		const isAuthFailure =
			code === 4 ||
			code === 5 ||
			/\b(?:bad user name or password|not authorized)\b/i.test(err.message);
		if (isAuthFailure) {
			sub.lastError = 'WRONG_ACCESS_CODE';
			// Stop auto-reconnect to avoid hammering the printer with bad credentials.
			// addBambuSubscriber() will re-create the client with new credentials.
			sub.client.end(true);
			console.log(`[bambu-mqtt] cam=${cameraId} stopped reconnect — wrong access code`);
		} else if (msg.includes('econnrefused') || msg.includes('ehostunreach') || msg.includes('timeout')) {
			sub.lastError = 'LAN_MODE_OFF';
		} else if (msg.includes('enotfound') || msg.includes('enetunreach')) {
			sub.lastError = 'PRINTER_UNREACHABLE';
		} else {
			sub.lastError = 'MQTT_DISCONNECTED';
		}
		console.error(`[bambu-mqtt] cam=${cameraId} error: ${err.message} → ${sub.lastError}`);
	});

	client.on('close', () => {
		sub.reconnectAttempts += 1;
		// If no explicit error fired, still flag as disconnected after 3 retries
		if (sub.reconnectAttempts >= 3 && !sub.lastError) {
			sub.lastError = 'MQTT_DISCONNECTED';
		}
		if (sub.reconnectAttempts % 10 === 1) {
			console.log(`[bambu-mqtt] cam=${cameraId} reconnecting (attempt ${sub.reconnectAttempts})`);
		}
	});
}

async function connectSubscriber(cameraId: number): Promise<void> {
	const cam = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	if (!cam || cam.cameraType !== 'bambu' || !cam.accessCode || !cam.serialNumber) return;

	const accessCode = decrypt(cam.accessCode);
	const url = `mqtts://${cam.ip}:8883`;

	const client = mqtt.connect(url, {
		username: 'bblp',
		password: accessCode,
		rejectUnauthorized: false,
		connectTimeout: 10_000,
		reconnectPeriod: 15_000,
		clean: true,
		clientId: `ipcm-${cam.serialNumber}-${Math.random().toString(16).slice(2, 8)}`
	});

	const sub: Subscriber = {
		cameraId,
		serial: cam.serialNumber,
		model: cam.model || 'H2C',
		client,
		lastGroup: 'unknown',
		reconnectAttempts: 0,
		lastError: null,
		lastMessageAt: 0
	};
	subscribers.set(cameraId, sub);
	attachHandlers(sub);
}

export async function startBambuSubscribers(): Promise<void> {
	const bambuCams = db.select().from(cameras).where(eq(cameras.cameraType, 'bambu')).all() as any[];
	for (const cam of bambuCams) {
		if (!cam.accessCode || !cam.serialNumber) continue;
		if (subscribers.has(cam.id)) continue;
		try {
			await connectSubscriber(cam.id);
		} catch (err) {
			console.error(`[bambu-mqtt] cam=${cam.id} connect failed:`, err);
		}
	}
	if (bambuCams.length > 0) {
		console.log(`[bambu-mqtt] started ${subscribers.size} subscriber(s)`);
	}
}

export function stopBambuSubscribers(): void {
	for (const sub of subscribers.values()) {
		sub.client.end(true);
	}
	subscribers.clear();
}

export async function addBambuSubscriber(cameraId: number): Promise<void> {
	// Remove stale subscriber if it exists (e.g. after access code rotation)
	const existing = subscribers.get(cameraId);
	if (existing) {
		existing.client.end(true);
		subscribers.delete(cameraId);
	}
	await connectSubscriber(cameraId);
}

export function removeBambuSubscriber(cameraId: number): void {
	const sub = subscribers.get(cameraId);
	if (!sub) return;
	sub.client.end(true);
	subscribers.delete(cameraId);
}

export function getBambuState(cameraId: number): {
	printState: string | null;
	streamGroup: 'live' | 'idle' | 'unknown';
	connected: boolean;
	error: BambuConnectionError | null;
	lastMessageAgeSeconds: number | null;
} {
	const sub = subscribers.get(cameraId);
	const cam = db.select().from(cameras).where(eq(cameras.id, cameraId)).get() as any;
	const lastMessageAgeSeconds =
		sub?.lastMessageAt ? Math.round((Date.now() - sub.lastMessageAt) / 1000) : null;

	let error = sub?.lastError ?? null;
	// Also flag MQTT_DISCONNECTED if we haven't heard from the printer in 2+ min
	// and the client is not reporting connected (printer silent / turned off)
	if (!error && sub && !sub.client.connected && sub.reconnectAttempts >= 3) {
		error = 'MQTT_DISCONNECTED';
	}

	return {
		printState: cam?.printState ?? null,
		streamGroup: sub?.lastGroup ?? 'unknown',
		connected: !!sub?.client.connected,
		error,
		lastMessageAgeSeconds
	};
}
