// v1.3 Phase 22 Plan 03 Task 3 — Smoke test for ProtectHubGuide.svelte (HUB-UI-04, HUB-UI-05).
//
// Regex-against-source per Shared 6 / tabs.test.ts pattern. The codebase has
// no @testing-library/svelte or jsdom for Svelte rendering — all component
// tests verify file structure via readFileSync + regex.
//
// 7 assertions per plan §verify:
//   1. Both tab labels: "Loxone (Intercom)" + "Frigate (NVR)"
//   2. Both snippet templates with `${mac}-low` / `${mac}-high` placeholders
//   3. Loxone URL template http://${bridgeIp}:1984/api/stream.mjpeg
//   4. Frigate RTSP template rtsp://${bridgeIp}:8554
//   5. Copy-button idiom appears at least twice (one per snippet)
//   6. German `#`-comment "# Hinweis: User-Agent darf leer bleiben"
//   7. Short-circuit on null bridgeIp/mac via `{#if bridgeIp && mac}`
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProtectHubGuide.svelte (HUB-UI-04, HUB-UI-05)', () => {
	const src = readFileSync(
		resolve('src/lib/components/protect-hub/ProtectHubGuide.svelte'),
		'utf8'
	);

	it('renders both tab labels (Loxone + Frigate)', () => {
		expect(src).toMatch(/Loxone \(Intercom\)/);
		expect(src).toMatch(/Frigate \(NVR\)/);
	});

	it('contains both snippet templates with mac-low and mac-high placeholders', () => {
		expect(src).toMatch(/\$\{mac\}-low/);
		expect(src).toMatch(/\$\{mac\}-high/);
	});

	it('contains the Loxone MJPEG URL template', () => {
		expect(src).toMatch(/http:\/\/\$\{bridgeIp\}:1984\/api\/stream\.mjpeg/);
	});

	it('contains the Frigate RTSP URL template', () => {
		expect(src).toMatch(/rtsp:\/\/\$\{bridgeIp\}:8554/);
	});

	it('uses the copy-button idiom at least twice (once per snippet)', () => {
		const matches = src.match(/copyToClipboard/g);
		expect(matches).not.toBeNull();
		expect(matches!.length).toBeGreaterThanOrEqual(2);
	});

	it('includes the German Hinweis comment line for User-Agent', () => {
		expect(src).toMatch(/# Hinweis: User-Agent darf leer bleiben/);
	});

	it('short-circuits render when bridgeIp or mac is null', () => {
		expect(src).toMatch(/\{#if bridgeIp && mac\}/);
	});
});
