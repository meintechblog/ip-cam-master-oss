<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();

	let password = $state('');
	let confirmPassword = $state('');
	let clientError = $state('');

	function validatePasswords() {
		if (password && password.length < 6) {
			clientError = 'Passwort muss mindestens 6 Zeichen lang sein.';
		} else if (confirmPassword && password !== confirmPassword) {
			clientError = 'Passwörter stimmen nicht überein.';
		} else {
			clientError = '';
		}
	}
</script>

<div class="min-h-screen flex items-center justify-center bg-bg-primary p-4">
	<div class="w-full max-w-md">
		<div class="bg-bg-secondary rounded-lg border border-border p-8">
			<h1 class="text-2xl font-bold text-text-primary mb-2">IP-Cam-Master einrichten</h1>
			<p class="text-text-secondary mb-6">Erstelle einen Benutzer für den Zugangsschutz.</p>

			{#if form?.error}
				<div class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded mb-4">
					{form.error}
				</div>
			{/if}
			{#if clientError}
				<div class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded mb-4">
					{clientError}
				</div>
			{/if}

			<form method="POST" action="?/create" use:enhance>
				<div class="space-y-4">
					<div>
						<label for="username" class="block text-sm font-medium text-text-secondary mb-1">
							Benutzername
						</label>
						<input
							type="text"
							id="username"
							name="username"
							value={form?.username ?? ''}
							required
							class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary
								focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
						/>
					</div>
					<div>
						<label for="password" class="block text-sm font-medium text-text-secondary mb-1">
							Passwort
						</label>
						<input
							type="password"
							id="password"
							name="password"
							required
							minlength="6"
							bind:value={password}
							oninput={validatePasswords}
							class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary
								focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
						/>
					</div>
					<div>
						<label for="confirmPassword" class="block text-sm font-medium text-text-secondary mb-1">
							Passwort bestätigen
						</label>
						<input
							type="password"
							id="confirmPassword"
							name="confirmPassword"
							required
							minlength="6"
							bind:value={confirmPassword}
							oninput={validatePasswords}
							class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary
								focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
						/>
					</div>
				</div>

				<button
					type="submit"
					disabled={!!clientError}
					class="w-full mt-6 px-4 py-2 bg-accent text-white rounded font-medium
						hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed
						transition-colors"
				>
					Speichern
				</button>
			</form>

			<div class="mt-8 pt-6 border-t border-border">
				<h2 class="text-lg font-semibold text-text-primary mb-2">YOLO-Modus</h2>
				<p class="text-sm text-text-secondary mb-4">
					Kein Login, sofort nutzbar. Du kannst den Zugangsschutz später in den Einstellungen aktivieren.
				</p>
				<form method="POST" action="?/yolo" use:enhance>
					<button
						type="submit"
						class="w-full px-4 py-2 border border-border text-text-secondary rounded font-medium
							hover:bg-bg-primary hover:text-text-primary transition-colors cursor-pointer"
					>
						Ohne Passwort fortfahren
					</button>
				</form>
			</div>
		</div>
	</div>
</div>
