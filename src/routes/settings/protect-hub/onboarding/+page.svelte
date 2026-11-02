<script lang="ts">
	// v1.3 Phase 22 Plan 04 — Onboarding wizard host page (6 steps).
	//
	// Refactor of the P20 host (which only had Steps 1 + 2 inline). P22 adds:
	//   - WizardStepIndicator (6 discs, backward-clickable)
	//   - WizardResumeBanner (renders ABOVE the step container on in_progress pointer)
	//   - Step3..6 child components (Plan 04 Tasks 2-3)
	//
	// Steps 1 + 2 are kept inline verbatim from P20 — no behavioural change to the
	// already-shipped flows (verifyProtect + provisionBridge). The Step 2 success
	// CTA now advances to Step 3 instead of returning to /settings.
	//
	// currentStep derivation (HUB-WIZ-09 resumability):
	//   - pointer.status='in_progress'  → pointer.step + 1 (clamped to 6)
	//   - pointer.status='completed'    → 6 (banner won't render; loader redirects)
	//   - no pointer, no bridge          → 1
	//   - no pointer, bridge not running → 2
	//   - no pointer, bridge running     → 3 (post-P20 first-time entry)
	//
	// Critical resumability invariant (Pitfall — was a regression in earlier P22 drafts):
	//   - jumpToStep (explicit backward indicator click): POST /wizard/[n-1] to
	//     overwrite the pointer. This IS an explicit user-driven retreat.
	//   - continuePointer (banner Continue): invalidateAll() ONLY. Server pointer
	//     is the source of truth; rewriting it on Continue regresses the step.
	import { CheckCircle2, XCircle, Loader2, Shield, ArrowLeft, Server } from 'lucide-svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import WizardStepIndicator from '$lib/components/protect-hub/WizardStepIndicator.svelte';
	import WizardResumeBanner from '$lib/components/protect-hub/WizardResumeBanner.svelte';
	import Step3 from './_components/Step3.svelte';
	import Step4 from './_components/Step4.svelte';
	import Step5 from './_components/Step5.svelte';
	import Step6 from './_components/Step6.svelte';

	let { data } = $props();

	// Step 1 inline state (from P20 — preserved verbatim).
	let checking = $state(false);
	let checkOk = $state(false);
	let checkError = $state<string | null>(null);
	let checkReason = $state<string | null>(null);

	// Step 2 inline state (from P20 — preserved verbatim).
	let provisioning = $state(false);
	let provisionOk = $state(false);
	let provisionError = $state<string | null>(null);
	let bridgeIp = $state<string | null>(null);

	// Local override so the user can advance past steps client-side after the
	// step component fires onComplete(). The server pointer is the source of
	// truth on cold-load; the client-side advance is cleared via invalidateAll().
	let localStep = $state<number | null>(null);

	const currentStep = $derived(localStep ?? deriveCurrentStep(data));
	const completedSteps = $derived(deriveCompletedSteps(data, currentStep));

	function deriveCurrentStep(d: typeof data): number {
		if (d.pointer && d.pointer.status === 'in_progress') {
			const next = d.pointer.step + 1;
			return next > 6 ? 6 : next;
		}
		if (d.pointer && d.pointer.status === 'completed') return 6;
		if (!d.bridge) return 1;
		if (d.bridge.status !== 'running') return 2;
		return 3; // bridge running, no pointer — post-P20 first-time entry
	}

	function deriveCompletedSteps(d: typeof data, current: number): number[] {
		const steps: number[] = [];
		if (d.credsConfigured || (d.pointer && d.pointer.step >= 1)) steps.push(1);
		if (d.bridge?.status === 'running' || (d.pointer && d.pointer.step >= 2)) steps.push(2);
		if (d.pointer && d.pointer.step >= 3) steps.push(3);
		if (d.pointer && d.pointer.step >= 4) steps.push(4);
		if (d.pointer && d.pointer.step >= 5) steps.push(5);
		if (d.pointer && d.pointer.status === 'completed') steps.push(6);
		// Local-advance reflection: if we've moved past a step client-side, mark complete.
		for (let i = 1; i < current; i += 1) {
			if (!steps.includes(i)) steps.push(i);
		}
		return steps.sort((a, b) => a - b);
	}

	// Explicit backward navigation: rewrite the pointer to (n-1) so that
	// on next derive (next pointer load), currentStep = (n-1) + 1 = n.
	async function jumpToStep(n: number) {
		const target = Math.max(1, n - 1);
		await fetch(`/api/protect-hub/wizard/${target}`, { method: 'POST' });
		localStep = null;
		await invalidateAll();
	}

	// Banner Continue: pointer already correct on the server; no rewrite — only
	// invalidateAll() so the loader re-reads the existing pointer. Critical:
	// rewriting the pointer on Continue regresses the step (Plan 04 Pitfall fix).
	async function continuePointer() {
		localStep = null;
		await invalidateAll();
	}

	async function resetWizard() {
		await fetch('/api/protect-hub/wizard/reset', { method: 'POST' });
		// Reset all local state too — back to a clean Step 1 entry.
		localStep = null;
		checkOk = false;
		checkError = null;
		checkReason = null;
		provisionOk = false;
		provisionError = null;
		bridgeIp = null;
		await invalidateAll();
	}

	// Each Step component calls onComplete after it has POSTed /wizard/[n] itself.
	// We just nudge to the next step locally + invalidate the loader so server
	// state matches.
	async function advanceLocal(next: number) {
		localStep = next;
		await invalidateAll();
	}

	// Auto-check Protect connection on mount if creds are configured (P20 verbatim).
	$effect(() => {
		if (currentStep === 1 && data.credsConfigured && !checkOk && !checking && !checkError) {
			void verifyProtect();
		}
	});

	async function verifyProtect() {
		checking = true;
		checkOk = false;
		checkError = null;
		checkReason = null;
		try {
			const res = await fetch('/api/protect-hub/discover', { method: 'POST' });
			const body = await res.json();
			if (res.ok && body.ok) {
				checkOk = true;
			} else {
				checkReason = body.reason ?? null;
				if (body.reason === 'auth_failed') {
					checkError = 'Anmeldung bei UniFi Protect fehlgeschlagen. Bitte Zugangsdaten prüfen.';
				} else if (body.reason === 'controller_unreachable') {
					checkError = 'UniFi Controller nicht erreichbar. Bitte Netzwerkverbindung prüfen.';
				} else {
					checkError = body.error || 'Verbindung fehlgeschlagen';
				}
			}
		} catch (err) {
			checkError = err instanceof Error ? err.message : 'Netzwerkfehler';
		} finally {
			checking = false;
		}
	}

	async function provisionBridge() {
		provisioning = true;
		provisionOk = false;
		provisionError = null;
		bridgeIp = null;
		try {
			const res = await fetch('/api/protect-hub/bridge/provision', { method: 'POST' });
			const body = await res.json();
			if (res.ok && body.ok) {
				provisionOk = true;
				bridgeIp = body.bridge?.containerIp ?? null;
				// Advance the wizard pointer so STEP_COMPLETED for step 2 is recorded.
				await fetch('/api/protect-hub/wizard/2', { method: 'POST' });
			} else {
				provisionError = body.error || 'Bereitstellung fehlgeschlagen';
			}
		} catch (err) {
			provisionError = err instanceof Error ? err.message : 'Netzwerkfehler';
		} finally {
			provisioning = false;
		}
	}

	async function step1Continue() {
		// Record STEP_COMPLETED for Step 1.
		await fetch('/api/protect-hub/wizard/1', { method: 'POST' });
		localStep = 2;
		await invalidateAll();
	}

	async function step2Continue() {
		// Bridge is running; pointer already at step 2; advance to Step 3.
		localStep = 3;
		await invalidateAll();
	}
</script>

<div class="max-w-2xl">
	<!-- Breadcrumb -->
	<a
		href="/settings"
		class="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 mb-6"
	>
		<ArrowLeft class="w-4 h-4" />
		Zurück zu Einstellungen
	</a>

	<h1 class="text-2xl font-bold text-text-primary mb-2">Protect Hub — Bridge einrichten</h1>
	<p class="text-sm text-text-secondary mb-8">
		Der Bridge-Container stellt go2rtc für alle Hub-Streams bereit.
	</p>

	<WizardStepIndicator {currentStep} {completedSteps} onStepClick={jumpToStep} />
	<WizardResumeBanner pointer={data.pointer} onContinue={continuePointer} onReset={resetWizard} />

	<!-- Step 1: Protect connection check (P20 inline — preserved verbatim) -->
	{#if currentStep === 1}
		<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
			<h2 class="text-lg font-semibold text-text-primary">Schritt 1: Protect-Verbindung prüfen</h2>

			{#if !data.credsConfigured}
				<!-- No creds configured -->
				<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 space-y-3">
					<div class="flex items-center gap-2">
						<XCircle class="w-5 h-5 text-yellow-400" />
						<span class="text-sm font-medium text-yellow-400"
							>Keine UniFi-Zugangsdaten konfiguriert</span
						>
					</div>
					<p class="text-sm text-text-secondary">
						Konfiguriere zuerst die UniFi-Verbindung in den Einstellungen.
					</p>
					<button
						onclick={() => goto('/settings')}
						class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
							hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer"
					>
						Zur UniFi-Konfiguration
					</button>
				</div>
			{:else if checking}
				<!-- Checking -->
				<div class="flex items-center gap-3 text-text-secondary py-4">
					<Loader2 class="w-5 h-5 animate-spin text-accent" />
					<span class="text-sm">Verbindung wird geprüft...</span>
				</div>
			{:else if checkOk}
				<!-- Success -->
				<div class="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center gap-3">
					<CheckCircle2 class="w-5 h-5 text-green-400 shrink-0" />
					<div>
						<span class="text-sm font-medium text-green-400">Protect-Verbindung erfolgreich</span>
						<p class="text-xs text-text-secondary mt-0.5">Kamerakatalog wurde aktualisiert.</p>
					</div>
				</div>
				<button
					onclick={step1Continue}
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
						hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer"
				>
					Weiter
				</button>
			{:else if checkError}
				<!-- Error -->
				<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
					<div class="flex items-center gap-2">
						<XCircle class="w-5 h-5 text-red-400 shrink-0" />
						<span class="text-sm font-medium text-red-400">{checkError}</span>
					</div>
					{#if checkReason === 'auth_failed'}
						<button
							onclick={() => goto('/settings')}
							class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
								hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer"
						>
							Zur UniFi-Konfiguration
						</button>
					{/if}
					<button
						onclick={verifyProtect}
						class="inline-flex items-center gap-2 px-3 py-1.5 border border-border text-text-secondary
							rounded-lg hover:text-text-primary hover:bg-bg-input transition-colors text-sm cursor-pointer"
					>
						Erneut prüfen
					</button>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Step 2: Bridge provisioning (P20 inline — preserved verbatim, terminate-CTA changed) -->
	{#if currentStep === 2}
		<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
			<h2 class="text-lg font-semibold text-text-primary">
				Schritt 2: Bridge-Container bereitstellen
			</h2>

			<!-- LAN-trust info panel (HUB-WIZ-04 / success criterion 8) -->
			<div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 flex items-start gap-3">
				<Shield class="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
				<div>
					<p class="text-sm text-blue-300">
						Bridge-Endpunkte sind absichtlich nicht authentifiziert. Stellen Sie sicher, dass der
						LXC-Container in einem vertrauenswürdigen LAN-Segment läuft.
					</p>
					<p class="text-xs text-text-secondary mt-1">
						Empfehlung: DHCP-Reservierung für eine stabile Bridge-IP.
					</p>
				</div>
			</div>

			{#if provisionOk}
				<!-- Success — advance to Step 3 instead of redirect-to-/settings (P22 change) -->
				<div class="bg-green-500/10 border border-green-500/30 rounded-lg p-4 space-y-3">
					<div class="flex items-center gap-3">
						<CheckCircle2 class="w-5 h-5 text-green-400 shrink-0" />
						<span class="text-sm font-medium text-green-400"
							>Bridge-Container erfolgreich bereitgestellt</span
						>
					</div>
					{#if bridgeIp}
						<div class="flex items-center gap-2 px-3 py-2 rounded bg-bg-input border border-border">
							<Server class="w-4 h-4 text-text-secondary" />
							<span class="text-sm text-text-secondary">Bridge-IP:</span>
							<span class="text-sm font-mono text-text-primary">{bridgeIp}</span>
						</div>
					{/if}
				</div>
				<button
					onclick={step2Continue}
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
						hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer"
				>
					Weiter zu Schritt 3
				</button>
			{:else if provisioning}
				<!-- Provisioning spinner -->
				<div class="flex items-center gap-3 py-4">
					<Loader2 class="w-5 h-5 animate-spin text-accent" />
					<div>
						<span class="text-sm text-text-primary">Bridge wird bereitgestellt...</span>
						<p class="text-xs text-text-secondary mt-0.5">
							Dies kann beim ersten Mal einige Minuten dauern.
						</p>
					</div>
				</div>
			{:else if provisionError}
				<!-- Error -->
				<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-3">
					<div class="flex items-center gap-2">
						<XCircle class="w-5 h-5 text-red-400 shrink-0" />
						<span class="text-sm font-medium text-red-400">{provisionError}</span>
					</div>
				</div>
				<button
					onclick={provisionBridge}
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
						hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer"
				>
					Erneut versuchen
				</button>
			{:else}
				<!-- Initial state — provision button -->
				<button
					onclick={provisionBridge}
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
						hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer"
				>
					<Server class="w-4 h-4" />
					Bridge bereitstellen
				</button>
			{/if}
		</div>
	{/if}

	<!-- Step 3-6: P22 child components -->
	{#if currentStep === 3}
		<Step3 onComplete={() => advanceLocal(4)} />
	{:else if currentStep === 4}
		<Step4 cams={data.protectCams} onComplete={() => advanceLocal(5)} />
	{:else if currentStep === 5}
		<Step5 onComplete={() => advanceLocal(6)} />
	{:else if currentStep === 6}
		<Step6 />
	{/if}
</div>
