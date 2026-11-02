<script lang="ts">
	let { currentStep = 0, cameraType = 'mobotix' }: { currentStep: number; cameraType?: string } = $props();

	const mobotixSteps = ['Zugangsdaten', 'Verbindung', 'Container', 'go2rtc', 'ONVIF', 'Verifizieren'];
	const loxoneSteps = ['Zugangsdaten', 'Verbindung', 'Container', 'nginx', 'go2rtc', 'ONVIF', 'Verifizieren'];

	let steps = $derived(cameraType === 'loxone' ? loxoneSteps : mobotixSteps);
</script>

<div class="flex items-center w-full mb-8">
	{#each steps as label, i}
		<div class="flex items-center {i < steps.length - 1 ? 'flex-1' : ''}">
			<div class="flex flex-col items-center">
				<div
					class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
						{i < currentStep
							? 'bg-success text-white'
							: i === currentStep
								? 'bg-accent text-white'
								: 'bg-bg-input text-text-secondary'}"
				>
					{i + 1}
				</div>
				<span class="text-xs mt-1 whitespace-nowrap {i <= currentStep ? 'text-text-primary' : 'text-text-secondary'}">
					{label}
				</span>
			</div>
			{#if i < steps.length - 1}
				<div
					class="flex-1 h-0.5 mx-2 mt-[-1rem]
						{i < currentStep ? 'bg-success' : 'bg-bg-input'}"
				></div>
			{/if}
		</div>
	{/each}
</div>
