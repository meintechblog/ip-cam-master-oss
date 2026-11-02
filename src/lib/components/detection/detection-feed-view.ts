// Quick-task 260610-cw6 — pure presentational logic for the C4 lean detection UI.
//
// Kept as a tiny, dependency-free, framework-agnostic module so the C5 banner state
// machine and the type->icon mapping are deterministically unit-testable WITHOUT a
// DOM renderer (this repo has no jsdom / @testing-library/svelte by convention). The
// .svelte components import from here — no logic is duplicated in the templates.
import type { ConnState } from '$lib/server/services/protect-connection-fsm';
import type { DetectionPhase } from '$lib/server/services/detection-tap-fsm';

// "Connected but no recent detections" must read as a calm, healthy QUIET state —
// distinct from disconnected (red) and from an active alarm (green). 5 minutes.
export const QUIET_THRESHOLD_MS = 5 * 60 * 1000;

export type BannerKind = 'disconnected' | 'degraded' | 'quiet' | 'active';
export type BannerTone = 'red' | 'yellow' | 'green' | 'muted';

export interface BannerView {
	kind: BannerKind;
	tone: BannerTone;
	label: string;
}

/**
 * The C5 liveness decision. "No events" while connected is NOT the same as
 * "disconnected" — it gets its own calm/quiet presentation so the operator can
 * trust silence rather than mistaking it for a dead tap.
 */
export function bannerState(
	connectionState: ConnState,
	lastEventAt: number | null,
	now: number = Date.now()
): BannerView {
	if (connectionState === 'disconnected') {
		return {
			kind: 'disconnected',
			tone: 'red',
			label: 'Nicht verbunden — keine Kamera-Anbindung konfiguriert'
		};
	}
	if (connectionState === 'degraded') {
		return {
			kind: 'degraded',
			tone: 'yellow',
			label: 'Verbindung gestört — Wiederverbindung läuft'
		};
	}
	// connectionState === 'connected'
	const fresh = lastEventAt !== null && now - lastEventAt <= QUIET_THRESHOLD_MS;
	if (!fresh) {
		return {
			kind: 'quiet',
			tone: 'muted',
			label: 'Verbunden — ruhig (keine Detektionen)'
		};
	}
	return {
		kind: 'active',
		tone: 'green',
		label: 'Verbunden — aktiv'
	};
}

// Lucide icon NAMES (resolved to components in the .svelte file). `type` is an OPEN
// string set off untrusted SSE data (T-cw6-02): unknown types fall back to a neutral
// default icon — we never trust/execute the string.
export type IconName = 'User' | 'Car' | 'PawPrint' | 'Package' | 'Eye';

const ICON_BY_TYPE: Record<string, IconName> = {
	person: 'User',
	vehicle: 'Car',
	animal: 'PawPrint',
	package: 'Package'
};

export function iconNameForType(type: string): IconName {
	return ICON_BY_TYPE[type] ?? 'Eye';
}

export function phaseLabel(phase: DetectionPhase): string {
	return phase === 'confirmed' ? 'bestätigt' : 'beendet';
}

/** de-DE wall-clock time (mirrors JournalTab.formatTime). */
export function formatTime(ms: number): string {
	try {
		return new Date(ms).toLocaleTimeString('de-DE', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	} catch {
		return '';
	}
}

/** Compact German relative time ("gerade eben" / "vor 3 min" / falls back to clock). */
export function relativeTime(ms: number, now: number = Date.now()): string {
	const diff = now - ms;
	if (!Number.isFinite(diff) || diff < 0) return formatTime(ms);
	const sec = Math.floor(diff / 1000);
	if (sec < 10) return 'gerade eben';
	if (sec < 60) return `vor ${sec} s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `vor ${min} min`;
	const hrs = Math.floor(min / 60);
	if (hrs < 24) return `vor ${hrs} h`;
	return formatTime(ms);
}
