// v1.3 Phase 20 — Bridge LXC lifecycle controls.
//
// start/stop/restart update the protect_hub_bridges row and call the
// corresponding Proxmox container actions. getBridgeStatus returns the
// current bridge row or null.
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { protectHubBridges } from '$lib/server/db/schema';
import { startContainer, stopContainer } from '$lib/server/services/proxmox';

export type BridgeRow = typeof protectHubBridges.$inferSelect;

export function getBridgeStatus(): BridgeRow | null {
	return db.select().from(protectHubBridges).get() ?? null;
}

export async function startBridge(): Promise<{ ok: boolean; error?: string }> {
	const bridge = getBridgeStatus();
	if (!bridge) return { ok: false, error: 'No bridge exists' };
	if (bridge.status === 'running') return { ok: true };

	try {
		await startContainer(bridge.vmid);
		db.update(protectHubBridges)
			.set({ status: 'running', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.id, bridge.id))
			.run();
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		db.update(protectHubBridges)
			.set({ status: 'failed', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.id, bridge.id))
			.run();
		return { ok: false, error: message };
	}
}

export async function stopBridge(): Promise<{ ok: boolean; error?: string }> {
	const bridge = getBridgeStatus();
	if (!bridge) return { ok: false, error: 'No bridge exists' };
	if (bridge.status === 'stopped') return { ok: true };

	try {
		await stopContainer(bridge.vmid);
		db.update(protectHubBridges)
			.set({ status: 'stopped', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.id, bridge.id))
			.run();
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

export async function restartBridge(): Promise<{ ok: boolean; error?: string }> {
	const bridge = getBridgeStatus();
	if (!bridge) return { ok: false, error: 'No bridge exists' };

	try {
		await stopContainer(bridge.vmid);
		await startContainer(bridge.vmid);
		db.update(protectHubBridges)
			.set({ status: 'running', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.id, bridge.id))
			.run();
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		db.update(protectHubBridges)
			.set({ status: 'failed', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.id, bridge.id))
			.run();
		return { ok: false, error: message };
	}
}
