import { NodeSSH } from 'node-ssh';
import { getSettings, getSetting } from './settings';
import type { EventType, EventSeverity, EventSource } from '$lib/types';

let lastScanTimestamp: string | null = null;

// Matches real UDM Protect log format:
// "2026-03-23T10:43:09.576Z - error: ... Third party camera Garten [BC2411000001 @ 192.0.2.222] stream failed"
// "2026-03-23T11:37:16.519Z - info: Adopting camera at 192.0.2.206:8899"
// Camera name pattern: captured from "Third party camera <NAME> [MAC @ IP]"
const CAMERA_WITH_BRACKET = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s.*[Tt]hird\s+party\s+camera\s+(.+?)\s*\[\w+\s*@\s*([\d.]+)\]/;
const LOG_PATTERNS: Record<
	string,
	{ regex: RegExp; eventType: EventType; severity: EventSeverity }
> = {
	streamFailed: {
		regex: new RegExp(CAMERA_WITH_BRACKET.source + '.*stream\\s+failed', 'i'),
		eventType: 'stream_failed',
		severity: 'error'
	},
	healthCheckFailed: {
		regex: new RegExp(CAMERA_WITH_BRACKET.source + '.*health\\s+check\\s+failed', 'i'),
		eventType: 'stream_failed',
		severity: 'warning'
	},
	disconnect: {
		regex: new RegExp(CAMERA_WITH_BRACKET.source + '.*disconnect', 'i'),
		eventType: 'camera_disconnect',
		severity: 'warning'
	},
	reconnect: {
		regex: new RegExp(CAMERA_WITH_BRACKET.source + '.*reconnect', 'i'),
		eventType: 'camera_reconnect',
		severity: 'info'
	},
	adopted: {
		regex: new RegExp(CAMERA_WITH_BRACKET.source + '.*adopted', 'i'),
		eventType: 'adoption_changed',
		severity: 'info'
	},
	adopting: {
		// "Adopting camera at 192.0.2.206:8899" — no [Name @ IP] format
		regex: /(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s.*[Aa]dopting\s+camera\s+at\s+([\d.]+)/i,
		eventType: 'adoption_changed',
		severity: 'info'
	},
	aiportError: {
		regex: /(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s.*aiport.*error/i,
		eventType: 'aiport_error',
		severity: 'error'
	}
};

const NOISE_PATTERNS = [
	/ONVIF discovery/i,
	/go2rtc.*started/i,
	/periodic/i,
	/Updating ONVIF camera info/i,
	/has at least one in-stream channel/i
];

interface ParsedEvent {
	eventType: EventType;
	severity: EventSeverity;
	message: string;
	cameraName: string | null;
	cameraIp: string | null;
	timestamp: string;
	source: EventSource;
}

export function parseLogLines(stdout: string, since: Date): ParsedEvent[] {
	const lines = stdout.split('\n').filter((line) => line.trim());
	const parsed: ParsedEvent[] = [];

	for (const line of lines) {
		// Skip noise
		if (NOISE_PATTERNS.some((pattern) => pattern.test(line))) {
			continue;
		}

		for (const [key, pattern] of Object.entries(LOG_PATTERNS)) {
			const match = pattern.regex.exec(line);
			if (match) {
				const timestamp = match[1];
				const lineDate = new Date(timestamp);

				// Filter lines older than since
				if (lineDate <= since) continue;

				// "adopting" pattern has only 2 groups: timestamp + IP (no camera name)
				let cameraName: string | null = null;
				let cameraIp: string | null = null;
				if (key === 'adopting') {
					cameraIp = match[2] || null;
				} else {
					cameraName = match[2]?.trim() || null;
					cameraIp = match[3] || null;
				}

				parsed.push({
					eventType: pattern.eventType,
					severity: pattern.severity,
					message: line.trim(),
					cameraName,
					cameraIp,
					timestamp: lineDate.toISOString(),
					source: 'ssh_logs'
				});

				break; // Only match first pattern per line
			}
		}
	}

	return parsed;
}

async function connectToUdm(): Promise<NodeSSH> {
	const settings = await getSettings('unifi_');
	const host = settings.unifi_host;
	if (!host) throw new Error('UniFi host not configured');

	// Strip port if present
	const sshHost = host.replace(/:.*$/, '');

	const keyPath =
		(await getSetting('udm_ssh_key_path')) || '/opt/ip-cam-master/data/udm_key';

	const ssh = new NodeSSH();
	await ssh.connect({
		host: sshHost,
		username: 'root',
		privateKeyPath: keyPath
	});

	return ssh;
}

export async function scanUdmLogs(): Promise<ParsedEvent[]> {
	const ssh = await connectToUdm();

	try {
		const result = await ssh.execCommand(
			'tail -500 /srv/unifi-protect/logs/cameras.thirdParty.log'
		);

		if (result.code !== null && result.code !== 0) {
			console.error('UDM log read failed:', result.stderr);
			return [];
		}

		// Use lastScanTimestamp or 24 hours ago (first scan catches recent history)
		const since = lastScanTimestamp
			? new Date(lastScanTimestamp)
			: new Date(Date.now() - 24 * 60 * 60 * 1000);

		const events = parseLogLines(result.stdout, since);

		// Update last scan timestamp
		lastScanTimestamp = new Date().toISOString();

		return events;
	} finally {
		ssh.dispose();
	}
}

export async function fetchRawProtectLogs(lines: number = 100): Promise<string> {
	const ssh = await connectToUdm();

	try {
		const result = await ssh.execCommand(
			`tail -${lines} /srv/unifi-protect/logs/cameras.thirdParty.log`
		);

		if (result.code !== null && result.code !== 0) {
			throw new Error(`Failed to read UDM logs: ${result.stderr}`);
		}

		return result.stdout;
	} finally {
		ssh.dispose();
	}
}
