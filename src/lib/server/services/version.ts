/**
 * Version info for the running app — see UPD-AUTO-13.
 *
 * Backed by `src/lib/version.ts` which is generated at build time by
 * `scripts/build/generate-version.mjs` (npm run gen:version, chained
 * into both `dev` and `build`). This removes the runtime dependency on
 * a `.git/` directory being present, which was a source of post-deploy
 * problems on rsync'd installs.
 *
 * `isDirty` is no longer derived (build artifacts can't tell us about
 * post-build worktree edits) — kept on the type for backwards
 * compatibility but always false in production builds.
 */

import { CURRENT_SHA, CURRENT_SHA_SHORT, BUILD_TIME } from '$lib/version';

export type VersionInfo = {
	version: string;
	sha: string;
	tag: string | null;
	isDev: boolean;
	isDirty: boolean;
	buildTime?: string;
};

let cachedVersion: VersionInfo | null = null;

/**
 * Build a human-readable label from a VersionInfo. Always renders SHAs
 * as 7-char short form regardless of input length.
 */
export function formatVersionLabel(info: VersionInfo): string {
	if (info.isDev) return 'dev';
	const shortSha = info.sha ? info.sha.slice(0, 7) : '';
	if (info.tag && shortSha) return `${info.tag} (${shortSha})`;
	if (info.tag && !shortSha) return info.tag;
	return `main @ ${shortSha}`;
}

/**
 * Resolve the current running version from the build-time generated
 * constants. Caches the first lookup in-process. Returns dev-mode
 * fallback if the generator wrote empty placeholders (fresh checkout
 * without git).
 */
export async function getCurrentVersion(): Promise<VersionInfo> {
	if (cachedVersion) return cachedVersion;

	const sha = CURRENT_SHA || '';
	if (!sha) {
		cachedVersion = {
			version: 'dev',
			sha: 'unknown',
			tag: null,
			isDev: true,
			isDirty: false,
			buildTime: BUILD_TIME
		};
		return cachedVersion;
	}

	const info: VersionInfo = {
		version: '',
		sha,
		tag: null,
		isDev: false,
		isDirty: false,
		buildTime: BUILD_TIME
	};
	info.version = formatVersionLabel({ ...info, sha: CURRENT_SHA_SHORT });
	cachedVersion = info;
	return cachedVersion;
}

/**
 * Test-only: clear the in-process version cache.
 */
export function resetVersionCacheForTests(): void {
	cachedVersion = null;
}

/**
 * Parse the output of `git describe --tags --always --dirty --abbrev=7`.
 * Retained as an exported helper because tests still reference it.
 */
export function parseDescribe(describe: string): {
	tag: string | null;
	sha: string | null;
	isDirty: boolean;
} {
	let isDirty = false;
	let value = describe.trim();
	if (value.endsWith('-dirty')) {
		isDirty = true;
		value = value.slice(0, -'-dirty'.length);
	}
	const tagWithCommits = value.match(/^(v[^-]+)-\d+-g([0-9a-f]{7,})$/);
	if (tagWithCommits) {
		return { tag: tagWithCommits[1], sha: tagWithCommits[2], isDirty };
	}
	const tagOnly = value.match(/^(v[^-]+)$/);
	if (tagOnly) {
		return { tag: tagOnly[1], sha: null, isDirty };
	}
	const bareSha = value.match(/^([0-9a-f]{7,})$/);
	if (bareSha) {
		return { tag: null, sha: bareSha[1], isDirty };
	}
	return { tag: null, sha: null, isDirty };
}
