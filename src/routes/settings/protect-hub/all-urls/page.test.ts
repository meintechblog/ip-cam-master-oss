// v1.3 Phase 22 Plan 05 — Smoke test for HUB-UI-07 (/settings/protect-hub/all-urls).
//
// Asserts:
//   1. +page.server.ts imports cameraOutputs + cameras schemas + uses innerJoin
//   2. +page.server.ts gates rendering on settings.protect_hub_enabled
//   3. +page.server.ts uses deriveSlug + deriveStreamUrl from $lib/protect-hub/slug
//   4. +page.svelte imports Copy + Check icons + uses copyToClipboard
//   5. Both group headers ("Loxone-MJPEG", "Frigate-RTSP") appear in the source
//   6. Empty-page state copy ("Protect Hub ist nicht aktiv") appears
//   7. h1 uses text-2xl font-semibold (NOT font-bold — UI-SPEC retired bold for new h1s)
//   8. Per-row layout uses grid grid-cols-[1fr_auto_auto] (UI-SPEC §all-urls)
//   9. <span class="sr-only">Adresse kopieren</span> accessibility hint present
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = 'src/routes/settings/protect-hub/all-urls/+page.svelte';
const SERVER_PATH = 'src/routes/settings/protect-hub/all-urls/+page.server.ts';

describe('all-urls/+page.server.ts loader (HUB-UI-07)', () => {
	it('imports cameraOutputs + cameras schemas and uses innerJoin', () => {
		const src = readFileSync(resolve(SERVER_PATH), 'utf8');
		expect(src).toMatch(
			/import\s+\{[^}]*\bcameraOutputs\b[^}]*\bcameras\b[^}]*\}\s+from\s+['"]\$lib\/server\/db\/schema['"]/
		);
		expect(src).toMatch(/\.innerJoin\s*\(\s*cameras\s*,/);
	});

	it('gates the response on settings.protect_hub_enabled', () => {
		const src = readFileSync(resolve(SERVER_PATH), 'utf8');
		expect(src).toMatch(/getSetting\(\s*['"]protect_hub_enabled['"]\s*\)/);
		expect(src).toMatch(/hubEnabled\s*:\s*false/);
	});

	it('imports deriveSlug + deriveStreamUrl from the browser-shareable util', () => {
		const src = readFileSync(resolve(SERVER_PATH), 'utf8');
		expect(src).toMatch(
			/import\s+\{[^}]*\bderiveSlug\b[^}]*\bderiveStreamUrl\b[^}]*\}\s+from\s+['"]\$lib\/protect-hub\/slug['"]/
		);
	});

	it('filters camera_outputs.enabled=true AND cameras.source=external', () => {
		const src = readFileSync(resolve(SERVER_PATH), 'utf8');
		expect(src).toMatch(/eq\(\s*cameraOutputs\.enabled\s*,\s*true\s*\)/);
		expect(src).toMatch(/eq\(\s*cameras\.source\s*,\s*['"]external['"]\s*\)/);
	});
});

describe('all-urls/+page.svelte (HUB-UI-07)', () => {
	it('imports Copy + Check icons and copyToClipboard utility', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		expect(src).toMatch(/import\s+\{[^}]*\bCopy\b[^}]*\bCheck\b[^}]*\}\s+from\s+['"]lucide-svelte['"]/);
		expect(src).toMatch(/import\s+\{\s*copyToClipboard\s*\}\s+from\s+['"]\$lib\/utils\/clipboard['"]/);
	});

	it('renders both group headers ("Loxone-MJPEG", "Frigate-RTSP")', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		expect(src).toMatch(/Loxone-MJPEG/);
		expect(src).toMatch(/Frigate-RTSP/);
	});

	it('renders the empty-page state copy when hub is disabled', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		expect(src).toMatch(/Protect Hub ist nicht aktiv/);
	});

	it('uses text-2xl font-semibold on the page h1 (NOT font-bold per UI-SPEC line 81)', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		// The new h1 must declare font-semibold; font-bold is retired for P22-introduced h1s.
		expect(src).toMatch(/<h1[^>]*class="[^"]*\btext-2xl\b[^"]*\bfont-semibold\b[^"]*"/);
		// Also assert no class attribute uses font-bold (defensive — UI-SPEC retired it).
		expect(src).not.toMatch(/class="[^"]*\bfont-bold\b[^"]*"/);
	});

	it('uses grid grid-cols-[1fr_auto_auto] layout per UI-SPEC §all-urls', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		expect(src).toMatch(/grid-cols-\[1fr_auto_auto\]/);
	});

	it('renders the sr-only "Adresse kopieren" accessibility hint', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		expect(src).toMatch(/sr-only[^>]*>\s*Adresse kopieren/);
	});

	it('includes the breadcrumb back-link to /settings', () => {
		const src = readFileSync(resolve(PAGE_PATH), 'utf8');
		expect(src).toMatch(/href="\/settings"/);
		expect(src).toMatch(/Zurück zu Einstellungen/);
	});
});
