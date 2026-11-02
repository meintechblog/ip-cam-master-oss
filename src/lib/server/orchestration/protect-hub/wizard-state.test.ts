// v1.3 Phase 22 Plan 01 Task 2 — Tests for wizard-state.ts.
// Single-row pointer service (id=1 always upserted). Uses in-memory
// better-sqlite3 + Drizzle (mirrors bridge-lifecycle.test.ts pattern).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const { memDbRef } = vi.hoisted(() => ({
	memDbRef: {
		db: null as ReturnType<typeof drizzle> | null,
		sqlite: null as Database.Database | null
	}
}));

vi.mock('$lib/server/db/client', () => ({
	get db() {
		return memDbRef.db;
	},
	get sqlite() {
		return memDbRef.sqlite;
	},
	DB_ABS_PATH: ':memory:'
}));

import * as schema from '../../db/schema';
import {
	getPointer,
	setPointer,
	resetPointer,
	completePointer
} from './wizard-state';
import { hubOnboardingState } from '../../db/schema';

function freshDb() {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');

	sqlite.exec(`
		CREATE TABLE hub_onboarding_state (
			id INTEGER PRIMARY KEY DEFAULT 1,
			step INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'in_progress',
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			error TEXT
		)
	`);

	memDbRef.sqlite = sqlite;
	memDbRef.db = drizzle(sqlite, { schema });
}

beforeEach(() => {
	freshDb();
});

describe('wizard-state — getPointer()', () => {
	it('returns null when no row exists', () => {
		expect(getPointer()).toBeNull();
	});
});

describe('wizard-state — setPointer()', () => {
	it('inserts a new row when no pointer exists; status=in_progress, error=null', () => {
		setPointer(3);
		const row = getPointer();
		expect(row).not.toBeNull();
		expect(row!.id).toBe(1);
		expect(row!.step).toBe(3);
		expect(row!.status).toBe('in_progress');
		expect(row!.error).toBeNull();
		expect(typeof row!.lastActivityAt).toBe('string');
		expect(row!.lastActivityAt.length).toBeGreaterThan(0);
	});

	it('persists the error string when provided', () => {
		setPointer(3, 'oops');
		const row = getPointer();
		expect(row).not.toBeNull();
		expect(row!.step).toBe(3);
		expect(row!.error).toBe('oops');
	});

	it('UPDATEs (does not insert second row) on a second call — single-row invariant', () => {
		setPointer(3);
		setPointer(4);
		const all = memDbRef
			.db!.select()
			.from(hubOnboardingState)
			.all();
		expect(all.length).toBe(1);
		expect(all[0].step).toBe(4);
		expect(all[0].status).toBe('in_progress');
	});
});

describe('wizard-state — resetPointer()', () => {
	it('deletes the row entirely so getPointer() returns null again', () => {
		setPointer(3);
		expect(getPointer()).not.toBeNull();
		resetPointer();
		expect(getPointer()).toBeNull();
	});
});

describe('wizard-state — completePointer()', () => {
	it('flips an existing row to step=6, status=completed, error=null', () => {
		setPointer(3, 'transient');
		completePointer();
		const row = getPointer();
		expect(row).not.toBeNull();
		expect(row!.step).toBe(6);
		expect(row!.status).toBe('completed');
		expect(row!.error).toBeNull();
	});

	it('inserts step=6/status=completed when called on an empty table (idempotent corner case)', () => {
		// HUB-WIZ-10 corner case: defensive insert so wizard/complete endpoint
		// can call this without first ensuring setPointer ran.
		expect(getPointer()).toBeNull();
		completePointer();
		const row = getPointer();
		expect(row).not.toBeNull();
		expect(row!.step).toBe(6);
		expect(row!.status).toBe('completed');
		expect(row!.error).toBeNull();
	});
});
