import { describe, it, expect } from 'vitest';
import { parseScanParams, isIPv4 } from './discovery-params';

const p = (q: string) => parseScanParams(new URL(`http://x/api/discovery${q}`).searchParams);

describe('parseScanParams', () => {
	it('uses defaults when nothing is given', () => {
		expect(p('')).toEqual({ subnet: '192.168.1', start: 1, end: 254 });
	});

	it('accepts a valid subnet and range', () => {
		expect(p('?subnet=10.0.3&start=20&end=30')).toEqual({ subnet: '10.0.3', start: 20, end: 30 });
	});

	it.each([
		'192.168.1; touch /tmp/x',
		'$(id)',
		'192.168.1.5',
		'192.168',
		'256.1.1',
		'1.2.3`id`',
		' 192.168.1',
		'01.2.3x',
		'192.168.1\n'
	])('rejects subnet %j', (subnet) => {
		expect(() => p(`?subnet=${encodeURIComponent(subnet)}`)).toThrow();
	});

	it.each([
		['0', '10'],
		['1', '255'],
		['20', '10'],
		['1;id', '10'],
		['1.5', '10'],
		['abc', '10'],
		['1', '1e2']
	])('rejects range start=%s end=%s', (start, end) => {
		expect(() => p(`?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)).toThrow();
	});
});

describe('isIPv4', () => {
	it('accepts dotted quads', () => {
		expect(isIPv4('192.168.3.21')).toBe(true);
	});
	it.each(['192.168.3', '192.168.3.256', 'evil.example', '1.2.3.4/x', '1.2.3.4:80', ''])(
		'rejects %j',
		(ip) => {
			expect(isIPv4(ip)).toBe(false);
		}
	);
});
