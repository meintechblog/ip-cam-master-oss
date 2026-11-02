// v1.3 Phase 22 Plan 03 Task 2 — Smoke test for ExternalCamCard.svelte (HUB-UI-02..06).
//
// Regex-against-source per Shared 6 / tabs.test.ts pattern (no jsdom for Svelte).
// Verifies the external-cam card variant: Protect-Hub badge, qualifier branch,
// no LXC chrome, no edit/delete cam buttons, disabled "Aus Hub entfernen" with
// P23 tooltip, ProtectHubGuide + OutputsSubsection wired in.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ExternalCamCard.svelte (HUB-UI-02..06)', () => {
	const src = readFileSync(
		resolve('src/lib/components/cameras/ExternalCamCard.svelte'),
		'utf8'
	);

	it('renders the primary "Protect Hub" badge with the locked accent token', () => {
		expect(src).toMatch(/Protect Hub/);
		expect(src).toMatch(/bg-accent\/15/);
		expect(src).toMatch(/text-accent/);
		expect(src).toMatch(/border-accent\/30/);
	});

	it('renders the qualifier badge (UniFi or Drittanbieter · {manufacturer})', () => {
		expect(src).toMatch(/UniFi/);
		// Drittanbieter qualifier template + Unbekannt fallback
		expect(src).toMatch(/Drittanbieter/);
		expect(src).toMatch(/Unbekannt/);
	});

	it('hides cam-edit and cam-delete buttons (not rendered for external cams)', () => {
		// Negative assertions: no edit/delete buttons in the source (look for the
		// CameraDetailCard idioms we are explicitly NOT carrying over)
		expect(src).not.toMatch(/<button[^>]*(rename|delete-camera|cam-delete|cam-edit)/i);
		// The Pencil + Trash2 icons from CameraDetailCard's edit/delete UI must
		// not appear in this card variant
		expect(src).not.toMatch(/Pencil[\s,}]/);
		expect(src).not.toMatch(/Trash2[\s,}]/);
	});

	it('renders disabled "Aus Hub entfernen" with the Verfügbar in Phase 23 tooltip', () => {
		expect(src).toMatch(/Aus Hub entfernen/);
		expect(src).toMatch(/Verfügbar in Phase 23/);
		// Button must be disabled (per UI-SPEC line 236)
		expect(src).toMatch(/disabled[\s>]/);
	});

	it('imports ProtectHubGuide and OutputsSubsection', () => {
		expect(src).toMatch(/import ProtectHubGuide/);
		expect(src).toMatch(/import OutputsSubsection/);
	});

	it('does NOT render any LXC card chrome (the live-VM "LXC 0" bug must be gone)', () => {
		// LXC chrome rendering markers — these must NOT appear in the rendered
		// template. The CameraDetailCard LXC block at lines 386-450 renders
		// `LXC {camera.vmid}`, the labels CPU / RAM / IP, and reads
		// camera.lxcCpu / lxcMemory / containerStatus / containerIp. None of
		// those rendering tokens may appear in the external-card variant.
		// (We allow the substring "LXC" inside source-comments — the regex
		// targets actual JSX templating syntax.)
		expect(src).not.toMatch(/\{camera\.vmid\}/);
		expect(src).not.toMatch(/\{camera\.lxcCpu/);
		expect(src).not.toMatch(/\{camera\.lxcMemory/);
		expect(src).not.toMatch(/\{camera\.containerStatus\}/);
		expect(src).not.toMatch(/protectHubBridges|protect_hub_bridges/);
	});

	it('imports the slug derivation util from the shared $lib/protect-hub/slug', () => {
		expect(src).toMatch(/from\s+['"]\$lib\/protect-hub\/slug['"]/);
		expect(src).toMatch(/deriveSlug|deriveStreamUrl/);
	});

	it('renders the read-only Stream Catalog table header (Channel · Codec · Auflösung@FPS)', () => {
		expect(src).toMatch(/Channel/);
		expect(src).toMatch(/Codec/);
		expect(src).toMatch(/Auflösung@FPS/);
	});
});
