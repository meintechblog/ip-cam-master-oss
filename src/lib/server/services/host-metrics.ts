import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DiskUsage = {
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
	percentUsed: number;
};

export type MemoryUsage = {
	totalBytes: number;
	availableBytes: number;
	usedBytes: number;
	percentUsed: number;
};

export type ServiceStatus = {
	state: 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'unknown';
	subState: string;
	uptimeSeconds: number | null;
	mainPid: number | null;
	result: string;
};

const KNOWN_STATES = new Set<ServiceStatus['state']>([
	'active',
	'inactive',
	'failed',
	'activating',
	'deactivating',
	'unknown'
]);

// systemd formats ActiveEnterTimestamp with a weekday prefix and timezone abbreviation
// (e.g. "Thu 2026-04-10 14:32:11 CEST"). Node's Date.parse handles this on glibc Linux
// but not on macOS/BSD, so strip the weekday and trailing TZ abbreviation for portable parsing.
function parseSystemdTimestamp(raw: string): number | null {
	const direct = Date.parse(raw);
	if (Number.isFinite(direct)) return direct;

	const stripped = raw
		.replace(/^[A-Za-z]{3}\s+/, '')
		.replace(/\s+[A-Z]{2,5}$/, '');
	const parsed = Date.parse(stripped);
	return Number.isFinite(parsed) ? parsed : null;
}

export async function getDiskUsage(path = '/'): Promise<DiskUsage> {
	const { stdout } = await execFileAsync('df', [
		'-B1',
		'--output=size,used,avail,pcent',
		path
	]);

	const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
	const row = lines[lines.length - 1].trim();
	const cols = row.split(/\s+/);
	const totalBytes = Number(cols[0]);
	const usedBytes = Number(cols[1]);
	const availableBytes = Number(cols[2]);
	const percentUsed = Number((cols[3] ?? '0').replace('%', ''));

	return { totalBytes, usedBytes, availableBytes, percentUsed };
}

export async function getMemoryUsage(): Promise<MemoryUsage> {
	const meminfo = await readFile('/proc/meminfo', 'utf8');
	const kv: Record<string, number> = {};
	for (const line of meminfo.split('\n')) {
		const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
		if (match) {
			kv[match[1]] = Number(match[2]) * 1024;
		}
	}

	const totalBytes = kv.MemTotal ?? 0;
	const availableBytes = kv.MemAvailable ?? kv.MemFree ?? 0;
	const usedBytes = Math.max(0, totalBytes - availableBytes);
	const percentUsed =
		totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

	return { totalBytes, availableBytes, usedBytes, percentUsed };
}

export async function getServiceStatus(): Promise<ServiceStatus> {
	const { stdout } = await execFileAsync('systemctl', [
		'show',
		'ip-cam-master',
		'--property=ActiveState,SubState,ActiveEnterTimestamp,MainPID,Result',
		'--no-pager'
	]);

	const kv: Record<string, string> = {};
	for (const line of stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		kv[line.slice(0, eq)] = line.slice(eq + 1);
	}

	const rawState = (kv.ActiveState ?? '').trim();
	const state: ServiceStatus['state'] = KNOWN_STATES.has(
		rawState as ServiceStatus['state']
	)
		? (rawState as ServiceStatus['state'])
		: 'unknown';

	let uptimeSeconds: number | null = null;
	const enteredAt = (kv.ActiveEnterTimestamp ?? '').trim();
	if (state === 'active' && enteredAt.length > 0) {
		const enteredMs = parseSystemdTimestamp(enteredAt);
		if (enteredMs !== null) {
			uptimeSeconds = Math.max(0, Math.floor((Date.now() - enteredMs) / 1000));
		}
	}

	const pidRaw = (kv.MainPID ?? '').trim();
	const mainPid = pidRaw && pidRaw !== '0' ? Number(pidRaw) : null;

	return {
		state,
		subState: (kv.SubState ?? '').trim(),
		uptimeSeconds,
		mainPid: Number.isFinite(mainPid) ? (mainPid as number | null) : null,
		result: (kv.Result ?? '').trim()
	};
}
