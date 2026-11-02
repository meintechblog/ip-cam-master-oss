import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Tests for Bambu A1 JPEG-over-TLS helpers (Phase 18 / BAMBU-A1-04).
 *
 * We mock `node:tls` so the production code paths run without a real printer.
 * The mock socket is a plain EventEmitter with stubbed `write` / `destroy`,
 * which is enough to exercise the settled-guard Promise + auth-send logic.
 */

type MockSocket = EventEmitter & {
	write: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
};

function mockSocket(): MockSocket {
	const sock = new EventEmitter() as MockSocket;
	sock.write = vi.fn();
	sock.destroy = vi.fn();
	return sock;
}

const sockets: MockSocket[] = [];
vi.mock('node:tls', () => ({
	default: {
		connect: vi.fn(() => {
			const s = mockSocket();
			sockets.push(s);
			return s;
		})
	}
}));

// Import AFTER the mock is registered.
import { checkTls6000Real, fetchA1SnapshotJpeg } from './bambu-a1-camera';

beforeEach(() => {
	sockets.length = 0;
});

describe('checkTls6000Real (Phase 18 / BAMBU-A1-04)', () => {
	it('resolves ok=true when printer returns data within timeout', async () => {
		const p = checkTls6000Real('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		// Let the Promise constructor run first, then fire events
		setImmediate(() => {
			s.emit('secureConnect');
			setImmediate(() => s.emit('data', Buffer.from([0x00])));
		});
		await expect(p).resolves.toEqual({ ok: true });
		// Auth packet was sent
		expect(s.write).toHaveBeenCalledTimes(1);
		const authArg = s.write.mock.calls[0][0] as Buffer;
		expect(authArg.length).toBe(80);
	});

	it('classifies ECONNREFUSED as REFUSED', async () => {
		const p = checkTls6000Real('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			const err = new Error('conn refused') as NodeJS.ErrnoException;
			err.code = 'ECONNREFUSED';
			s.emit('error', err);
		});
		await expect(p).resolves.toEqual({ ok: false, reason: 'REFUSED' });
	});

	it('classifies ETIMEDOUT as TIMEOUT', async () => {
		const p = checkTls6000Real('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			const err = new Error('etimedout') as NodeJS.ErrnoException;
			err.code = 'ETIMEDOUT';
			s.emit('error', err);
		});
		await expect(p).resolves.toEqual({ ok: false, reason: 'TIMEOUT' });
	});

	it('classifies timeout before auth as TLS_HANDSHAKE', async () => {
		const p = checkTls6000Real('1.2.3.4', 'code', 30);
		// Don't fire any events — timer fires first
		await expect(p).resolves.toEqual({ ok: false, reason: 'TLS_HANDSHAKE' });
	});

	it('classifies timeout after auth (socket still open, no data) as CAMERA_DISABLED', async () => {
		// Live observation 2026-04-29 on a real A1 Mini with the Bambu app's
		// camera switch off: TLS auth accepted, connection holds open >30s,
		// zero bytes ever sent. The old AUTH_SILENT_DROP label conflated this
		// with a wrong access code, which costs users hours debugging the
		// wrong field.
		const p = checkTls6000Real('1.2.3.4', 'code', 40);
		const s = sockets[sockets.length - 1];
		setImmediate(() => s.emit('secureConnect')); // auth sent, no data reply, no close
		await expect(p).resolves.toEqual({ ok: false, reason: 'CAMERA_DISABLED' });
	});

	it('classifies post-auth close (no data) as AUTH_REJECTED', async () => {
		// Live observation 2026-04-29 with a known-wrong code: printer FINs
		// within ~6ms after receiving the auth packet. Differentiating this
		// from CAMERA_DISABLED is what lets the preflight tell the user
		// "your code is wrong" vs "your camera is off in the Bambu app".
		const p = checkTls6000Real('1.2.3.4', 'badcode', 100);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			s.emit('secureConnect');
			setImmediate(() => s.emit('close'));
		});
		await expect(p).resolves.toEqual({ ok: false, reason: 'AUTH_REJECTED' });
	});

	it('sends buildAuth("bblp", accessCode) as the first write', async () => {
		const p = checkTls6000Real('1.2.3.4', 'supersecret', 100);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			s.emit('secureConnect');
			setImmediate(() => s.emit('data', Buffer.from([0x00])));
		});
		await p;
		const authArg = s.write.mock.calls[0][0] as Buffer;
		// u32 LE 0x40 at offset 0
		expect(authArg.readUInt32LE(0)).toBe(0x40);
		// u32 LE 0x3000 at offset 4 (NOT 0x30 — silent-fail pitfall)
		expect(authArg.readUInt32LE(4)).toBe(0x3000);
		// Username 'bblp' at offset 16..19
		expect(authArg.subarray(16, 20).toString('ascii')).toBe('bblp');
		// Access code at offset 48..58
		expect(authArg.subarray(48, 48 + 'supersecret'.length).toString('ascii')).toBe('supersecret');
	});
});

describe('fetchA1SnapshotJpeg (Phase 18 / BAMBU-A1-10 shared helper)', () => {
	it('returns Buffer when a synthetic frame-header + JPEG is delivered', async () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
		const header = Buffer.alloc(16);
		header.writeUInt32LE(jpeg.length, 0);
		const p = fetchA1SnapshotJpeg('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			s.emit('secureConnect');
			setImmediate(() => s.emit('data', Buffer.concat([header, jpeg])));
		});
		const result = await p;
		expect(result).not.toBeNull();
		expect(result?.equals(jpeg)).toBe(true);
	});

	it('returns null on socket error', async () => {
		const p = fetchA1SnapshotJpeg('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		setImmediate(() => s.emit('error', new Error('boom')));
		await expect(p).resolves.toBeNull();
	});

	it('returns null when frame size is suspiciously large', async () => {
		const header = Buffer.alloc(16);
		header.writeUInt32LE(10_000_000, 0); // > 5 MB threshold
		const p = fetchA1SnapshotJpeg('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			s.emit('secureConnect');
			setImmediate(() => s.emit('data', header));
		});
		await expect(p).resolves.toBeNull();
	});

	it('returns null when payload does not start with JPEG magic', async () => {
		const notJpeg = Buffer.from([0x00, 0x11, 0x22, 0x33]);
		const header = Buffer.alloc(16);
		header.writeUInt32LE(notJpeg.length, 0);
		const p = fetchA1SnapshotJpeg('1.2.3.4', 'code', 500);
		const s = sockets[sockets.length - 1];
		setImmediate(() => {
			s.emit('secureConnect');
			setImmediate(() => s.emit('data', Buffer.concat([header, notJpeg])));
		});
		await expect(p).resolves.toBeNull();
	});

	it('returns null on timeout with no data', async () => {
		const p = fetchA1SnapshotJpeg('1.2.3.4', 'code', 30);
		// No events — timer fires
		await expect(p).resolves.toBeNull();
	});
});
