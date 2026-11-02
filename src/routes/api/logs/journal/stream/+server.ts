import type { RequestHandler } from './$types';
import { spawn } from 'node:child_process';

const VALID_SEVERITY = new Set(['error', 'warning', 'info', 'all']);

export const GET: RequestHandler = async ({ url, request }) => {
	const severityRaw = url.searchParams.get('severity') ?? 'all';
	const severity = VALID_SEVERITY.has(severityRaw) ? severityRaw : 'all';
	const priorityArg =
		severity === 'error'
			? 'err'
			: severity === 'warning'
				? 'warning'
				: severity === 'info'
					? 'info'
					: 'debug';

	const child = spawn(
		'journalctl',
		[
			'-u',
			'ip-cam-master',
			'-f',
			'-n',
			'100',
			'-o',
			'json',
			'-p',
			priorityArg,
			'--no-pager'
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);

	const encoder = new TextEncoder();
	let buffer = '';
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let killed = false;

	const killChild = () => {
		if (killed) return;
		killed = true;
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		try {
			child.kill('SIGTERM');
		} catch {
			/* already exited */
		}
	};

	const stream = new ReadableStream({
		start(controller) {
			child.stdout.on('data', (chunk: Buffer) => {
				buffer += chunk.toString('utf8');
				let idx: number;
				while ((idx = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, idx).trim();
					buffer = buffer.slice(idx + 1);
					if (line.length === 0) continue;
					try {
						controller.enqueue(encoder.encode(`event: entry\ndata: ${line}\n\n`));
					} catch {
						killChild();
						return;
					}
				}
			});

			child.on('exit', () => {
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
					killChild();
				}
			}, 15_000);

			// CRITICAL: cleanup journalctl -f child to avoid orphan zombies when client disconnects
			request.signal.addEventListener('abort', () => {
				killChild();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			killChild();
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
