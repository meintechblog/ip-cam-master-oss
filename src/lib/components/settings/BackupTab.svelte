<script lang="ts">
	import { Download, Upload, AlertTriangle, Loader2 } from 'lucide-svelte';

	let file = $state<File | null>(null);
	let fileInput: HTMLInputElement | null = $state(null);
	let showConfirm = $state(false);
	let submitting = $state(false);
	let success = $state<string | null>(null);
	let error = $state<string | null>(null);

	function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		file = input.files?.[0] ?? null;
		success = null;
		error = null;
	}

	function openConfirm() {
		if (!file) return;
		error = null;
		success = null;
		showConfirm = true;
	}

	function cancelConfirm() {
		showConfirm = false;
	}

	async function doRestore() {
		if (!file) return;
		submitting = true;
		error = null;
		success = null;
		try {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('confirmed', 'true');
			const res = await fetch('/api/backup/restore', { method: 'POST', body: fd });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = errorMessage(body.error, body.detail);
			} else {
				success =
					'Restore erfolgreich. Server startet neu… Bitte Seite in 10 Sekunden neu laden.';
				setTimeout(() => location.reload(), 10_000);
			}
		} catch (e) {
			error = `Netzwerkfehler: ${(e as Error).message}`;
		} finally {
			submitting = false;
			showConfirm = false;
		}
	}

	function errorMessage(code: string, detail: string | null): string {
		switch (code) {
			case 'invalid_filename':
				return 'Datei muss auf .db enden.';
			case 'file_too_large':
				return 'Datei ist größer als 100 MB.';
			case 'integrity_check_failed':
				return `Datei ist keine gültige SQLite-Datenbank${detail ? ` (${detail})` : ''}.`;
			case 'missing_required_table':
				return `Datenbank fehlen erforderliche Tabellen${detail ? ` (${detail})` : ''}.`;
			case 'confirmation_required':
				return 'Bestätigung fehlt.';
			case 'no_file':
				return 'Keine Datei ausgewählt.';
			case 'io_error':
				return `Schreibfehler auf dem Server${detail ? ` (${detail})` : ''}.`;
			default:
				return `Fehler: ${code}${detail ? ` — ${detail}` : ''}`;
		}
	}
</script>

<div class="max-w-lg space-y-6">
	{#if success}
		<div class="bg-green-500/10 border border-green-500/30 text-green-400 px-4 py-3 rounded">
			{success}
		</div>
	{/if}
	{#if error}
		<div class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded">
			{error}
		</div>
	{/if}

	<!-- Download card -->
	<div class="bg-bg-card rounded-lg border border-border p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-2">Backup herunterladen</h2>
		<p class="text-sm text-text-secondary mb-4">
			Lädt die aktuelle Datenbank als Datei herunter. Empfohlen vor jedem Update.
		</p>
		<a
			href="/api/backup/download"
			download
			class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded font-medium
				hover:bg-accent/90 transition-colors"
		>
			<Download class="w-4 h-4" />
			Jetzt herunterladen
		</a>
	</div>

	<!-- Restore card -->
	<div class="bg-bg-card rounded-lg border border-border p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-2">Backup wiederherstellen</h2>
		<p class="text-sm text-text-secondary mb-4">
			Ersetzt die aktuelle Datenbank mit einer hochgeladenen Backup-Datei. Der Server startet
			danach neu.
		</p>

		<div class="space-y-4">
			<div>
				<label for="backup-file" class="block text-sm font-medium text-text-secondary mb-1">
					Backup-Datei (.db)
				</label>
				<input
					bind:this={fileInput}
					type="file"
					id="backup-file"
					accept=".db"
					onchange={onFile}
					disabled={submitting}
					class="w-full text-sm text-text-secondary
						file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-border
						file:bg-bg-primary file:text-text-primary file:font-medium
						file:cursor-pointer hover:file:bg-bg-card"
				/>
				{#if file}
					<p class="text-xs text-text-secondary mt-1">
						Ausgewählt: <span class="text-text-primary">{file.name}</span>
						({(file.size / 1024).toFixed(1)} KB)
					</p>
				{/if}
			</div>

			<button
				type="button"
				onclick={openConfirm}
				disabled={!file || submitting}
				class="inline-flex items-center gap-2 px-4 py-2 border border-red-500/50 text-red-400 rounded font-medium
					hover:bg-red-500/10 transition-colors
					disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
			>
				{#if submitting}
					<Loader2 class="w-4 h-4 animate-spin" />
				{:else}
					<Upload class="w-4 h-4" />
				{/if}
				Wiederherstellen
			</button>
		</div>
	</div>
</div>

<!-- Confirmation modal -->
{#if showConfirm}
	<div
		class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="backup-confirm-title"
	>
		<div class="bg-bg-card rounded-lg border border-border p-6 max-w-md w-full space-y-4">
			<div class="flex items-start gap-3">
				<AlertTriangle class="w-6 h-6 text-red-400 flex-shrink-0 mt-0.5" />
				<div>
					<h3 id="backup-confirm-title" class="text-lg font-semibold text-text-primary">
						Daten wirklich ersetzen?
					</h3>
					<p class="text-sm text-text-secondary mt-2">
						Diese Aktion ersetzt alle aktuellen Daten (Kameras, Einstellungen, Zugangsdaten) mit
						dem Inhalt der hochgeladenen Datei. Fortfahren?
					</p>
					{#if file}
						<p class="text-xs text-text-secondary mt-2">
							Datei: <span class="text-text-primary">{file.name}</span>
						</p>
					{/if}
				</div>
			</div>

			<div class="flex gap-2 justify-end pt-2">
				<button
					type="button"
					onclick={cancelConfirm}
					disabled={submitting}
					class="px-4 py-2 border border-border text-text-secondary rounded font-medium
						hover:text-text-primary transition-colors
						disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Abbrechen
				</button>
				<button
					type="button"
					onclick={doRestore}
					disabled={submitting}
					class="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded font-medium
						hover:bg-red-700 transition-colors
						disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{#if submitting}
						<Loader2 class="w-4 h-4 animate-spin" />
					{/if}
					Ja, wiederherstellen
				</button>
			</div>
		</div>
	</div>
{/if}
