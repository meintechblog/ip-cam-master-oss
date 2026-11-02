<script lang="ts">
	import {
		RefreshCw,
		AlertTriangle,
		CheckCircle2,
		ArrowUpCircle,
		RotateCcw
	} from 'lucide-svelte';
	import UpdateRunPanel from './UpdateRunPanel.svelte';
	import AutoUpdateCard from './AutoUpdateCard.svelte';

	type CurrentShape = {
		label: string;
		sha: string;
		tag: string | null;
		isDev: boolean;
		isDirty: boolean;
	};

	type AutoUpdateShape = {
		enabled: boolean;
		hour: number;
		lastAutoUpdateAt: string | null;
	};

	type StatusShape = {
		current: CurrentShape;
		lastCheckedAt: string | null;
		latestSha: string | null;
		latestCommitDate: string | null;
		latestCommitMessage: string | null;
		lastError: string | null;
		hasUpdate: boolean;
		updateStatus?: string;
		rollbackHappened?: boolean;
		rollbackReason?: string | null;
		rollbackStage?: 'stage1' | 'stage2' | null;
		inProgressUpdate?: { targetSha: string | null; startedAt: string | null } | null;
		autoUpdate?: AutoUpdateShape;
	};

	type CheckResponse = StatusShape & {
		checkResult:
			| { error: null }
			| { error: 'cooldown'; retryAfterSeconds: number }
			| { error: 'rate_limited'; resetAt: string }
			| { error: 'network'; message: string }
			| { error: 'dev_mode' };
	};

	let status = $state<StatusShape | null>(null);
	let loading = $state(false);
	let errorBanner = $state<string | null>(null);
	let dismissingRollback = $state(false);

	function formatRelativeTime(iso: string | null): string {
		if (!iso) return 'nie';
		const then = new Date(iso).getTime();
		if (Number.isNaN(then)) return 'nie';
		const deltaSec = Math.max(0, Math.round((Date.now() - then) / 1000));
		if (deltaSec < 60) return 'gerade eben';
		const deltaMin = Math.round(deltaSec / 60);
		if (deltaMin < 60) return `vor ${deltaMin} ${deltaMin === 1 ? 'Minute' : 'Minuten'}`;
		const deltaH = Math.round(deltaMin / 60);
		if (deltaH < 24) return `vor ${deltaH} ${deltaH === 1 ? 'Stunde' : 'Stunden'}`;
		const deltaD = Math.round(deltaH / 24);
		return `vor ${deltaD} ${deltaD === 1 ? 'Tag' : 'Tagen'}`;
	}

	function formatResetTime(iso: string): string {
		try {
			const d = new Date(iso);
			const hh = String(d.getHours()).padStart(2, '0');
			const mm = String(d.getMinutes()).padStart(2, '0');
			return `${hh}:${mm}`;
		} catch {
			return iso;
		}
	}

	function shortSha(sha: string | null): string {
		if (!sha) return 'unbekannt';
		return sha.slice(0, 7);
	}

	async function loadStatus() {
		try {
			const res = await fetch('/api/update/status');
			if (!res.ok) {
				errorBanner = 'Status konnte nicht geladen werden';
				return;
			}
			status = (await res.json()) as StatusShape;
		} catch {
			errorBanner = 'Status konnte nicht geladen werden';
		}
	}

	async function checkNow() {
		loading = true;
		errorBanner = null;
		try {
			const res = await fetch('/api/update/check', { method: 'POST' });
			const body = (await res.json()) as CheckResponse;

			status = {
				...status,
				current: body.current,
				lastCheckedAt: body.lastCheckedAt,
				latestSha: body.latestSha,
				latestCommitDate: body.latestCommitDate,
				latestCommitMessage: body.latestCommitMessage,
				lastError: body.lastError,
				hasUpdate: body.hasUpdate
			} as StatusShape;

			const result = body.checkResult;
			if (result.error === 'cooldown') {
				errorBanner = `Cooldown — bitte in ${result.retryAfterSeconds}s erneut versuchen`;
			} else if (result.error === 'rate_limited') {
				errorBanner = `Rate limit — nächste Prüfung möglich um ${formatResetTime(result.resetAt)}`;
			} else if (result.error === 'network') {
				errorBanner = 'Netzwerkfehler — GitHub nicht erreichbar';
			} else if (result.error === 'dev_mode') {
				errorBanner = 'Dev-Modus — Version-Check deaktiviert';
			}
		} catch (e) {
			errorBanner = `Netzwerkfehler: ${(e as Error).message}`;
		} finally {
			loading = false;
		}
	}

	async function dismissRollback() {
		dismissingRollback = true;
		try {
			await fetch('/api/update/ack-rollback', { method: 'POST' });
			await loadStatus();
		} finally {
			dismissingRollback = false;
		}
	}

	$effect(() => {
		loadStatus();
	});
</script>

<div class="max-w-2xl space-y-6">
	{#if status === null}
		<div class="bg-bg-card rounded-lg border border-border p-6 text-text-secondary">
			Lade Version…
		</div>
	{:else}
		<!-- Card 1: Installed version -->
		<div class="bg-bg-card rounded-lg border border-border p-6">
			<h2 class="text-lg font-semibold text-text-primary mb-4">Installierte Version</h2>
			<div class="text-2xl font-mono text-text-primary">{status.current.label}</div>
			<div class="text-xs font-mono text-text-secondary mt-1 break-all">{status.current.sha}</div>

			{#if status.current.isDirty}
				<div
					class="mt-4 bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded flex items-start gap-2"
				>
					<AlertTriangle class="w-5 h-5 flex-shrink-0 mt-0.5" />
					<span>Lokale Änderungen im Installationsverzeichnis — Update blockiert.</span>
				</div>
			{/if}

			{#if status.current.isDev}
				<div
					class="mt-4 bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 px-4 py-3 rounded"
				>
					Dev-Modus — kein Git-Repository erkannt.
				</div>
			{/if}
		</div>

		<!-- Rollback banner (Phase 24) -->
		{#if status.rollbackHappened}
			<div class="bg-orange-500/10 border border-orange-500/30 text-orange-400 px-4 py-3 rounded space-y-2">
				<div class="flex items-start gap-2">
					<RotateCcw class="w-5 h-5 flex-shrink-0 mt-0.5" />
					<div class="space-y-1">
						<div class="font-semibold">Letztes Update wurde zurückgesetzt</div>
						{#if status.rollbackStage}
							<div class="text-sm">
								Rollback-Stufe: {status.rollbackStage === 'stage2' ? 'Snapshot-Restore (Stufe 2)' : 'Git-Reset (Stufe 1)'}
							</div>
						{/if}
						{#if status.rollbackReason}
							<div class="text-sm">Grund: {status.rollbackReason}</div>
						{/if}
					</div>
				</div>
				<div>
					<button
						type="button"
						onclick={dismissRollback}
						disabled={dismissingRollback}
						class="text-sm px-3 py-1.5 bg-orange-500/20 hover:bg-orange-500/30 rounded transition-colors disabled:opacity-50"
					>
						Verstanden
					</button>
				</div>
			</div>
		{/if}

		<!-- Card 2: Auto-Update (Phase 24) -->
		{#if !status.current.isDev && status.autoUpdate}
			<AutoUpdateCard
				initialEnabled={status.autoUpdate.enabled}
				initialHour={status.autoUpdate.hour}
				lastAutoUpdateAt={status.autoUpdate.lastAutoUpdateAt}
			/>
		{/if}

		<!-- Card 3: Update status -->
		<div class="bg-bg-card rounded-lg border border-border p-6 space-y-4">
			<h2 class="text-lg font-semibold text-text-primary">Update-Status</h2>

			<div class="space-y-2 text-sm text-text-secondary">
				<div>
					<span class="text-text-secondary">Zuletzt geprüft:</span>
					<span class="text-text-primary">{formatRelativeTime(status.lastCheckedAt)}</span>
				</div>
				<div>
					<span class="text-text-secondary">Neueste Version auf main:</span>
					<span class="text-text-primary font-mono">{shortSha(status.latestSha)}</span>
				</div>
				{#if status.latestCommitMessage}
					<div class="italic text-text-secondary">"{status.latestCommitMessage}"</div>
				{/if}
				{#if status.latestCommitDate}
					<div class="text-xs">vom {formatRelativeTime(status.latestCommitDate)}</div>
				{/if}
			</div>

			<!-- Status badge -->
			{#if status.current.isDev}
				<div
					class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gray-500/10 border border-gray-500/30 text-gray-400 font-semibold"
				>
					Dev-Modus
				</div>
			{:else if status.current.isDirty}
				<div
					class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-orange-500/10 border border-orange-500/30 text-orange-400 font-semibold"
				>
					<AlertTriangle class="w-4 h-4" />
					Lokale Änderungen — Update blockiert
				</div>
			{:else if status.hasUpdate}
				<div
					class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/30 text-green-400 font-semibold"
				>
					<span class="relative flex h-2 w-2">
						<span class="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping"
						></span>
						<span class="relative inline-flex rounded-full h-2 w-2 bg-green-400"></span>
					</span>
					<ArrowUpCircle class="w-4 h-4" />
					Update verfügbar
				</div>
			{:else if status.latestSha}
				<div
					class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 font-semibold"
				>
					<CheckCircle2 class="w-4 h-4" />
					Auf dem neuesten Stand
				</div>
			{:else}
				<div
					class="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gray-500/10 border border-gray-500/30 text-gray-400 font-semibold"
				>
					Noch nicht geprüft
				</div>
			{/if}

			{#if errorBanner}
				<div
					class="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 px-4 py-3 rounded text-sm"
				>
					{errorBanner}
				</div>
			{/if}

			<div>
				<button
					type="button"
					onclick={checkNow}
					disabled={loading || status.current.isDev}
					class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{#if loading}
						<RefreshCw class="w-4 h-4 animate-spin" />
						Wird geprüft…
					{:else}
						<RefreshCw class="w-4 h-4" />
						Jetzt prüfen
					{/if}
				</button>
			</div>
		</div>

		<!-- Card 4: Update runner -->
		<div class="bg-bg-card rounded-lg border border-border p-6">
			<UpdateRunPanel {status} />
		</div>
	{/if}
</div>
