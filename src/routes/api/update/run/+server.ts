import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getCurrentVersion } from '$lib/server/services/version';
import { getStoredUpdateStatus } from '$lib/server/services/update-check';
import { spawnUpdateRun, getDirtyFiles } from '$lib/server/services/update-runner';
import { appendUpdateRun } from '$lib/server/services/update-history';
import { getActiveFlowConflicts } from '$lib/server/services/update-checker';

const CANDIDATE_INSTALL_DIRS = ['/opt/ip-cam-master', process.cwd()];

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLocalhostRequest(request: Request): boolean {
	const host = request.headers.get('host') ?? '';
	const hostname = host.split(':')[0]?.toLowerCase() ?? '';
	return LOCAL_HOSTS.has(hostname);
}

function findSchemaPath(): string | null {
	for (const dir of CANDIDATE_INSTALL_DIRS) {
		const candidate = path.join(dir, 'src', 'lib', 'server', 'db', 'schema.ts');
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

async function computePreSchemaHash(): Promise<string> {
	const schemaPath = findSchemaPath();
	if (!schemaPath) return '';
	try {
		const buf = await readFile(schemaPath);
		return createHash('sha256').update(buf).digest('hex');
	} catch {
		return '';
	}
}

export const POST: RequestHandler = async ({ request }) => {
	// UPD-AUTO-12: trigger is privileged — only loopback requests allowed.
	if (!isLocalhostRequest(request)) {
		return json({ error: 'localhost_only' }, { status: 403 });
	}

	const body = (await request.json().catch(() => ({}))) as {
		force?: boolean;
		ignoreConflicts?: boolean;
	};
	const force = body.force === true;
	const ignoreConflicts = body.ignoreConflicts === true;

	const current = await getCurrentVersion();

	if (current.isDev) {
		return json({ error: 'dev_mode' }, { status: 400 });
	}

	if (current.isDirty) {
		const dirtyFiles = await getDirtyFiles();
		return json({ error: 'dirty_tree', dirtyFiles }, { status: 409 });
	}

	const status = await getStoredUpdateStatus();
	if (!status.hasUpdate && !force) {
		return json({ error: 'already_up_to_date' }, { status: 400 });
	}

	if (!ignoreConflicts) {
		const conflicts = getActiveFlowConflicts();
		if (conflicts.length > 0) {
			return json({ error: 'active_flows', conflicts }, { status: 409 });
		}
	}

	const preSchemaHash = await computePreSchemaHash();
	let run;
	try {
		run = await spawnUpdateRun({
			preSha: current.sha,
			preSchemaHash,
			targetSha: status.latestSha ?? null,
			trigger: 'manual'
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'unknown';
		return json({ error: 'backup_failed', detail: message }, { status: 500 });
	}

	await appendUpdateRun({
		startedAt: run.startedAt,
		finishedAt: null,
		preSha: current.sha,
		postSha: null,
		targetSha: run.targetSha ?? null,
		result: 'running',
		logPath: run.logPath,
		unitName: run.unitName,
		backupPath: run.backupPath,
		trigger: 'manual'
	});

	return json(run, { status: 202 });
};
