import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB_PATH = resolve('data/test-client.db');

describe('database client', () => {
	let db: ReturnType<typeof drizzle>;
	let sqlite: InstanceType<typeof Database>;

	beforeAll(() => {
		mkdirSync(resolve('data'), { recursive: true });
		sqlite = new Database(TEST_DB_PATH);
		sqlite.pragma('journal_mode = WAL');
		sqlite.pragma('foreign_keys = ON');
		db = drizzle(sqlite, { schema });

		// Create tables for the test
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS settings (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				key TEXT NOT NULL UNIQUE,
				value TEXT NOT NULL,
				encrypted INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
	});

	afterAll(() => {
		sqlite.close();
		if (existsSync(TEST_DB_PATH)) {
			unlinkSync(TEST_DB_PATH);
		}
	});

	it('db object is defined and has a select method', () => {
		expect(db).toBeDefined();
		expect(db.select).toBeDefined();
		expect(typeof db.select).toBe('function');
	});

	it('database file is created in data/ directory', () => {
		expect(existsSync(TEST_DB_PATH)).toBe(true);
	});

	it('can execute a simple query on settings table', () => {
		const result = db.select().from(schema.settings).all();
		expect(Array.isArray(result)).toBe(true);
	});
});
