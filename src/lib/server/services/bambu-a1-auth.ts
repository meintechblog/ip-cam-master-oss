/**
 * Builds the 80-byte auth handshake packet for Bambu Lab A1 JPEG-over-TLS
 * camera stream on port 6000.
 *
 * Byte layout (per ha-bambulab pybambu/bambu_client.py ChamberImageThread.run
 * + validated byte-for-byte against real A1 hardware in spike 004):
 *   offset  0.. 3   u32 LE 0x40    (packet type)
 *   offset  4.. 7   u32 LE 0x3000  (subtype — NOT 0x30, silent-fail pitfall)
 *   offset  8..15   zero (reserved)
 *   offset 16..47   username, ASCII, null-padded to 32 bytes
 *   offset 48..79   access code, ASCII, null-padded to 32 bytes
 *
 * Pure function — no I/O, no env deps. Safe to import from the LXC ingestion
 * script (`lxc-assets/bambu-a1-camera.mjs`), preflight (`bambu-preflight.ts`),
 * and snapshot endpoint (`bambu-a1-camera.ts`) without circular deps.
 *
 * Regression guard: the 0x30-vs-0x3000 silent-fail mode (documented in spike
 * 004 §2, CONTEXT.md D-08, RESEARCH Pitfall 1) is covered by the companion
 * test's byte-for-byte assertion + golden fixture compare.
 */
export function buildAuth(username: string, accessCode: string): Buffer {
	const buf = Buffer.alloc(80, 0);
	buf.writeUInt32LE(0x40, 0);
	buf.writeUInt32LE(0x3000, 4); // NOT 0x30 — u32 LE 0x3000 gives bytes 00 30 00 00
	// bytes 8..15 stay zero (reserved)
	buf.write(username, 16, 32, 'ascii');
	buf.write(accessCode, 48, 32, 'ascii');
	return buf;
}
