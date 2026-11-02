import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
	const rawKey = env.DB_ENCRYPTION_KEY;
	if (!rawKey || rawKey.length < 32) {
		throw new Error('DB_ENCRYPTION_KEY must be at least 32 characters. Set it in .env');
	}
	return scryptSync(rawKey, 'ip-cam-master-salt', 32);
}

export function encrypt(plaintext: string): string {
	const key = getKey();
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(stored: string): string {
	const key = getKey();
	const parts = stored.split(':');
	if (parts.length !== 3) {
		throw new Error('Invalid encrypted value format');
	}
	const iv = Buffer.from(parts[0], 'hex');
	const authTag = Buffer.from(parts[1], 'hex');
	const encrypted = Buffer.from(parts[2], 'hex');
	const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
	decipher.setAuthTag(authTag);
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	return decrypted.toString('utf8');
}
