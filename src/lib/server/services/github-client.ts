/**
 * GitHub API client for self-update commit polling — see UPD-AUTO-03.
 *
 * Single method `checkLatestCommit({ etag?, timeoutMs? })` that fetches
 * the latest commit on `meintechblog/ip-cam-master` `main`. Sends
 * `If-None-Match: <etag>` to avoid burning rate-limit quota when nothing
 * changed (304 = no quota consumed on the unauthenticated path).
 *
 * **Never throws.** All errors are mapped to a `LastCheckResult`
 * discriminated union and returned. Callers can persist the result
 * directly to `update-state-store`.
 */

import { CURRENT_SHA_SHORT } from '$lib/version';
import type { LastCheckResult } from './update-state-store';

const COMMITS_URL = 'https://api.github.com/repos/meintechblog/ip-cam-master/commits/main';
const DEFAULT_TIMEOUT_MS = 10_000;
const COMMIT_MESSAGE_MAX_LEN = 200;

export type CheckLatestCommitOptions = {
	etag?: string | null;
	timeoutMs?: number;
};

export type CheckLatestCommitResponse = {
	result: LastCheckResult;
	etag: string | null;
};

function truncateCommitMessage(message: string): string {
	const firstLine = message.split('\n', 1)[0] ?? '';
	return firstLine.slice(0, COMMIT_MESSAGE_MAX_LEN);
}

function buildUserAgent(): string {
	const sha = CURRENT_SHA_SHORT || 'unknown';
	return `ip-cam-master-self-update/${sha}`;
}

/**
 * Fetch the latest commit on main. Returns a discriminated union
 * inside the `result` field, plus the `ETag` header from the response
 * (when present — null on 304 / errors so the caller keeps the prior one).
 */
export async function checkLatestCommit(
	options: CheckLatestCommitOptions = {}
): Promise<CheckLatestCommitResponse> {
	const { etag, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': buildUserAgent()
	};
	if (etag) {
		headers['If-None-Match'] = etag;
	}

	try {
		const res = await fetch(COMMITS_URL, { headers, signal: controller.signal });

		if (res.status === 304) {
			return { result: { status: 'unchanged' }, etag: null };
		}

		const newEtag = res.headers.get('etag');

		if (res.status === 403 || res.status === 429) {
			const remaining = res.headers.get('x-ratelimit-remaining');
			const reset = res.headers.get('x-ratelimit-reset');
			if (remaining === '0' && reset) {
				const resetAt = Number.parseInt(reset, 10);
				if (Number.isFinite(resetAt)) {
					return { result: { status: 'rate_limited', resetAt }, etag: newEtag };
				}
			}
			return {
				result: { status: 'error', error: `GitHub HTTP ${res.status}` },
				etag: newEtag
			};
		}

		if (!res.ok) {
			return {
				result: { status: 'error', error: `GitHub HTTP ${res.status}` },
				etag: newEtag
			};
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch (err) {
			return {
				result: { status: 'error', error: `GitHub JSON parse: ${(err as Error).message}` },
				etag: newEtag
			};
		}

		if (!isCommitPayload(body)) {
			return {
				result: { status: 'error', error: 'GitHub: unexpected payload shape' },
				etag: newEtag
			};
		}

		const remoteSha = body.sha;
		const remoteShaShort = remoteSha.slice(0, 7);
		const message = truncateCommitMessage(body.commit.message);
		const author = body.commit.author?.name ?? 'unknown';
		const date = body.commit.author?.date ?? body.commit.committer?.date ?? '';

		return {
			result: { status: 'ok', remoteSha, remoteShaShort, message, author, date },
			etag: newEtag
		};
	} catch (err) {
		const aborted = (err as Error)?.name === 'AbortError';
		const msg = aborted
			? `timed out after ${timeoutMs}ms`
			: ((err as Error)?.message ?? 'unknown');
		return { result: { status: 'error', error: msg }, etag: null };
	} finally {
		clearTimeout(timer);
	}
}

type CommitPayload = {
	sha: string;
	commit: {
		message: string;
		author?: { name?: string; date?: string };
		committer?: { name?: string; date?: string };
	};
};

function isCommitPayload(value: unknown): value is CommitPayload {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	if (typeof v.sha !== 'string' || v.sha.length < 7) return false;
	if (!v.commit || typeof v.commit !== 'object') return false;
	const commit = v.commit as Record<string, unknown>;
	if (typeof commit.message !== 'string') return false;
	return true;
}
