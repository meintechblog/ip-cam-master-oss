<script lang="ts">
	import {
		Download,
		Loader2,
		CheckCircle2,
		XCircle,
		RotateCcw,
		AlertTriangle,
		Clock
	} from 'lucide-svelte';
	import UpdateStageStepper, { type StageName, type StageState } from './UpdateStageStepper.svelte';
	import ReconnectOverlay from './ReconnectOverlay.svelte';
	import InstallModal, { type PreflightShape } from './InstallModal.svelte';

	type VersionCurrent = {
		label: string;
		sha: string;
		tag: string | null;
		isDev: boolean;
		isDirty: boolean;
	};

	type StoredUpdateStatusShape = {
		current: VersionCurrent;
		lastCheckedAt: string | null;
		latestSha: string | null;
		latestCommitDate: string | null;
		latestCommitMessage: string | null;
		lastError: string | null;
		hasUpdate: boolean;
	};

	type RunInfo = {
		logPath: string;
		exitcodeFile: string;
		unitName: string;
		startedAt: string;
	};

	type UpdateRunEntry = {
		startedAt: string;
		finishedAt: string | null;
		preSha: string;
		postSha: string | null;
		result: 'running' | 'success' | 'failed' | 'rolled_back';
		logPath: string;
		unitName: string;
		trigger?: 'manual' | 'auto';
	};

	type DoneResult = { exitCode: number; result: string; postSha: string | null };

	const { status }: { status: StoredUpdateStatusShape } = $props();

	let runState = $state<'idle' | 'starting' | 'running' | 'success' | 'failed' | 'rolled_back'>(
		'idle'
	);
	let logLines = $state<string[]>([]);
	let runInfo = $state<RunInfo | null>(null);
	let doneResult = $state<DoneResult | null>(null);
	let errorBanner = $state<string | null>(null);
	let history = $state<UpdateRunEntry[]>([]);
	let preflight = $state<PreflightShape | null>(null);
	let modalOpen = $state(false);
	let showReconnect = $state(false);
	let currentStage = $state<StageName | null>(null);
	let stageStatuses = $state<Partial<Record<StageName, StageState>>>({});

	let eventSource: EventSource | null = null;
	let logPanel = $state<HTMLPreElement | null>(null);

	function buttonDisabled(): boolean {
		if (status.current.isDirty) return true;
		if (!status.hasUpdate) return true;
		if (runState === 'starting' || runState === 'running') return true;
		return false;
	}

	function buttonTooltip(): string {
		if (status.current.isDirty) return 'Lokale Änderungen — Update blockiert';
		if (!status.hasUpdate) return 'Keine Updates verfügbar';
		return '';
	}

	function shortSha(sha: string | null | undefined): string {
		if (!sha) return '—';
		return sha.slice(0, 7);
	}

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '—';
		try {
			const d = new Date(iso);
			const dd = String(d.getDate()).padStart(2, '0');
			const mm = String(d.getMonth() + 1).padStart(2, '0');
			const yy = d.getFullYear();
			const hh = String(d.getHours()).padStart(2, '0');
			const mi = String(d.getMinutes()).padStart(2, '0');
			return `${dd}.${mm}.${yy} ${hh}:${mi}`;
		} catch {
			return iso;
		}
	}

	function parseStageMarker(line: string): StageName | null {
		const m = line.match(
			/\[stage=(preflight|snapshot|drain|stop|fetch|install|build|start|verify)\]/
		);
		return (m?.[1] as StageName) ?? null;
	}

	async function loadHistory() {
		try {
			const res = await fetch('/api/update/run/history');
			if (res.ok) {
				history = (await res.json()) as UpdateRunEntry[];
			}
		} catch {
			/* ignore */
		}
	}

	function closeStream() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	function openStream(info: RunInfo) {
		closeStream();
		logLines = [];
		stageStatuses = {};
		currentStage = null;
		showReconnect = false;
		const url = `/api/update/run/stream?logPath=${encodeURIComponent(info.logPath)}&exitcodeFile=${encodeURIComponent(info.exitcodeFile)}`;
		const es = new EventSource(url);
		eventSource = es;

		es.addEventListener('open', () => {
			logLines = [];
			runState = 'running';
		});

		es.addEventListener('log', (e: MessageEvent) => {
			try {
				const { line } = JSON.parse(e.data) as { line: string };
				logLines = [...logLines, line].slice(-1000);
				const next = parseStageMarker(line);
				if (next) {
					if (currentStage && currentStage !== next) {
						stageStatuses = { ...stageStatuses, [currentStage]: 'done' };
					}
					currentStage = next;
				}
				if (line.includes('rolled back stage1')) {
					stageStatuses = { ...stageStatuses, [currentStage ?? 'verify']: 'rolled_back' };
				}
				if (line.includes('rolled back stage2')) {
					stageStatuses = { ...stageStatuses, [currentStage ?? 'verify']: 'rolled_back' };
				}
			} catch {
				/* ignore */
			}
		});

		es.addEventListener('done', (e: MessageEvent) => {
			try {
				const parsed = JSON.parse(e.data) as DoneResult;
				doneResult = parsed;
				runState = parsed.result as typeof runState;
				if (parsed.result === 'success' && currentStage) {
					stageStatuses = { ...stageStatuses, [currentStage]: 'done' };
				} else if (parsed.result === 'failed' && currentStage) {
					stageStatuses = { ...stageStatuses, [currentStage]: 'failed' };
				}
			} catch {
				runState = 'failed';
			}
			closeStream();
			showReconnect = false;
			loadHistory();
		});

		es.onerror = () => {
			// SSE drop while running install — show reconnect overlay so the
			// user knows we're waiting for the new server to come up.
			if (runState === 'running' && currentStage && ['stop', 'start', 'verify'].includes(currentStage)) {
				showReconnect = true;
			}
		};
	}

	async function fetchPreflight(): Promise<PreflightShape | null> {
		try {
			const res = await fetch('/api/update/run-preflight');
			if (!res.ok) return null;
			return (await res.json()) as PreflightShape;
		} catch {
			return null;
		}
	}

	async function startUpdateClick() {
		errorBanner = null;
		preflight = await fetchPreflight();
		if (!preflight) {
			errorBanner = 'Pre-flight konnte nicht geladen werden';
			return;
		}
		modalOpen = true;
	}

	async function confirmInstall(overrideConflicts: boolean) {
		modalOpen = false;
		runState = 'starting';
		doneResult = null;
		logLines = [];

		try {
			const res = await fetch('/api/update/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ignoreConflicts: overrideConflicts })
			});

			if (!res.ok) {
				let body: { error?: string; dirtyFiles?: string[]; conflicts?: { detail: string }[] } = {};
				try {
					body = await res.json();
				} catch {
					/* empty */
				}
				switch (body.error) {
					case 'localhost_only':
						errorBanner = 'Update kann nur lokal ausgelöst werden (localhost-Schutz)';
						break;
					case 'dev_mode':
						errorBanner = 'Dev-Modus — Update deaktiviert';
						break;
					case 'dirty_tree':
						errorBanner = `Lokale Änderungen: ${(body.dirtyFiles ?? []).join(', ')}`;
						break;
					case 'already_up_to_date':
						errorBanner = 'Bereits auf dem neuesten Stand';
						break;
					case 'active_flows':
						errorBanner = `Aktive Vorgänge: ${(body.conflicts ?? []).map((c) => c.detail).join('; ')}`;
						break;
					default:
						errorBanner = `Fehler: ${body.error ?? res.statusText}`;
				}
				runState = 'idle';
				return;
			}

			runInfo = (await res.json()) as RunInfo;
			openStream(runInfo);
		} catch (e) {
			errorBanner = `Netzwerkfehler: ${(e as Error).message}`;
			runState = 'idle';
		}
	}

	function onReconnectComplete(_newSha: string) {
		showReconnect = false;
		loadHistory();
	}

	$effect(() => {
		void logLines.length;
		if (logPanel) {
			logPanel.scrollTop = logPanel.scrollHeight;
		}
	});

	$effect(() => {
		loadHistory().then(() => {
			const latest = history[0];
			if (latest && latest.result === 'running') {
				const resumedInfo: RunInfo = {
					logPath: latest.logPath,
					exitcodeFile: latest.logPath.replace(/\.log$/, '.exitcode'),
					unitName: latest.unitName,
					startedAt: latest.startedAt
				};
				runInfo = resumedInfo;
				openStream(resumedInfo);
			}
		});

		return () => {
			closeStream();
		};
	});
</script>

<div class="space-y-4">
	<h2 class="text-lg font-semibold text-text-primary">Update ausführen</h2>

	{#if !status.current.isDev}
		<div>
			<button
				type="button"
				onclick={startUpdateClick}
				disabled={buttonDisabled()}
				title={buttonTooltip()}
				class="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{#if runState === 'starting' || runState === 'running'}
					<Loader2 class="w-4 h-4 animate-spin" />
					Update läuft…
				{:else}
					<Download class="w-4 h-4" />
					Jetzt updaten
				{/if}
			</button>
		</div>
	{/if}

	{#if errorBanner}
		<div
			class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded text-sm flex items-start gap-2"
		>
			<AlertTriangle class="w-5 h-5 flex-shrink-0 mt-0.5" />
			<span>{errorBanner}</span>
		</div>
	{/if}

	{#if runState !== 'idle'}
		<div class="space-y-3">
			<UpdateStageStepper currentStage={currentStage} statuses={stageStatuses} />

			<pre
				bind:this={logPanel}
				class="bg-black/60 border border-border text-xs text-green-300 font-mono p-4 rounded max-h-96 overflow-auto whitespace-pre-wrap break-all">{logLines.join('\n')}</pre>

			{#if doneResult}
				{#if doneResult.result === 'success'}
					<div
						class="bg-green-500/10 border border-green-500/30 text-green-400 px-4 py-3 rounded flex items-start gap-2"
					>
						<CheckCircle2 class="w-5 h-5 flex-shrink-0 mt-0.5" />
						<span>
							Update erfolgreich ({shortSha(history[0]?.preSha)} → {shortSha(
								doneResult.postSha ?? history[0]?.postSha ?? null
							)})
						</span>
					</div>
				{:else if doneResult.result === 'rolled_back'}
					<div
						class="bg-orange-500/10 border border-orange-500/30 text-orange-400 px-4 py-3 rounded flex items-start gap-2"
					>
						<RotateCcw class="w-5 h-5 flex-shrink-0 mt-0.5" />
						<span>
							Update fehlgeschlagen — zurückgesetzt auf {shortSha(history[0]?.preSha)}
						</span>
					</div>
				{:else}
					<div
						class="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded flex items-start gap-2"
					>
						<XCircle class="w-5 h-5 flex-shrink-0 mt-0.5" />
						<span>Update fehlgeschlagen</span>
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	{#if history.length > 0}
		<div class="space-y-2 pt-4 border-t border-border">
			<h3 class="text-sm font-semibold text-text-primary">Letzte Updates</h3>
			<div class="overflow-x-auto">
				<table class="w-full text-xs">
					<thead>
						<tr class="text-left text-text-secondary border-b border-border">
							<th class="py-2 pr-2">Zeitpunkt</th>
							<th class="py-2 pr-2">SHA</th>
							<th class="py-2 pr-2">Auslöser</th>
							<th class="py-2">Ergebnis</th>
						</tr>
					</thead>
					<tbody>
						{#each history.slice(0, 10) as entry (entry.unitName)}
							<tr class="border-b border-border/50">
								<td class="py-2 pr-2 text-text-secondary">{formatTimestamp(entry.startedAt)}</td>
								<td class="py-2 pr-2 font-mono text-text-secondary">
									{shortSha(entry.preSha)} → {shortSha(entry.postSha)}
								</td>
								<td class="py-2 pr-2">
									{#if entry.trigger === 'auto'}
										<span class="inline-flex items-center gap-1 text-blue-400 text-xs">
											<Clock class="w-3 h-3" /> auto
										</span>
									{:else}
										<span class="text-text-secondary text-xs">manuell</span>
									{/if}
								</td>
								<td class="py-2">
									{#if entry.result === 'success'}
										<span class="inline-flex items-center gap-1 text-green-400">
											<CheckCircle2 class="w-3 h-3" /> Erfolg
										</span>
									{:else if entry.result === 'rolled_back'}
										<span class="inline-flex items-center gap-1 text-orange-400">
											<RotateCcw class="w-3 h-3" /> Zurückgesetzt
										</span>
									{:else if entry.result === 'failed'}
										<span class="inline-flex items-center gap-1 text-red-400">
											<XCircle class="w-3 h-3" /> Fehler
										</span>
									{:else}
										<span class="inline-flex items-center gap-1 text-blue-400">
											<Loader2 class="w-3 h-3 animate-spin" /> Läuft
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

{#if modalOpen && preflight}
	<InstallModal
		{preflight}
		onConfirm={confirmInstall}
		onClose={() => (modalOpen = false)}
	/>
{/if}

{#if showReconnect && status.current.sha}
	<ReconnectOverlay
		startSha={status.current.sha}
		expectedSha={preflight?.target.sha ?? null}
		onComplete={onReconnectComplete}
	/>
{/if}
