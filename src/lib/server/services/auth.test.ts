import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';

const TEST_DB_PATH = resolve('data/test-auth.db');
let testSqlite: InstanceType<typeof Database>;
let testDb: ReturnType<typeof drizzle>;

beforeAll(() => {
	mkdirSync(resolve('data'), { recursive: true });
	testSqlite = new Database(TEST_DB_PATH);
	testSqlite.pragma('journal_mode = WAL');
	testDb = drizzle(testSqlite, { schema });

	testSqlite.exec(`
		CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL UNIQUE,
			value TEXT NOT NULL,
			encrypted INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	testSqlite.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
});

afterAll(() => {
	testSqlite.close();
	if (existsSync(TEST_DB_PATH)) {
		unlinkSync(TEST_DB_PATH);
	}
});

vi.mock('$lib/server/db/client', () => ({
	get db() {
		return testDb;
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'a'.repeat(32)
	}
}));

import {
	hashPassword,
	verifyPassword,
	createSession,
	validateSession,
	deleteSession,
	isYoloMode,
	getUser,
	createUser,
	deleteUser
} from './auth';

describe('auth service', () => {
	beforeEach(() => {
		testSqlite.exec('DELETE FROM users');
		testSqlite.exec('DELETE FROM settings');
	});

	describe('password hashing', () => {
		it('hashPassword returns salt:hash format', () => {
			const hash = hashPassword('test123');
			expect(hash).toContain(':');
			const parts = hash.split(':');
			expect(parts).toHaveLength(2);
			expect(parts[0].length).toBeGreaterThan(0);
			expect(parts[1].length).toBeGreaterThan(0);
		});

		it('verifyPassword returns true for correct password', () => {
			const hash = hashPassword('test123');
			expect(verifyPassword('test123', hash)).toBe(true);
		});

		it('verifyPassword returns false for wrong password', () => {
			const hash = hashPassword('test123');
			expect(verifyPassword('wrong', hash)).toBe(false);
		});
	});

	describe('session management', () => {
		it('createSession returns session ID with length >= 32', () => {
			const sessionId = createSession('user1');
			expect(sessionId.length).toBeGreaterThanOrEqual(32);
		});

		it('validateSession returns session data for valid session', () => {
			const sessionId = createSession('user1');
			const session = validateSession(sessionId);
			expect(session).not.toBeNull();
			expect(session!.username).toBe('user1');
			expect(session!.expiresAt).toBeInstanceOf(Date);
		});

		it('validateSession returns null for invalid session', () => {
			const session = validateSession('invalid-id');
			expect(session).toBeNull();
		});

		it('deleteSession removes the session', () => {
			const sessionId = createSession('user1');
			expect(validateSession(sessionId)).not.toBeNull();
			deleteSession(sessionId);
			expect(validateSession(sessionId)).toBeNull();
		});
	});

	describe('YOLO mode', () => {
		it('isYoloMode returns false when no auth_yolo setting exists', () => {
			expect(isYoloMode()).toBe(false);
		});

		it('isYoloMode returns true when auth_yolo setting is "true"', async () => {
			const { saveSetting } = await import('./settings');
			await saveSetting('auth_yolo', 'true');
			expect(isYoloMode()).toBe(true);
		});
	});

	describe('user management', () => {
		it('createUser inserts into users table', () => {
			createUser('admin', 'pass123');
			const user = getUser();
			expect(user).not.toBeNull();
			expect(user!.username).toBe('admin');
		});

		it('getUser returns null when no user exists', () => {
			expect(getUser()).toBeNull();
		});

		it('deleteUser removes the user', () => {
			createUser('admin', 'pass123');
			expect(getUser()).not.toBeNull();
			deleteUser();
			expect(getUser()).toBeNull();
		});

		it('createUser upserts (single user only)', () => {
			createUser('admin', 'pass1');
			createUser('newadmin', 'pass2');
			const user = getUser();
			expect(user!.username).toBe('newadmin');
			// Should only be one user
			const count = testSqlite.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
			expect(count.cnt).toBe(1);
		});
	});
});
