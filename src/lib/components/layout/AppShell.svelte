<script lang="ts">
	import Sidebar from './Sidebar.svelte';
	import UpdateBadge from './UpdateBadge.svelte';
	import { Menu, X } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
	let menuOpen = $state(false);
</script>

<div class="flex h-screen bg-bg-primary">
	<!-- Desktop sidebar -->
	<div class="hidden md:block">
		<Sidebar onNavigate={() => {}} />
	</div>

	<!-- Mobile overlay -->
	{#if menuOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="fixed inset-0 bg-black/50 z-40 md:hidden" onclick={() => menuOpen = false}></div>
		<div class="fixed inset-y-0 left-0 z-50 md:hidden">
			<Sidebar onNavigate={() => menuOpen = false} />
		</div>
	{/if}

	<div class="flex-1 flex flex-col overflow-hidden">
		<!-- Desktop top bar -->
		<div class="hidden md:flex items-center justify-end px-6 py-2 border-b border-border bg-bg-secondary">
			<UpdateBadge />
		</div>

		<!-- Mobile header -->
		<div class="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary">
			<button onclick={() => menuOpen = !menuOpen} class="text-text-secondary hover:text-text-primary cursor-pointer">
				{#if menuOpen}
					<X class="w-6 h-6" />
				{:else}
					<Menu class="w-6 h-6" />
				{/if}
			</button>
			<span class="text-sm font-bold text-text-primary">IP-Cam-Master</span>
			<div class="ml-auto">
				<UpdateBadge />
			</div>
		</div>

		<main class="flex-1 overflow-auto p-4 md:p-6">
			{@render children()}
		</main>
	</div>
</div>
