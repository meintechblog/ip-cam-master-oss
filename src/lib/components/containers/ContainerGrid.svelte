<script lang="ts">
	import ContainerCard from './ContainerCard.svelte';
	import DeleteConfirmDialog from './DeleteConfirmDialog.svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ContainerInfo } from '$lib/types';

	let { containers = [] }: { containers: ContainerInfo[] } = $props();

	let deleteDialog = $state<{ open: boolean; vmid: number; name: string }>({
		open: false,
		vmid: 0,
		name: ''
	});

	async function handleAction(vmid: number, action: string) {
		if (action === 'delete') {
			const container = containers.find((c) => c.vmid === vmid);
			deleteDialog = {
				open: true,
				vmid,
				name: container?.cameraName || container?.hostname || `ct-${vmid}`
			};
			return;
		}

		try {
			await fetch(`/api/proxmox/containers/${vmid}/${action}`, { method: 'POST' });
			await invalidateAll();
		} catch (err) {
			console.error(`Action ${action} failed for VMID ${vmid}:`, err);
		}
	}

	async function handleDeleteConfirm() {
		try {
			await fetch(`/api/proxmox/containers/${deleteDialog.vmid}`, { method: 'DELETE' });
			deleteDialog = { open: false, vmid: 0, name: '' };
			await invalidateAll();
		} catch (err) {
			console.error(`Delete failed for VMID ${deleteDialog.vmid}:`, err);
		}
	}

	function handleDeleteCancel() {
		deleteDialog = { open: false, vmid: 0, name: '' };
	}
</script>

{#if containers.length === 0}
	<div class="text-center py-12">
		<p class="text-text-secondary">
			Keine Container gefunden. Container werden automatisch erstellt, wenn Kameras eingerichtet
			werden.
		</p>
	</div>
{:else}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each containers as container (container.vmid)}
			<ContainerCard {container} onAction={handleAction} />
		{/each}
	</div>
{/if}

<DeleteConfirmDialog
	open={deleteDialog.open}
	containerName={deleteDialog.name}
	vmid={deleteDialog.vmid}
	onConfirm={handleDeleteConfirm}
	onCancel={handleDeleteCancel}
/>
