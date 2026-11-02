import { describe, it, expect, vi } from 'vitest';

// Mock $env/dynamic/private before importing the module under test
// (crypto.ts reads DB_ENCRYPTION_KEY at call time via $env).
vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'x'.repeat(32)
	}
}));

import { encryptAccessCode, decryptAccessCode, BAMBU_USERNAME } from './bambu-credentials';

describe('bambu-credentials service', () => {
	it('round-trips an 8-char Access Code', () => {
		const plaintext = '12345678';
		const encrypted = encryptAccessCode(plaintext);
		expect(decryptAccessCode(encrypted)).toBe(plaintext);
	});

	it('ciphertext is not equal to plaintext', () => {
		const plaintext = '12345678';
		const encrypted = encryptAccessCode(plaintext);
		expect(encrypted).not.toBe(plaintext);
	});

	it('two encryptions of the same plaintext yield different ciphertexts (random IV)', () => {
		const a = encryptAccessCode('12345678');
		const b = encryptAccessCode('12345678');
		expect(a).not.toBe(b);
	});

	it('BAMBU_USERNAME is the constant "bblp"', () => {
		expect(BAMBU_USERNAME).toBe('bblp');
	});
});
