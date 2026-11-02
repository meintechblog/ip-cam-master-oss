<script lang="ts">
	// Thresholds ≥90/75 for warning/danger mirror dashboard convention
	import { HardDrive, MemoryStick, Activity } from 'lucide-svelte';
	import type {
		DiskUsage,
		MemoryUsage,
		ServiceStatus
	} from '$lib/server/services/host-metrics';

	type Props = {
		disk: DiskUsage | null;
		memory: MemoryUsage | null;
		service: ServiceStatus | null;
	};

	let { disk, memory, service }: Props = $props();

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
		if (bytes < 1024 * 1024 * 1024 * 1024)
			return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
	}

	function formatUptime(seconds: number | null): string {
		if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
		if (seconds < 60) return `${Math.floor(seconds)}s`;
		const mins = Math.floor(seconds / 60);
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		const remMins = mins % 60;
		if (hours < 24) return `${hours}h ${remMins}m`;
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h ${remMins}m`;
	}

	function barColor(percent: number): string {
		if (percent >= 90) return 'bg-danger';
		if (percent >= 75) return 'bg-warning';
		return 'bg-accent';
	}

	type ServiceBadge = { label: string; tone: string };

	function serviceBadge(s: ServiceStatus | null): ServiceBadge {
		if (!s) return { label: '—', tone: 'text-text-secondary' };
		switch (s.state) {
			case 'active':
				return { label: 'Aktiv', tone: 'text-success' };
			case 'failed':
				return { label: 'Fehler', tone: 'text-danger' };
			case 'inactive':
				return { label: 'Inaktiv', tone: 'text-warning' };
			case 'activating':
			case 'deactivating':
				return { label: 'Wechselt', tone: 'text-text-secondary' };
			default:
				return { label: '—', tone: 'text-text-secondary' };
		}
	}

	let diskPct = $derived(disk?.percentUsed ?? 0);
	let memPct = $derived(memory?.percentUsed ?? 0);
	let badge = $derived(serviceBadge(service));
</script>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
	<!-- Festplatte -->
	<div class="bg-bg-card rounded-xl p-5 border border-border">
		<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-4 uppercase tracking-wider">
			<HardDrive class="w-3.5 h-3.5" />
			Festplatte
		</div>
		<p class="text-3xl font-bold text-text-primary">
			{disk ? `${disk.percentUsed}%` : '—'}
		</p>
		<div class="mt-3">
			<div class="flex justify-between text-xs text-text-secondary mb-2">
				<span>
					{#if disk}
						{formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
					{:else}
						—
					{/if}
				</span>
			</div>
			<div class="h-2 bg-bg-input rounded-full overflow-hidden">
				<div
					class="h-full rounded-full transition-all duration-500 {barColor(diskPct)}"
					style="width: {Math.min(100, diskPct).toFixed(1)}%"
				></div>
			</div>
		</div>
	</div>

	<!-- Arbeitsspeicher -->
	<div class="bg-bg-card rounded-xl p-5 border border-border">
		<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-4 uppercase tracking-wider">
			<MemoryStick class="w-3.5 h-3.5" />
			Arbeitsspeicher
		</div>
		<p class="text-3xl font-bold text-text-primary">
			{memory ? `${memory.percentUsed}%` : '—'}
		</p>
		<div class="mt-3">
			<div class="flex justify-between text-xs text-text-secondary mb-2">
				<span>
					{#if memory}
						{formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}
					{:else}
						—
					{/if}
				</span>
			</div>
			<div class="h-2 bg-bg-input rounded-full overflow-hidden">
				<div
					class="h-full rounded-full transition-all duration-500 {barColor(memPct)}"
					style="width: {Math.min(100, memPct).toFixed(1)}%"
				></div>
			</div>
		</div>
	</div>

	<!-- ip-cam-master.service -->
	<div class="bg-bg-card rounded-xl p-5 border border-border">
		<div class="flex items-center gap-2 text-text-secondary text-xs font-medium mb-4 uppercase tracking-wider">
			<Activity class="w-3.5 h-3.5" />
			ip-cam-master.service
		</div>
		<p class="text-3xl font-bold {badge.tone}">{badge.label}</p>
		<div class="mt-3 text-xs text-text-secondary">
			{#if service && service.uptimeSeconds !== null}
				Läuft seit {formatUptime(service.uptimeSeconds)}
			{:else if service && service.subState}
				{service.subState}
			{:else}
				—
			{/if}
		</div>
	</div>
</div>
