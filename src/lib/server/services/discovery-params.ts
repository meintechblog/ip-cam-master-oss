// Validation for /api/discovery query parameters. subnet/start/end end up in a
// generated bash scan script, so only strict numeric values are allowed.

export interface ScanParams {
	subnet: string;
	start: number;
	end: number;
}

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const SUBNET_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}$`);
const IPV4_RE = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
const HOST_RE = /^\d{1,3}$/;

export function isIPv4(ip: string): boolean {
	return IPV4_RE.test(ip);
}

function parseHost(value: string | null, fallback: number, name: string): number {
	if (value === null || value === '') return fallback;
	if (!HOST_RE.test(value)) throw new Error(`invalid ${name}`);
	const n = Number(value);
	if (n < 1 || n > 254) throw new Error(`invalid ${name}`);
	return n;
}

/** Throws on invalid input; callers answer with 400. */
export function parseScanParams(params: URLSearchParams): ScanParams {
	const subnet = params.get('subnet') || '192.168.1';
	if (!SUBNET_RE.test(subnet)) throw new Error('invalid subnet');
	const start = parseHost(params.get('start'), 1, 'start');
	const end = parseHost(params.get('end'), 254, 'end');
	if (start > end) throw new Error('invalid range');
	return { subnet, start, end };
}
