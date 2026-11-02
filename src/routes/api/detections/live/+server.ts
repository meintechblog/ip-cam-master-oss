import type { RequestHandler } from './$types';
import { getDetectionService } from '$lib/server/services/detection-service';
import type { MinimalEvent } from '$lib/server/services/detection-tap';

// Read-only live detection feed as Server-Sent Events. Mirrors the journal SSE
// route (src/routes/api/logs/journal/stream/+server.ts): a ReadableStream that
// emits `event: ...\ndata: ...\n\n` frames, a 15s heartbeat comment to keep the
// connection warm, and abort/cancel cleanup so we never leak the listener.
//
// Source seam: DetectionService.onDetection — the SAME PII-free MinimalEvent
// stream a UI / C3 MQTT egress consumes. NO raw payload, NO bbox, NO frames ever
// cross this boundary (the C2 PII gate already stripped them). This route never
// opens the live connection; it only observes whatever the started stack delivers.
export const GET: RequestHandler = async ({ request }) => {
	const service = getDetectionService();
	// Arm the C1⇄C2 observers (idempotent, no ws open) so detections flow into the
	// seam this stream subscribes to once the stack is started.
	service.wire();

	const encoder = new TextEncoder();
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let onDetection: ((event: MinimalEvent) => void) | null = null;
	let closed = false;

	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (onDetection) {
			service.off('detection', onDetection);
			onDetection = null;
		}
	};

	const stream = new ReadableStream({
		start(controller) {
			// 1) Replay the current buffer so a late subscriber sees recent context
			//    immediately (newest-first from status()).
			const snapshot = service.status();
			try {
				controller.enqueue(
					encoder.encode(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`)
				);
			} catch {
				cleanup();
				return;
			}

			// 2) Live detections.
			onDetection = (event: MinimalEvent) => {
				try {
					controller.enqueue(
						encoder.encode(`event: detection\ndata: ${JSON.stringify(event)}\n\n`)
					);
				} catch {
					cleanup();
				}
			};
			service.onDetection(onDetection);

			// 3) Heartbeat — same cadence as the journal stream.
			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					cleanup();
				}
			}, 15_000);

			// 4) Client disconnect → drop the listener + heartbeat (no orphan).
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
