<script lang="ts">
	import type { ContainerStatus } from '$lib/types';

	let { status }: { status: ContainerStatus } = $props();

	const config: Record<ContainerStatus, { label: string; classes: string }> = {
		running: { label: 'Running', classes: 'text-success bg-success/10' },
		stopped: { label: 'Stopped', classes: 'text-warning bg-warning/10' },
		error: { label: 'Error', classes: 'text-danger bg-danger/10' },
		unknown: { label: 'Unknown', classes: 'text-text-secondary bg-text-secondary/10' }
	};

	const current = $derived(config[status] ?? config.unknown);
</script>

<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium {current.classes}">
	<span class="w-1.5 h-1.5 rounded-full bg-current"></span>
	{current.label}
</span>
