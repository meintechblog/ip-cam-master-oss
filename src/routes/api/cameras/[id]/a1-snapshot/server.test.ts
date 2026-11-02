import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock $env/dynamic/private before importing anything that touches it.
vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

// Drizzle query chain — selectGet returns the row stub per test.
const selectGet = vi.fn();
vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({ from: () => ({ where: () => ({ get: selectGet }) }) })
	}
}));
vi.mock('$lib/server/db/schema', () => ({ cameras: {} }));

// Crypto mock: return a predictable transform so a negative test can assert
// the decrypted value never appears in the response body.
vi.mock('$lib/server/services/crypto', () => ({ decrypt: (v: string) => v + '-dec' }));

// A1 snapshot helper — spy so we can assert call count across cache windows.
const fetchA1SnapshotJpeg = vi.fn();
vi.mock('$lib/server/services/bambu-a1-camera', () => ({
	fetchA1SnapshotJpeg: (...args: unknown[]) => (fetchA1SnapshotJpeg as any)(...args)
}));

import { GET } from './+server';

const call = async (id = '1'): Promise<Response> => await (GET({ params: { id } } as any) as Promise<Response>);

describe('GET /api/cameras/:id/a1-snapshot (Phase 18 / BAMBU-A1-10)', () => {
	beforeEach(() => {
		selectGet.mockReset();
		fetchA1SnapshotJpeg.mockReset();
	});

	it('400 on non-integer id', async () => {
		const res = await call('foo');
		expect(res.status).toBe(400);
	});

	it('404 when camera does not exist', async () => {
		selectGet.mockReturnValue(undefined);
		const res = await call('42');
		expect(res.status).toBe(404);
		expect(await res.text()).toContain('not found');
	});

	it('404 when camera is not Bambu', async () => {
		selectGet.mockReturnValue({ id: 1, cameraType: 'mobotix', model: null });
		const res = await call();
		expect(res.status).toBe(404);
		expect(await res.text()).toContain('Not a Bambu');
	});

	it('400 when camera is Bambu but not A1', async () => {
		selectGet.mockReturnValue({ id: 1, cameraType: 'bambu', model: 'H2C' });
		const res = await call();
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Not an A1');
	});

	it('502 when fetchA1SnapshotJpeg returns null', async () => {
		selectGet.mockReturnValue({
			id: 1,
			cameraType: 'bambu',
			model: 'A1',
			accessCode: 'enc',
			ip: '1.2.3.4'
		});
		fetchA1SnapshotJpeg.mockResolvedValueOnce(null);
		const res = await call();
		expect(res.status).toBe(502);
	});

	it('200 image/jpeg on successful fetch', async () => {
		selectGet.mockReturnValue({
			id: 1,
			cameraType: 'bambu',
			model: 'A1',
			accessCode: 'enc',
			ip: '1.2.3.4'
		});
		const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]);
		fetchA1SnapshotJpeg.mockResolvedValueOnce(jpeg);
		const res = await call();
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/jpeg');
		const body = Buffer.from(await res.arrayBuffer());
		expect(body.equals(jpeg)).toBe(true);
	});

	it('serves from 2s cache on second call; fetch called exactly once', async () => {
		selectGet.mockReturnValue({
			id: 7,
			cameraType: 'bambu',
			model: 'A1',
			accessCode: 'enc',
			ip: '1.2.3.4'
		});
		const jpeg = Buffer.from([0xff, 0xd8, 0xde, 0xad, 0xff, 0xd9]);
		fetchA1SnapshotJpeg.mockResolvedValueOnce(jpeg);
		await call('7');
		await call('7');
		expect(fetchA1SnapshotJpeg).toHaveBeenCalledTimes(1);
	});

	// Phase 18 / WR-01: Concurrent cache misses must coalesce onto a single
	// in-flight TLS session. The DoS-mitigation invariant is ≤1 TLS handshake
	// per 2 s per camera, regardless of simultaneous request count.
	it('coalesces concurrent misses into one fetchA1SnapshotJpeg call', async () => {
		selectGet.mockReturnValue({
			id: 123,
			cameraType: 'bambu',
			model: 'A1',
			accessCode: 'enc',
			ip: '1.2.3.4'
		});
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
		let resolveFetch!: (v: Buffer) => void;
		fetchA1SnapshotJpeg.mockReturnValueOnce(
			new Promise<Buffer>((r) => {
				resolveFetch = r;
			})
		);
		// Two overlapping requests — must share the single in-flight promise.
		const p1 = call('123');
		const p2 = call('123');
		resolveFetch(jpeg);
		await Promise.all([p1, p2]);
		expect(fetchA1SnapshotJpeg).toHaveBeenCalledTimes(1);
	});

	it('never includes the access code in the response body or headers', async () => {
		selectGet.mockReturnValue({
			id: 99,
			cameraType: 'bambu',
			model: 'A1',
			accessCode: 'SECRET123',
			ip: '1.2.3.4'
		});
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
		fetchA1SnapshotJpeg.mockResolvedValueOnce(jpeg);
		const res = await call('99');
		const bodyText = Buffer.from(await res.arrayBuffer()).toString();
		expect(bodyText).not.toContain('SECRET');
		expect(bodyText).not.toContain('-dec');
		for (const [, value] of res.headers.entries()) {
			expect(value).not.toContain('SECRET');
			expect(value).not.toContain('-dec');
		}
	});
});
