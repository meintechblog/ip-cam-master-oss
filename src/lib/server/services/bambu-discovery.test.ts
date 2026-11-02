import { describe, it, expect } from 'vitest';
import {
	parseNotifyPayload,
	BAMBU_MODEL_ALLOWLIST,
	PRINTER_CAPABILITIES,
	normalizeBambuModel
} from './bambu-discovery';

// Canonical H2C NOTIFY payload, verbatim from
// .planning/research/H2C-FIELD-NOTES.md §SSDP (validated 2026-04-15).
const H2C_PAYLOAD = [
	'NOTIFY * HTTP/1.1',
	'Host: 239.255.255.250:1990',
	'Server: UPnP/1.0',
	'Location: 192.0.2.109',
	'NT: urn:bambulab-com:device:3dprinter:1',
	'NTS: ssdp:alive',
	'USN: 31B8BP611201453',
	'Cache-Control: max-age=1800',
	'DevModel.bambu.com: O1C2',
	'DevName.bambu.com: Bob the Builder',
	'DevConnect.bambu.com: cloud',
	'DevBind.bambu.com: occupied',
	'Devseclink.bambu.com: secure',
	'DevInf.bambu.com: wlan0',
	'DevVersion.bambu.com: 01.01.05.00',
	'DevCap.bambu.com: 1'
].join('\r\n');

// Synthetic A1 payload — same shape, different DevModel + USN + name.
// Uses the canonical 'A1' wire code form (kept as a test case even though
// real hardware broadcasts 'N2S' — the allowlist accepts both).
const A1_PAYLOAD = [
	'NOTIFY * HTTP/1.1',
	'Host: 239.255.255.250:1900',
	'Server: UPnP/1.0',
	'Location: 192.0.2.195',
	'NT: urn:bambulab-com:device:3dprinter:1',
	'NTS: ssdp:alive',
	'USN: AAAAAAA0000001',
	'Cache-Control: max-age=1800',
	'DevModel.bambu.com: A1',
	'DevName.bambu.com: TestA1'
].join('\r\n');

// Real A1 payload — verbatim from live tcpdump 2026-04-21 against the
// user's A1 at 192.0.2.195. Wire code is N2S, not A1 (same namespace
// mismatch as H2C's O1C2). This capture is the ground truth for the
// SSDP allowlist + normalizer.
const A1_REAL_PAYLOAD = [
	'NOTIFY * HTTP/1.1',
	'HOST: 239.255.255.250:1900',
	'Server: UPnP/1.0',
	'Location: 192.0.2.195',
	'NT: urn:bambulab-com:device:3dprinter:1',
	'USN: 03919A3B0100254',
	'Cache-Control: max-age=1800',
	'DevModel.bambu.com: N2S',
	'DevName.bambu.com: A1',
	'DevSignal.bambu.com: -51',
	'DevConnect.bambu.com: cloud',
	'DevBind.bambu.com: occupied',
	'Devseclink.bambu.com: secure',
	'DevVersion.bambu.com: 01.08.00.00',
	'DevCap.bambu.com: 1'
].join('\r\n');

const GENERIC_UPNP_PAYLOAD = [
	'NOTIFY * HTTP/1.1',
	'Host: 239.255.255.250:1900',
	'Server: UPnP/1.0',
	'Location: http://192.0.2.50:8200/rootDesc.xml',
	'NT: urn:schemas-upnp-org:device:MediaServer:1',
	'NTS: ssdp:alive',
	'USN: uuid:aaaabbbb-cccc-dddd-eeee-ffff00001111::urn:schemas-upnp-org:device:MediaServer:1',
	'Cache-Control: max-age=1800'
].join('\r\n');

const UNKNOWN_MODEL_PAYLOAD = [
	'NOTIFY * HTTP/1.1',
	'Host: 239.255.255.250:1990',
	'Server: UPnP/1.0',
	'Location: 192.0.2.210',
	'NT: urn:bambulab-com:device:3dprinter:1',
	'NTS: ssdp:alive',
	'USN: ZZZZZZZ9999999',
	'DevModel.bambu.com: Z9Z9',
	'DevName.bambu.com: FutureModel'
].join('\r\n');

describe('parseNotifyPayload', () => {
	it('parses the canonical H2C NOTIFY payload from H2C-FIELD-NOTES §SSDP', () => {
		const result = parseNotifyPayload(H2C_PAYLOAD, '192.0.2.109');
		expect(result).toEqual({
			ip: '192.0.2.109',
			serialNumber: '31B8BP611201453',
			model: 'O1C2',
			modelLabel: 'Bambu Lab H2C',
			name: 'Bob the Builder'
		});
	});

	it('parses a synthetic A1 payload (forward-compat allowlist entry)', () => {
		const result = parseNotifyPayload(A1_PAYLOAD, '192.0.2.195');
		expect(result).toEqual({
			ip: '192.0.2.195',
			serialNumber: 'AAAAAAA0000001',
			model: 'A1',
			modelLabel: 'Bambu Lab A1',
			name: 'TestA1'
		});
	});

	it('returns null for a non-Bambu UPnP NOTIFY (wrong NT URN)', () => {
		expect(parseNotifyPayload(GENERIC_UPNP_PAYLOAD, '192.0.2.50')).toBeNull();
	});

	it('returns null for a Bambu-URN NOTIFY with an unknown DevModel', () => {
		expect(parseNotifyPayload(UNKNOWN_MODEL_PAYLOAD, '192.0.2.210')).toBeNull();
	});

	it('allowlist contains the documented model codes + wire aliases', () => {
		expect([...BAMBU_MODEL_ALLOWLIST].sort()).toEqual(
			['A1', 'H2C', 'H2D', 'N1', 'N2S', 'O1C2', 'P1S', 'X1C'].sort()
		);
	});

	it('parses the REAL A1 SSDP payload (DevModel: N2S) captured 2026-04-21', () => {
		const result = parseNotifyPayload(A1_REAL_PAYLOAD, '192.0.2.195');
		expect(result).toEqual({
			ip: '192.0.2.195',
			serialNumber: '03919A3B0100254',
			model: 'N2S',
			modelLabel: 'Bambu Lab A1',
			name: 'A1'
		});
	});
});

describe('normalizeBambuModel', () => {
	it('maps N2S (A1 wire code) to A1', () => {
		expect(normalizeBambuModel('N2S')).toBe('A1');
	});
	it('maps O1C2 (H2C wire code) to H2C', () => {
		expect(normalizeBambuModel('O1C2')).toBe('H2C');
	});
	it('passes canonical codes through unchanged', () => {
		expect(normalizeBambuModel('A1')).toBe('A1');
		expect(normalizeBambuModel('H2C')).toBe('H2C');
		expect(normalizeBambuModel('H2D')).toBe('H2D');
		expect(normalizeBambuModel('X1C')).toBe('X1C');
		expect(normalizeBambuModel('P1S')).toBe('P1S');
	});
	it('maps N1 (A1 Mini wire code) to A1 — shares runtime path', () => {
		expect(normalizeBambuModel('N1')).toBe('A1');
	});
	it('passes unknown codes through unchanged (forward-compat)', () => {
		expect(normalizeBambuModel('Z9Z9')).toBe('Z9Z9');
	});
});

describe('PRINTER_CAPABILITIES (Phase 18 / D-07)', () => {
	it('declares all canonical Bambu models + wire aliases', () => {
		const keys = Object.keys(PRINTER_CAPABILITIES).sort();
		expect(keys).toEqual(['A1', 'A1Mini', 'H2C', 'H2D', 'N1', 'N2S', 'O1C2', 'P1S', 'X1C']);
	});

	it('N2S (A1 wire alias) has identical capabilities to A1', () => {
		expect(PRINTER_CAPABILITIES.N2S).toEqual(PRINTER_CAPABILITIES.A1);
	});
	it('A1 uses jpeg-tls-6000 camera transport (drives preflight split)', () => {
		expect(PRINTER_CAPABILITIES.A1.cameraTransport).toBe('jpeg-tls-6000');
	});
	it('H2C-family uses rtsps-322 camera transport (existing behavior preserved)', () => {
		expect(PRINTER_CAPABILITIES.H2C.cameraTransport).toBe('rtsps-322');
		expect(PRINTER_CAPABILITIES.O1C2.cameraTransport).toBe('rtsps-322');
	});
	it('A1 declares lite AMS and has chamberHeater off (spike 003 telemetry facts)', () => {
		expect(PRINTER_CAPABILITIES.A1.ams).toBe('lite');
		expect(PRINTER_CAPABILITIES.A1.chamberHeater).toBe(false);
	});
	it('A1 xcamFeatures is exactly [buildplateMarkerDetector]', () => {
		expect(PRINTER_CAPABILITIES.A1.xcamFeatures).toEqual(['buildplateMarkerDetector']);
	});
});
