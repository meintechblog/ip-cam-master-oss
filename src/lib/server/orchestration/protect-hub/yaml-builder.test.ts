// v1.3 Phase 21 Plan 02 — yaml-builder unit tests + golden-file fixtures.
// yaml-builder is a pure unit (no DB, no SSH); only $env mock is required so
// downstream imports of $lib/* don't blow up at module load.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify, parse } from 'yaml';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

import {
	buildBridgeYaml,
	canonicalHash,
	STAMP_REGEX,
	type OutputRow
} from './yaml-builder';

// Token-redaction policy (RESEARCH §Open Question 5 + T-21-01 in threat model):
// All test fixtures use these placeholder strings, never real Protect tokens.
// CRITICAL for the public GitHub repo per CLAUDE.md "Security" constraint.
const TEST_RECONCILE_ID = '00000000-0000-0000-0000-000000000001';
const SECOND_RECONCILE_ID = '99999999-9999-9999-9999-999999999999';
const CARPORT_TOKEN = '<TEST-TOKEN-CARPORT>';
const FRONTDOOR_TOKEN = '<TEST-TOKEN-FRONTDOOR>';
const ROTATED_TOKEN = '<TEST-TOKEN-ROTATED>';
const CARPORT_MAC = 'aabbccddee01';
const FRONTDOOR_MAC = 'aabbccddee02';

const FIXTURE_DIR = join(__dirname, '__fixtures__/yaml-builder');

function loxoneRow(mac: string, token: string): OutputRow {
	return {
		cameraId: 1,
		mac,
		outputType: 'loxone-mjpeg',
		rtspUrl: `rtsps://192.0.2.1:7441/${token}?enableSrtp`
	};
}

function frigateRow(mac: string, token: string): OutputRow {
	return {
		cameraId: 2,
		mac,
		outputType: 'frigate-rtsp',
		rtspUrl: `rtsps://192.0.2.1:7441/${token}?enableSrtp`
	};
}

describe('yaml-builder — buildBridgeYaml', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Helper: parse YAML and pull the (sole) ffmpeg source string for a given
	// slug. Asserts against the parsed string — go2rtc receives this value
	// verbatim after its own yaml.parse, so it is the load-bearing wire form.
	// (Raw `yaml` text is line-wrapped by `yaml.stringify` for readability;
	//  fragments that span wrap boundaries break naive `toContain` checks.)
	function getSource(yamlText: string, slug: string): string {
		const parsed = parse(yamlText) as { streams: Record<string, string[]> };
		const sources = parsed.streams[slug];
		expect(sources, `slug ${slug} not present in YAML`).toBeDefined();
		expect(sources.length).toBe(1);
		return sources[0];
	}

	// HUB-OUT-02: Loxone-MJPEG ffmpeg form per D-PIPE-02 (amended P22-UAT 2026-05-15)
	// Switched from go2rtc's `ffmpeg:` shorthand to `exec:` after the shorthand
	// produced 0 bytes on the live bridge — see yaml-builder.ts buildLoxoneMjpegSource
	// header comment for the root cause + fix rationale.
	it('loxone — emits exec: ffmpeg with VAAPI hw_device init + 640x360@10fps mjpeg_vaapi pipeline', () => {
		const yaml = buildBridgeYaml([loxoneRow(CARPORT_MAC, CARPORT_TOKEN)], TEST_RECONCILE_ID);
		const src = getSource(yaml, `${CARPORT_MAC}-low`);

		expect(src).not.toContain('tls_verify');
		// exec: source bypasses go2rtc's auto-construction.
		expect(src.startsWith('exec:ffmpeg ')).toBe(true);
		// Manual VAAPI device init (the part go2rtc's shorthand got wrong).
		expect(src).toContain('-init_hw_device vaapi=intel:/dev/dri/renderD128');
		expect(src).toContain('-filter_hw_device intel');
		// Encoder + filter graph: software decode → format=nv12|vaapi → hwupload → scale_vaapi → mjpeg_vaapi.
		expect(src).toContain('-vf format=nv12|vaapi,hwupload,scale_vaapi=640:360');
		expect(src).toContain('-c:v mjpeg_vaapi');
		expect(src).toContain('-f mjpeg -');
		// 10fps, no audio (D-PIPE-02 spirit retained).
		expect(src).toContain('-r 10');
		expect(src).toContain('-an');
		// D-PIPE-05 amended (P22-UAT 2026-05-15): `-reconnect` flags are HTTP-only
		// in ffmpeg 7.1.3 and fatal-rejected by the RTSP demuxer ("Option not
		// found"). Reconnect now handled by go2rtc's exec-respawn lifecycle.
		expect(src).not.toContain('-reconnect');
		// RTSP transport pinned to TCP (was -rtsp_flags prefer_tcp under shorthand).
		expect(src).toContain('-rtsp_transport tcp');
		// D-PIPE-06: slug pattern <mac>-low for loxone-mjpeg
		expect(yaml).toContain(`${CARPORT_MAC}-low:`);
		// CR-2: rtsps:// URL passed through unchanged (no rewrite step).
		expect(src).toContain(`rtsps://192.0.2.1:7441/${CARPORT_TOKEN}?enableSrtp`);
	});

	// HUB-OUT-03: Frigate-RTSP ffmpeg form per D-PIPE-04
	it('frigate — emits #video=copy#raw=-an passthrough + reconnect flags (D-PIPE-04 + D-PIPE-05)', () => {
		const yaml = buildBridgeYaml([frigateRow(CARPORT_MAC, CARPORT_TOKEN)], TEST_RECONCILE_ID);
		const src = getSource(yaml, `${CARPORT_MAC}-high`);

		expect(src).not.toContain('tls_verify');
		expect(src).toContain('#video=copy');
		expect(src).toContain('#raw=-an');
		// MUST NOT contain VAAPI for Frigate (pure passthrough, zero VAAPI cost per L-26)
		expect(src).not.toContain('#hardware=vaapi');
		// D-PIPE-05 reconnect flags also apply to Frigate per "every output, regardless of type"
		expect(src).toContain('#raw=-reconnect 1');
		expect(src).toContain('#raw=-reconnect_streamed 1');
		expect(src).toContain('#raw=-reconnect_delay_max 2');
		// D-PIPE-06: slug pattern <mac>-high for frigate-rtsp
		expect(yaml).toContain(`${CARPORT_MAC}-high:`);
	});

	it('mixed — 2 cams × 2 output types each → 4 stream entries with all 4 slugs', () => {
		const rows: OutputRow[] = [
			loxoneRow(CARPORT_MAC, CARPORT_TOKEN),
			frigateRow(CARPORT_MAC, CARPORT_TOKEN),
			loxoneRow(FRONTDOOR_MAC, FRONTDOOR_TOKEN),
			frigateRow(FRONTDOOR_MAC, FRONTDOOR_TOKEN)
		];
		const yaml = buildBridgeYaml(rows, TEST_RECONCILE_ID);

		expect(yaml).toContain(`${CARPORT_MAC}-low:`);
		expect(yaml).toContain(`${CARPORT_MAC}-high:`);
		expect(yaml).toContain(`${FRONTDOOR_MAC}-low:`);
		expect(yaml).toContain(`${FRONTDOOR_MAC}-high:`);
	});

	it('empty bridge — 0 outputs → valid YAML with empty streams (does NOT throw)', () => {
		// NOT throw: bridge can run dry between reconciles when no outputs are enabled.
		const yaml = buildBridgeYaml([], TEST_RECONCILE_ID);
		expect(yaml).toContain('streams:');
		// Round-trip parse must succeed and produce an empty/null streams map.
		const parsed = parse(yaml) as { streams: Record<string, unknown> | null };
		expect(parsed).toHaveProperty('streams');
		const streamsKeyCount = parsed.streams ? Object.keys(parsed.streams).length : 0;
		expect(streamsKeyCount).toBe(0);
	});

	// HUB-OUT-06: slug stable across name edits.
	// yaml-builder doesn't take a cam display name as input (per HUB-OUT-06 spec
	// in 21-RESEARCH.md Security Domain — no user-supplied free text in YAML).
	// This test asserts that two builds with identical OutputRows produce
	// byte-identical streams blocks regardless of any caller-side state.
	it('slug stable — same MAC → identical streams entries across calls', () => {
		const rows = [loxoneRow(CARPORT_MAC, CARPORT_TOKEN)];
		const yaml1 = buildBridgeYaml(rows, TEST_RECONCILE_ID);
		const yaml2 = buildBridgeYaml(rows, TEST_RECONCILE_ID);
		// Strip the time-varying stamp before comparing.
		const stripped1 = yaml1.replace(STAMP_REGEX, '');
		const stripped2 = yaml2.replace(STAMP_REGEX, '');
		expect(stripped1).toBe(stripped2);
		// Slug uses MAC verbatim (NOT re-normalised).
		expect(yaml1).toContain(`${CARPORT_MAC}-low:`);
	});

	// HUB-OUT-07: URLs in YAML follow correct format (slug pattern <mac>-<low|high>)
	it('emits stream URLs with mac-slug-low|high naming (D-PIPE-06)', () => {
		const rows = [loxoneRow(CARPORT_MAC, CARPORT_TOKEN), frigateRow(FRONTDOOR_MAC, FRONTDOOR_TOKEN)];
		const yaml = buildBridgeYaml(rows, TEST_RECONCILE_ID);
		expect(yaml).toMatch(new RegExp(`${CARPORT_MAC}-low:`));
		expect(yaml).toMatch(new RegExp(`${FRONTDOOR_MAC}-high:`));
	});

	it('throws typed Error on unknown outputType (defensive guard for future types)', () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const badRow = {
			cameraId: 99,
			mac: 'aabbccddee99',
			outputType: 'unsupported' as 'loxone-mjpeg',
			rtspUrl: 'rtsps://192.0.2.1:7441/x?enableSrtp'
		};
		expect(() => buildBridgeYaml([badRow], TEST_RECONCILE_ID)).toThrow(/unsupported outputType/);
	});

	it('first line is the L-8 stamp comment with the supplied reconcileId', () => {
		const yaml = buildBridgeYaml([], TEST_RECONCILE_ID);
		expect(yaml).toMatch(STAMP_REGEX);
		const firstLine = yaml.split('\n', 1)[0];
		expect(firstLine).toContain('# managed by ip-cam-master');
		expect(firstLine).toContain(`reconcile-id ${TEST_RECONCILE_ID}`);
	});

	it('second line is the static WARNING comment (defense-in-depth against accidental edits)', () => {
		const yaml = buildBridgeYaml([], TEST_RECONCILE_ID);
		const secondLine = yaml.split('\n')[1];
		expect(secondLine).toContain('WARNING');
		expect(secondLine).toContain('managed by ip-cam-master');
	});
});

describe('yaml-builder — canonicalHash', () => {
	it('strips stamp + sorts keys + sha256 stable across renders (P21-#5 mitigation)', () => {
		const rows = [loxoneRow(CARPORT_MAC, CARPORT_TOKEN)];
		const yaml1 = buildBridgeYaml(rows, TEST_RECONCILE_ID);
		const yaml2 = buildBridgeYaml(rows, SECOND_RECONCILE_ID);
		// Different reconcileId → different stamp comments → identical canonicalHash.
		expect(yaml1).not.toBe(yaml2);
		expect(canonicalHash(yaml1)).toBe(canonicalHash(yaml2));
	});

	it('token rotation produces different hash (proves dedupe rotates on URL change)', () => {
		const original = buildBridgeYaml([loxoneRow(CARPORT_MAC, CARPORT_TOKEN)], TEST_RECONCILE_ID);
		const rotated = buildBridgeYaml([loxoneRow(CARPORT_MAC, ROTATED_TOKEN)], TEST_RECONCILE_ID);
		expect(canonicalHash(original)).not.toBe(canonicalHash(rotated));
	});

	// Assumption A1 in 21-RESEARCH.md: sortMapEntries:true applies recursively.
	// Build two YAMLs by hand with reordered top-level keys and assert their
	// canonicalHash is identical. Proves the assumption holds at runtime so
	// Plan 03 reconcile.ts can rely on it.
	it('sortMapEntries normalizes nested map ordering (Assumption A1 verification)', () => {
		const obj1 = {
			api: { listen: '0.0.0.0:1984', ui_editor: false },
			rtsp: { listen: ':8554' },
			streams: { 'aaa-low': ['s1'], 'bbb-high': ['s2'] },
			ffmpeg: { bin: 'ffmpeg' },
			log: { level: 'info' }
		};
		// Same structural data, deliberately reordered insertion order at every level.
		const obj2 = {
			log: { level: 'info' },
			ffmpeg: { bin: 'ffmpeg' },
			streams: { 'bbb-high': ['s2'], 'aaa-low': ['s1'] },
			rtsp: { listen: ':8554' },
			api: { ui_editor: false, listen: '0.0.0.0:1984' }
		};
		const yaml1 = `# managed by ip-cam-master, reconcile-id x, ts t\n${stringify(obj1, { sortMapEntries: true })}`;
		const yaml2 = `# managed by ip-cam-master, reconcile-id y, ts u\n${stringify(obj2, { sortMapEntries: true })}`;
		expect(canonicalHash(yaml1)).toBe(canonicalHash(yaml2));
	});

	it('handles input without stamp gracefully (idempotent on raw user-edited file)', () => {
		const rows = [loxoneRow(CARPORT_MAC, CARPORT_TOKEN)];
		const yamlWithStamp = buildBridgeYaml(rows, TEST_RECONCILE_ID);
		const yamlNoStamp = yamlWithStamp.replace(STAMP_REGEX, '');
		// canonicalHash works on both forms and yields identical digests.
		expect(canonicalHash(yamlWithStamp)).toBe(canonicalHash(yamlNoStamp));
	});

	it('empty bridge YAML hashes deterministically', () => {
		const yaml1 = buildBridgeYaml([], TEST_RECONCILE_ID);
		const yaml2 = buildBridgeYaml([], SECOND_RECONCILE_ID);
		expect(canonicalHash(yaml1)).toBe(canonicalHash(yaml2));
	});
});

describe('yaml-builder — golden-file fixtures', () => {
	// Use canonicalHash equality (not raw byte equality) so timestamp drift in
	// the stamp line doesn't flake the test. canonicalHash strips the stamp
	// before hashing, exercising the dedupe path AND avoiding time-flake.
	it('loxone-only-1cam.yaml byte-canonical-equals current builder output', () => {
		const fixture = readFileSync(join(FIXTURE_DIR, 'loxone-only-1cam.yaml'), 'utf-8');
		const actual = buildBridgeYaml(
			[loxoneRow(CARPORT_MAC, CARPORT_TOKEN)],
			TEST_RECONCILE_ID
		);
		expect(canonicalHash(fixture)).toBe(canonicalHash(actual));
	});

	it('frigate-only-1cam.yaml byte-canonical-equals current builder output', () => {
		const fixture = readFileSync(join(FIXTURE_DIR, 'frigate-only-1cam.yaml'), 'utf-8');
		const actual = buildBridgeYaml(
			[frigateRow(CARPORT_MAC, CARPORT_TOKEN)],
			TEST_RECONCILE_ID
		);
		expect(canonicalHash(fixture)).toBe(canonicalHash(actual));
	});

	it('mixed-2cams.yaml byte-canonical-equals current builder output', () => {
		const fixture = readFileSync(join(FIXTURE_DIR, 'mixed-2cams.yaml'), 'utf-8');
		const actual = buildBridgeYaml(
			[
				loxoneRow(CARPORT_MAC, CARPORT_TOKEN),
				frigateRow(FRONTDOOR_MAC, FRONTDOOR_TOKEN)
			],
			TEST_RECONCILE_ID
		);
		expect(canonicalHash(fixture)).toBe(canonicalHash(actual));
	});

	it('empty-bridge.yaml byte-canonical-equals current builder output', () => {
		const fixture = readFileSync(join(FIXTURE_DIR, 'empty-bridge.yaml'), 'utf-8');
		const actual = buildBridgeYaml([], TEST_RECONCILE_ID);
		expect(canonicalHash(fixture)).toBe(canonicalHash(actual));
	});
});

describe('yaml-builder — SECURITY: token redaction in fixtures (T-21-01 mitigation)', () => {
	// T-21-01 (Information Disclosure): repository is public on GitHub. Fixtures
	// MUST NEVER contain real Protect rtspAlias tokens. This test scans every
	// committed fixture file for any 32+ character alphanumeric run that could
	// look like a real token, and fails loudly if one slips in. Belt-and-
	// suspenders defense — even if a developer pastes a real token while
	// regenerating fixtures, this test blocks the commit at CI.
	it('every committed fixture uses <TEST-TOKEN-...> placeholders only', () => {
		const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.yaml'));
		expect(fixtureFiles.length).toBeGreaterThan(0);

		// A real Protect rtspAlias is 32+ alphanumeric chars (UUID-like).
		// Placeholder tokens use angle brackets and hyphens (`<TEST-TOKEN-FOO>`)
		// which the regex below won't match.
		const realTokenPattern = /[a-zA-Z0-9]{32,}/;

		for (const file of fixtureFiles) {
			const content = readFileSync(join(FIXTURE_DIR, file), 'utf-8');
			// All non-empty fixtures must contain the placeholder marker.
			if (file !== 'empty-bridge.yaml') {
				expect(
					content,
					`fixture ${file} missing <TEST-TOKEN-...> placeholder`
				).toMatch(/<TEST-TOKEN-/);
			}
			// No fixture may contain anything that looks like a real token.
			const match = content.match(realTokenPattern);
			expect(
				match,
				`fixture ${file} contains a 32+ char alphanumeric run that looks like a real Protect token: ${match?.[0] ?? ''}`
			).toBeNull();
		}
	});
});
