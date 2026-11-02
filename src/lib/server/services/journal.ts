import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Severity = 'error' | 'warning' | 'info' | 'all';

export type JournalEntry = {
	timestamp: number;
	priority: number;
	message: string;
	pid: number | null;
};

const PRIORITY_FLAG: Record<Severity, string[]> = {
	error: ['-p', 'err'],
	warning: ['-p', 'warning'],
	info: ['-p', 'info'],
	all: ['-p', 'debug']
};

export async function readJournal(
	lines: number,
	severity: Severity = 'all'
): Promise<JournalEntry[]> {
	const safeLines = Math.min(Math.max(1, Math.floor(lines)), 1000);
	const { stdout } = await execFileAsync(
		'journalctl',
		[
			'-u',
			'ip-cam-master',
			'-n',
			String(safeLines),
			'-o',
			'json',
			'--no-pager',
			...PRIORITY_FLAG[severity]
		],
		{ maxBuffer: 16 * 1024 * 1024 }
	);

	return stdout
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((line) => {
			const raw = JSON.parse(line);
			const tsMicros = Number(raw.__REALTIME_TIMESTAMP ?? 0);
			return {
				timestamp: Math.floor(tsMicros / 1000),
				priority: Number(raw.PRIORITY ?? 6),
				message: normalizeMessage(raw.MESSAGE),
				pid: raw._PID ? Number(raw._PID) : null
			};
		});
}

function normalizeMessage(msg: unknown): string {
	// systemd emits MESSAGE as an array of byte values when the payload contains non-UTF-8 bytes
	if (typeof msg === 'string') return msg;
	if (Array.isArray(msg)) return Buffer.from(msg).toString('utf8');
	return String(msg ?? '');
}
