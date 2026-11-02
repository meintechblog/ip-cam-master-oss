import { encrypt, decrypt } from './crypto';

/**
 * Bambu LAN-Mode MQTT / RTSPS username. Constant per
 * `.planning/research/H2C-FIELD-NOTES.md` §MQTT. All Bambu rows in the
 * `cameras` table use this literal — it is not user-editable.
 */
export const BAMBU_USERNAME = 'bblp' as const;

/**
 * Wraps an 8-char Bambu Access Code with AES-256-GCM.
 * Thin wrapper over `crypto.ts` — exists to give downstream Bambu code
 * a domain-named symbol and make call-sites greppable.
 */
export function encryptAccessCode(accessCode: string): string {
	return encrypt(accessCode);
}

/**
 * Unwraps a stored Access Code ciphertext back to plaintext.
 * Throws if the stored value is malformed or authentication fails.
 */
export function decryptAccessCode(stored: string): string {
	return decrypt(stored);
}
