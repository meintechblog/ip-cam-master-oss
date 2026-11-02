<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import Banner from '$lib/components/ui/Banner.svelte';
	import { page } from '$app/stores';
	import { isStandalonePage } from '$lib/config/routes';

	let { data, children } = $props();

	let isStandalone = $derived(isStandalonePage($page.url.pathname));
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if isStandalone}
	{@render children()}
{:else}
	<AppShell>
		{#if !data.configured.proxmox}
			<Banner
				message="Proxmox ist nicht konfiguriert."
				linkText="Zu den Einstellungen"
				linkHref="/settings"
			/>
		{/if}
		{@render children()}
	</AppShell>
{/if}
