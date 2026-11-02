<script lang="ts">
	// v1.3 Phase 22 Plan 05 — Hub-Status panel (HUB-UI-08).
	//
	// Polls /api/protect-hub/health + /api/protect-hub/drift every 10 s in
	// parallel. Renders 4 status rows (bridge state, last reconcile, YAML
	// hash, active stream count), an optional drift block (when
	// driftDetected===true; defaults to false in P22 per Plan 02 stub), and
	// a Sync-now button that POSTs /api/protect-hub/reconcile and waits
	// until reconcilerBusy=false before re-enabling.
	//
	// Per UI-SPEC §hub-status-panel (lines 396-401) + §accent-reserved-for
	// + Shared 4 (10 s polling cadence).
	import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-svelte';
	import { invalidateAll } from '$app/navigation';

	type Health = {
		ok: boolean;
		bridgeStatus?: string;
		bridgeIp?: string;
		go2rtcReady?: boolean;
		streamCount?: number;
		reconcilerBusy?: boolean;
		lastReconciledAt?: string | null;
		lastDeployedYamlHash?: string | null;
		stage?: string;
	};
	type Drift = { ok: boolean; driftDetected: boolean; checkedAt: string | null };

	let health = $state<Health | null>(null);
	let drift = $state<Drift | null>(null);
	let syncInFlight = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function refresh() {
		try {
			const [h, d] = await Promise.all([
				fetch('/api/protect-hub/health').then((r) => r.json()),
				fetch('/api/protect-hub/drift').then((r) => r.json())
			]);
			health = h;
			drift = d;
		} catch {
			// network blip — keep last good state
		}
	}

	async function syncNow() {
		syncInFlight = true;
		try {
			const res = await fetch('/api/protect-hub/reconcile', { method: 'POST' });
			if (!res.ok) {
				return;
			}
			// Wait for reconcilerBusy to drop. Cap loop at ~120s safety.
			// WR-01 fix — refresh() is wrapped so a transient network error
			// inside the loop doesn't break the busy-wait. Without the inner
			// try/catch, a network blip during the poll would propagate up
			// and exit syncNow() via finally; but more importantly, the
			// existing refresh() already swallows fetch errors silently and
			// keeps the prior `health` value — which would leave
			// reconcilerBusy stuck `true` from the last good poll until the
			// 120s cap. Keeping refresh() under the inner try/catch is
			// defensive: if refresh() ever throws (e.g. a future change
			// promotes errors), the wait still terminates on cap.
			const start = Date.now();
			while (Date.now() - start < 120_000) {
				await new Promise((r) => setTimeout(r, 1000));
				try {
					await refresh();
				} catch {
					// keep waiting — the loop's hard cap (120 s) bounds the wait.
				}
				if (!health?.reconcilerBusy) break;
			}
		} finally {
			syncInFlight = false;
			await invalidateAll();
		}
	}

	function relativeDe(iso: string | null | undefined): string {
		if (!iso) return '—';
		const ms = Date.now() - new Date(iso).getTime();
		const fmt = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
		const minutes = Math.round(ms / 60000);
		if (Math.abs(minutes) < 60) return fmt.format(-minutes, 'minute');
		const hours = Math.round(minutes / 60);
		if (Math.abs(hours) < 24) return fmt.format(-hours, 'hour');
		const days = Math.round(hours / 24);
		return fmt.format(-days, 'day');
	}

	function bridgeDot(status: string | undefined): string {
		switch (status) {
			case 'running':
				return 'bg-green-500';
			case 'stopped':
				return 'bg-yellow-500';
			case 'failed':
				return 'bg-red-500';
			case 'provisioning':
				return 'bg-blue-500';
			default:
				return 'bg-gray-500';
		}
	}

	$effect(() => {
		refresh();
		pollTimer = setInterval(refresh, 10000);
		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});

	const isBusy = $derived(syncInFlight || health?.reconcilerBusy === true);
</script>

<div class="bg-bg-card border border-border rounded-lg p-6">
	<h2 class="text-base font-semibold text-text-primary mb-4">Hub-Status</h2>

	<div class="space-y-3">
		<div class="flex items-center gap-3 text-sm">
			<span class="w-2.5 h-2.5 rounded-full {bridgeDot(health?.bridgeStatus)}"></span>
			<span class="text-text-secondary">Bridge:</span>
			<span class="text-xs font-mono text-text-primary">{health?.bridgeStatus ?? 'unbekannt'}</span>
		</div>
		<div class="flex items-center gap-3 text-sm">
			<span class="text-text-secondary">Letzte Synchronisation:</span>
			<span class="text-text-primary">{relativeDe(health?.lastReconciledAt)}</span>
		</div>
		<div class="flex items-center gap-3 text-sm">
			<span class="text-text-secondary">Konfig-Hash:</span>
			<span class="text-xs font-mono text-text-secondary"
				>{health?.lastDeployedYamlHash ? `${health.lastDeployedYamlHash.slice(0, 8)}…` : '—'}</span
			>
		</div>
		<div class="flex items-center gap-3 text-sm">
			<span class="text-text-secondary">Aktive Streams:</span>
			<span class="text-text-primary">{health?.streamCount ?? 0}</span>
		</div>
	</div>

	{#if drift?.driftDetected}
		<div
			class="mt-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 flex items-start gap-3"
		>
			<AlertTriangle class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<div class="flex-1">
				<p class="text-xs text-warning">
					YAML-Drift erkannt — die Bridge läuft auf einer fremden Konfiguration.
				</p>
				<button
					type="button"
					onclick={syncNow}
					disabled={isBusy}
					class="mt-2 text-xs text-accent hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
				>
					Erneut deployen
				</button>
			</div>
		</div>
	{/if}

	<div class="mt-6 flex justify-end">
		<button
			type="button"
			onclick={syncNow}
			disabled={isBusy}
			class="inline-flex items-center gap-2 bg-accent text-white px-4 py-2 rounded-lg text-sm
				hover:bg-accent/90 disabled:opacity-60 disabled:cursor-not-allowed"
		>
			{#if isBusy}
				<Loader2 class="w-4 h-4 animate-spin" />
				Synchronisation läuft…
			{:else}
				<RefreshCw class="w-4 h-4" />
				Jetzt synchronisieren
			{/if}
		</button>
	</div>
</div>
