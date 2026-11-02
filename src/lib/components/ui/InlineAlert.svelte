<script lang="ts">
	import { CheckCircle, AlertCircle, Info } from 'lucide-svelte';
	import { slide } from 'svelte/transition';

	let { type, message }: { type: 'success' | 'error' | 'info'; message: string } = $props();

	const styles = {
		success: 'border-success/40 bg-success/10 text-success',
		error: 'border-danger/40 bg-danger/10 text-danger',
		info: 'border-accent/40 bg-accent/10 text-accent'
	};

	const icons = {
		success: CheckCircle,
		error: AlertCircle,
		info: Info
	};

	let Icon = $derived(icons[type]);
</script>

<div
	transition:slide={{ duration: 200 }}
	class="flex items-center gap-2 border rounded-lg px-3 py-2 text-sm {styles[type]}"
>
	<Icon class="w-4 h-4 shrink-0" />
	<span>{message}</span>
</div>
