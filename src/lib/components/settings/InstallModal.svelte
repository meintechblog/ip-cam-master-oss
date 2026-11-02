<script lang="ts">
	import { AlertTriangle, X } from 'lucide-svelte';

	export type Conflict = {
		kind: string;
		detail: string;
	};

	export type PreflightShape = {
		current: { sha: string; shaShort: string; isDev: boolean; isDirty: boolean };
		target: { sha: string | null; shaShort: string | null; message: string | null; date: string | null };
		hasUpdate: boolean;
		dirtyFiles: string[];
		conflicts: Conflict[];
	};

	type Props = {
		preflight: PreflightShape;
		onConfirm: (overrideConflicts: boolean) => void;
		onClose: () => void;
	};

	const { preflight, onConfirm, onClose }: Props = $props();

	const hasConflicts = $derived(preflight.conflicts.length > 0);

	function handleKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
	}

	$effect(() => {
		document.addEventListener('keydown', handleKey);
		return () => document.removeEventListener('keydown', handleKey);
	});
</script>

<div
	class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
	onclick={onClose}
	role="presentation"
>
	<div
		class="bg-bg-card border border-border rounded-lg p-6 max-w-lg w-full mx-4 space-y-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="install-modal-title"
		onclick={(e) => e.stopPropagation()}
	>
		<div class="flex items-start justify-between">
			<h2 id="install-modal-title" class="text-lg font-semibold text-text-primary">
				Update jetzt installieren?
			</h2>
			<button
				type="button"
				onclick={onClose}
				class="text-text-secondary hover:text-text-primary"
				aria-label="Schließen"
			>
				<X class="w-5 h-5" />
			</button>
		</div>

		<div class="text-sm space-y-2">
			<div class="flex items-baseline gap-2">
				<span class="text-text-secondary">Aktuelle Version:</span>
				<span class="font-mono text-text-primary">{preflight.current.shaShort}</span>
			</div>
			<div class="flex items-baseline gap-2">
				<span class="text-text-secondary">Ziel-Version:</span>
				<span class="font-mono text-text-primary"
					>{preflight.target.shaShort ?? '–'}</span
				>
			</div>
			{#if preflight.target.message}
				<div class="text-text-secondary italic">"{preflight.target.message}"</div>
			{/if}
			{#if preflight.target.date}
				<div class="text-xs text-text-secondary">vom {preflight.target.date}</div>
			{/if}
		</div>

		{#if hasConflicts}
			<div
				class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded text-sm flex items-start gap-2"
			>
				<AlertTriangle class="w-5 h-5 flex-shrink-0 mt-0.5" />
				<div class="space-y-1">
					<div class="font-semibold">Aktive Vorgänge erkannt:</div>
					<ul class="list-disc pl-4 space-y-0.5">
						{#each preflight.conflicts as c}
							<li>{c.detail}</li>
						{/each}
					</ul>
					<div class="pt-1">Diese werden vom Update unterbrochen.</div>
				</div>
			</div>
		{/if}

		{#if preflight.dirtyFiles.length > 0}
			<div
				class="bg-orange-500/10 border border-orange-500/30 text-orange-400 px-4 py-3 rounded text-xs"
			>
				<div class="font-semibold mb-1">Lokale Änderungen blockieren das Update:</div>
				<ul class="list-disc pl-4">
					{#each preflight.dirtyFiles.slice(0, 5) as f}
						<li class="font-mono">{f}</li>
					{/each}
					{#if preflight.dirtyFiles.length > 5}
						<li>… und {preflight.dirtyFiles.length - 5} weitere</li>
					{/if}
				</ul>
			</div>
		{/if}

		<div class="flex justify-end gap-3 pt-2">
			<button
				type="button"
				onclick={onClose}
				class="px-4 py-2 bg-bg-input text-text-primary rounded font-medium hover:bg-bg-input/80 transition-colors"
			>
				Abbrechen
			</button>
			<button
				type="button"
				onclick={() => onConfirm(hasConflicts)}
				disabled={preflight.current.isDev || preflight.current.isDirty}
				class="px-4 py-2 bg-accent text-white rounded font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{hasConflicts ? 'Trotzdem installieren' : 'Installieren'}
			</button>
		</div>
	</div>
</div>
