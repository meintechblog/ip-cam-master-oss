// v1.3 Phase 22 Plan 03 Task 1 — Smoke test for /kameras partition (HUB-UI-01).
//
// Regex-against-source per Shared 6 / tabs.test.ts pattern. Verifies:
//   1. Two section headers exist (managed + external) with the locked German copy
//   2. External section is gated on data.hubEnabled
//   3. ExternalCamCard is imported (so it can be rendered for source='external')
//   4. The pre-existing h1 (text-2xl font-bold) is preserved verbatim per UI-SPEC
//      (P22 introduces zero new font-bold usages; the kameras h1 inherits this)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('/kameras partition (HUB-UI-01)', () => {
	const src = readFileSync(resolve('src/routes/kameras/+page.svelte'), 'utf8');

	it('renders two sections (managed + external) with locked German copy', () => {
		// Section header copy per UI-SPEC §kameras-partition + §copywriting
		expect(src).toMatch(/Eigene Kameras \(\{?managedCams\.length\}?\)/);
		expect(src).toMatch(/Aus UniFi Protect \(\{?externalCams\.length\}?\)/);
	});

	it('gates the external section on data.hubEnabled (omits when false)', () => {
		expect(src).toMatch(/\{#if data\.hubEnabled\}/);
	});

	it('imports ExternalCamCard for the external rows', () => {
		expect(src).toMatch(/import ExternalCamCard/);
	});

	it('preserves the pre-existing h1 with text-2xl font-bold (NOT modified by P22)', () => {
		// UI-SPEC line 89-90: the existing kameras h1 is inherited verbatim.
		// P22 introduces zero new font-bold; new h1s would use font-semibold.
		expect(src).toMatch(/text-2xl font-bold/);
	});

	it('derives managedCams + externalCams from the cameras list', () => {
		expect(src).toMatch(/managedCams.*=.*\$derived/);
		expect(src).toMatch(/externalCams.*=.*\$derived/);
		// Filter expressions keyed on c.source
		expect(src).toMatch(/c\.source !== 'external'/);
		expect(src).toMatch(/c\.source === 'external'/);
	});
});
