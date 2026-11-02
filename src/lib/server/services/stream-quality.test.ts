import { describe, it, expect } from 'vitest';
import { computeStreamRates, type StreamRateSample } from './stream-quality';

describe('computeStreamRates', () => {
	it('Test 1: normal positive deltas → bitrate kbps + packet rate pps', () => {
		// 125000 bytes over 1000ms = 1000 kbps; 1000 packets over 1000ms = 1000 pps.
		const prev: StreamRateSample = { bytesRecv: 0, packets: 0, tsMs: 1_000 };
		const next: StreamRateSample = { bytesRecv: 125_000, packets: 1_000, tsMs: 2_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBe(1000);
		expect(rates.packetRatePps).toBe(1000);
	});

	it('Test 1b: non-round delta is rounded to one decimal place', () => {
		// 3000 bytes over 30000ms = (3000*8)/30000 = 0.8 kbps; 45 packets / 30s = 1.5 pps.
		const prev: StreamRateSample = { bytesRecv: 1_000, packets: 10, tsMs: 0 };
		const next: StreamRateSample = { bytesRecv: 4_000, packets: 55, tsMs: 30_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBe(0.8);
		expect(rates.packetRatePps).toBe(1.5);
	});

	it('Test 2a: counter reset on bytes (next < prev) → both rates null', () => {
		const prev: StreamRateSample = { bytesRecv: 500_000, packets: 4_000, tsMs: 1_000 };
		const next: StreamRateSample = { bytesRecv: 1_000, packets: 4_100, tsMs: 2_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBeNull();
		expect(rates.packetRatePps).toBeNull();
	});

	it('Test 2b: counter reset on packets (next < prev) → both rates null', () => {
		const prev: StreamRateSample = { bytesRecv: 500_000, packets: 4_000, tsMs: 1_000 };
		const next: StreamRateSample = { bytesRecv: 600_000, packets: 10, tsMs: 2_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBeNull();
		expect(rates.packetRatePps).toBeNull();
	});

	it('Test 3: first observation (prev null/undefined) → both rates null', () => {
		const next: StreamRateSample = { bytesRecv: 125_000, packets: 1_000, tsMs: 2_000 };
		expect(computeStreamRates(null, next)).toEqual({ bitrateKbps: null, packetRatePps: null });
		expect(computeStreamRates(undefined, next)).toEqual({ bitrateKbps: null, packetRatePps: null });
	});

	it('Test 4a: deltaMs <= 0 (same tsMs) → both rates null (no divide-by-zero)', () => {
		const prev: StreamRateSample = { bytesRecv: 0, packets: 0, tsMs: 5_000 };
		const next: StreamRateSample = { bytesRecv: 125_000, packets: 1_000, tsMs: 5_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBeNull();
		expect(rates.packetRatePps).toBeNull();
	});

	it('Test 4b: negative deltaMs (clock skew) → both rates null (no infinity)', () => {
		const prev: StreamRateSample = { bytesRecv: 0, packets: 0, tsMs: 5_000 };
		const next: StreamRateSample = { bytesRecv: 125_000, packets: 1_000, tsMs: 4_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBeNull();
		expect(rates.packetRatePps).toBeNull();
		expect(Number.isFinite(rates.bitrateKbps ?? 0)).toBe(true);
	});

	it('Test 5: zero delta with positive interval → 0 kbps / 0 pps, not null', () => {
		const prev: StreamRateSample = { bytesRecv: 999, packets: 42, tsMs: 1_000 };
		const next: StreamRateSample = { bytesRecv: 999, packets: 42, tsMs: 31_000 };
		const rates = computeStreamRates(prev, next);
		expect(rates.bitrateKbps).toBe(0);
		expect(rates.packetRatePps).toBe(0);
	});
});
