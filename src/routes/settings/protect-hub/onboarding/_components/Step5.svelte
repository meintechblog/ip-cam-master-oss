<script lang="ts">
	// v1.3 Phase 22 Plan 04 — Wizard Step 5 "Erste Synchronisation" (HUB-WIZ-07).
	//
	// On mount: POST /api/protect-hub/reconcile, capture reconcileId.
	// Poll loop at 1500 ms cadence: parallel fetch GET /api/protect-hub/reconcile-runs?reconcileId=X
	// + GET /api/protect-hub/health. Three named stages render as a vertical mini-progress
	// (UI-SPEC §step-5):
	//   Stage 1 (YAML)    — done when run.run.status !== null && status !== 'running'
	//   Stage 2 (go2rtc)  — done when health.go2rtcReady === true
	//   Stage 3 (streams) — done when health.streamCount > 0 && run.run.status === 'success'
	//
	// On terminal success (status ∈ {'success','no_op'}): clear interval, POST /wizard/5, onComplete().
	// On 90s elapsed: render non-blocking "dauert länger als gewöhnlich" note + Zur Kameraliste link.
	// On terminal error: render error block + Retry button (re-fires reconcile).
	// On 404 from reconcile-runs: retry the SAME reconcileId (Pitfall #6 — race with audit-row insert).
	//
	// 2000 ms health-probe timeout (server-side AbortSignal) keeps request pile-up bounded
	// at 1500 ms client cadence (T-22-05 mitigation accepted in Plan 02).
	import { CheckCircle2, XCircle, Loader2 } from 'lucide-svelte';

	let {
		onComplete
	}: {
		onComplete: () => void;
	} = $props();

	type StageStatus = 'pending' | 'in-progress' | 'done';
	type Stage = {
		label: string;
		doneLabel: string;
		status: StageStatus;
	};

	type RunRow = {
		status: 'running' | 'success' | 'no_op' | 'bridge_unreachable' | 'error' | null;
		error: string | null;
	};

	type HealthBody = {
		go2rtcReady?: boolean;
		streamCount?: number;
		stage?: string;
	};

	let stages = $state<Stage[]>([
		{ label: 'YAML wird geschrieben…', doneLabel: 'YAML auf Bridge', status: 'in-progress' },
		{ label: 'go2rtc wird neu geladen…', doneLabel: 'go2rtc bereit', status: 'pending' },
		{ label: 'Streams werden geprüft…', doneLabel: 'Streams laufen', status: 'pending' }
	]);

	let reconcileId = $state<string | null>(null);
	let pollHandle: ReturnType<typeof setInterval> | null = null;
	let startedAtMs = $state<number>(0);
	let timedOut = $state(false);
	let errorCopy = $state<string | null>(null);
	let advancing = $state(false);

	$effect(() => {
		void startFirstReconcile();
		return () => {
			if (pollHandle) clearInterval(pollHandle);
		};
	});

	async function startFirstReconcile() {
		errorCopy = null;
		timedOut = false;
		startedAtMs = Date.now();
		stages = [
			{ label: 'YAML wird geschrieben…', doneLabel: 'YAML auf Bridge', status: 'in-progress' },
			{ label: 'go2rtc wird neu geladen…', doneLabel: 'go2rtc bereit', status: 'pending' },
			{ label: 'Streams werden geprüft…', doneLabel: 'Streams laufen', status: 'pending' }
		];
		try {
			const res = await fetch('/api/protect-hub/reconcile', { method: 'POST' });
			const body = (await res.json()) as { ok?: boolean; reconcileId?: string; error?: string };
			if (!res.ok || !body.ok || !body.reconcileId) {
				errorCopy = body.error || 'Synchronisation konnte nicht gestartet werden.';
				return;
			}
			reconcileId = body.reconcileId;
			pollHandle = setInterval(() => void pollOnce(), 1500);
		} catch (err) {
			errorCopy = err instanceof Error ? err.message : 'Netzwerkfehler beim Start.';
		}
	}

	async function pollOnce() {
		if (!reconcileId) return;
		// Track the 90s timeout regardless of poll progress.
		if (Date.now() - startedAtMs >= 90_000) {
			timedOut = true;
		}
		try {
			const [runRes, healthRes] = await Promise.all([
				fetch(`/api/protect-hub/reconcile-runs?reconcileId=${reconcileId}`),
				fetch('/api/protect-hub/health')
			]);

			let runRow: RunRow | null = null;
			if (runRes.status === 404) {
				// Race with audit-row insert per reconcile.ts:138-145 — keep polling
				// the SAME reconcileId; do NOT abandon. (Pitfall #6.)
			} else if (runRes.ok) {
				const runBody = (await runRes.json()) as { ok?: boolean; run?: RunRow };
				runRow = runBody.run ?? null;
			}

			let health: HealthBody = {};
			if (healthRes.ok) {
				health = (await healthRes.json()) as HealthBody;
			}

			updateStages(runRow, health);

			if (runRow && (runRow.status === 'success' || runRow.status === 'no_op')) {
				if (pollHandle) {
					clearInterval(pollHandle);
					pollHandle = null;
				}
				await advance();
				return;
			}
			if (runRow && (runRow.status === 'error' || runRow.status === 'bridge_unreachable')) {
				if (pollHandle) {
					clearInterval(pollHandle);
					pollHandle = null;
				}
				errorCopy = runRow.error || `Synchronisation fehlgeschlagen: ${runRow.status}`;
				return;
			}
		} catch {
			// Transient network error — keep polling.
		}
	}

	function updateStages(run: RunRow | null, health: HealthBody) {
		const next = stages.map((s) => ({ ...s }));
		// Stage 1 — YAML
		const stage1Done = run?.status != null && run.status !== 'running';
		next[0].status = stage1Done ? 'done' : 'in-progress';
		// Stage 2 — go2rtc
		if (stage1Done) {
			next[1].status = health.go2rtcReady === true ? 'done' : 'in-progress';
		}
		// Stage 3 — streams. WR-04 fix: a no_op reconcile (bridge YAML
		// unchanged, no SSH deploy) terminates without ever entering
		// `success`, but pollOnce() advances on `no_op` too. Without
		// recognising `no_op` as a terminal-success status here, Stage 3
		// flashes 'in-progress' for one render frame before the component
		// auto-advances to Step 6. Treat both 'success' and 'no_op' as
		// stage-3-complete.
		if (stage1Done && health.go2rtcReady === true) {
			const terminalOk = run?.status === 'success' || run?.status === 'no_op';
			next[2].status =
				(health.streamCount ?? 0) > 0 && terminalOk ? 'done' : 'in-progress';
		}
		stages = next;
	}

	async function advance() {
		if (advancing) return;
		advancing = true;
		try {
			await fetch('/api/protect-hub/wizard/5', { method: 'POST' });
			onComplete();
		} finally {
			advancing = false;
		}
	}

	function retry() {
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
		void startFirstReconcile();
	}
</script>

<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
	<h2 class="text-base font-semibold text-text-primary">
		Schritt 5: Streams werden eingerichtet
	</h2>
	<p class="text-sm text-text-secondary">
		Wir schreiben jetzt die go2rtc-Konfiguration auf die Bridge und warten, bis alle Streams laufen.
	</p>

	<div class="space-y-3">
		{#each stages as stage (stage.label)}
			<div class="flex items-start gap-3">
				{#if stage.status === 'done'}
					<CheckCircle2 class="w-5 h-5 text-success shrink-0 mt-0.5" />
					<span class="text-sm font-medium text-text-primary">{stage.doneLabel}</span>
				{:else if stage.status === 'in-progress'}
					<Loader2 class="w-5 h-5 text-accent animate-spin shrink-0 mt-0.5" />
					<span class="text-sm text-text-primary">{stage.label}</span>
				{:else}
					<div class="w-5 h-5 shrink-0 mt-0.5 flex items-center justify-center">
						<span class="w-2 h-2 rounded-full bg-text-secondary/40"></span>
					</div>
					<span class="text-sm text-text-secondary">{stage.label}</span>
				{/if}
			</div>
		{/each}
	</div>

	{#if errorCopy}
		<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-2">
				<XCircle class="w-5 h-5 text-red-400 shrink-0" />
				<span class="text-sm font-medium text-red-400">
					Synchronisation fehlgeschlagen: {errorCopy}
				</span>
			</div>
			<button
				type="button"
				onclick={retry}
				class="inline-flex items-center gap-2 px-3 py-1.5 border border-border text-text-secondary
					rounded-lg hover:text-text-primary hover:bg-bg-input transition-colors text-sm cursor-pointer"
			>
				Erneut versuchen
			</button>
		</div>
	{:else if timedOut}
		<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 space-y-2">
			<p class="text-sm text-text-primary">
				Hinweis: Das dauert länger als gewöhnlich. Du kannst warten oder im Hintergrund fortfahren.
			</p>
			<a href="/kameras" class="text-sm text-accent hover:text-accent/80 cursor-pointer">
				Zur Kameraliste
			</a>
		</div>
	{/if}
</div>
