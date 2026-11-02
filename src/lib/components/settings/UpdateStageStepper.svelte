<script lang="ts">
	import { Check, X, AlertTriangle, Loader2 } from 'lucide-svelte';

	export type StageName =
		| 'preflight'
		| 'snapshot'
		| 'drain'
		| 'stop'
		| 'fetch'
		| 'install'
		| 'build'
		| 'start'
		| 'verify';

	export type StageState = 'pending' | 'running' | 'done' | 'failed' | 'rolled_back';

	type Props = {
		currentStage: StageName | null;
		statuses: Partial<Record<StageName, StageState>>;
	};

	const { currentStage, statuses }: Props = $props();

	const ORDER: StageName[] = [
		'preflight',
		'snapshot',
		'drain',
		'stop',
		'fetch',
		'install',
		'build',
		'start',
		'verify'
	];

	const LABELS: Record<StageName, string> = {
		preflight: 'Pre-flight',
		snapshot: 'Snapshot',
		drain: 'Drain',
		stop: 'Stop',
		fetch: 'Fetch',
		install: 'Install',
		build: 'Build',
		start: 'Start',
		verify: 'Verify'
	};

	function stateOf(stage: StageName): StageState {
		const explicit = statuses[stage];
		if (explicit) return explicit;
		if (!currentStage) return 'pending';
		const idx = ORDER.indexOf(stage);
		const cur = ORDER.indexOf(currentStage);
		if (idx < cur) return 'done';
		if (idx === cur) return 'running';
		return 'pending';
	}

	function pillClasses(s: StageState): string {
		switch (s) {
			case 'pending':
				return 'bg-bg-input text-text-secondary border-border';
			case 'running':
				return 'bg-blue-500/10 text-blue-400 border-blue-500/30 animate-pulse';
			case 'done':
				return 'bg-green-500/10 text-green-400 border-green-500/30';
			case 'failed':
				return 'bg-red-500/10 text-red-400 border-red-500/30';
			case 'rolled_back':
				return 'bg-orange-500/10 text-orange-400 border-orange-500/30';
		}
	}
</script>

<div class="flex flex-wrap gap-2" aria-label="Update-Pipeline-Status">
	{#each ORDER as stage (stage)}
		{@const s = stateOf(stage)}
		<div
			class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium {pillClasses(
				s
			)}"
			title={`${LABELS[stage]} — ${s}`}
		>
			{#if s === 'running'}
				<Loader2 class="w-3.5 h-3.5 animate-spin" />
			{:else if s === 'done'}
				<Check class="w-3.5 h-3.5" />
			{:else if s === 'failed'}
				<X class="w-3.5 h-3.5" />
			{:else if s === 'rolled_back'}
				<AlertTriangle class="w-3.5 h-3.5" />
			{/if}
			<span>{LABELS[stage]}</span>
		</div>
	{/each}
</div>
