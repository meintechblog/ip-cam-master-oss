// v1.3 Phase 22 Plan 05 — Smoke test for HUB-UI-08 + SC-4 (L-18 toggle-flap-protection).
//
// Asserts:
//   1. Source imports HubStatusPanel + HubEventLog
//   2. Template references <HubStatusPanel
//   3. Template references <HubEventLog
//   4. Existing Bridge-Container heading preserved (no P19/P20 regression)
//   5. Existing bridgeAction function preserved
//   6. SC-4: hubState === 'starting' / 'stopping' check appears in the script (toggleDisabled derive)
//      AND in the template (rendering) — at least 2 occurrences total
//   7. SC-4: caption "Vorgang läuft…" appears
//   8. SC-4: cancel button label "Abbrechen" appears
//   9. SC-4: cancel handler POSTs to /api/protect-hub/wizard/reset
//  10. SC-4: a button/toggle is bound to disabled={toggleDisabled}
//  11. /settings/+page.server.ts loader exposes hubState via getHubState()
//
// Co-located under src/lib/components/settings/ per project test convention
// (vitest.config picks up src/**/*.test.ts; no top-level tests/ dir).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TAB_PATH = 'src/lib/components/settings/ProtectHubTab.svelte';
const LOADER_PATH = 'src/routes/settings/+page.server.ts';

describe('ProtectHubTab — HUB-UI-08 panel embedding', () => {
	it('imports HubStatusPanel and HubEventLog', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(
			/import\s+HubStatusPanel\s+from\s+['"]\$lib\/components\/protect-hub\/HubStatusPanel\.svelte['"]/
		);
		expect(src).toMatch(
			/import\s+HubEventLog\s+from\s+['"]\$lib\/components\/protect-hub\/HubEventLog\.svelte['"]/
		);
	});

	it('renders <HubStatusPanel> in the template', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(/<HubStatusPanel\b/);
	});

	it('renders <HubEventLog> in the template', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(/<HubEventLog\b/);
	});

	it('preserves the existing Bridge-Container heading (no P19/P20 regression)', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(/Bridge-Container/);
	});

	it('preserves the existing bridgeAction function', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(/function\s+bridgeAction\b/);
	});
});

describe('ProtectHubTab — SC-4 L-18 toggle-flap-protection', () => {
	it('checks hubState === starting / stopping at least twice (script derive + template guard)', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		const matches = src.match(/hubState\s*===\s*['"](?:starting|stopping)['"]/g);
		expect(matches).not.toBeNull();
		expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it('renders the "Vorgang läuft…" caption while a transition is in flight', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(/Vorgang läuft…/);
	});

	it('renders an "Abbrechen" cancel button', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		expect(src).toMatch(/Abbrechen/);
	});

	it('cancel handler POSTs to /api/protect-hub/wizard/reset', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		// Match a fetch to the wizard/reset endpoint with method: 'POST' nearby.
		expect(src).toMatch(/['"`]\/api\/protect-hub\/wizard\/reset['"`]/);
		expect(src).toMatch(/method:\s*['"]POST['"]/);
	});

	it('binds a button/toggle disabled attr to toggleDisabled (or hubState ===)', () => {
		const src = readFileSync(resolve(TAB_PATH), 'utf8');
		// Either form is acceptable per plan (lines 480-481):
		//   disabled={toggleDisabled}    — preferred
		//   disabled={hubState === ...}  — also acceptable
		const direct = /disabled=\{toggleDisabled\}/.test(src);
		const inline = /disabled=\{hubState\s*===/.test(src);
		expect(direct || inline).toBe(true);
	});
});

describe('settings/+page.server.ts loader (Plan 22-05 additive)', () => {
	it('imports getHubState from hub-state.ts', () => {
		const src = readFileSync(resolve(LOADER_PATH), 'utf8');
		expect(src).toMatch(
			/import\s+\{\s*getHubState\s*\}\s+from\s+['"]\$lib\/server\/orchestration\/protect-hub\/hub-state['"]/
		);
	});

	it('returns hubState in the load() return object', () => {
		const src = readFileSync(resolve(LOADER_PATH), 'utf8');
		expect(src).toMatch(/await\s+getHubState\(\)/);
		expect(src).toMatch(/\bhubState\b/);
	});
});
