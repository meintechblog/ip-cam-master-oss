// C2 DetectionTap — PURE per-event normalization / dedup / cooldown / reaper logic.
//
// This module is deliberately I/O-free, timer-free, and clock-injected: it owns
// ONLY the decision arithmetic that collapses UniFi Protect's add+N-updates
// firehose into at most one finalized `MinimalEvent` per (event, type, phase).
// The thin manager in `detection-tap.ts` wires a real Map + reaper interval +
// the C1 `'packet'` stream around these pure functions, so the hard-to-reproduce
// edge cases (growing type sets, lost `end`, cooldown windows) stay deterministic
// and unit-testable — mirroring the split in `protect-connection-fsm.ts`.
//
// HARD CONSTRAINT: no imports from `unifi-protect` or `protect-bridge` here.
// `parseEventPacket` is the load-bearing PII gate: it copies ONLY the five
// whitelisted fields out of the untrusted `unknown` payload and NEVER reads
// metadata / thumbnailId / smartDetectEvents / bboxes — so PII is structurally
// dropped at the boundary, not merely "not forwarded". Nothing here logs any
// payload-derived value (local-first / log-redaction constraint).

/** The only two phases a finalized detection is reported in. */
export type DetectionPhase = 'confirmed' | 'ended';

/**
 * The EXACT outward shape. No more fields, ever — asserted in tests. Anything
 * richer (bbox, metadata, thumbnail, raw payload) would leak presence-PII toward
 * the C3 MQTT egress / smart-home.
 */
export interface MinimalEvent {
	camera: string; // = payload.camera (id passthrough; name resolution deferred)
	type: string; // a single smartDetectType, e.g. 'person' (open string set, NOT an enum)
	phase: DetectionPhase;
	score: number; // latest known score for the event at emission time
	ts: number; // emission time in ms (REQUIRED — C3/smart-home use it to discard stale events)
}

/** Per-event tracked state, keyed by the Protect event id in the manager's Map. */
export interface EventState {
	camera: string;
	confirmedTypes: Set<string>;
	lastScore: number;
	firstSeen: number;
	lastSeen: number;
	ended: boolean;
}

/** Canonical cooldown key — `${camera} ${type}` (single space join). */
export type CooldownKey = string;

/** The normalized, PII-stripped view of one ws packet (or `null` if not an event). */
export interface ParsedEvent {
	id: string;
	camera: string;
	types: string[];
	score: number;
	end: number;
	isEvent: true;
}

/**
 * Recognition verdict extracted from Protect's face/plate matching, PII-free.
 * `known` mirrors Protect's `groupType:known` label (face library / named plates);
 * unknown + degraded both map to known=false. NEVER carries names, group ids,
 * plate text, embeddings or coordinates — those stay inside parseRecognitionPacket.
 */
export interface RecognitionEvent {
	camera: string;
	kind: 'face' | 'vehicle';
	known: boolean;
	ts: number;
}

/** One packet's recognition marks, pre camera-resolution (label-updates carry no camera). */
export interface ParsedRecognition {
	id: string;
	marks: Array<{ kind: 'face' | 'vehicle'; known: boolean }>;
}

/**
 * Second structural PII gate, for the recognition seam. Protect delivers face/plate
 * match results as `metadata.detectedThumbnails[].labels` on late `update` packets
 * that often carry ONLY `{labels, metadata}` — no camera, no smartDetectTypes (so
 * parseEventPacket rejects them; the event id comes from the HEADER). This reads
 * exclusively header.id + thumbnail `type` + the `groupType:*` label strings and
 * reduces them to booleans. It NEVER copies `name` (plate text!), `group:*` ids,
 * `faceEmbed` biometrics, coords or attributes — measured on the live wire
 * 2026-06-11: all of those are present and must die at this boundary.
 */
export function parseRecognitionPacket(packet: unknown): ParsedRecognition | null {
	if (!isRecord(packet)) return null;
	const header = packet.header;
	if (!isRecord(header)) return null;
	if (header.modelKey !== 'event') return null;

	const payload = packet.payload;
	if (!isRecord(payload)) return null;

	// Label-updates identify the event in the header; full payloads also carry payload.id.
	const id =
		typeof header.id === 'string' && header.id.length > 0
			? header.id
			: typeof payload.id === 'string' && payload.id.length > 0
				? payload.id
				: '';
	if (id.length === 0) return null;

	const metadata = payload.metadata;
	if (!isRecord(metadata)) return null;
	const thumbs = metadata.detectedThumbnails;
	if (!Array.isArray(thumbs)) return null;

	const seen = new Set<string>();
	const marks: ParsedRecognition['marks'] = [];
	for (const thumb of thumbs) {
		if (!isRecord(thumb)) continue;
		const kind = thumb.type;
		if (kind !== 'face' && kind !== 'vehicle') continue;
		const labels = Array.isArray(thumb.labels)
			? thumb.labels.filter((l): l is string => typeof l === 'string')
			: [];
		const groupTypes = labels.filter((l) => l.startsWith('groupType:'));
		if (groupTypes.length === 0) continue; // no recognition verdict on this thumb
		const known = groupTypes.includes('groupType:known');
		const dedupe = `${kind}:${known}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);
		marks.push({ kind, known });
	}
	if (marks.length === 0) return null;
	return { id, marks };
}

// Score gate for a 'confirmed' emit. Protect sends a weak first sighting and then
// strengthens the score over subsequent updates; 50 filters the low-confidence
// first blush while still letting a type confirm on a later, higher-score update.
export const DEFAULT_CONFIRM_SCORE = 50;

// Per-(camera,type) cooldown: a flapping detector must not storm smart-home rules.
// 30s is long enough to debounce re-triggers of the same subject without dropping
// genuinely distinct re-entries.
export const DEFAULT_COOLDOWN_MS = 30_000;

// Orphan reaper window: an event that got 'add' but whose 'end' packet was lost
// (silent ws death, dropped update) is swept after 2 min of silence so its state
// is freed AND downstream can close any presence it opened on 'confirmed'.
export const DEFAULT_EVENT_TTL_MS = 120_000;

/** Build the canonical cooldown key for a (camera, type) pair. */
export function cooldownKey(camera: string, type: string): CooldownKey {
	return `${camera} ${type}`;
}

/**
 * Structural PII gate. Narrows the untrusted `unknown` packet defensively and
 * copies ONLY id / cameraId / smartDetectTypes / score / end. Returns `null` for
 * anything that is not a well-formed `modelKey === 'event'` packet (wrong model,
 * missing header/payload/id). NEVER casts to a lib interface and trusts it; never
 * reads metadata / thumbnailId / smartDetectEvents / detectedAt / type / …
 */
export function parseEventPacket(packet: unknown): ParsedEvent | null {
	if (!isRecord(packet)) return null;

	const header = packet.header;
	if (!isRecord(header)) return null;
	if (header.modelKey !== 'event') return null;

	const payload = packet.payload;
	if (!isRecord(payload)) return null;

	const id = payload.id;
	if (typeof id !== 'string' || id.length === 0) return null;

	// The Protect realtime ws AND the historical events API carry the camera id
	// under `camera` (verified against the live wire 2026-06-10). An earlier
	// synthetic fixture used `cameraId`, which never appears on a real packet —
	// reading it dropped every event. Read `camera` first, keep `cameraId` as a
	// defensive fallback so both shapes parse.
	const camera =
		typeof payload.camera === 'string'
			? payload.camera
			: typeof payload.cameraId === 'string'
				? payload.cameraId
				: '';
	if (camera.length === 0) return null;

	// smartDetectTypes is optional and grows over the event's life. Copy only
	// string members; ignore a malformed value entirely (defaults to []).
	const rawTypes = payload.smartDetectTypes;
	const types = Array.isArray(rawTypes) ? rawTypes.filter((t): t is string => typeof t === 'string') : [];

	const score = typeof payload.score === 'number' ? payload.score : 0;
	const end = typeof payload.end === 'number' ? payload.end : 0;

	return { id, camera, types, score, end, isEvent: true };
}

/** Shallow-clone an EventState so the reducers never mutate their input. */
function cloneState(state: EventState): EventState {
	return {
		camera: state.camera,
		confirmedTypes: new Set(state.confirmedTypes),
		lastScore: state.lastScore,
		firstSeen: state.firstSeen,
		lastSeen: state.lastSeen,
		ended: state.ended
	};
}

/**
 * Fold an 'add'/'update' packet into the per-event state, emitting a 'confirmed'
 * MinimalEvent for each NEW type whose score clears `confirmScore`.
 *
 * Dedup invariant: a type already in `confirmedTypes` never re-emits 'confirmed',
 * so repeated updates are idempotent. A type seen below the score gate is NOT
 * marked confirmed — it stays eligible to confirm on a later, stronger update
 * (avoids emitting on a weak first sighting without permanently swallowing it).
 */
export function computeConfirmations(
	state: EventState | undefined,
	parsed: ParsedEvent,
	now: number,
	confirmScore: number
): { nextState: EventState; emit: MinimalEvent[] } {
	const next: EventState = state
		? cloneState(state)
		: {
				camera: parsed.camera,
				confirmedTypes: new Set<string>(),
				lastScore: parsed.score,
				firstSeen: now,
				lastSeen: now,
				ended: false
			};

	next.lastScore = parsed.score;
	next.lastSeen = now;

	const emit: MinimalEvent[] = [];
	// A terminated event never re-confirms (defensive — manager deletes on end).
	if (next.ended) return { nextState: next, emit };

	for (const type of parsed.types) {
		if (next.confirmedTypes.has(type)) continue; // dedup: already confirmed
		if (parsed.score < confirmScore) continue; // score gate — stays eligible later
		next.confirmedTypes.add(type);
		emit.push({
			camera: next.camera,
			type,
			phase: 'confirmed',
			score: parsed.score,
			ts: now
		});
	}

	return { nextState: next, emit };
}

/**
 * Close out an event: emit one 'ended' MinimalEvent per already-confirmed type
 * (score = last known, ts = now), then mark the state ended. An event that never
 * confirmed any type emits nothing — nothing downstream opened state for it.
 * Used both for a real non-zero `end` and by the orphan reaper (synthetic end).
 */
export function computeEnd(
	state: EventState,
	now: number
): { nextState: EventState; emit: MinimalEvent[] } {
	const next = cloneState(state);
	const emit: MinimalEvent[] = [];
	if (next.ended) return { nextState: next, emit };

	for (const type of next.confirmedTypes) {
		emit.push({
			camera: next.camera,
			type,
			phase: 'ended',
			score: next.lastScore,
			ts: now
		});
	}
	next.ended = true;
	return { nextState: next, emit };
}

/** Cooldown predicate: true while inside the per-(camera,type) suppression window. */
export function isCoolingDown(
	lastEmit: number | undefined,
	now: number,
	cooldownMs: number
): boolean {
	if (lastEmit === undefined) return false;
	return now - lastEmit < cooldownMs;
}

/**
 * Orphan predicate: an event that got 'add' but never a clean 'end' and has gone
 * silent for at least `ttlMs`. The reaper uses this to free leaked state (and emit
 * a synthetic 'ended' so a stuck-open detection never reads as permanent presence).
 */
export function isOrphanExpired(state: EventState, now: number, ttlMs: number): boolean {
	return !state.ended && now - state.lastSeen >= ttlMs;
}

/** Narrow an `unknown` to a plain string-keyed record without trusting its shape. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
