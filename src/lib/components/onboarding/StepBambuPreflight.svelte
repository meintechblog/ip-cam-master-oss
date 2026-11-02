<script lang="ts">
	import { Loader2, CheckCircle, XCircle } from 'lucide-svelte';

	type PreflightError =
		| 'PRINTER_UNREACHABLE'
		| 'LAN_MODE_OFF'
		| 'WRONG_ACCESS_CODE'
		| 'A1_CAMERA_DISABLED'
		| 'RTSPS_HANDSHAKE_HUNG'
		| 'A1_CLOUD_MODE_ACTIVE'
		| 'INVALID_INPUT';

	let {
		ip,
		serialNumber,
		accessCode,
		model = 'H2C',
		onDone,
		onRetry
	}: {
		ip: string;
		serialNumber: string;
		accessCode: string;
		/**
		 * SSDP-discovered model (Phase 18 / BAMBU-A1-04). Threaded through to the
		 * preflight route so the server picks the A1 TLS:6000 branch vs. the H2C
		 * RTSPS:322 branch. Default 'H2C' preserves pre-Phase-18 behaviour for
		 * manual-add flows where model is unknown.
		 */
		model?: string;
		onDone: (ok: boolean) => void;
		onRetry: () => void;
	} = $props();

	// Fallback hints duplicated from src/lib/server/services/bambu-preflight.ts PREFLIGHT_HINTS_DE
	// (server sends the hint on the wire; this map only covers the case where we can't read it).
	// Phase 18 / D-05: A1_CLOUD_MODE_ACTIVE wording must match the server-side
	// PREFLIGHT_HINTS_DE entry byte-for-byte — keep these two maps in sync.
	const HINTS_DE: Record<PreflightError, string> = {
		PRINTER_UNREACHABLE: 'Drucker nicht erreichbar. IP-Adresse und Netzwerkverbindung prüfen.',
		LAN_MODE_OFF: 'LAN Mode scheint deaktiviert. Am Drucker: Einstellungen → Netzwerk → LAN Mode aktivieren.',
		WRONG_ACCESS_CODE: 'Access Code abgelehnt. Am Drucker-Display aktuellen Code ablesen (Einstellungen → Netzwerk → Access Code).',
		A1_CAMERA_DISABLED:
			'Access Code OK, aber die Kamera ist am Drucker deaktiviert (ipcam_dev=0). Beim A1 Mini liegt der Toggle in der Bambu Handy App: Gerät → Kamera-Tab → LiveView aktivieren.',
		RTSPS_HANDSHAKE_HUNG: 'RTSPS-Server antwortet nicht (Live555 hängt). Drucker bitte kurz aus- und wieder einschalten.',
		A1_CLOUD_MODE_ACTIVE:
			'Cloud-Modus ist aktiv. Bambu Handy App → Gerät → "LAN Mode only" aktivieren und Cloud-Verbindung deaktivieren.',
		INVALID_INPUT: 'Ungültige Eingabe. Seriennummer und Access Code prüfen.'
	};

	let status = $state<'running' | 'ok' | 'error'>('running');
	let errorCode = $state<PreflightError | null>(null);
	let hint = $state<string>('');

	$effect(() => {
		runPreflight();
	});

	async function runPreflight() {
		status = 'running';
		errorCode = null;
		hint = '';

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 25000);

		try {
			const res = await fetch('/api/onboarding/bambu/preflight', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ip, serialNumber, accessCode, model }),
				signal: controller.signal
			});
			clearTimeout(timeoutId);

			const data = await res.json();
			if (data.ok === true) {
				status = 'ok';
			} else {
				status = 'error';
				errorCode = (data.error as PreflightError) ?? 'PRINTER_UNREACHABLE';
				hint = data.hint ?? HINTS_DE[errorCode] ?? 'Unbekannter Fehler.';
			}
		} catch (err) {
			clearTimeout(timeoutId);
			// Abort or network error → treat as unreachable
			status = 'error';
			errorCode = 'PRINTER_UNREACHABLE';
			hint = HINTS_DE.PRINTER_UNREACHABLE;
		}
	}
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-bold text-text-primary mb-1">Pre-Flight</h2>
		<p class="text-sm text-text-secondary">
			Drucker: <span class="font-mono text-text-primary">{ip}</span>
			<span class="mx-2">·</span>
			Seriennummer: <span class="font-mono text-text-primary">{serialNumber}</span>
		</p>
	</div>

	{#if status === 'running'}
		<div class="flex items-center gap-3 text-text-secondary">
			<Loader2 class="w-5 h-5 animate-spin" />
			<span>Pre-Flight läuft (TCP → RTSPS → MQTT, bis zu 20 s)...</span>
		</div>
	{:else if status === 'ok'}
		<div class="space-y-4">
			<div class="flex items-center gap-3 text-green-400">
				<CheckCircle class="w-6 h-6" />
				<span class="font-medium text-text-primary">Pre-Flight erfolgreich</span>
			</div>
			<div class="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-sm text-green-400">
				Bereit für LXC-Provisionierung (Phase 12).
			</div>
			<div class="flex justify-end">
				<button
					type="button"
					onclick={() => onDone(true)}
					class="bg-accent text-white rounded-lg px-6 py-2 hover:bg-accent/90 transition-colors font-medium cursor-pointer"
				>
					Fertig
				</button>
			</div>
		</div>
	{:else if status === 'error'}
		<div class="space-y-4">
			<div class="flex items-center gap-3 text-red-400">
				<XCircle class="w-6 h-6" />
				<span class="font-medium text-text-primary">Pre-Flight fehlgeschlagen</span>
			</div>
			{#if errorCode}
				<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-2">
					<p class="text-xs font-mono text-red-400">{errorCode}</p>
					<p class="text-sm text-text-primary">{hint}</p>
					{#if errorCode === 'RTSPS_HANDSHAKE_HUNG'}
						<p class="text-xs text-text-secondary mt-2">
							Drucker bitte kurz aus- und wieder einschalten, dann erneut versuchen. (Live555-Bug, bekannt — siehe Dokumentation.)
						</p>
					{/if}
				</div>
			{/if}
			<div class="flex gap-2 justify-end">
				<button
					type="button"
					onclick={() => onDone(false)}
					class="bg-bg-input text-text-secondary rounded-lg px-4 py-2 hover:bg-bg-card text-sm cursor-pointer"
				>
					Abbrechen
				</button>
				<button
					type="button"
					onclick={onRetry}
					class="bg-accent text-white rounded-lg px-6 py-2 hover:bg-accent/90 transition-colors font-medium cursor-pointer"
				>
					Erneut prüfen
				</button>
			</div>
		</div>
	{/if}
</div>
