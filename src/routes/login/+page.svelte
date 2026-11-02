<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
</script>

<div class="min-h-screen flex items-center justify-center bg-bg-primary p-4">
	<div class="w-full max-w-md">
		<div class="bg-bg-secondary rounded-lg border border-border p-8">
			<h1 class="text-2xl font-bold text-text-primary mb-6">Anmelden</h1>

			{#if form?.error}
				<div class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded mb-4">
					{form.error}
				</div>
			{/if}

			<form method="POST" use:enhance>
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
							class="w-full px-3 py-2 bg-bg-primary border border-border rounded text-text-primary
								focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
						/>
					</div>
				</div>

				<button
					type="submit"
					class="w-full mt-6 px-4 py-2 bg-accent text-white rounded font-medium
						hover:bg-accent/90 transition-colors"
				>
					Anmelden
				</button>
			</form>
		</div>
	</div>
</div>
