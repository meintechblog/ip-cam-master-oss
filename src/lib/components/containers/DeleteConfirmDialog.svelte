<script lang="ts">
	let {
		open = false,
		containerName = '',
		vmid = 0,
		onConfirm,
		onCancel
	}: {
		open: boolean;
		containerName: string;
		vmid: number;
		onConfirm: () => void;
		onCancel: () => void;
	} = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onCancel();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center"
		role="dialog"
		aria-modal="true"
		onkeydown={handleKeydown}
	>
		<button
			class="absolute inset-0 bg-black/60"
			onclick={onCancel}
			aria-label="Close dialog"
			tabindex="-1"
		></button>

		<div class="relative bg-bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
			<h2 class="text-lg font-semibold text-text-primary mb-2">Container löschen?</h2>
			<p class="text-sm text-text-secondary mb-6">
				Soll Container <strong class="text-text-primary">{containerName}</strong> (VMID {vmid})
				wirklich gelöscht werden? Diese Aktion kann nicht rückgängig gemacht werden.
			</p>

			<div class="flex justify-end gap-3">
				<button
					onclick={onCancel}
					class="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary bg-bg-input border border-border rounded-md transition-colors"
				>
					Abbrechen
				</button>
				<button
					onclick={onConfirm}
					class="px-4 py-2 text-sm font-medium text-white bg-danger hover:bg-danger/90 rounded-md transition-colors"
				>
					Löschen
</button>
			</div>
		</div>
	</div>
{/if}
