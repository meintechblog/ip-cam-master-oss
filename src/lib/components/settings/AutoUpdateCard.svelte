<script lang="ts">
	import { Clock, ToggleLeft, ToggleRight, Save } from 'lucide-svelte';

	type Props = {
		initialEnabled: boolean;
		initialHour: number;
		lastAutoUpdateAt: string | null;
	};

	const { initialEnabled, initialHour, lastAutoUpdateAt }: Props = $props();

	let enabled = $state(initialEnabled);
	let hour = $state(Number.isFinite(initialHour) ? initialHour : 3);
	let saving = $state(false);
	let lastSaveAt = $state<number | null>(null);
	let saveError = $state<string | null>(null);

	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	function debouncedSave(): void {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void persistSettings();
		}, 300);
	}

	async function persistSettings(): Promise<void> {
		saving = true;
		saveError = null;
		try {
			// PUT /api/settings expects a flat { key1: val1, key2: val2 } object,
			// NOT { key, value } envelope.
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					'update.autoUpdate': enabled ? 'true' : 'false',
					'update.autoUpdateHour': String(hour)
				})
			});
			if (!res.ok) throw new Error(`save: HTTP ${res.status}`);

			lastSaveAt = Date.now();
		} catch (err) {
			saveError = (err as Error).message;
		} finally {
			saving = false;
		}
	}

	function onToggle(): void {
		enabled = !enabled;
		debouncedSave();
	}

	function onHourChange(e: Event): void {
		const target = e.currentTarget as HTMLSelectElement;
		const next = Number.parseInt(target.value, 10);
		if (Number.isFinite(next) && next >= 0 && next <= 23) {
			hour = next;
			debouncedSave();
		}
	}

	function formatHour(h: number): string {
		return `${String(h).padStart(2, '0')}:00`;
	}

	function formatRelative(iso: string | null): string {
		if (!iso) return 'noch nie ausgeführt';
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) {
			// Try epoch ms
			const num = Number.parseInt(iso, 10);
			if (Number.isFinite(num)) return formatRelative(new Date(num).toISOString());
			return 'noch nie ausgeführt';
		}
		const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (deltaSec < 60) return 'gerade eben';
		const deltaMin = Math.round(deltaSec / 60);
		if (deltaMin < 60) return `vor ${deltaMin} Min.`;
		const deltaH = Math.round(deltaMin / 60);
		if (deltaH < 24) return `vor ${deltaH} Std.`;
		const deltaD = Math.round(deltaH / 24);
		return `vor ${deltaD} ${deltaD === 1 ? 'Tag' : 'Tagen'}`;
	}

	function nextWindowDescription(): string {
		if (!enabled) return 'Auto-Update ist deaktiviert';
		const now = new Date();
		const berlinHour = now.getHours();
		const day = berlinHour < hour ? 'heute' : 'morgen';
		return `Nächste mögliche Prüfung: ${day} um ${formatHour(hour)} (Europe/Berlin)`;
	}
</script>

<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
	<div class="flex items-center gap-2">
		<Clock class="w-5 h-5 text-text-secondary" />
		<h2 class="text-lg font-semibold text-text-primary">Auto-Update</h2>
	</div>
	<p class="text-sm text-text-secondary">
		Wenn aktiviert, prüft die App alle 6 Stunden auf neue Versionen und installiert sie
		automatisch zur unten gewählten Uhrzeit. Updates werden übersprungen, wenn ein
		Onboarding-Wizard oder eine Hub-Bridge gerade aktiv ist.
	</p>

	<div class="flex items-center gap-3">
		<button
			type="button"
			onclick={onToggle}
			class="inline-flex items-center gap-2 text-text-primary hover:text-accent transition-colors"
			aria-pressed={enabled}
		>
			{#if enabled}
				<ToggleRight class="w-8 h-8 text-green-400" />
				<span class="font-semibold">aktiviert</span>
			{:else}
				<ToggleLeft class="w-8 h-8 text-text-secondary" />
				<span class="text-text-secondary">deaktiviert</span>
			{/if}
		</button>
	</div>

	<div class="flex items-center gap-3">
		<label for="auto-update-hour" class="text-sm text-text-secondary">
			Tägliche Uhrzeit (Europe/Berlin)
		</label>
		<select
			id="auto-update-hour"
			value={hour}
			onchange={onHourChange}
			disabled={!enabled}
			class="bg-bg-input border border-border rounded px-2 py-1 text-text-primary text-sm disabled:opacity-50"
		>
			{#each Array.from({ length: 24 }, (_, i) => i) as h}
				<option value={h}>{formatHour(h)}</option>
			{/each}
		</select>
	</div>

	<div class="text-xs text-text-secondary space-y-1">
		<div>{nextWindowDescription()}</div>
		<div>Letztes Auto-Update: {formatRelative(lastAutoUpdateAt)}</div>
	</div>

	{#if saveError}
		<div class="text-xs text-red-400">Speichern fehlgeschlagen: {saveError}</div>
	{:else if saving}
		<div class="text-xs text-text-secondary inline-flex items-center gap-1">
			<Save class="w-3 h-3 animate-pulse" /> wird gespeichert…
		</div>
	{:else if lastSaveAt}
		<div class="text-xs text-green-400">gespeichert</div>
	{/if}
</div>
