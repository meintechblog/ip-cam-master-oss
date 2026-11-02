<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import CameraDetailCard from '$lib/components/cameras/CameraDetailCard.svelte';
	import ExternalCamCard from '$lib/components/cameras/ExternalCamCard.svelte';
	import type { CameraCardData } from '$lib/types';
	import { Loader2, CheckCircle2, X } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	let { data } = $props();
	let cameras = $state<CameraCardData[]>([]);
	let loading = $state(true);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// v1.3 Phase 22 Plan 03 Task 1 — partition into managed (always) + external
	// (only when data.hubEnabled). Per UI-SPEC §kameras-partition + CONTEXT.md
	// decisions: insertion-order preserved within each section, no search bar,
	// external section completely omitted when hub is disabled.
	//
	// CR-05 fix — `c.source !== 'external'` previously matched
	// 'external_archived' (P21 soft-delete state) and rendered those rows in
	// the managed section with the full LXC/pipeline UI, which is meaningless
	// for archived Protect cams. Use positive matches on both sections so
	// 'external_archived' is excluded from both and surfaces only when
	// P23 ships an archive view.
	//
	// P22-UAT 2026-05-15 amendment 1: filter external section to cams that have
	// at least one ENABLED output. Hub discovery pulls every Protect-managed
	// cam — including Mobotix-via-adoption rows that duplicate this app's own
	// managed LXC cams. Without filter the section also shows ~11 third-party
	// rows with no outputs/no working stream — useless noise.
	//
	// P22-UAT 2026-05-15 amendment 2: when a managed cam was *also* adopted
	// into Protect (matching protectStatus.protectId on both sides), MERGE the
	// external row's Hub data (outputs + catalog + mac) into the managed
	// card's `hubAugment` prop and HIDE the external row from its own section.
	// User feedback: "wenn es eine kamera schon gibt in der liste dann sollen
	// die zusatzinfos da auftauchen" — one physical cam = one card, even when
	// it has both a managed LXC pipeline AND a Protect Hub output.
	let managedCams = $derived(cameras.filter((c) => c.source === 'managed'));

	// External cams with outputs, keyed by protectId for merge into managed
	// cards. Externals without a managed counterpart (pure UniFi UVC cams)
	// render as own cards in the external section.
	const externalByProtectId = $derived.by(() => {
		const map = new Map<string, CameraCardData>();
		for (const c of cameras) {
			if (c.source !== 'external') continue;
			if (!(c.outputs ?? []).some((o) => o.enabled)) continue;
			const pid = c.protectStatus?.protectId;
			if (pid) map.set(pid, c);
		}
		return map;
	});

	// Set of protectIds claimed by a managed cam — used to hide the external
	// duplicate from its section.
	const managedProtectIds = $derived(
		new Set(managedCams.map((c) => c.protectStatus?.protectId).filter((p): p is string => !!p))
	);

	let externalCams = $derived(
		cameras.filter(
			(c) =>
				c.source === 'external' &&
				(c.outputs ?? []).some((o) => o.enabled) &&
				!managedProtectIds.has(c.protectStatus?.protectId ?? '')
		)
	);

	// Helper for the managed render loop — returns the matching external row
	// (with hub data) when available, else null.
	function getHubAugment(managedCam: CameraCardData): CameraCardData | null {
		const pid = managedCam.protectStatus?.protectId;
		if (!pid) return null;
		return externalByProtectId.get(pid) ?? null;
	}

	// v1.3 Phase 22 Plan 03 Task 4 — onboarding=success toast (Pitfall #4).
	// On mount, consume the ?onboarding=success query param ONCE: fetch the
	// stream count from /api/protect-hub/health, render a green dismissable
	// banner under the h1 for ~5 s, then strip the param via replaceState so
	// a refresh doesn't retrigger.
	let showToast = $state(false);
	let toastStreamCount = $state<number | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	let toastConsumed = $state(false);

	async function consumeOnboardingToast() {
		if (toastConsumed) return;
		const v = page.url.searchParams.get('onboarding');
		if (v !== 'success') return;
		toastConsumed = true;
		try {
			const res = await fetch('/api/protect-hub/health');
			const body = await res.json();
			toastStreamCount = body?.streamCount ?? null;
		} catch {
			toastStreamCount = null;
		}
		showToast = true;
		// Strip the param so refresh doesn't retrigger the toast.
		goto(window.location.pathname, { replaceState: true });
		toastTimer = setTimeout(() => {
			showToast = false;
		}, 5000);
	}

	function dismissToast() {
		showToast = false;
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = null;
		}
	}

	async function fetchCameras() {
		try {
			const res = await fetch('/api/cameras/status');
			if (res.ok) {
				cameras = await res.json();
			}
		} catch {
			// silently retry next poll
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		fetchCameras();
		pollTimer = setInterval(fetchCameras, 10000);
		consumeOnboardingToast();
		return () => {
			if (pollTimer) clearInterval(pollTimer);
			if (toastTimer) clearTimeout(toastTimer);
		};
	});
</script>

<div class="flex items-center justify-between mb-6">
	<h1 class="text-2xl font-bold text-text-primary">Kameras</h1>
	{#if data.proxmoxConfigured}
		<a href="/kameras/onboarding" class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors">
			+ Kamera hinzufügen
		</a>
	{:else}
		<span class="inline-flex items-center gap-2 px-4 py-2 bg-bg-input text-text-secondary rounded-lg cursor-not-allowed" title="Proxmox muss zuerst in den Einstellungen konfiguriert werden">
			+ Kamera hinzufügen
		</span>
	{/if}
</div>

{#if showToast}
	<div
		class="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-sm text-success flex items-center gap-3 mb-6"
	>
		<CheckCircle2 class="w-4 h-4 shrink-0" />
		<span class="flex-1">
			Protect Hub aktiv{toastStreamCount !== null
				? ` — ${toastStreamCount} Streams laufen.`
				: '.'}
		</span>
		<button
			type="button"
			onclick={dismissToast}
			class="text-success hover:text-success/80 cursor-pointer"
			aria-label="Schließen"
		>
			<X class="w-4 h-4" />
		</button>
	</div>
{/if}

{#if data.error}
	<div class="mb-4">
		<InlineAlert type="error" message={data.error} />
	</div>
{/if}

{#if loading}
	<div class="flex items-center gap-3 text-text-secondary py-8">
		<Loader2 class="w-5 h-5 animate-spin" />
		<span>Kamerastatus wird geladen...</span>
	</div>
{:else if cameras.length === 0}
	<div class="text-text-secondary text-center py-12">
		<p class="text-lg mb-2">Keine Kameras eingerichtet</p>
		<p class="text-sm">Klicke "+ Kamera hinzufügen" um loszulegen</p>
	</div>
{:else}
	<div class="space-y-12">
		<section>
			<h2 class="text-base font-semibold text-text-primary mb-4">
				Eigene Kameras ({managedCams.length})
			</h2>
			<div class="space-y-4">
				{#each managedCams as camera (camera.id)}
					<CameraDetailCard {camera} hubAugment={getHubAugment(camera)} bridgeIp={data.bridgeIp} />
				{:else}
					<!-- WR-03 fix — when the user has zero managed cams but multiple
					     external cams (hub enabled), the outer cameras.length===0
					     guard does not fire and the section header reads
					     "Eigene Kameras (0)" with an empty card list. Surface a
					     short empty-state caption so the section's intent is
					     unmistakable. -->
					<p class="text-sm text-text-secondary">Keine Kameras eingerichtet.</p>
				{/each}
			</div>
		</section>

		{#if data.hubEnabled}
			<section>
				<h2 class="text-base font-semibold text-text-primary mb-4">
					Aus UniFi Protect ({externalCams.length})
				</h2>
				<div class="space-y-4">
					{#each externalCams as camera (camera.id)}
						<ExternalCamCard {camera} bridgeIp={data.bridgeIp} />
					{:else}
						<!-- WR-05 fix — append "Letzte Synchronisation" timestamp per
						     UI-SPEC line 219. lastDiscoveredAt comes from
						     loadCatalog() in +page.server.ts (MAX(cachedAt) across
						     protect_stream_catalog). Render only when present. -->
						<p class="text-sm text-text-secondary">
							Noch keine Protect-Kameras erkannt.{#if data.lastDiscoveredAt}
								Letzte Synchronisation: {new Date(data.lastDiscoveredAt).toLocaleString('de-DE')}.
							{/if}
						</p>
					{/each}
				</div>
			</section>
		{/if}
	</div>
{/if}
