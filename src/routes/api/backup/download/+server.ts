import { createBackup } from '$lib/server/services/backup';
import { unlinkSync, readFileSync } from 'node:fs';
import type { RequestHandler } from './$types';

/**
 * GET /api/backup/download
 *
 * Creates a fresh SQLite snapshot via sqlite.backup(), streams it back with a
 * timestamped Content-Disposition filename, then deletes the on-disk copy
 * (best-effort). Auth is enforced upstream in hooks.server.ts (the path is
 * not in `isPublicPath`).
 */
export const GET: RequestHandler = async () => {
	const { filename, absPath } = await createBackup();
	try {
		const buf = readFileSync(absPath);
		return new Response(new Uint8Array(buf), {
			status: 200,
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${filename}"`,
				'Content-Length': String(buf.byteLength),
				'Cache-Control': 'no-store'
			}
		});
	} finally {
		try {
			unlinkSync(absPath);
		} catch {
			/* best-effort cleanup */
		}
	}
};
