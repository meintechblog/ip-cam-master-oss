// v1.3 Phase 22 Plan 04 — Wizard structure regex-against-source scaffold.
//
// One file covers all six step components + the wizard chrome (StepIndicator +
// ResumeBanner) + the host page (`+page.svelte` / `+page.server.ts`). Each
// `it()` block reads its target file fresh, so the same test file is the
// `<automated>` verify for Tasks 1-4: assertions for files-not-yet-created
// fail (RED) until each task lands the source it owns. By Task 4, all blocks
// are GREEN.
//
// HUB-WIZ-05 / 06 / 07 / 08 / 09 / 10 closure relies on this file.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function read(rel: string): string {
	const p = resolve(rel);
	return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('P22 wizard structure (HUB-WIZ-05..10)', () => {
	const stepIndicator = read('src/lib/components/protect-hub/WizardStepIndicator.svelte');
	const resumeBanner = read('src/lib/components/protect-hub/WizardResumeBanner.svelte');
	const step3 = read('src/routes/settings/protect-hub/onboarding/_components/Step3.svelte');
	const step4 = read('src/routes/settings/protect-hub/onboarding/_components/Step4.svelte');
	const step5 = read('src/routes/settings/protect-hub/onboarding/_components/Step5.svelte');
	const step6 = read('src/routes/settings/protect-hub/onboarding/_components/Step6.svelte');
	const hostPage = read('src/routes/settings/protect-hub/onboarding/+page.svelte');
	const hostServer = read('src/routes/settings/protect-hub/onboarding/+page.server.ts');

	// Task 1 — WizardStepIndicator + WizardResumeBanner
	it('WizardStepIndicator: 6 discs with backward-clickable handler', () => {
		expect(stepIndicator).toMatch(/STEP_LABELS/);
		expect(stepIndicator).toMatch(/Protect-Verbindung/);
		expect(stepIndicator).toMatch(/Erste Synchronisation/);
		expect(stepIndicator).toMatch(/onStepClick/);
		expect(stepIndicator).toMatch(/aria-current/);
	});
	it('WizardResumeBanner: renders only on in_progress pointer; Continue calls onContinue', () => {
		expect(resumeBanner).toMatch(/pointer\.status === 'in_progress'/);
		expect(resumeBanner).toMatch(/Du warst bei Schritt/);
		expect(resumeBanner).toMatch(/Zurücksetzen/);
		expect(resumeBanner).toMatch(/Intl\.RelativeTimeFormat\('de'/);
		expect(resumeBanner).toMatch(/onclick=\{onContinue\}/);
	});

	// Task 2 — Step3 + Step4
	it('Step3: calls /api/protect-hub/discover (POST) and surfaces controller-unreachable copy', () => {
		expect(step3).toMatch(/\/api\/protect-hub\/discover/);
		expect(step3).toMatch(/method:\s*['"]POST['"]/);
		expect(step3).toMatch(/UniFi Controller nicht erreichbar/);
		expect(step3).toMatch(/\/api\/protect-hub\/wizard\/3/);
	});
	// Cap raised 6 → 12 on 2026-05-16 (Arrow Lake-P GPU).
	it('Step4: enforces VAAPI cap client-side at 12 + soft-warn at 10 + Maximal 12 copy', () => {
		expect(step4).toMatch(/mjpegCount/);
		expect(step4).toMatch(/VAAPI_HARD_CAP\s*=\s*12/);
		expect(step4).toMatch(/Maximal 12/);
		expect(step4).toMatch(/\/api\/cameras\/.+\/outputs/);
		expect(step4).toMatch(/\/api\/protect-hub\/wizard\/4/);
	});

	// Task 3 — Step5 + Step6
	it('Step5: setInterval 1500 ms parallel poll of health + reconcile-runs', () => {
		expect(step5).toMatch(/setInterval[\s\S]{0,80}1500/);
		expect(step5).toMatch(/\/api\/protect-hub\/health/);
		expect(step5).toMatch(/\/api\/protect-hub\/reconcile-runs/);
	});
	it('Step5: renders 3 named stages', () => {
		expect(step5).toMatch(/YAML wird geschrieben/);
		expect(step5).toMatch(/go2rtc wird neu geladen/);
		expect(step5).toMatch(/Streams werden geprüft/);
	});
	it('Step5: 90s timeout note + link to Kameraliste', () => {
		expect(step5).toMatch(/dauert länger als gewöhnlich/);
		expect(step5).toMatch(/Zur Kameraliste/);
	});
	it('Step6: posts /api/protect-hub/wizard/complete then redirects to /kameras?onboarding=success', () => {
		expect(step6).toMatch(/\/api\/protect-hub\/wizard\/complete/);
		expect(step6).toMatch(/\/kameras\?onboarding=success/);
	});

	// Task 4 — host page + server loader
	it('+page.svelte imports WizardStepIndicator + WizardResumeBanner + Step3..6', () => {
		expect(hostPage).toMatch(/import WizardStepIndicator/);
		expect(hostPage).toMatch(/import WizardResumeBanner/);
		expect(hostPage).toMatch(/import Step3/);
		expect(hostPage).toMatch(/import Step4/);
		expect(hostPage).toMatch(/import Step5/);
		expect(hostPage).toMatch(/import Step6/);
	});
	it('+page.server.ts imports getPointer from wizard-state', () => {
		expect(hostServer).toMatch(
			/import \{[^}]*getPointer[^}]*\} from ['"]\$lib\/server\/orchestration\/protect-hub\/wizard-state['"]/
		);
	});
});

describe('P22 wizard host page (Task 4 additions)', () => {
	const hostPage = read('src/routes/settings/protect-hub/onboarding/+page.svelte');
	const hostServer = read('src/routes/settings/protect-hub/onboarding/+page.server.ts');

	it('jumpToStep posts pointer rewrite (explicit backward navigation)', () => {
		expect(hostPage).toMatch(/jumpToStep[\s\S]{0,300}\/api\/protect-hub\/wizard\//);
		expect(hostPage).toMatch(/jumpToStep[\s\S]{0,300}method:\s*['"]POST['"]/);
	});

	it('continuePointer does NOT POST a pointer rewrite (only invalidateAll)', () => {
		// Extract the continuePointer function body and assert it does not contain a POST.
		const m = hostPage.match(/(?:async\s+)?function\s+continuePointer[\s\S]{0,400}?\n\s*\}/);
		expect(m, 'continuePointer function not found').toBeTruthy();
		expect(m![0]).not.toMatch(/method:\s*['"]POST['"]/);
		expect(m![0]).toMatch(/invalidateAll\(\)/);
	});

	it('+page.server.ts uses loadCatalog (or inlines a fallback drizzle SELECT)', () => {
		// Either named import OR inline drizzle SELECT against the cameras table.
		const usesLoadCatalog = /import\s+\{[^}]*loadCatalog[^}]*\}/.test(hostServer);
		const inlinesSelect = /db\.select\(\)[\s\S]{0,200}from\(cameras\)/.test(hostServer);
		expect(
			usesLoadCatalog || inlinesSelect,
			'must import loadCatalog OR inline a drizzle SELECT fallback'
		).toBe(true);
	});

	it('host page wires WizardStepIndicator with onStepClick={jumpToStep}', () => {
		expect(hostPage).toMatch(/onStepClick=\{jumpToStep\}/);
	});

	it('host page wires WizardResumeBanner Continue → continuePointer', () => {
		expect(hostPage).toMatch(/onContinue=\{continuePointer\}/);
	});

	it('host page renders Step3..6 conditionally on currentStep', () => {
		expect(hostPage).toMatch(/currentStep === 3[\s\S]{0,200}<Step3/);
		expect(hostPage).toMatch(/currentStep === 4[\s\S]{0,200}<Step4/);
		expect(hostPage).toMatch(/currentStep === 5[\s\S]{0,200}<Step5/);
		expect(hostPage).toMatch(/currentStep === 6[\s\S]{0,200}<Step6/);
	});

	it('+page.server.ts no longer redirects on bridge.status=running (P22 change)', () => {
		// The P20 redirect on bridge?.status==='running' is removed; only the
		// post-onboarding redirect (enabled flag + null/completed pointer) remains.
		const redirectMatches = hostServer.match(/redirect\(/g) ?? [];
		// Exactly one redirect call (the new post-onboarding gate).
		expect(redirectMatches.length).toBe(1);
		expect(hostServer).toMatch(/protect_hub_enabled/);
	});
});
