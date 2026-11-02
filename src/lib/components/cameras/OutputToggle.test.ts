// v1.3 Phase 22 Plan 03 Task 2 — Smoke test for OutputToggle.svelte (HUB-UI-03).
//
// Regex-against-source per Shared 6 / tabs.test.ts pattern (no jsdom for Svelte).
// Verifies the state machine + AbortController + 422 vaapi-cap rollback path
// per RESEARCH §Pattern 3 + UI-SPEC §toggle.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('OutputToggle.svelte (HUB-UI-03)', () => {
	const src = readFileSync(
		resolve('src/lib/components/cameras/OutputToggle.svelte'),
		'utf8'
	);

	it('declares the off → enabling → on state machine literal types', () => {
		// All five states (off, enabling, on, disabling, error) per UI-SPEC §toggle line 350
		expect(src).toMatch(/'off'/);
		expect(src).toMatch(/'enabling'/);
		expect(src).toMatch(/'on'/);
		expect(src).toMatch(/'disabling'/);
		expect(src).toMatch(/'error'/);
	});

	it('uses AbortController for in-flight cancellation', () => {
		// Mentions AbortController either as `new AbortController()` or as a stored ref
		expect(src).toMatch(/AbortController/);
	});

	it('PUTs to /api/cameras/{id}/outputs', () => {
		// Endpoint contract per outputs/+server.ts (PUT replace-strategy)
		expect(src).toMatch(/method:\s*['"]PUT['"]/);
		expect(src).toMatch(/\/api\/cameras\/\$\{[^}]+\}\/outputs/);
	});

	it('handles the 422 vaapi_hard_cap_exceeded reason and surfaces server message', () => {
		expect(src).toMatch(/vaapi_hard_cap_exceeded/);
		// Surface server-provided German `message` field directly (the variable
		// holding the parsed body may be `body` or any local rename, but the
		// `.message` access of the JSON body is the load-bearing read).
		expect(src).toMatch(/\.message/);
		// Status 422 branch must exist
		expect(src).toMatch(/422/);
	});

	it('disables the button while in flight (L-18 toggle-disabled-during-flight)', () => {
		expect(src).toMatch(/disabled=\{[^}]*(enabling|disabling|inFlight)/);
	});
});
