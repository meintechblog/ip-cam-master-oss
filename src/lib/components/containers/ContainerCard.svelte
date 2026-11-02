<script lang="ts">
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import { Play, Square, RotateCw, Trash2 } from 'lucide-svelte';
	import type { ContainerInfo } from '$lib/types';

	let {
		container,
		onAction
	}: { container: ContainerInfo; onAction: (vmid: number, action: string) => void } = $props();

	function formatMemory(bytes: number): string {
		const mb = bytes / (1024 * 1024);
		if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
		return `${Math.round(mb)} MB`;
	}
</script>

<div class="bg-bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
	<div class="flex items-center justify-between">
		<StatusBadge status={container.status} />
		<span class="text-xs text-text-secondary font-mono">VMID {container.vmid}</span>
	</div>

	<div>
		<h3 class="text-sm font-semibold text-text-primary">
			{container.cameraName || container.hostname}
		</h3>
		{#if container.cameraIp}
			<p class="text-xs text-text-secondary mt-0.5">{container.cameraIp}</p>
		{/if}
	</div>

	{#if container.memory || container.cpu !== undefined}
		<div class="flex gap-4 text-xs text-text-secondary">
			{#if container.cpu !== undefined}
				<span>CPU: {(container.cpu * 100).toFixed(1)}%</span>
			{/if}
			{#if container.memory}
				<span>RAM: {formatMemory(container.memory.used)} / {formatMemory(container.memory.total)}</span>
			{/if}
		</div>
	{/if}

	<div class="flex items-center gap-1 pt-2 border-t border-border">
		<button
			onclick={() => onAction(container.vmid, 'start')}
			class="p-1.5 rounded-md text-success hover:bg-success/20 transition-colors"
			title="Start"
		>
			<Play class="w-4 h-4" />
		</button>
		<button
			onclick={() => onAction(container.vmid, 'stop')}
			class="p-1.5 rounded-md text-warning hover:bg-warning/20 transition-colors"
			title="Stop"
		>
			<Square class="w-4 h-4" />
		</button>
		<button
			onclick={() => onAction(container.vmid, 'restart')}
			class="p-1.5 rounded-md text-accent hover:bg-accent/20 transition-colors"
			title="Restart"
		>
			<RotateCw class="w-4 h-4" />
		</button>
		<div class="flex-1"></div>
		<button
			onclick={() => onAction(container.vmid, 'delete')}
			class="p-1.5 rounded-md text-danger hover:bg-danger/20 transition-colors"
			title="Delete"
		>
			<Trash2 class="w-4 h-4" />
		</button>
	</div>
</div>
