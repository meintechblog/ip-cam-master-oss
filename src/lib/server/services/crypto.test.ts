import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock $env/dynamic/private before importing crypto module
vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'a'.repeat(32)
	}
}));

import { encrypt, decrypt } from './crypto';

describe('crypto service', () => {
	it('encrypt returns string in format "hex:hex:hex" (iv:authTag:ciphertext)', () => {
		const result = encrypt('hello');
		const parts = result.split(':');
		expect(parts).toHaveLength(3);
		// Each part should be a valid hex string
		for (const part of parts) {
			expect(part).toMatch(/^[0-9a-f]+$/);
		}
	});

	it('decrypt(encrypt("hello")) returns "hello"', () => {
		const encrypted = encrypt('hello');
		const decrypted = decrypt(encrypted);
		expect(decrypted).toBe('hello');
	});

	it('encrypt produces different output each time (random IV)', () => {
		const a = encrypt('hello');
		const b = encrypt('hello');
		expect(a).not.toBe(b);
	});

	it('decrypt with wrong data throws error', () => {
		expect(() => decrypt('bad:data:here')).toThrow();
	});
});
