/**
 * Atomic JSON state file shared between the Node app and the bash
 * update.sh script — see UPD-AUTO-09.
 *
 * Path: <cwd>/.update-state/state.json
 *
 * Contract:
 *   - Reads are sync (called from API hot paths)
 *   - Writes are atomic via tmp + os.rename, never partial JSON
 *   - Bash side uses Python3 inline scripts to perform the same
 *     tmp+rename — both sides must agree on the path and key names
 *   - Schema is enforced by writer; reader trusts it (no Zod)
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
	statSync
} from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SHA, CURRENT_SHA_SHORT } from '$lib/version';

export type UpdateStatus =
	| 'idle'
	| 'checking'
	| 'available'
	| 'installing'
	| 'rolled_back'
	| 'failed';

export type LastCheckResult =
	| {
			status: 'ok';
			remoteSha: string;
			remoteShaShort: string;
			message: string;
			author: string;
			date: string;
	  }
	| { status: 'unchanged' }
	| { status: 'rate_limited'; resetAt: number }
	| { status: 'error'; error: string };

export type UpdateState = {
	currentSha: string;
	rollbackSha: string | null;
	lastCheckAt: string | null;
	lastCheckEtag: string | null;
	lastCheckResult: LastCheckResult | null;
	updateStatus: UpdateStatus;
	targetSha: string | null;
	updateStartedAt: string | null;
	rollbackHappened: boolean;
	rollbackReason: string | null;
	rollbackStage: 'stage1' | 'stage2' | null;
};

const STATE_DIR_NAME = '.update-state';
const STATE_FILE_NAME = 'state.json';

function stateRoot(): string {
	return join(process.cwd(), STATE_DIR_NAME);
}

function statePath(): string {
	return join(stateRoot(), STATE_FILE_NAME);
}

function defaultState(currentSha: string): UpdateState {
	return {
		currentSha,
		rollbackSha: null,
		lastCheckAt: null,
		lastCheckEtag: null,
		lastCheckResult: null,
		updateStatus: 'idle',
		targetSha: null,
		updateStartedAt: null,
		rollbackHappened: false,
		rollbackReason: null,
		rollbackStage: null
	};
}

/**
 * Create the state dir + seed state.json if missing.
 * Idempotent. Never overwrites an existing state.json.
 */
export function initUpdateStateStore(): void {
	const dir = stateRoot();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const file = statePath();
	if (!existsSync(file)) {
		const seed = defaultState(CURRENT_SHA || 'unknown');
		writeFileSync(file, JSON.stringify(seed, null, 2), 'utf8');
	}
}

/**
 * Read the current state. Returns a default state if the file is missing
 * or malformed — never throws.
 */
export function readUpdateState(): UpdateState {
	try {
		const raw = readFileSync(statePath(), 'utf8');
		const parsed = JSON.parse(raw) as UpdateState;
		if (!parsed.currentSha) parsed.currentSha = CURRENT_SHA || 'unknown';
		return parsed;
	} catch {
		return defaultState(CURRENT_SHA || 'unknown');
	}
}

/**
 * Atomic merge-and-write. Writes the merged state to a tmp file in the
 * same directory, then renames it on top of state.json. POSIX guarantees
 * the rename is atomic, so concurrent readers never see partial JSON.
 */
export function writeUpdateState(patch: Partial<UpdateState>): UpdateState {
	const dir = stateRoot();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const current = readUpdateState();
	const next: UpdateState = { ...current, ...patch };
	const tmp = `${statePath()}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
	renameSync(tmp, statePath());
	return next;
}

/**
 * Read-only snapshot for view-model derivation.
 */
export function getStateSnapshot(): {
	state: UpdateState;
	currentSha: string;
	currentShaShort: string;
} {
	return {
		state: readUpdateState(),
		currentSha: CURRENT_SHA || 'unknown',
		currentShaShort: CURRENT_SHA_SHORT || 'unknown'
	};
}

/**
 * Returns true when a manual check is allowed under the cooldown rule
 * (UPD-AUTO-11: 5min server-side cooldown).
 */
export function isCheckCooldownClear(now: number = Date.now()): {
	clear: boolean;
	retryAfterSeconds: number;
} {
	const state = readUpdateState();
	if (!state.lastCheckAt) return { clear: true, retryAfterSeconds: 0 };
	const last = Date.parse(state.lastCheckAt);
	if (!Number.isFinite(last)) return { clear: true, retryAfterSeconds: 0 };
	const elapsed = (now - last) / 1000;
	const cooldown = 5 * 60;
	if (elapsed >= cooldown) return { clear: true, retryAfterSeconds: 0 };
	return { clear: false, retryAfterSeconds: Math.ceil(cooldown - elapsed) };
}

/**
 * Test-only: nukes the state directory. Used in vitest setup hooks.
 * Never call from production code.
 */
export function _resetStateForTests(): void {
	const dir = stateRoot();
	if (existsSync(dir)) {
		try {
			const file = statePath();
			if (existsSync(file)) {
				try {
					const stat = statSync(file);
					if (stat.isFile()) {
						renameSync(file, `${file}.testbak.${Date.now()}`);
					}
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
	}
}
