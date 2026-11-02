<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import type { UnifiSettings } from '$lib/types';

	let {
		initialValues = {},
		udmSshKeyPath: initialKeyPath = '/opt/ip-cam-master/data/udm_key',
		udmSshPassword: initialSshPassword = ''
	}: {
		initialValues: Partial<UnifiSettings>;
		udmSshKeyPath?: string;
		udmSshPassword?: string;
	} = $props();

	let unifi_host = $state(initialValues.unifi_host ?? '');
	let unifi_username = $state(initialValues.unifi_username ?? '');
	let unifi_password = $state(initialValues.unifi_password ?? '');

	let saving = $state(false);
	let feedback: { type: 'success' | 'error'; message: string } | null = $state(null);

	// Protect API test
	let protectTesting = $state(false);
	let protectFeedback: { type: 'success' | 'error'; message: string } | null = $state(null);

	// SSH state — prefilled from stored password so the input shows bullets
	// when a password is already saved (same pattern as the UniFi password).
	let udm_ssh_key_path = $state(initialKeyPath);
	let udm_ssh_password = $state(initialSshPassword);
	let sshGenerating = $state(false);
	let sshTesting = $state(false);
	let sshPublicKey = $state('');
	let sshFeedback: { type: 'success' | 'error'; message: string } | null = $state(null);
	let savingKeyPath = $state(false);

	async function handleSave() {
		saving = true;
		feedback = null;

		try {
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					unifi_host,
					unifi_username,
					unifi_password
				})
			});

			const data = await res.json();

			if (data.saved) {
				feedback = { type: 'success', message: 'UniFi-Einstellungen gespeichert.' };
			} else {
				feedback = { type: 'error', message: 'Fehler beim Speichern.' };
			}
		} catch (err) {
			feedback = { type: 'error', message: 'Fehler beim Speichern.' };
		} finally {
			saving = false;
		}
	}

	async function testProtect() {
		protectTesting = true;
		protectFeedback = null;
		try {
			const res = await fetch('/api/settings/unifi-test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: unifi_host, username: unifi_username, password: unifi_password })
			});
			const data = await res.json();
			if (data.success) {
				protectFeedback = { type: 'success', message: `Verbindung erfolgreich — ${data.name || 'UniFi Protect'}` };
			} else {
				protectFeedback = { type: 'error', message: data.error || 'Verbindung fehlgeschlagen' };
			}
		} catch {
			protectFeedback = { type: 'error', message: 'Verbindung fehlgeschlagen' };
		} finally {
			protectTesting = false;
		}
	}

	async function saveKeyPath() {
		savingKeyPath = true;
		try {
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ udm_ssh_key_path })
			});
			const data = await res.json();
			if (!data.saved) {
				sshFeedback = { type: 'error', message: 'Fehler beim Speichern des Key-Pfads.' };
			}
		} catch {
			sshFeedback = { type: 'error', message: 'Fehler beim Speichern des Key-Pfads.' };
		} finally {
			savingKeyPath = false;
		}
	}

	async function generateKey() {
		sshGenerating = true;
		sshFeedback = null;
		sshPublicKey = '';

		// Save key path and SSH password first
		await saveKeyPath();
		if (udm_ssh_password) {
			await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ udm_ssh_password })
			});
		}

		try {
			const res = await fetch('/api/settings/udm-ssh', { method: 'POST' });
			const data = await res.json();

			if (data.success) {
				sshPublicKey = data.deployed ? '' : data.publicKey; // Only show key if manual install needed
				if (data.deployed) {
					sshFeedback = { type: 'success', message: 'SSH-Key generiert und auf dem UDM installiert.' };
				} else if (data.deployError) {
					sshFeedback = { type: 'error', message: `SSH-Key generiert, aber Installation auf UDM fehlgeschlagen: ${data.deployError}. Key manuell in ~/.ssh/authorized_keys eintragen.` };
				} else {
					sshFeedback = { type: 'success', message: 'SSH-Key wurde generiert.' };
				}
			} else {
				sshFeedback = { type: 'error', message: data.error || 'Fehler beim Generieren.' };
			}
		} catch {
			sshFeedback = { type: 'error', message: 'Fehler beim Generieren.' };
		} finally {
			sshGenerating = false;
		}
	}

	async function testConnection() {
		sshTesting = true;
		sshFeedback = null;

		try {
			const res = await fetch('/api/settings/udm-ssh', { method: 'PUT' });
			const data = await res.json();

			if (data.success) {
				sshFeedback = { type: 'success', message: 'SSH-Verbindung erfolgreich' };
			} else {
				sshFeedback = { type: 'error', message: `SSH-Verbindung fehlgeschlagen: ${data.error || 'Unbekannter Fehler'}` };
			}
		} catch {
			sshFeedback = { type: 'error', message: 'SSH-Verbindung fehlgeschlagen' };
		} finally {
			sshTesting = false;
		}
	}
</script>

<p class="text-sm text-text-secondary mb-4">
	Verbindung zur UniFi Protect API auf deinem UDM. Damit kann die App Kamera-Status abfragen und Adoption-Events auslesen.
</p>

<form onsubmit={handleSave} class="space-y-4 max-w-lg">
	<div>
		<label for="unifi_host" class="block text-sm font-medium text-text-secondary mb-1"
			>UDM Host</label
		>
		<input
			id="unifi_host"
			type="text"
			bind:value={unifi_host}
			placeholder="192.0.2.1"
			class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
		/>
	</div>

	<div>
		<label for="unifi_username" class="block text-sm font-medium text-text-secondary mb-1"
			>Username</label
		>
		<input
			id="unifi_username"
			type="text"
			bind:value={unifi_username}
			placeholder="admin"
			class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
		/>
	</div>

	<div>
		<label for="unifi_password" class="block text-sm font-medium text-text-secondary mb-1"
			>Password</label
		>
		<input
			id="unifi_password"
			type="password"
			bind:value={unifi_password}
			placeholder="••••••••"
			class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
		/>
	</div>

	{#if feedback}
		<InlineAlert type={feedback.type} message={feedback.message} />
	{/if}

	<div class="flex gap-3">
		<button
			type="submit"
			disabled={saving}
			class="bg-accent hover:bg-accent/90 text-white font-medium px-4 py-2 rounded-md text-sm disabled:opacity-50 transition-colors"
		>
			{saving ? 'Speichern...' : 'Speichern'}
		</button>
		<button
			type="button"
			onclick={testProtect}
			disabled={protectTesting || !unifi_host}
			class="border border-border text-text-secondary hover:text-text-primary hover:bg-bg-input font-medium px-4 py-2 rounded-md text-sm disabled:opacity-50 transition-colors cursor-pointer"
		>
			{protectTesting ? 'Teste...' : 'Verbindung testen'}
		</button>
	</div>

	{#if protectFeedback}
		<InlineAlert type={protectFeedback.type} message={protectFeedback.message} />
	{/if}
</form>

<!-- SSH Section -->
<div class="mt-8 pt-6 border-t border-border max-w-lg">
	<h3 class="text-lg font-semibold text-text-primary mb-4">SSH-Zugang zum UDM</h3>

	<p class="text-sm text-text-secondary mb-4">
		SSH-Zugriff auf den UDM wird für Log-Auswertung und Kamera-Status benötigt. Der UDM akzeptiert SSH nur als <code class="text-text-primary">root</code>.
	</p>

	<div class="space-y-4">
		<div>
			<label for="udm_ssh_password" class="block text-sm font-medium text-text-secondary mb-1"
				>Root-Passwort</label
			>
			<input
				id="udm_ssh_password"
				type="password"
				bind:value={udm_ssh_password}
				placeholder="UDM Root-Passwort"
				class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
			/>
			<p class="text-xs text-text-secondary mt-1">Wird einmalig benötigt, um den SSH-Key auf dem UDM zu installieren.</p>
		</div>

		<div>
			<label for="udm_ssh_key_path" class="block text-sm font-medium text-text-secondary mb-1"
				>SSH-Key Pfad</label
			>
			<input
				id="udm_ssh_key_path"
				type="text"
				bind:value={udm_ssh_key_path}
				placeholder="/opt/ip-cam-master/data/udm_key"
				class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
			/>
		</div>

		<div class="flex gap-3">
			<button
				type="button"
				onclick={generateKey}
				disabled={sshGenerating}
				class="bg-accent hover:bg-accent/90 text-white font-medium px-4 py-2 rounded-md text-sm disabled:opacity-50 transition-colors cursor-pointer"
			>
				{sshGenerating ? 'Generieren...' : 'Key generieren & installieren'}
			</button>

			<button
				type="button"
				onclick={testConnection}
				disabled={sshTesting}
				class="border border-border text-text-secondary hover:text-text-primary hover:bg-bg-input font-medium px-4 py-2 rounded-md text-sm disabled:opacity-50 transition-colors cursor-pointer"
			>
				{sshTesting ? 'Teste...' : 'Verbindung testen'}
			</button>
		</div>

		{#if sshFeedback}
			<InlineAlert type={sshFeedback.type} message={sshFeedback.message} />
		{/if}

		{#if sshPublicKey}
			<div class="space-y-2">
				<label class="block text-sm font-medium text-text-secondary">
					Öffentlicher Schlüssel (auf dem UDM in ~/.ssh/authorized_keys eintragen)
				</label>
				<textarea
					readonly
					value={sshPublicKey}
					rows="3"
					class="w-full bg-bg-input border border-border text-text-primary rounded-md px-3 py-2 text-xs font-mono focus:outline-none select-all"
					onclick={(e) => { const t = e.currentTarget; t.select(); }}
				></textarea>
			</div>
		{/if}
	</div>
</div>
