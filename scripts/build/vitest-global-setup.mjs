/**
 * Vitest globalSetup: src/lib/version.ts is generated (and git-ignored), so a
 * fresh checkout has no such file and every importer of `$lib/version` fails
 * to resolve, even when the test mocks it. Generate it once if it is missing,
 * and remove it again after the run if this setup created it.
 */
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const versionFile = join(here, '..', '..', 'src', 'lib', 'version.ts');

export default function setup() {
	if (existsSync(versionFile)) return;
	execFileSync(process.execPath, [join(here, 'generate-version.mjs')], { stdio: 'inherit' });
	return function teardown() {
		rmSync(versionFile, { force: true });
	};
}
