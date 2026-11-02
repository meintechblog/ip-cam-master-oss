import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import path from 'node:path';
import { tailUpdateLog } from '$lib/server/services/update-runner';
import { updateUpdateRun } from '$lib/server/services/update-history';

const LOG_PATH_REGEX = /^\/tmp\/ip-cam-master-update-\d+\.log$/;
const EXITCODE_PATH_REGEX = /^\/tmp\/ip-cam-master-update-\d+\.exitcode$/;

const UPDATE_RESULT_SUCCESS_REGEX = /UPDATE_RESULT: success \([0-9a-f]+ -> ([0-9a-f]+)\)/;

function validatePath(value: string | null, regex: RegExp): boolean {
	if (value === null) return false;
	if (value.includes('..')) return false;
	return regex.test(value);
}

function deriveUnitName(logPath: string): string {
	const base = path.basename(logPath);
	return base.replace(/\.log$/, '');
}

export const GET: RequestHandler = async ({ url, request }) => {
	const logPath = url.searchParams.get('logPath');
	const exitcodeFile = url.searchParams.get('exitcodeFile');

	if (!validatePath(logPath, LOG_PATH_REGEX) || !validatePath(exitcodeFile, EXITCODE_PATH_REGEX)) {
		return json({ error: 'invalid_path' }, { status: 400 });
	}

	// Paths are now guaranteed to be non-null and match the strict regex
	const safeLogPath = logPath as string;
	const safeExitcodeFile = exitcodeFile as string;

	const abortController = new AbortController();
	const encoder = new TextEncoder();
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	// Track last UPDATE_RESULT marker to extract postSha on done
	let lastResultLine: string | null = null;

	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		try {
			abortController.abort();
		} catch {
			/* ignore */
		}
	};

	const stream = new ReadableStream({
		async start(controller) {
			// Client disconnect -> abort tail + close stream
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});

			heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(`: heartbeat\n\n`));
				} catch {
					cleanup();
				}
			}, 15_000);

			try {
				for await (const ev of tailUpdateLog(safeLogPath, safeExitcodeFile, abortController.signal)) {
					if (closed) break;
					if (ev.type === 'log') {
						if (ev.line.includes('UPDATE_RESULT:')) {
							lastResultLine = ev.line;
						}
						try {
							controller.enqueue(
								encoder.encode(`event: log\ndata: ${JSON.stringify({ line: ev.line })}\n\n`)
							);
						} catch {
							cleanup();
							return;
						}
					} else if (ev.type === 'done') {
						// Parse postSha from the most recent success marker line
						let postSha: string | null = null;
						if (lastResultLine) {
							const match = lastResultLine.match(UPDATE_RESULT_SUCCESS_REGEX);
							if (match) postSha = match[1];
						}

						const unitName = deriveUnitName(safeLogPath);
						try {
							await updateUpdateRun(unitName, {
								finishedAt: new Date().toISOString(),
								result: ev.result,
								postSha
							});
						} catch (err) {
							console.error('[update/run/stream] updateUpdateRun failed:', err);
						}

						try {
							controller.enqueue(
								encoder.encode(
									`event: done\ndata: ${JSON.stringify({
										exitCode: ev.exitCode,
										result: ev.result,
										postSha
									})}\n\n`
								)
							);
						} catch {
							/* closed */
						}
						cleanup();
						try {
							controller.close();
						} catch {
							/* already closed */
						}
						return;
					}
				}
			} catch (err) {
				console.error('[update/run/stream] tail failed:', err);
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
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
