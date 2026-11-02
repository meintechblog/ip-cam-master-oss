<script lang="ts">
	// v1.3 Phase 22 Plan 04 — Resume banner for the Protect Hub onboarding wizard.
	//
	// Renders ABOVE the step container when `hub_onboarding_state` has an
	// in-progress pointer. Provides Continue (calls `onContinue()` — the host
	// page implementation MUST only `invalidateAll()`, never POST a pointer
	// rewrite) and Reset (calls `onReset()` — host page POSTs /wizard/reset).
	// UI-SPEC §resume-banner locks the visual + copy contract.
	//
	// The Continue-vs-pointer-rewrite distinction is critical: the previous bug
	// was that Continue POSTed `/wizard/[pointer.step - 1]` which regressed the
	// pointer one step. By contrast, an explicit backward click on the step
	// indicator IS supposed to rewrite the pointer (it's an explicit user-driven
	// step retreat). Continue just lets the user keep going from where they were.
	import { RotateCcw } from 'lucide-svelte';

	type WizardPointer = {
		step: number;
		status: string;
		lastActivityAt: string;
		error: string | null;
	} | null;

	let {
		pointer,
		onContinue,
		onReset
	}: {
		pointer: WizardPointer;
		onContinue: () => void;
		onReset: () => void;
	} = $props();

	function relativeDe(iso: string): string {
		const ms = Date.now() - new Date(iso).getTime();
		const fmt = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });
		const minutes = Math.round(ms / 60000);
		if (Math.abs(minutes) < 60) return fmt.format(-minutes, 'minute');
		const hours = Math.round(minutes / 60);
		if (Math.abs(hours) < 24) return fmt.format(-hours, 'hour');
		const days = Math.round(hours / 24);
		return fmt.format(-days, 'day');
	}
</script>

{#if pointer && pointer.status === 'in_progress'}
	<div
		class="bg-bg-card border-l-4 border-l-accent rounded-lg p-4 mb-6 flex items-center gap-4"
	>
		<RotateCcw class="w-5 h-5 text-accent shrink-0" />
		<div class="flex-1">
			<p class="text-base font-semibold text-text-primary">
				Du warst bei Schritt {pointer.step} — weiter?
			</p>
			<p class="text-sm text-text-secondary">
				Letzte Aktivität: {relativeDe(pointer.lastActivityAt)}.
			</p>
		</div>
		<div class="flex items-center gap-3">
			<button
				type="button"
				onclick={onContinue}
				class="bg-accent text-white px-4 py-2 rounded-lg text-sm hover:bg-accent/90 cursor-pointer"
			>
				Weiter zu Schritt {pointer.step}
			</button>
			<button
				type="button"
				onclick={onReset}
				class="text-sm text-text-secondary hover:text-danger cursor-pointer"
			>
				Zurücksetzen
			</button>
		</div>
	</div>
{/if}
