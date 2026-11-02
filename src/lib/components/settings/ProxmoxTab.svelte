<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Loader2 } from 'lucide-svelte';
	import type { ProxmoxSettings } from '$lib/types';

	let { initialValues = {} }: { initialValues: Partial<ProxmoxSettings> } = $props();

	let proxmox_host = $state(initialValues.proxmox_host ?? '');
	let proxmox_token_id = $state(initialValues.proxmox_token_id ?? '');
	let proxmox_token_secret = $state(initialValues.proxmox_token_secret ?? '');
	let proxmox_storage = $state(initialValues.proxmox_storage ?? 'local-lvm');
	let proxmox_bridge = $state(initialValues.proxmox_bridge ?? 'vmbr0');

	let saving = $state(false);
	let feedback = $state<{ type: 'success' | 'error'; message: string } | null>(null);

	// Dropdown options from Proxmox
	let bridges = $state<{ name: string; comment: string }[]>([]);
	let storages = $state<{ name: string; type: string; totalGB: number; availGB: number }[]>([]);
	let optionsLoading = $state(false);
	let optionsLoaded = $state(false);

	async function loadOptions() {
		optionsLoading = true;
		try {
			const res = await fetch('/api/proxmox/options');
			if (res.ok) {
				const data = await res.json();
				bridges = data.bridges || [];
				storages = data.storages || [];
				optionsLoaded = true;
			}
		} catch { /* ignore */ }
		finally { optionsLoading = false; }
	}

	// Auto-load options when credentials are present
	$effect(() => {
		if (proxmox_host && proxmox_token_id && proxmox_token_secret && !optionsLoaded) {
			loadOptions();
		}
	});

	async function handleSave() {
		saving = true;
		feedback = null;

		try {
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					proxmox_host,
					proxmox_token_id,
					proxmox_token_secret,
					proxmox_storage,
					proxmox_bridge
				})
			});

			const data = await res.json();

			if (data.validation?.valid) {
				feedback = {
					type: 'success',
					message: `Verbindung erfolgreich. Node: ${data.validation.nodeName}`
				};
				// Reload options after successful save
				loadOptions();
			} else if (data.validation?.error) {
				feedback = { type: 'error', message: data.validation.error };
			} else if (data.saved) {
				feedback = { type: 'success', message: 'Einstellungen gespeichert.' };
			}
		} catch (err) {
			feedback = { type: 'error', message: 'Fehler beim Speichern.' };
		} finally {
			saving = false;
		}
	}
</script>

<form onsubmit={handleSave} class="space-y-4 max-w-lg">
	<div>
		<label for="proxmox_host" class="block text-sm font-medium text-text-secondary mb-1">Proxmox Host</label>
		<input
			id="proxmox_host"
			type="text"
			bind:value={proxmox_host}
			placeholder="192.0.2.16"
			class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
		/>
	</div>

	<div>
		<label for="proxmox_token_id" class="block text-sm font-medium text-text-secondary mb-1">API Token ID</label>
		<input
			id="proxmox_token_id"
			type="text"
			bind:value={proxmox_token_id}
			placeholder="user@pve!tokenname"
			class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
		/>
		<p class="text-xs text-text-secondary mt-1">Format: user@realm!tokenname</p>
	</div>

	<div>
		<label for="proxmox_token_secret" class="block text-sm font-medium text-text-secondary mb-1">API Token Secret</label>
		<input
			id="proxmox_token_secret"
			type="password"
			bind:value={proxmox_token_secret}
			placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
			class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
		/>
	</div>

	{#if optionsLoading}
		<div class="flex items-center gap-2 text-text-secondary text-sm py-2">
			<Loader2 class="w-4 h-4 animate-spin" />
			<span>Lade Storage und Netzwerk-Optionen von Proxmox...</span>
		</div>
	{:else if storages.length > 0 || bridges.length > 0}
		<div>
			<label for="proxmox_storage" class="block text-sm font-medium text-text-secondary mb-1">Storage Target</label>
			<select
				id="proxmox_storage"
				bind:value={proxmox_storage}
				class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
			>
				{#each storages as s}
					<option value={s.name}>{s.name} ({s.type}) — {s.availGB} GB frei von {s.totalGB} GB</option>
				{/each}
			</select>
		</div>

		<div>
			<label for="proxmox_bridge" class="block text-sm font-medium text-text-secondary mb-1">Network Bridge</label>
			<select
				id="proxmox_bridge"
				bind:value={proxmox_bridge}
				class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
			>
				{#each bridges as b}
					<option value={b.name}>{b.name}{b.comment ? ` — ${b.comment}` : ''}</option>
				{/each}
			</select>
		</div>
	{:else if !proxmox_host || !proxmox_token_id || !proxmox_token_secret}
		<p class="text-xs text-text-secondary py-2">Storage und Bridge werden nach dem ersten Speichern automatisch geladen.</p>
	{/if}

	{#if feedback}
		<InlineAlert type={feedback.type} message={feedback.message} />
	{/if}

	<button
		type="submit"
		disabled={saving}
		class="bg-accent hover:bg-accent/90 text-white font-medium px-4 py-2 rounded-md text-sm disabled:opacity-50 transition-colors"
	>
		{saving ? 'Speichern...' : 'Speichern'}
	</button>
</form>
