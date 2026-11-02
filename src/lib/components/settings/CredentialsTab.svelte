<script lang="ts">
	import InlineAlert from '$lib/components/ui/InlineAlert.svelte';
	import { Trash2, Plus, Loader2 } from 'lucide-svelte';

	type SavedCred =
		| { id: number; name: string; type: 'mobotix'; username: string; passwordMasked: string; priority: number }
		| { id: number; name: string; type: 'bambu'; serialNumber: string; accessCodeMasked: string; priority: number };

	let savedCreds = $state<SavedCred[]>([]);
	let loading = $state(true);

	type NewType = 'mobotix' | 'bambu';
	let newType = $state<NewType>('mobotix');

	// Mobotix/Loxone form
	let newName = $state('');
	let newUsername = $state('');
	let newPassword = $state('');

	// Bambu form
	let newBambuName = $state('');
	let newSerial = $state('');
	let newAccessCode = $state('');

	let saving = $state(false);
	let feedback = $state<{ type: 'success' | 'error'; message: string } | null>(null);

	async function loadCredentials() {
		try {
			const res = await fetch('/api/credentials');
			if (res.ok) savedCreds = (await res.json()) as SavedCred[];
		} catch { /* ignore */ }
		finally { loading = false; }
	}

	$effect(() => { loadCredentials(); });

	async function submitMobotix() {
		if (!newName || !newUsername || !newPassword) {
			feedback = { type: 'error', message: 'Alle Felder erforderlich.' };
			return;
		}
		await postCredential({ name: newName, type: 'mobotix', username: newUsername, password: newPassword }, () => {
			newName = ''; newUsername = ''; newPassword = '';
		});
	}

	async function submitBambu() {
		if (!newBambuName || !newAccessCode) {
			feedback = { type: 'error', message: 'Name und Access Code erforderlich (Seriennummer ist optional).' };
			return;
		}
		if (newAccessCode.length !== 8) {
			feedback = { type: 'error', message: 'Access Code muss 8 Zeichen lang sein.' };
			return;
		}
		await postCredential(
			{ name: newBambuName, type: 'bambu', serialNumber: newSerial.trim() || undefined, accessCode: newAccessCode },
			() => { newBambuName = ''; newSerial = ''; newAccessCode = ''; }
		);
	}

	async function postCredential(body: Record<string, unknown>, resetForm: () => void) {
		saving = true;
		feedback = null;
		try {
			const res = await fetch('/api/credentials', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await res.json();
			if (data.success) {
				feedback = { type: 'success', message: `"${body.name}" gespeichert.` };
				resetForm();
				await loadCredentials();
			} else {
				feedback = { type: 'error', message: data.error || 'Fehler' };
			}
		} catch {
			feedback = { type: 'error', message: 'Fehler beim Speichern.' };
		} finally {
			saving = false;
		}
	}

	async function handleDelete(id: number) {
		try {
			await fetch('/api/credentials', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			await loadCredentials();
		} catch { /* ignore */ }
	}
</script>

<div class="space-y-6">
	<div class="bg-bg-primary/50 rounded-lg p-4 text-sm text-text-secondary">
		<p>Standard-Logins werden beim Hinzufügen neuer Kameras automatisch der Reihe nach durchprobiert. Die Reihenfolge bestimmt die Priorität. Bambu-Logins werden beim Onboarding eines H2C zur Auswahl angeboten.</p>
	</div>

	<!-- Saved credentials list -->
	{#if loading}
		<div class="flex items-center gap-2 text-text-secondary">
			<Loader2 class="w-4 h-4 animate-spin" />
			<span class="text-sm">Lade...</span>
		</div>
	{:else if savedCreds.length > 0}
		<div>
			<h3 class="text-sm font-medium text-text-secondary mb-2">Gespeicherte Logins ({savedCreds.length})</h3>
			<div class="space-y-2">
				{#each savedCreds as cred, i (cred.id)}
					<div class="flex items-center gap-3 bg-bg-input border border-border rounded-lg px-4 py-3">
						<span class="text-text-secondary/40 text-xs font-mono w-5 text-center">{i + 1}.</span>
						<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-medium shrink-0
							{cred.type === 'bambu' ? 'bg-orange-500/15 text-orange-400' : 'bg-blue-500/15 text-blue-400'}"
						>
							{cred.type === 'bambu' ? 'Bambu' : 'HTTP'}
						</span>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-3 flex-wrap">
								<span class="text-text-primary text-sm font-medium">{cred.name}</span>
								{#if cred.type === 'bambu'}
									<span class="text-text-secondary text-xs font-mono">SN: {cred.serialNumber}</span>
									<span class="text-text-secondary/50 text-xs">{cred.accessCodeMasked}</span>
								{:else}
									<span class="text-text-secondary text-xs font-mono">{cred.username}</span>
									<span class="text-text-secondary/50 text-xs">{cred.passwordMasked}</span>
								{/if}
							</div>
						</div>
						<button
							onclick={() => handleDelete(cred.id)}
							class="text-text-secondary hover:text-red-400 transition-colors cursor-pointer shrink-0"
							title="Löschen"
						>
							<Trash2 class="w-4 h-4" />
						</button>
					</div>
				{/each}
			</div>
		</div>
	{:else}
		<p class="text-text-secondary text-sm">Noch keine Standard-Logins gespeichert.</p>
	{/if}

	<!-- Add new credential -->
	<div>
		<h3 class="text-sm font-medium text-text-secondary mb-2">Neues Login hinzufügen</h3>

		<!-- Type switch -->
		<div class="flex items-center gap-2 mb-3">
			<button
				type="button"
				onclick={() => { newType = 'mobotix'; feedback = null; }}
				class="text-xs px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer
					{newType === 'mobotix' ? 'bg-accent text-white' : 'bg-bg-input text-text-secondary hover:text-text-primary'}"
			>
				Mobotix / Loxone (HTTP Basic)
			</button>
			<button
				type="button"
				onclick={() => { newType = 'bambu'; feedback = null; }}
				class="text-xs px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer
					{newType === 'bambu' ? 'bg-accent text-white' : 'bg-bg-input text-text-secondary hover:text-text-primary'}"
			>
				Bambu Lab (Serial + Access Code)
			</button>
		</div>

		<div class="bg-bg-input border border-border rounded-lg p-4 space-y-3">
			{#if newType === 'mobotix'}
				<div class="grid grid-cols-3 gap-3">
					<div>
						<label for="cred_name" class="block text-xs text-text-secondary mb-1">Bezeichnung</label>
						<input
							id="cred_name"
							type="text"
							bind:value={newName}
							placeholder="z.B. Mobotix Standard"
							autocomplete="off"
							class="w-full bg-bg-primary border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
						/>
					</div>
					<div>
						<label for="cred_user" class="block text-xs text-text-secondary mb-1">Benutzername</label>
						<input
							id="cred_user"
							type="text"
							bind:value={newUsername}
							placeholder="admin"
							autocomplete="off"
							class="w-full bg-bg-primary border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
						/>
					</div>
					<div>
						<label for="cred_pass" class="block text-xs text-text-secondary mb-1">Passwort</label>
						<input
							id="cred_pass"
							type="password"
							bind:value={newPassword}
							placeholder="••••••••"
							autocomplete="off"
							class="w-full bg-bg-primary border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
						/>
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-3 gap-3">
					<div>
						<label for="cred_bname" class="block text-xs text-text-secondary mb-1">Bezeichnung</label>
						<input
							id="cred_bname"
							type="text"
							bind:value={newBambuName}
							placeholder="z.B. Bob the Builder"
							autocomplete="off"
							class="w-full bg-bg-primary border border-border text-text-primary rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent"
						/>
					</div>
					<div>
						<label for="cred_serial" class="block text-xs text-text-secondary mb-1">Seriennummer <span class="text-text-secondary/60 font-normal">(optional)</span></label>
						<input
							id="cred_serial"
							type="text"
							bind:value={newSerial}
							placeholder="leer = für alle Drucker"
							autocomplete="off"
							class="w-full bg-bg-primary border border-border text-text-primary rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
						/>
					</div>
					<div>
						<label for="cred_code" class="block text-xs text-text-secondary mb-1">Access Code (8 Zeichen)</label>
						<input
							id="cred_code"
							type="password"
							bind:value={newAccessCode}
							placeholder="••••••••"
							maxlength="8"
							autocomplete="off"
							class="w-full bg-bg-primary border border-border text-text-primary rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
						/>
					</div>
				</div>
				<p class="text-[11px] text-text-secondary/80">Zu finden im Printer-Display unter <span class="font-mono">Einstellungen → LAN</span>. Serial + Access Code werden bei der Bambu-Onboarding-Routine angeboten und dienen gleichzeitig als RTSP-Login für UniFi Protect.</p>
				<p class="text-[11px] text-yellow-400/90">⚠ Tippfalle: Der Access Code enthält oft <span class="font-mono font-bold">0</span> (Null) und <span class="font-mono font-bold">O</span> (großes O) nebeneinander. Code nochmal am Drucker-Display verifizieren, auf dem Display sind beide Zeichen klar unterscheidbar.</p>
			{/if}

			{#if feedback}
				<InlineAlert type={feedback.type} message={feedback.message} />
			{/if}

			<button
				type="button"
				onclick={newType === 'mobotix' ? submitMobotix : submitBambu}
				disabled={saving}
				class="flex items-center gap-1.5 bg-accent hover:bg-accent/90 text-white font-medium px-4 py-2 rounded-md text-sm disabled:opacity-50 transition-colors cursor-pointer"
			>
				{#if saving}
					<Loader2 class="w-4 h-4 animate-spin" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				Hinzufügen
			</button>
		</div>
	</div>
</div>
