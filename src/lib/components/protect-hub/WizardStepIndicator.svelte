<script lang="ts">
	// v1.3 Phase 22 Plan 04 — 6-disc step indicator for the Protect Hub onboarding wizard.
	//
	// Replaces the inline 2-step indicator from P20 (`onboarding/+page.svelte:95-118`).
	// Each disc renders as a `<button>` for keyboard accessibility — backward
	// navigation to a completed step calls `onStepClick(n)`; forward navigation is
	// blocked at the disc level (the button is `disabled` when `n > currentStep`
	// or when the step is not in `completedSteps`). UI-SPEC §wizard-step-indicator
	// locks the disc + connector token vocabulary.
	import { CheckCircle2 } from 'lucide-svelte';

	const STEP_LABELS = [
		'Protect-Verbindung',
		'Bridge bereitstellen',
		'Kameras katalogisieren',
		'Kameras auswählen',
		'Erste Synchronisation',
		'Fertig'
	];

	let {
		currentStep,
		completedSteps = [],
		onStepClick
	}: {
		currentStep: number;
		completedSteps?: number[];
		onStepClick?: (n: number) => void;
	} = $props();

	function handleClick(n: number) {
		if (n <= currentStep && completedSteps.includes(n) && onStepClick) {
			onStepClick(n);
		}
	}

	function isCompleted(n: number): boolean {
		return completedSteps.includes(n) && n < currentStep;
	}

	function isCurrent(n: number): boolean {
		return n === currentStep;
	}
</script>

<div class="flex items-center gap-3 mb-8">
	{#each [1, 2, 3, 4, 5, 6] as step (step)}
		<div class="flex items-center gap-2">
			<button
				type="button"
				onclick={() => handleClick(step)}
				disabled={!isCompleted(step) || step > currentStep}
				class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors
					{isCompleted(step)
					? 'bg-green-500/20 text-green-400 border border-green-500/40 cursor-pointer hover:bg-green-500/30'
					: isCurrent(step)
						? 'bg-accent/20 text-accent border border-accent/40'
						: 'bg-bg-input text-text-secondary border border-border cursor-not-allowed'}"
				aria-label={`Schritt ${step}: ${STEP_LABELS[step - 1]}`}
				aria-current={isCurrent(step) ? 'step' : undefined}
			>
				{#if isCompleted(step)}
					<CheckCircle2 class="w-4 h-4" />
				{:else}
					{step}
				{/if}
			</button>
			<span
				class="text-sm hidden lg:inline {isCurrent(step) || isCompleted(step)
					? 'text-text-primary'
					: 'text-text-secondary'}"
			>
				{STEP_LABELS[step - 1]}
			</span>
		</div>
		{#if step < 6}
			<div class="flex-1 h-px {isCompleted(step) ? 'bg-green-500/40' : 'bg-border'}"></div>
		{/if}
	{/each}
</div>
