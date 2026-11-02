// v1.3 Phase 19 Plan 04 — Smoke test for HUB-WIZ-01.
// Asserts that /settings tabs array contains 'Protect Hub' between
// 'UniFi' (the prerequisite credential tab) and 'Credentials'.
//
// Test colocated under src/routes/settings/ per project convention
// (Plan 03 SUMMARY §Deviations 3 — vitest.config includes src/**/*.test.ts;
// no top-level tests/ directory exists in this repo).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('settings tabs (HUB-WIZ-01)', () => {
	it('includes a "Protect Hub" tab between UniFi and Credentials', () => {
		const src = readFileSync(resolve('src/routes/settings/+page.svelte'), 'utf8');
		const match = src.match(/const tabs = \[([^\]]+)\]/);
		expect(match).not.toBeNull();
		const arr = match![1];
		expect(arr).toMatch(/'UniFi'\s*,\s*'Protect Hub'/);
		expect(arr).toMatch(/'Protect Hub'\s*,\s*'Credentials'/);
	});

	it('renders a <ProtectHubTab> dispatch case bound to data.protectHub', () => {
		const src = readFileSync(resolve('src/routes/settings/+page.svelte'), 'utf8');
		expect(src).toMatch(/activeTab === 'Protect Hub'/);
		expect(src).toMatch(/<ProtectHubTab\s/);
		expect(src).toMatch(/hub=\{data\.protectHub\}/);
	});

	it('+page.server.ts loads catalog state via loadCatalog()', () => {
		const src = readFileSync(resolve('src/routes/settings/+page.server.ts'), 'utf8');
		expect(src).toMatch(/loadCatalog/);
		expect(src).toMatch(/protectHub:/);
		expect(src).toMatch(/credsConfigured/);
	});
});
