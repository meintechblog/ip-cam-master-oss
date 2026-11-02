<!--
  v1.3 Phase 22 Plan 03 Task 2 — Output toggle primitive (HUB-UI-03).

  Single-output toggle row primitive. Drives the off → enabling → on state
  machine (and reverse) with optimistic UI + AbortController + 422 vaapi-cap
  rollback per RESEARCH §Pattern 3 + UI-SPEC §toggle.

  Endpoint contract (per outputs/+server.ts):
    PUT /api/cameras/{id}/outputs
    Body: { outputs: Array<{ outputType, enabled }> }   (replace-strategy)
    200: { ok: true }
    422: { ok: false, reason: 'vaapi_hard_cap_exceeded', message: '<de>' }

  Per UI-SPEC L-18: while in flight, the toggle is DISABLED (visual hint that
  we are working — no double-click). Error rolls back to the last stable state.

  Note: The local rune-state variable is named `toggleState` (not `state`) to
  avoid shadowing the Svelte 5 `$state` rune in svelte-check's scope analysis.

  Note: This primitive sends only its OWN output entry — the parent
  OutputsSubsection knows nothing about the other outputs. Because the server
  uses replace-strategy, every PUT must include the full output set for the
  cam. The parent component composes the request via the `siblingOutputs`
  prop (an array of the OTHER outputs that should remain unchanged).
-->
<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import type { OutputType } from '$lib/protect-hub/slug';

	type ToggleState = 'off' | 'enabling' | 'on' | 'disabling' | 'error';
	type SiblingOutput = { outputType: OutputType; enabled: boolean };

	let {
		cameraId,
		outputType,
		enabled = $bindable(false),
		siblingOutputs = [],
		onErrorMessage
	}: {
		cameraId: number;
		outputType: OutputType;
		enabled: boolean;
		siblingOutputs?: SiblingOutput[];
		onErrorMessage?: (msg: string | null) => void;
	} = $props();

	let toggleState = $state<ToggleState>(enabled ? 'on' : 'off');
	let errorMessage = $state<string | null>(null);
	let abortController: AbortController | null = null;

	const inFlight = $derived(toggleState === 'enabling' || toggleState === 'disabling');

	// v1.3 Phase 22 WR-02 fix — abort any in-flight PUT when the component is
	// destroyed. Without this, navigating away from /kameras (or letting the
	// poll-driven re-render swap the cam card) leaves the fetch running against
	// a detached signal: the server processes the toggle, but no component
	// instance is left to receive the response, so the new instance can read
	// stale outputs from the next /api/cameras/status poll.
	$effect(() => {
		return () => {
			if (abortController) {
				abortController.abort();
				abortController = null;
			}
		};
	});

	async function toggle() {
		if (inFlight) return;

		const wasOn = toggleState === 'on';
		const targetEnabled = !wasOn;
		const previousState = toggleState;

		// Optimistic UI: enter transitional state immediately.
		toggleState = targetEnabled ? 'enabling' : 'disabling';
		errorMessage = null;
		onErrorMessage?.(null);

		// Cancel any prior in-flight request (defensive — parent controls re-entry).
		if (abortController) abortController.abort();
		abortController = new AbortController();

		try {
			const requestBody = {
				outputs: [
					...siblingOutputs,
					{ outputType, enabled: targetEnabled }
				]
			};
			const res = await fetch(`/api/cameras/${cameraId}/outputs`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: abortController.signal
			});

			if (res.ok) {
				toggleState = targetEnabled ? 'on' : 'off';
				enabled = targetEnabled;
				return;
			}

			// 422 vaapi-cap rollback: server provides German error in body.message.
			if (res.status === 422) {
				let capBody: { reason?: string; message?: string } = {};
				try {
					capBody = await res.json();
				} catch {
					/* ignore parse error */
				}
				if (capBody?.reason === 'vaapi_hard_cap_exceeded' && capBody?.message) {
					errorMessage = capBody.message;
				} else {
					errorMessage = `Konnte Ausgang nicht umschalten: ${capBody?.message ?? res.statusText}`;
				}
				onErrorMessage?.(errorMessage);
				// Rollback to last stable state — toggle stays where it was.
				toggleState = previousState === 'on' ? 'on' : 'off';
				return;
			}

			// Generic non-OK: surface short German error and roll back.
			let errBody: { message?: string; error?: string } = {};
			try {
				errBody = await res.json();
			} catch {
				/* ignore parse error */
			}
			errorMessage = `Konnte Ausgang nicht umschalten: ${errBody?.message ?? errBody?.error ?? res.statusText}`;
			onErrorMessage?.(errorMessage);
			toggleState = previousState === 'on' ? 'on' : 'off';
		} catch (err) {
			// Aborted requests don't surface errors (parent kicked off a new one).
			if (err instanceof Error && err.name === 'AbortError') return;
			errorMessage = `Konnte Ausgang nicht umschalten: ${
				err instanceof Error ? err.message : 'Netzwerkfehler'
			}`;
			onErrorMessage?.(errorMessage);
			toggleState = previousState === 'on' ? 'on' : 'off';
		}
	}

	const captionText = $derived(
		toggleState === 'on'
			? 'aktiv'
			: toggleState === 'off'
				? 'aus'
				: 'Vorgang läuft…'
	);
	const captionClass = $derived(
		toggleState === 'on' ? 'text-success' : 'text-text-secondary'
	);
</script>

<div class="flex items-center gap-3">
	<button
		type="button"
		onclick={toggle}
		disabled={inFlight}
		role="switch"
		aria-checked={toggleState === 'on'}
		aria-disabled={inFlight}
		class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed
			{toggleState === 'on' ? 'bg-accent' : 'bg-bg-input'}"
	>
		<span
			class="inline-block h-4 w-4 transform rounded-full transition-transform
				{toggleState === 'on' ? 'translate-x-6 bg-white' : 'translate-x-1 bg-text-secondary'}"
		>
			{#if inFlight}
				<Loader2 class="w-3 h-3 animate-spin text-text-primary" />
			{/if}
		</span>
	</button>
	<span class="text-xs {captionClass}">{captionText}</span>
	{#if inFlight}
		<button
			type="button"
			disabled
			title="Vorgang läuft — bitte warten"
			class="text-xs text-text-secondary/60 cursor-not-allowed"
		>
			Abbrechen
		</button>
	{/if}
</div>

{#if errorMessage}
	<p class="text-xs text-danger mt-1">{errorMessage}</p>
{/if}
