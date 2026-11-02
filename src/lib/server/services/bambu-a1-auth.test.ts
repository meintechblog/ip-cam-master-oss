import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAuth } from './bambu-a1-auth';

describe('buildAuth (Phase 18 / D-08 — spike 004 byte layout)', () => {
	it('produces exactly 80 bytes', () => {
		expect(buildAuth('bblp', '12345678').length).toBe(80);
	});

	it('encodes the 16-byte header with u32 LE 0x40 and u32 LE 0x3000 (NOT 0x30)', () => {
		const actual = buildAuth('bblp', '12345678');
		// This assertion catches the 0x30-vs-0x3000 silent-fail from spike 004 §2.
		// Wrong encoding (buf[4] = 0x30) produces 30 00 00 00; correct is 00 30 00 00.
		expect([...actual.subarray(0, 16)]).toEqual([
			0x40, 0, 0, 0, // u32 LE = 0x40
			0, 0x30, 0, 0, // u32 LE = 0x3000 (NOT 0x30 — silent-fail pitfall)
			0, 0, 0, 0, // reserved
			0, 0, 0, 0 // reserved
		]);
	});

	it('encodes username "bblp" ASCII at bytes 16..19, null-padded through 47', () => {
		const actual = buildAuth('bblp', '12345678');
		expect(actual.subarray(16, 20).toString('ascii')).toBe('bblp');
		expect(actual.subarray(20, 48).every((b) => b === 0)).toBe(true);
	});

	it('encodes access code "12345678" ASCII at bytes 48..55, null-padded through 79', () => {
		const actual = buildAuth('bblp', '12345678');
		expect(actual.subarray(48, 56).toString('ascii')).toBe('12345678');
		expect(actual.subarray(56, 80).every((b) => b === 0)).toBe(true);
	});

	it('matches the committed golden fixture byte-for-byte', () => {
		const fixture = readFileSync('src/lib/server/services/__fixtures__/a1-auth-packet.bin');
		expect(buildAuth('bblp', '12345678').equals(fixture)).toBe(true);
	});
});
