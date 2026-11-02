<script lang="ts">
	// v1.3 Phase 22 Plan 04 — Wizard Step 3 "Kameras katalogisieren" (HUB-WIZ-05).
	//
	// On mount: POST /api/protect-hub/discover (re-uses Step 1's endpoint contract).
	// On success: shows "{N} Kameras gefunden — {M} erstanbieter, {K} drittanbieter."
	// On controller_unreachable / auth_failed: surfaces specific German copy.
	// CTA "Auswahl übernehmen": POST /api/protect-hub/wizard/3 then onComplete().
	//
	// Card chrome + state-block triad reused verbatim from P20 Step 1
	// (`onboarding/+page.svelte:121-191`); UI-SPEC §wizard-step-3 locks copy.
	import { CheckCircle2, XCircle, Loader2 } from 'lucide-svelte';

	let {
		onComplete
	}: {
		onComplete: () => void;
	} = $props();

	type DiscoverSummary = {
		insertedCams: number;
		updatedCams: number;
		insertedChannels: number;
	};

	let phase = $state<'idle' | 'loading' | 'success' | 'error'>('idle');
	let summary = $state<DiscoverSummary | null>(null);
	let errorCopy = $state<string | null>(null);
	let errorReason = $state<string | null>(null);
	let advancing = $state(false);

	$effect(() => {
		if (phase === 'idle') {
			void fetchDiscover();
		}
	});

	async function fetchDiscover() {
		phase = 'loading';
		summary = null;
		errorCopy = null;
		errorReason = null;
		try {
			const res = await fetch('/api/protect-hub/discover', { method: 'POST' });
			const body = (await res.json()) as {
				ok?: boolean;
				reason?: string;
				error?: string;
				insertedCams?: number;
				updatedCams?: number;
				insertedChannels?: number;
			};
			if (res.ok && body.ok) {
				summary = {
					insertedCams: body.insertedCams ?? 0,
					updatedCams: body.updatedCams ?? 0,
					insertedChannels: body.insertedChannels ?? 0
				};
				phase = 'success';
			} else {
				errorReason = body.reason ?? null;
				if (body.reason === 'controller_unreachable') {
					errorCopy = 'UniFi Controller nicht erreichbar. Bitte Netzwerkverbindung prüfen.';
				} else if (body.reason === 'auth_failed') {
					errorCopy = 'Anmeldung bei UniFi Protect fehlgeschlagen.';
				} else {
					errorCopy = body.error || 'Konnte Kameras nicht laden.';
				}
				phase = 'error';
			}
		} catch (err) {
			errorCopy = err instanceof Error ? err.message : 'Netzwerkfehler';
			phase = 'error';
		}
	}

	async function advance() {
		if (advancing) return;
		advancing = true;
		try {
			await fetch('/api/protect-hub/wizard/3', { method: 'POST' });
			onComplete();
		} finally {
			advancing = false;
		}
	}
</script>

<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
	<h2 class="text-base font-semibold text-text-primary">Schritt 3: Kameras aus Protect laden</h2>
	<p class="text-sm text-text-secondary">
		Wir holen jetzt die Liste deiner Protect-Kameras und ihre Stream-Qualitäten.
	</p>

	{#if phase === 'loading'}
		<div class="flex items-center gap-3 text-text-secondary py-4">
			<Loader2 class="w-5 h-5 animate-spin text-accent" />
			<span class="text-sm">Kameras werden gelesen…</span>
		</div>
	{:else if phase === 'success' && summary}
		<div class="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-start gap-3">
			<CheckCircle2 class="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
			<div>
				<span class="text-sm font-medium text-green-400">
					{summary.insertedCams + summary.updatedCams} Kameras erfasst — {summary.insertedCams} neu,
					{summary.updatedCams} aktualisiert.
				</span>
				<p class="text-xs text-text-secondary mt-1">
					{summary.insertedChannels} Stream-Qualitäten katalogisiert.
				</p>
			</div>
		</div>
		<div class="flex justify-end">
			<button
				type="button"
				onclick={advance}
				disabled={advancing}
				class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
					hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50"
			>
				{#if advancing}
					<Loader2 class="w-4 h-4 animate-spin" />
				{/if}
				Auswahl übernehmen
			</button>
		</div>
	{:else if phase === 'error'}
		<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-2">
				<XCircle class="w-5 h-5 text-red-400 shrink-0" />
				<span class="text-sm font-medium text-red-400">{errorCopy}</span>
			</div>
			{#if errorReason === 'controller_unreachable' || errorReason === 'auth_failed'}
				<p class="text-xs text-text-secondary">
					Konnte Kameras nicht laden: {errorReason}
				</p>
			{/if}
			<button
				type="button"
				onclick={fetchDiscover}
				class="inline-flex items-center gap-2 px-3 py-1.5 border border-border text-text-secondary
					rounded-lg hover:text-text-primary hover:bg-bg-input transition-colors text-sm cursor-pointer"
			>
				Erneut versuchen
			</button>
		</div>
	{/if}
</div>
