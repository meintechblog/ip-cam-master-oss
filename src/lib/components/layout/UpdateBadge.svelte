<script lang="ts">
	import { Bell } from 'lucide-svelte';

	type StatusShape = {
		hasUpdate: boolean;
		current: { isDev: boolean; isDirty: boolean };
		latestSha: string | null;
	};

	let status = $state<StatusShape | null>(null);

	async function load() {
		try {
			const res = await fetch('/api/update/status');
			if (res.ok) status = (await res.json()) as StatusShape;
		} catch {
			// silent — badge just won't show
		}
	}

	$effect(() => {
		load();
		const id = setInterval(load, 5 * 60_000);
		return () => clearInterval(id);
	});

	let showBadge = $derived(status !== null && status.hasUpdate === true);
</script>

{#if showBadge}
	<a
		href="/settings"
		title="Update verfügbar"
		class="relative inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors"
		aria-label="Update verfügbar"
	>
		<Bell class="w-5 h-5" />
		<span
			class="absolute top-1 right-1 w-2 h-2 rounded-full bg-green-500 ring-2 ring-bg-secondary"
		></span>
	</a>
{/if}
