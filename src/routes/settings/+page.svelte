<script lang="ts">
	import ProxmoxTab from '$lib/components/settings/ProxmoxTab.svelte';
	import UnifiTab from '$lib/components/settings/UnifiTab.svelte';
	import ProtectHubTab from '$lib/components/settings/ProtectHubTab.svelte';
	import CredentialsTab from '$lib/components/settings/CredentialsTab.svelte';
	import BackupTab from '$lib/components/settings/BackupTab.svelte';
	import VersionTab from '$lib/components/settings/VersionTab.svelte';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	const tabs = ['Proxmox', 'UniFi', 'Protect Hub', 'Credentials', 'Backup', 'Version', 'Zugangsschutz'] as const;
	let activeTab = $state<(typeof tabs)[number]>('Proxmox');

	function switchTab(tab: string) {
		// Type-narrow at call site — only valid tabs are accepted by activeTab.
		if ((tabs as readonly string[]).includes(tab)) {
			activeTab = tab as (typeof tabs)[number];
		}
	}

	let confirmDelete = $state(false);
</script>

<h1 class="text-2xl font-bold text-text-primary mb-6">Settings</h1>

<div class="border-b border-border mb-6">
	<div class="flex gap-0" role="tablist">
		{#each tabs as tab}
			<button
				role="tab"
				aria-selected={activeTab === tab}
				class="px-4 py-2 text-sm font-medium transition-colors border-b-2
					{activeTab === tab
					? 'border-accent text-text-primary'
					: 'border-transparent text-text-secondary hover:text-text-primary'}"
				onclick={() => (activeTab = tab)}
			>
				{tab}
			</button>
		{/each}
	</div>
</div>

<div>
	{#if activeTab === 'Proxmox'}
		<ProxmoxTab initialValues={data.proxmox} />
	{:else if activeTab === 'UniFi'}
		<UnifiTab initialValues={data.unifi} udmSshKeyPath={data.udmSshKeyPath} udmSshPassword={data.udmSshPassword} />
	{:else if activeTab === 'Protect Hub'}
		<ProtectHubTab hub={data.protectHub} hubState={data.hubState} {switchTab} />
	{:else if activeTab === 'Credentials'}
		<CredentialsTab />
	{:else if activeTab === 'Backup'}
		<BackupTab />
	{:else if activeTab === 'Version'}
		<VersionTab />
	{:else if activeTab === 'Zugangsschutz'}
		<div class="max-w-lg space-y-6">
			{#if form?.authSuccess}
				<div class="bg-green-500/10 border border-green-500/30 text-green-400 px-4 py-3 rounded">
					{form.authSuccess}
				</div>
			{/if}
			{#if form?.authError}
				<div class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded">
					{form.authError}
				</div>
			{/if}

			{#if data.hasUser}
				<div class="bg-bg-card rounded-lg border border-border p-6">
					<h2 class="text-lg font-semibold text-text-primary mb-4">Benutzer</h2>
					<div class="mb-4">
						<label class="block text-sm font-medium text-text-secondary mb-1">Benutzername</label>
						<input
							type="text"
							value={data.authUsername ?? ''}
							readonly
							class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-secondary"
						/>
					</div>
				</div>

				<div class="bg-bg-card rounded-lg border border-border p-6">
					<h2 class="text-lg font-semibold text-text-primary mb-4">Passwort ändern</h2>
					<form method="POST" action="?/changePassword" use:enhance class="space-y-4">
						<div>
							<label for="currentPassword" class="block text-sm font-medium text-text-secondary mb-1">
								Aktuelles Passwort
							</label>
							<input
								type="password"
								id="currentPassword"
								name="currentPassword"
								required
								class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary
									focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
							/>
						</div>
						<div>
							<label for="newPassword" class="block text-sm font-medium text-text-secondary mb-1">
								Neues Passwort
							</label>
							<input
								type="password"
								id="newPassword"
								name="newPassword"
								required
								minlength="6"
								class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary
									focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
							/>
						</div>
						<button
							type="submit"
							class="px-4 py-2 bg-accent text-white rounded font-medium
								hover:bg-accent/90 transition-colors"
						>
							Passwort ändern
						</button>
					</form>
				</div>

				<div class="bg-bg-card rounded-lg border border-border p-6">
					<h2 class="text-lg font-semibold text-text-primary mb-4">Zugangsschutz entfernen</h2>
					<p class="text-sm text-text-secondary mb-4">
						Entfernt den Benutzer und leitet zur Einrichtungsseite weiter.
					</p>
					{#if confirmDelete}
						<form method="POST" action="?/deleteAuth" use:enhance>
							<div class="flex gap-2">
								<button
									type="submit"
									class="px-4 py-2 bg-red-600 text-white rounded font-medium
										hover:bg-red-700 transition-colors"
								>
									Wirklich entfernen
								</button>
								<button
									type="button"
									onclick={() => (confirmDelete = false)}
									class="px-4 py-2 border border-border text-text-secondary rounded
										hover:text-text-primary transition-colors"
								>
									Abbrechen
								</button>
							</div>
						</form>
					{:else}
						<button
							type="button"
							onclick={() => (confirmDelete = true)}
							class="px-4 py-2 border border-red-500/50 text-red-400 rounded font-medium
								hover:bg-red-500/10 transition-colors"
						>
							Zugangsschutz entfernen
						</button>
					{/if}
				</div>
			{:else}
				<div class="bg-bg-card rounded-lg border border-border p-6">
					<p class="text-text-secondary mb-4">Kein Benutzer eingerichtet.</p>
					<a
						href="/setup"
						class="inline-block px-4 py-2 bg-accent text-white rounded font-medium
							hover:bg-accent/90 transition-colors"
					>
						Zur Einrichtung
					</a>
				</div>
			{/if}

			<div class="bg-bg-card rounded-lg border border-border p-6">
				<h2 class="text-lg font-semibold text-text-primary mb-2">YOLO-Modus</h2>
				<p class="text-sm text-text-secondary mb-4">
					Im YOLO-Modus ist kein Login erforderlich. Die App ist sofort nutzbar.
				</p>
				<form method="POST" action="?/toggleYolo" use:enhance>
					<button
						type="submit"
						class="px-4 py-2 border border-border rounded font-medium text-text-secondary
							hover:bg-bg-primary hover:text-text-primary transition-colors"
					>
						{data.isYolo ? 'YOLO-Modus deaktivieren' : 'YOLO-Modus aktivieren'}
					</button>
				</form>
			</div>
		</div>
	{/if}
</div>
