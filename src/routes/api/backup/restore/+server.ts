import { validateAndRestore } from '$lib/server/services/backup';
import { DB_ABS_PATH } from '$lib/server/db/client';
import { writeFileSync, renameSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * POST /api/backup/restore  (multipart/form-data)
 *
 * Fields:
 *   file       — the uploaded .db file
 *   confirmed  — must equal the string "true"; without it we return 400
 *                (the UI surfaces a confirmation modal and only sends the
 *                request after the user explicitly accepts).
 *
 * Flow:
 *   1. Require `confirmed=true` or 400 confirmation_required.
 *   2. Write upload to a scratch tmpdir so validateAndRestore can open it
 *      read-only with better-sqlite3.
 *   3. Validate (filename, size, PRAGMA integrity_check, required tables).
 *   4. On success: write the bytes to `${DB_ABS_PATH}.restore-pending` and
 *      renameSync() over DB_ABS_PATH. POSIX guarantees the rename is atomic
 *      because both paths live in the same `data/` directory.
 *   5. Schedule `process.exit(0)` for 500ms after returning the JSON response.
 *      The delay gives Node's TCP stack time to flush the response before the
 *      process dies; otherwise the client would see ECONNRESET. systemd's
 *      Restart=on-failure / Restart=always on ip-cam-master.service is
 *      expected to bring the app back up with the new DB. We cannot keep
 *      serving with the current better-sqlite3 handle — it's stale (the file
 *      was replaced under it), so exit is mandatory.
 *
 * Auth: `/api/backup/*` is not in `isPublicPath`, so hooks.server.ts enforces
 * the session / YOLO check upstream. No route-level auth needed.
 */
export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData();

	const confirmed = form.get('confirmed');
	if (confirmed !== 'true') {
		return json(
			{
				error: 'confirmation_required',
				message: 'Diese Aktion ersetzt alle aktuellen Daten. Bestätigung erforderlich.'
			},
			{ status: 400 }
		);
	}

	const file = form.get('file');
	if (!(file instanceof File)) {
		return json({ error: 'no_file' }, { status: 400 });
	}

	// Persist upload to a scratch dir so validateAndRestore can open it.
	const scratch = mkdtempSync(join(tmpdir(), 'ipcam-restore-'));
	const uploadedPath = join(scratch, 'upload.db');
	const arrayBuf = await file.arrayBuffer();
	writeFileSync(uploadedPath, Buffer.from(arrayBuf));

	const result = validateAndRestore({ uploadedPath, originalFilename: file.name });
	if (!result.ok) {
		try {
			unlinkSync(uploadedPath);
		} catch {
			/* ignore */
		}
		return json({ error: result.error, detail: result.detail ?? null }, { status: 400 });
	}

	// Atomic rename: stage next to the live DB, then rename over it.
	// rename() is POSIX-atomic only on the same filesystem, which is why
	// validateAndRestore returned DB_ABS_PATH + '.restore-pending'.
	try {
		writeFileSync(result.stagedPath, Buffer.from(arrayBuf));
		renameSync(result.stagedPath, DB_ABS_PATH);
	} catch (e) {
		try {
			unlinkSync(result.stagedPath);
		} catch {
			/* ignore */
		}
		return json({ error: 'io_error', detail: (e as Error).message }, { status: 500 });
	} finally {
		try {
			unlinkSync(uploadedPath);
		} catch {
			/* ignore */
		}
	}

	// Build the response FIRST, then schedule the exit. SvelteKit serializes
	// the Response and returns it to Node's HTTP layer before any subsequent
	// microtask runs, so the 500ms timeout fires well after the bytes are
	// flushed to the client socket.
	const response = json({ ok: true, message: 'Restore erfolgreich. Server startet neu…' });
	setTimeout(() => {
		process.exit(0);
	}, 500);
	return response;
};
