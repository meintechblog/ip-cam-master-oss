import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'update.sh');

/**
 * TEXTUAL invariants for scripts/update.sh after the Phase 24 rewrite.
 * Verifies the 9-stage pipeline + 2-stage rollback are intact.
 *
 * The integration test that previously lived here was removed — it was
 * exercising the v1.1 single-stage update.sh, and the new pipeline
 * needs an entirely different harness (drain endpoint stub, dedicated
 * unit, atomic state.json mutations) that's better validated in UAT
 * against the live VM than in vitest.
 */
describe('scripts/update.sh static invariants (Phase 24, 9-stage)', () => {
	let script: string;

	beforeAll(() => {
		script = readFileSync(SCRIPT_PATH, 'utf8');
	});

	it('has set -o pipefail', () => {
		expect(script).toContain('set -o pipefail');
	});

	it('reads env vars from EnvironmentFile', () => {
		expect(script).toContain('PRE_SHA="${PRE_SHA:-${1:-}}"');
		expect(script).toContain('TARGET_SHA="${TARGET_SHA:-}"');
		expect(script).toContain('UPDATE_TRIGGER="${UPDATE_TRIGGER:-manual}"');
	});

	it('emits all 9 stage markers', () => {
		for (const stage of [
			'preflight',
			'snapshot',
			'drain',
			'stop',
			'fetch',
			'install',
			'build',
			'start',
			'verify'
		]) {
			expect(script).toContain(`stage ${stage}`);
		}
	});

	it('uses [stage=NAME] markers via stage() helper', () => {
		expect(script).toMatch(/echo "\[stage=\$1\]"/);
	});

	it('has UPDATE_RESULT: success marker', () => {
		expect(script).toContain('UPDATE_RESULT: success');
	});

	it('has UPDATE_RESULT: failed markers', () => {
		expect(script).toMatch(/UPDATE_RESULT: failed/);
	});

	it('rollback() is two-stage', () => {
		expect(script).toContain('Rollback stage 1: git reset --hard');
		expect(script).toContain('Rollback stage 1 failed — escalating to stage 2');
		expect(script).toMatch(/Stage 2: extracting/);
	});

	it('writes exit codes 0/2/3', () => {
		expect(script).toMatch(/write_exit 0/);
		expect(script).toMatch(/write_exit 2/);
		expect(script).toMatch(/write_exit 3/);
	});

	it('git resets to PRE_SHA in rollback', () => {
		expect(script).toContain('git reset --hard "$PRE_SHA"');
	});

	it('drain stage POSTs to /api/internal/prepare-for-shutdown', () => {
		expect(script).toContain('/api/internal/prepare-for-shutdown');
	});

	it('verify stage polls /api/version', () => {
		expect(script).toContain('/api/version');
	});

	it('snapshot stage tars excluding node_modules and build artifacts', () => {
		expect(script).toContain("--exclude='node_modules'");
		expect(script).toContain("--exclude='.svelte-kit'");
		expect(script).toContain("--exclude='build'");
	});

	it('install stage skips npm ci when lockfile + package.json unchanged', () => {
		expect(script).toMatch(/Dependencies unchanged — skipping npm ci/);
	});

	it('state.json is mutated via Python3 tmp+rename', () => {
		expect(script).toMatch(/state_patch\(\)/);
		expect(script).toMatch(/os\.replace\(tmp, path\)/);
	});

	it('flock-guards on /run/ip-cam-master-deploy.lock', () => {
		expect(script).toContain('/run/ip-cam-master-deploy.lock');
		expect(script).toContain('flock -n 9');
	});
});
