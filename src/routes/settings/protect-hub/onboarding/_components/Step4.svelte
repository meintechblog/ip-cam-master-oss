<script lang="ts">
	// v1.3 Phase 22 Plan 04 — Wizard Step 4 "Kameras auswählen" (HUB-WIZ-06).
	//
	// Renders two sections (Erstanbieter / Drittanbieter) of camera rows; each row
	// has a checkbox + output dropdown (loxone-mjpeg | frigate-rtsp). First-party
	// cams default to selected=true, third-party default to false. Client-side
	// VAAPI cap mirrors the server-side hard-cap (12, raised 2026-05-16 — see
	// /api/cameras/[id]/outputs header for hardware rationale) at
	// /api/cameras/[id]/outputs: once VAAPI_HARD_CAP Loxone-MJPEG outputs are
	// selected, additional MJPEG checkboxes are disabled with the exact server
	// tooltip ("Maximal 12 ..."). At VAAPI_SOFT_CAP a soft-warning surfaces.
	//
	// CTA "Auswahl übernehmen": iterate selections, PUT /api/cameras/[id]/outputs
	// per cam; on 422 (vaapi_hard_cap_exceeded — server projects across all cams,
	// includes other rows we just wrote), surface the exact server message and
	// do NOT advance. On all-success: POST /api/protect-hub/wizard/4 then onComplete().
	//
	// UI-SPEC §wizard-step-4 locks copy + the per-row layout.
	import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-svelte';

	type CamRow = {
		id: number;
		name: string;
		kind: string | null;
		manufacturer: string | null;
		modelName: string | null;
	};

	type OutputType = 'loxone-mjpeg' | 'frigate-rtsp';

	type Selection = {
		selected: boolean;
		outputType: OutputType;
	};

	let {
		cams,
		onComplete
	}: {
		cams: CamRow[];
		onComplete: () => void;
	} = $props();

	// Initial selections — first-party pre-checked, third-party unchecked.
	function buildInitialSelections(input: CamRow[]): Record<number, Selection> {
		const out: Record<number, Selection> = {};
		for (const cam of input) {
			out[cam.id] = {
				selected: cam.kind === 'first-party',
				outputType: 'loxone-mjpeg'
			};
		}
		return out;
	}

	let selections = $state<Record<number, Selection>>(buildInitialSelections(cams));
	let submitting = $state(false);
	let submitError = $state<string | null>(null);

	const firstParty = $derived(cams.filter((c) => c.kind === 'first-party'));
	const thirdParty = $derived(cams.filter((c) => c.kind !== 'first-party'));

	const mjpegCount = $derived(
		Object.values(selections).filter((s) => s.selected && s.outputType === 'loxone-mjpeg').length
	);
	const VAAPI_HARD_CAP = 12; // kept in sync with /api/cameras/[id]/outputs
	const mjpegCapHit = $derived(mjpegCount >= VAAPI_HARD_CAP);
	const VAAPI_SOFT_CAP = 10;
	const mjpegCapWarn = $derived(mjpegCount >= VAAPI_SOFT_CAP && mjpegCount < VAAPI_HARD_CAP);

	function toggleSelected(camId: number, nextSelected: boolean) {
		const cur = selections[camId];
		if (!cur) return;
		// Block additional MJPEG selections once cap is hit.
		if (
			nextSelected &&
			!cur.selected &&
			cur.outputType === 'loxone-mjpeg' &&
			mjpegCapHit
		) {
			return;
		}
		selections = { ...selections, [camId]: { ...cur, selected: nextSelected } };
	}

	function changeOutputType(camId: number, next: OutputType) {
		const cur = selections[camId];
		if (!cur) return;
		// Block flipping into MJPEG when cap already hit (and cam is currently selected).
		if (cur.selected && next === 'loxone-mjpeg' && cur.outputType !== 'loxone-mjpeg' && mjpegCapHit) {
			return;
		}
		selections = { ...selections, [camId]: { ...cur, outputType: next } };
	}

	async function submit() {
		if (submitting) return;
		submitting = true;
		submitError = null;
		try {
			for (const cam of cams) {
				const sel = selections[cam.id];
				if (!sel) continue;
				const outputs = sel.selected
					? [{ outputType: sel.outputType, enabled: true }]
					: [];
				const res = await fetch(`/api/cameras/${cam.id}/outputs`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ outputs })
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as {
						reason?: string;
						message?: string;
						error?: string;
					};
					if (body.reason === 'vaapi_hard_cap_exceeded' && body.message) {
						submitError = body.message;
					} else {
						submitError =
							body.message || body.error || `Konnte ${cam.name} nicht speichern.`;
					}
					return;
				}
			}
			await fetch('/api/protect-hub/wizard/4', { method: 'POST' });
			onComplete();
		} catch (err) {
			submitError = err instanceof Error ? err.message : 'Netzwerkfehler';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="bg-bg-card rounded-lg border border-border p-6 space-y-6">
	<div>
		<h2 class="text-base font-semibold text-text-primary">
			Schritt 4: Welche Kameras in den Hub?
		</h2>
		<p class="text-sm text-text-secondary mt-1">
			Erstanbieter-Cams sind vorausgewählt mit Loxone-MJPEG aktiv. Drittanbieter-Cams sind aus —
			viele liefern bereits MJPEG nativ.
		</p>
	</div>

	{#if cams.length === 0}
		<p class="text-sm text-text-secondary">Keine Kameras zum Auswählen vorhanden.</p>
	{:else}
		<!-- VAAPI cap notices -->
		{#if mjpegCapWarn}
			<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 flex items-start gap-2">
				<AlertTriangle class="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
				<p class="text-xs text-text-secondary">
					{mjpegCount} von {VAAPI_HARD_CAP} Loxone-MJPEG-Slots belegt. VAAPI-Hardware-Limit erreicht bei {VAAPI_HARD_CAP}.
				</p>
			</div>
		{/if}
		{#if mjpegCapHit}
			<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 flex items-start gap-2">
				<AlertTriangle class="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
				<p class="text-xs text-text-secondary">
					Maximal {VAAPI_HARD_CAP} Loxone-MJPEG-Streams gleichzeitig (VAAPI-Limit). Weitere Auswahl deaktiviert.
				</p>
			</div>
		{/if}

		<!-- First-party section -->
		{#if firstParty.length > 0}
			<section class="space-y-3">
				<h3 class="text-sm font-semibold text-text-primary">Erstanbieter (UniFi)</h3>
				<div class="space-y-2">
					{#each firstParty as cam (cam.id)}
						{@const sel = selections[cam.id]}
						{@const disableMjpeg =
							!sel?.selected &&
							sel?.outputType === 'loxone-mjpeg' &&
							mjpegCapHit}
						<div class="flex items-center gap-3 p-3 bg-bg-input rounded-lg border border-border">
							<input
								type="checkbox"
								checked={sel?.selected ?? false}
								disabled={disableMjpeg}
								onchange={(e) => toggleSelected(cam.id, e.currentTarget.checked)}
								class="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
								title={disableMjpeg
									? 'Maximal 12 gleichzeitige Loxone-MJPEG-Transkodierungen pro Bridge möglich'
									: ''}
							/>
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate">
									{cam.name} · {cam.modelName ?? '—'}
								</p>
							</div>
							<label class="flex items-center gap-2">
								<span class="text-xs text-text-secondary">Ausgang:</span>
								<select
									value={sel?.outputType ?? 'loxone-mjpeg'}
									onchange={(e) =>
										changeOutputType(cam.id, e.currentTarget.value as OutputType)}
									class="bg-bg-card border border-border rounded text-sm px-2 py-1 cursor-pointer"
								>
									<option value="loxone-mjpeg">Loxone-MJPEG (640×360@10)</option>
									<option value="frigate-rtsp">Frigate-RTSP (Passthrough)</option>
								</select>
							</label>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Third-party section -->
		{#if thirdParty.length > 0}
			<section class="space-y-3">
				<h3 class="text-sm font-semibold text-text-primary">Drittanbieter — vorausgewählt aus</h3>
				<p class="text-xs text-text-secondary">
					Liefert die Cam bereits MJPEG nativ? Dann hier aus lassen.
				</p>
				<div class="space-y-2">
					{#each thirdParty as cam (cam.id)}
						{@const sel = selections[cam.id]}
						{@const disableMjpeg =
							!sel?.selected &&
							sel?.outputType === 'loxone-mjpeg' &&
							mjpegCapHit}
						<div class="flex items-center gap-3 p-3 bg-bg-input rounded-lg border border-border">
							<input
								type="checkbox"
								checked={sel?.selected ?? false}
								disabled={disableMjpeg}
								onchange={(e) => toggleSelected(cam.id, e.currentTarget.checked)}
								class="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
								title={disableMjpeg
									? 'Maximal 12 gleichzeitige Loxone-MJPEG-Transkodierungen pro Bridge möglich'
									: ''}
							/>
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate">
									{cam.name} · {cam.modelName ?? cam.manufacturer ?? '—'}
								</p>
							</div>
							<label class="flex items-center gap-2">
								<span class="text-xs text-text-secondary">Ausgang:</span>
								<select
									value={sel?.outputType ?? 'loxone-mjpeg'}
									onchange={(e) =>
										changeOutputType(cam.id, e.currentTarget.value as OutputType)}
									class="bg-bg-card border border-border rounded text-sm px-2 py-1 cursor-pointer"
								>
									<option value="loxone-mjpeg">Loxone-MJPEG (640×360@10)</option>
									<option value="frigate-rtsp">Frigate-RTSP (Passthrough)</option>
								</select>
							</label>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if submitError}
			<div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-start gap-2">
				<XCircle class="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
				<p class="text-sm text-red-400">{submitError}</p>
			</div>
		{/if}

		<div class="flex justify-end">
			<button
				type="button"
				onclick={submit}
				disabled={submitting}
				class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg
					hover:bg-accent/90 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50"
			>
				{#if submitting}
					<Loader2 class="w-4 h-4 animate-spin" />
				{:else}
					<CheckCircle2 class="w-4 h-4" />
				{/if}
				Auswahl übernehmen
			</button>
		</div>
	{/if}
</div>
