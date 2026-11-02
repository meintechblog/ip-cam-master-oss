<script lang="ts">
	import type { CameraCardData, CameraEvent, CamHealthSummary } from '$lib/types';
	import type {
		DiskUsage,
		MemoryUsage,
		ServiceStatus
	} from '$lib/server/services/host-metrics';
	import HealthWidgets from '$lib/components/host/HealthWidgets.svelte';
	import CamHealthStrip from '$lib/components/host/CamHealthStrip.svelte';
	import {
		Loader2,
		CheckCircle,
		AlertTriangle,
		XCircle,
		Monitor,
		Server,
		Radio,
		Shield,
		Activity,
		ArrowRight
	} from 'lucide-svelte';

	let cameras = $state<CameraCardData[]>([]);
	let recentEvents = $state<CameraEvent[]>([]);
	let loading = $state(true);
	let lastUpdate = $state<Date | null>(null);
	let disk = $state<DiskUsage | null>(null);
	let memory = $state<MemoryUsage | null>(null);
	let service = $state<ServiceStatus | null>(null);
	// Quick-task 260531-2zx — cross-cam health ampel, fetched in the existing
	// 10s poll below (no separate timer). One colored dot per managed cam.
	let camHealth = $state<CamHealthSummary[]>([]);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function fetchCameras() {
		try {
			const [cameraRes, eventsRes, metricsRes, healthRes] = await Promise.all([
				fetch('/api/cameras/status'),
				fetch('/api/protect/events?limit=10'),
				fetch('/api/host/metrics'),
				fetch('/api/cameras/health-summary')
			]);
			if (cameraRes.ok) {
				cameras = await cameraRes.json();
				lastUpdate = new Date();
			}
			if (eventsRes.ok) {
				const data = await eventsRes.json();
				recentEvents = data.events || [];
			}
			if (metricsRes.ok) {
				const data = await metricsRes.json();
				disk = data.disk ?? null;
				memory = data.memory ?? null;
				service = data.service ?? null;
			}
			if (healthRes.ok) {
				camHealth = await healthRes.json();
			}
		} catch {
			// retry next poll
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		fetchCameras();
		pollTimer = setInterval(fetchCameras, 10000);
		return () => {
			if (pollTimer) clearInterval(pollTimer);
		};
	});

	// Single-pass stats computation over cameras array
	let stats = $derived(() => {
		let nativeOnvif = 0;
		let containersRunning = 0;
		let containersStopped = 0;
		let containersError = 0;
		let streamsActive = 0;
		let protectAdopted = 0;
		let protectConnected = 0;
		let totalClients = 0;
		let cpuSum = 0;
		let cpuCount = 0;
		let ramUsed = 0;
		let ramTotal = 0;
		const pipelineCameras: CameraCardData[] = [];
		const problems: CameraCardData[] = [];

		for (const c of cameras) {
			const isNative = c.cameraType === 'mobotix-onvif';
			if (isNative) nativeOnvif++;

			if (c.containerStatus === 'running') containersRunning++;
			else if (c.containerStatus === 'stopped') containersStopped++;
			else if (c.containerStatus === 'error') containersError++;

			if (c.streamInfo?.active) streamsActive++;
			if (c.protectStatus?.isAdopted) protectAdopted++;
			if (c.protectStatus?.state === 'CONNECTED') protectConnected++;
			totalClients += c.connectedClients;

			if (c.vmid > 0) {
				pipelineCameras.push(c);
				if (c.lxcCpu !== null) { cpuSum += c.lxcCpu; cpuCount++; }
				ramUsed += c.lxcMemory?.used ?? 0;
				ramTotal += c.lxcMemory?.total ?? 0;

				if (c.containerStatus !== 'running' || !c.go2rtcRunning || !c.streamInfo?.active) {
					problems.push(c);
				}
			}
		}

		const total = cameras.length;
		const pipeline = total - nativeOnvif;
		const avgCpu = cpuCount > 0 ? cpuSum / cpuCount : null;
		const ramPct = ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0;
		const healthStatus: 'good' | 'warn' | 'bad' =
			problems.length === 0 && total > 0 ? 'good' : problems.length <= 1 ? 'warn' : 'bad';

		return {
			total, nativeOnvif, pipeline,
			containersRunning, containersStopped, containersError,
			streamsActive, protectAdopted, protectConnected,
			totalClients, pipelineCameras, problems,
			avgCpu, ramUsed, ramTotal, ramPct, healthStatus
		};
	});

	let total = $derived(stats().total);
	let nativeOnvif = $derived(stats().nativeOnvif);
	let pipeline = $derived(stats().pipeline);
	let containersRunning = $derived(stats().containersRunning);
	let containersStopped = $derived(stats().containersStopped);
	let containersError = $derived(stats().containersError);
	let streamsActive = $derived(stats().streamsActive);
	let protectAdopted = $derived(stats().protectAdopted);
	let protectConnected = $derived(stats().protectConnected);
	let totalClients = $derived(stats().totalClients);
	let pipelineCameras = $derived(stats().pipelineCameras);
	let problems = $derived(stats().problems);
	let healthStatus = $derived(stats().healthStatus);
	let avgCpu = $derived(stats().avgCpu);
	let totalRamUsed = $derived(stats().ramUsed);
	let totalRamTotal = $derived(stats().ramTotal);
	let ramPct = $derived(stats().ramPct);

	function formatBytes(bytes: number): string {
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	function formatTime(date: Date): string {
		return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-text-primary">Dashboard</h1>
		{#if lastUpdate}
			<span class="text-xs text-text-secondary">
				Aktualisiert: {formatTime(lastUpdate)}
			</span>
		{/if}
	</div>

	<!-- Cross-Cam Health Ampel (260531-2zx) — one dot per managed cam, links debug panel -->
	<CamHealthStrip items={camHealth} />

	<!-- Host Vitals (visible in all states: loading, empty, populated) -->
	<HealthWidgets {disk} {memory} {service} />

	{#if loading}
		<div class="flex items-center gap-3 text-text-secondary py-16 justify-center">
			<Loader2 class="w-5 h-5 animate-spin" />
			<span>Status wird geladen...</span>
		</div>
	{:else if total === 0}
		<div class="text-center py-16">
			<Monitor class="w-12 h-12 text-text-secondary mx-auto mb-4 opacity-40" />
			<p class="text-lg text-text-secondary mb-2">Keine Kameras eingerichtet</p>
			<a href="/kameras/onboarding" class="text-accent hover:underline text-sm">
				Erste Kamera hinzufügen
			</a>
		</div>
	{:else}
		<!-- Health Banner -->
		<div class="rounded-xl p-5 border {healthStatus === 'good'
			? 'bg-success/5 border-success/20'
			: healthStatus === 'warn'
				? 'bg-warning/5 border-warning/20'
				: 'bg-danger/5 border-danger/20'}">
			<div class="flex items-center gap-3">
				{#if healthStatus === 'good'}
					<div class="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center">
						<CheckCircle class="w-5 h-5 text-success" />
					</div>
					<div>
						<p class="text-text-primary font-semibold">Alles läuft</p>
						<p class="text-text-secondary text-sm">{total} Kamera{total !== 1 ? 's' : ''} online — keine Probleme</p>
					</div>
				{:else if healthStatus === 'warn'}
					<div class="w-10 h-10 rounded-full bg-warning/15 flex items-center justify-center">
						<AlertTriangle class="w-5 h-5 text-warning" />
					</div>
					<div>
						<p class="text-text-primary font-semibold">{problems.length} Problem{problems.length !== 1 ? 'e' : ''}</p>
						<p class="text-text-secondary text-sm">
							{problems.map((c) => c.name).join(', ')}
						</p>
					</div>
				{:else}
					<div class="w-10 h-10 rounded-full bg-danger/15 flex items-center justify-center">
						<XCircle class="w-5 h-5 text-danger" />
					</div>
					<div>
						<p class="text-text-primary font-semibold">{problems.length} Probleme</p>
						<p class="text-text-secondary text-sm">
							{problems.map((c) => c.name).join(', ')}
						</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- Stat Cards Row -->
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			<!-- Cameras -->
			<div class="bg-bg-card rounded-xl p-4 border border-border">
				<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-3 uppercase tracking-wider">
					<Monitor class="w-3.5 h-3.5" />
					Kameras
				</div>
				<p class="text-3xl font-bold text-text-primary">{total}</p>
				<div class="flex gap-3 mt-2 text-xs text-text-secondary">
					{#if pipeline > 0}
						<span>{pipeline} Pipeline</span>
					{/if}
					{#if nativeOnvif > 0}
						<span>{nativeOnvif} Nativ</span>
					{/if}
				</div>
			</div>

			<!-- Containers -->
			<div class="bg-bg-card rounded-xl p-4 border border-border">
				<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-3 uppercase tracking-wider">
					<Server class="w-3.5 h-3.5" />
					Container
				</div>
				<p class="text-3xl font-bold text-text-primary">{containersRunning}<span class="text-lg text-text-secondary font-normal">/{pipelineCameras.length}</span></p>
				<div class="flex gap-3 mt-2 text-xs">
					{#if containersRunning > 0}
						<span class="text-success">{containersRunning} aktiv</span>
					{/if}
					{#if containersStopped > 0}
						<span class="text-warning">{containersStopped} gestoppt</span>
					{/if}
					{#if containersError > 0}
						<span class="text-danger">{containersError} Fehler</span>
					{/if}
				</div>
			</div>

			<!-- Streams -->
			<div class="bg-bg-card rounded-xl p-4 border border-border">
				<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-3 uppercase tracking-wider">
					<Radio class="w-3.5 h-3.5" />
					Streams
				</div>
				<p class="text-3xl font-bold text-text-primary">{streamsActive}<span class="text-lg text-text-secondary font-normal">/{pipelineCameras.length}</span></p>
				<div class="flex gap-3 mt-2 text-xs text-text-secondary">
					<span>{totalClients} Client{totalClients !== 1 ? 's' : ''} verbunden</span>
				</div>
			</div>

			<!-- UniFi Protect -->
			<div class="bg-bg-card rounded-xl p-4 border border-border">
				<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-3 uppercase tracking-wider">
					<Shield class="w-3.5 h-3.5" />
					UniFi Protect
				</div>
				<p class="text-3xl font-bold text-text-primary">{protectAdopted}<span class="text-lg text-text-secondary font-normal">/{total}</span></p>
				<div class="flex gap-3 mt-2 text-xs">
					{#if protectConnected > 0}
						<span class="text-success">{protectConnected} verbunden</span>
					{/if}
					{#if protectAdopted - protectConnected > 0}
						<span class="text-danger">{protectAdopted - protectConnected} getrennt</span>
					{/if}
					{#if total - protectAdopted > 0}
						<span class="text-text-secondary">{total - protectAdopted} wartend</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- Resource Usage (only if pipeline cameras exist) -->
		{#if pipelineCameras.length > 0}
			<div class="bg-bg-card rounded-xl p-5 border border-border">
				<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-4 uppercase tracking-wider">
					<Activity class="w-3.5 h-3.5" />
					Ressourcen (LXC Container)
				</div>
				<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
					<!-- CPU -->
					<div>
						<div class="flex justify-between text-sm mb-2">
							<span class="text-text-secondary">CPU Durchschnitt</span>
							<span class="text-text-primary font-medium">
								{avgCpu !== null ? `${(avgCpu * 100).toFixed(1)}%` : '—'}
							</span>
						</div>
						<div class="h-2 bg-bg-input rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all duration-500 {(avgCpu ?? 0) > 0.8 ? 'bg-danger' : (avgCpu ?? 0) > 0.5 ? 'bg-warning' : 'bg-accent'}"
								style="width: {((avgCpu ?? 0) * 100).toFixed(1)}%"
							></div>
						</div>
					</div>
					<!-- RAM -->
					<div>
						<div class="flex justify-between text-sm mb-2">
							<span class="text-text-secondary">RAM Gesamt</span>
							<span class="text-text-primary font-medium">
								{totalRamTotal > 0
									? `${formatBytes(totalRamUsed)} / ${formatBytes(totalRamTotal)}`
									: '—'}
							</span>
						</div>
							<div class="h-2 bg-bg-input rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all duration-500 {ramPct > 80 ? 'bg-danger' : ramPct > 50 ? 'bg-warning' : 'bg-accent'}"
								style="width: {ramPct.toFixed(1)}%"
							></div>
						</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Letzte Ereignisse -->
		<div class="bg-bg-card rounded-xl border border-border overflow-hidden">
			<div class="px-5 py-4 border-b border-border flex items-center justify-between">
				<span class="text-text-secondary text-xs font-medium uppercase tracking-wider">Letzte Ereignisse</span>
				<a href="/logs" class="text-xs text-accent hover:underline">Alle anzeigen</a>
			</div>
			{#if recentEvents.length === 0}
				<div class="px-5 py-6 text-center text-text-secondary text-sm">
					Keine Ereignisse
				</div>
			{:else}
				<div class="divide-y divide-border/50">
					{#each recentEvents as event (event.id)}
						<div class="px-5 py-3 flex items-center gap-3 text-sm">
							<!-- Severity icon -->
							{#if event.severity === 'error'}
								<XCircle class="w-4 h-4 text-danger shrink-0" />
							{:else if event.severity === 'warning'}
								<AlertTriangle class="w-4 h-4 text-warning shrink-0" />
							{:else}
								<CheckCircle class="w-4 h-4 text-success shrink-0" />
							{/if}
							<!-- Timestamp -->
							<span class="text-text-secondary text-xs font-mono shrink-0">
								{new Date(event.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
							</span>
							<!-- Camera name -->
							<span class="text-text-primary text-xs font-medium shrink-0">
								{event.cameraName || 'System'}
							</span>
							<!-- Message -->
							<span class="text-text-secondary text-xs truncate">
								{event.message}
							</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Camera Status Table -->
		<div class="bg-bg-card rounded-xl border border-border overflow-hidden">
			<div class="px-5 py-4 border-b border-border flex items-center justify-between">
				<span class="text-text-secondary text-xs font-medium uppercase tracking-wider">Kamera-Übersicht</span>
				<a href="/kameras" class="text-xs text-accent hover:underline flex items-center gap-1">
					Alle Kameras <ArrowRight class="w-3 h-3" />
				</a>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-text-secondary text-xs uppercase tracking-wider border-b border-border">
							<th class="text-left px-5 py-3 font-medium">Status</th>
							<th class="text-left px-5 py-3 font-medium">Name</th>
							<th class="text-left px-5 py-3 font-medium">IP</th>
							<th class="text-left px-5 py-3 font-medium">Typ</th>
							<th class="text-left px-5 py-3 font-medium">Container</th>
							<th class="text-left px-5 py-3 font-medium">go2rtc</th>
							<th class="text-left px-5 py-3 font-medium">Stream</th>
							<th class="text-left px-5 py-3 font-medium">UniFi</th>
						</tr>
					</thead>
					<tbody>
						{#each cameras as cam (cam.id)}
							{@const isNative = cam.cameraType === 'mobotix-onvif'}
							{@const allGood = isNative || (cam.containerStatus === 'running' && cam.go2rtcRunning && cam.streamInfo?.active)}
							<tr class="border-b border-border/50 hover:bg-bg-input/30 transition-colors">
								<!-- Overall status dot -->
								<td class="px-5 py-3">
									<span class="inline-block w-2.5 h-2.5 rounded-full {allGood ? 'bg-success' : 'bg-danger'} {allGood ? 'shadow-[0_0_6px_rgba(34,197,94,0.4)]' : 'shadow-[0_0_6px_rgba(239,68,68,0.4)]'}"></span>
								</td>
								<!-- Name -->
								<td class="px-5 py-3 text-text-primary font-medium">
									{cam.name}
									{#if cam.flapping}
										<span class="text-xs px-1.5 py-0.5 rounded bg-warning/15 text-warning ml-1.5">instabil</span>
									{/if}
								</td>
								<!-- IP -->
								<td class="px-5 py-3 text-text-secondary font-mono text-xs">{cam.cameraIp}</td>
								<!-- Type -->
								<td class="px-5 py-3">
									{#if cam.cameraType === 'mobotix-onvif'}
										<span class="text-xs px-2 py-0.5 rounded-full bg-success/10 text-success">ONVIF</span>
									{:else if cam.cameraType === 'mobotix'}
										<span class="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">Mobotix</span>
									{:else if cam.cameraType === 'loxone'}
										<span class="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400">Loxone</span>
									{:else}
										<span class="text-xs text-text-secondary">{cam.cameraType}</span>
									{/if}
								</td>
								<!-- Container -->
								<td class="px-5 py-3">
									{#if isNative}
										<span class="text-xs text-text-secondary">—</span>
									{:else if cam.containerStatus === 'running'}
										<span class="text-xs text-success">aktiv</span>
									{:else if cam.containerStatus === 'stopped'}
										<span class="text-xs text-warning">gestoppt</span>
									{:else}
										<span class="text-xs text-danger">Fehler</span>
									{/if}
								</td>
								<!-- go2rtc -->
								<td class="px-5 py-3">
									{#if isNative}
										<span class="text-xs text-text-secondary">—</span>
									{:else if cam.go2rtcRunning}
										<span class="text-xs text-success">ok</span>
									{:else}
										<span class="text-xs text-danger">down</span>
									{/if}
								</td>
								<!-- Stream -->
								<td class="px-5 py-3">
									{#if isNative}
										<span class="text-xs text-success">nativ</span>
									{:else if cam.streamInfo?.active}
										<span class="text-xs text-success">aktiv</span>
									{:else}
										<span class="text-xs text-danger">inaktiv</span>
									{/if}
								</td>
								<!-- UniFi -->
								<td class="px-5 py-3">
									{#if cam.protectStatus?.isAdopted && cam.protectStatus?.state === 'CONNECTED'}
										<span class="text-xs text-success">adoptiert</span>
									{:else if cam.protectStatus?.isAdopted && cam.protectStatus?.state !== 'CONNECTED'}
										<span class="text-xs text-danger">getrennt</span>
									{:else if cam.protectConfigured}
										<span class="text-xs text-warning">nicht adoptiert</span>
									{:else}
										<span class="text-xs text-text-secondary">—</span>
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
