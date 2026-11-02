// Recognition seam (known/unknown face & vehicle) — FSM parse, tap correlation,
// wire serialization. Fixtures mirror the REAL label-update shape measured on the
// live Protect ws 2026-06-11: late `update` packets carrying ONLY {labels, metadata}
// in the payload, event id in the HEADER, verdict in detectedThumbnails[].labels.
import { describe, expect, it, vi } from 'vitest';
// The real db client needs a pre-created schema on disk; use an in-memory DB instead.
vi.mock('$lib/server/db/client', async () => {
	const { default: Database } = await import('better-sqlite3');
	return { sqlite: new Database(':memory:'), db: {}, DB_ABS_PATH: ':memory:' };
});

import { parseRecognitionPacket } from './detection-tap-fsm';
import { DetectionTap, type RecognitionEvent } from './detection-tap';
import { recognitionTopic, serializeRecognition } from './detection-publisher';

const EVENT_ID = 'evt-1234';
const CAM = 'cam-aaaa';

function addPacket(id = EVENT_ID, camera = CAM) {
	return {
		header: { modelKey: 'event', action: 'add', id },
		payload: { id, camera, type: 'smartDetectZone', smartDetectTypes: ['person'], score: 80, end: 0 }
	};
}

function endPacket(id = EVENT_ID, camera = CAM) {
	return {
		header: { modelKey: 'event', action: 'update', id },
		payload: { id, camera, smartDetectTypes: ['person'], score: 80, end: 1781180000000 }
	};
}

/** The measured shape: payload has ONLY labels+metadata — no camera, no id. */
function labelUpdatePacket(id = EVENT_ID, groupTypes = ['groupType:known'], thumbType = 'face') {
	return {
		header: { modelKey: 'event', action: 'update', id },
		payload: {
			labels: ['some-label'],
			metadata: {
				detectedThumbnails: [
					{
						type: thumbType,
						coord: [1, 2, 3, 4],
						labels: ['smartDetectType:face', 'zone:x:1', 'group:abc123', ...groupTypes],
						name: 'TEST-PLATE-1', // plate text — MUST never survive the gate
						attributes: { faceEmbed: [0.1, 0.2], matchedName: 'secret' }
					}
				]
			}
		}
	};
}

describe('parseRecognitionPacket', () => {
	it('extracts a known face verdict from a header-id-only label update', () => {
		const parsed = parseRecognitionPacket(labelUpdatePacket());
		expect(parsed).toEqual({ id: EVENT_ID, marks: [{ kind: 'face', known: true }] });
	});

	it('maps unknown and degraded groupTypes to known=false', () => {
		for (const labels of [['groupType:unknown'], ['groupType:unknown', 'groupType:degraded']]) {
			const parsed = parseRecognitionPacket(labelUpdatePacket(EVENT_ID, labels));
			expect(parsed).toEqual({ id: EVENT_ID, marks: [{ kind: 'face', known: false }] });
		}
	});

	it('extracts vehicle verdicts (plate matching rides on vehicle thumbnails)', () => {
		const parsed = parseRecognitionPacket(labelUpdatePacket(EVENT_ID, ['groupType:known'], 'vehicle'));
		expect(parsed).toEqual({ id: EVENT_ID, marks: [{ kind: 'vehicle', known: true }] });
	});

	it('returns null when no thumbnail carries a groupType verdict', () => {
		expect(parseRecognitionPacket(labelUpdatePacket(EVENT_ID, []))).toBeNull();
		expect(parseRecognitionPacket(addPacket())).toBeNull();
		expect(parseRecognitionPacket({ header: { modelKey: 'camera' }, payload: {} })).toBeNull();
		expect(parseRecognitionPacket(null)).toBeNull();
	});

	it('never copies names, group ids, embeddings or coords (structural PII gate)', () => {
		const parsed = parseRecognitionPacket(labelUpdatePacket());
		// Exact-shape assertion: id + booleans only.
		expect(JSON.stringify(parsed)).toBe(
			JSON.stringify({ id: EVENT_ID, marks: [{ kind: 'face', known: true }] })
		);
	});
});

describe('DetectionTap recognition correlation', () => {
	function collect(tap: DetectionTap): RecognitionEvent[] {
		const out: RecognitionEvent[] = [];
		tap.onRecognition((e) => out.push(e));
		return out;
	}

	it('resolves the camera from live event state', () => {
		const tap = new DetectionTap({ now: () => 1000 });
		const got = collect(tap);
		tap.ingest(addPacket());
		tap.ingest(labelUpdatePacket());
		expect(got).toEqual([{ camera: CAM, kind: 'face', known: true, ts: 1000 }]);
		tap.stop();
	});

	it('dedupes repeated identical verdicts per event', () => {
		const tap = new DetectionTap({ now: () => 1000 });
		const got = collect(tap);
		tap.ingest(addPacket());
		tap.ingest(labelUpdatePacket());
		tap.ingest(labelUpdatePacket());
		expect(got).toHaveLength(1);
		tap.stop();
	});

	it('still resolves verdicts that arrive AFTER the event ended (tombstone)', () => {
		const tap = new DetectionTap({ now: () => 1000 });
		const got = collect(tap);
		tap.ingest(addPacket());
		tap.ingest(endPacket());
		tap.ingest(labelUpdatePacket()); // measured: labels can trail `end` by seconds
		expect(got).toEqual([{ camera: CAM, kind: 'face', known: true, ts: 1000 }]);
		tap.stop();
	});

	it('drops verdicts for events it never tracked (no camera to resolve)', () => {
		const tap = new DetectionTap({ now: () => 1000 });
		const got = collect(tap);
		tap.ingest(labelUpdatePacket('evt-unseen'));
		expect(got).toHaveLength(0);
		tap.stop();
	});

	it('sweeps the tombstone after its window — late verdicts then drop', () => {
		let now = 1000;
		const tap = new DetectionTap({ now: () => now });
		const got = collect(tap);
		tap.ingest(addPacket());
		tap.ingest(endPacket());
		now += 31_000; // > RECOGNITION_TOMBSTONE_MS
		tap.reap();
		tap.ingest(labelUpdatePacket());
		expect(got).toHaveLength(0);
		tap.stop();
	});
});

describe('recognition wire contract', () => {
	it('topic is per-camera and sanitized', () => {
		expect(recognitionTopic('cam-1')).toBe('ipcam/cam-1/recognition');
		expect(recognitionTopic('a/b#c')).toBe('ipcam/a_b_c/recognition');
	});

	it('payload is pinned to EXACTLY the 4 contract keys', () => {
		const fat = {
			camera: 'c',
			kind: 'face',
			known: true,
			ts: 5,
			name: 'leak',
			faceEmbed: [1]
		} as unknown as RecognitionEvent;
		expect(JSON.parse(serializeRecognition(fat))).toEqual({
			camera: 'c',
			kind: 'face',
			known: true,
			ts: 5
		});
	});
});
