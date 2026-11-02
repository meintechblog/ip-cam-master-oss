// v1.3 Phase 20 — Bridge LXC provisioning orchestration.
//
// provisionBridge() creates the single shared bridge container, deploys
// a hello-world go2rtc config with the YAML idempotency stamp (L-8),
// and returns the bridge row. Idempotent: existing running bridge is
// returned without side effects; failed rows are cleaned up and re-provisioned.
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { protectHubBridges } from '$lib/server/db/schema';
import { getNextVmid } from '$lib/server/services/onboarding';
import {
	createContainer,
	cloneFromTemplate,
	startContainer,
	getTemplateVmid,
	createTemplateFromContainer,
	getProxmoxClient,
	getNodeName
} from '$lib/server/services/proxmox';
import {
	connectToProxmox,
	executeOnContainer,
	pushFileToContainer,
	waitForContainerReady
} from '$lib/server/services/ssh';
import {
	generateBridgeConfig,
	generateBridgeSystemdUnit,
	getInstallCommands
} from '$lib/server/services/go2rtc';

const BRIDGE_HOSTNAME = 'protect-hub';
const BRIDGE_MEMORY = 1024;
const BRIDGE_CORES = 2;
const IP_POLL_ATTEMPTS = 15;
const IP_POLL_INTERVAL_MS = 2000;

export type ProvisionResult =
	| { ok: true; bridge: typeof protectHubBridges.$inferSelect }
	| { ok: false; error: string };

export async function provisionBridge(): Promise<ProvisionResult> {
	// Idempotency: return existing running bridge
	const existing = db.select().from(protectHubBridges).all();
	const running = existing.find((b) => b.status === 'running');
	if (running) return { ok: true, bridge: running };

	// Clean up failed attempts
	const failed = existing.find((b) => b.status === 'failed');
	if (failed) {
		db.delete(protectHubBridges).where(eq(protectHubBridges.id, failed.id)).run();
	}

	// Also clean up any other non-running row (e.g. stale 'provisioning')
	const stale = existing.find((b) => b.status !== 'running' && b.id !== failed?.id);
	if (stale) {
		db.delete(protectHubBridges).where(eq(protectHubBridges.id, stale.id)).run();
	}

	const vmid = await getNextVmid();
	const now = new Date().toISOString();

	// Insert provisioning row
	db.insert(protectHubBridges)
		.values({
			vmid,
			hostname: BRIDGE_HOSTNAME,
			status: 'provisioning',
			createdAt: now,
			updatedAt: now
		})
		.run();

	const ssh = await connectToProxmox();
	try {
		// Try template clone (fast path) or raw create (slow path)
		const templateVmid = await getTemplateVmid();
		if (templateVmid) {
			await cloneFromTemplate({
				templateVmid,
				vmid,
				hostname: BRIDGE_HOSTNAME,
				memory: BRIDGE_MEMORY,
				cores: BRIDGE_CORES,
				cameraName: 'Protect Hub Bridge',
				cameraType: 'protect-hub'
			});
		} else {
			const proxmox = await getProxmoxClient();
			const node = await getNodeName(proxmox);
			// Fetch available templates for ostemplate
			const templates = await proxmox.nodes.$(node).storage.$('local').content.$get({ content: 'vztmpl' });
			const debian = (templates as Array<{ volid: string }>).find(
				(t) => t.volid.includes('debian-13') || t.volid.includes('debian-12')
			);
			if (!debian) throw new Error('No Debian template found in Proxmox local storage');

			await createContainer({
				vmid,
				hostname: BRIDGE_HOSTNAME,
				ostemplate: debian.volid,
				memory: BRIDGE_MEMORY,
				cores: BRIDGE_CORES,
				cameraName: 'Protect Hub Bridge',
				cameraType: 'protect-hub'
			});
		}

		// Start container
		await startContainer(vmid);
		await waitForContainerReady(ssh, vmid);

		// Install go2rtc if not from template (template already has ffmpeg + go2rtc)
		if (!templateVmid) {
			const commands = getInstallCommands(false);
			for (const cmd of commands) {
				const result = await executeOnContainer(ssh, vmid, cmd);
				if (result.code !== 0) {
					throw new Error(`Install command failed: ${cmd}\nstderr: ${result.stderr}`);
				}
			}
		}

		// Deploy go2rtc config
		const config = generateBridgeConfig();
		await executeOnContainer(ssh, vmid, 'mkdir -p /etc/go2rtc');
		await pushFileToContainer(ssh, vmid, config, '/etc/go2rtc/go2rtc.yaml');

		// Deploy systemd unit
		const unit = generateBridgeSystemdUnit();
		await pushFileToContainer(ssh, vmid, unit, '/etc/systemd/system/go2rtc.service');
		// `enable --now` is a no-op for already-running services. The clone-from-template
		// path inherits a started go2rtc with the template's residual config in memory,
		// so we must `restart` to force the process to re-read /etc/go2rtc/go2rtc.yaml.
		// Without this, the bridge serves whatever streams the source template was
		// configured for instead of our hello-world `test:` stream.
		await executeOnContainer(
			ssh,
			vmid,
			'systemctl daemon-reload && systemctl enable go2rtc && systemctl restart go2rtc'
		);

		// Poll for container IP
		let containerIp: string | null = null;
		for (let i = 0; i < IP_POLL_ATTEMPTS; i++) {
			const ipResult = await executeOnContainer(ssh, vmid, 'hostname -I');
			const ip = ipResult.stdout.trim().split(/\s+/)[0];
			if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
				containerIp = ip;
				break;
			}
			await new Promise((r) => setTimeout(r, IP_POLL_INTERVAL_MS));
		}

		if (!containerIp) {
			throw new Error('Failed to obtain container IP after polling');
		}

		// Verify go2rtc health
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			await fetch(`http://${containerIp}:1984/api/streams`, { signal: controller.signal });
			clearTimeout(timeout);
		} catch {
			throw new Error(`go2rtc not responding on ${containerIp}:1984`);
		}

		// Update bridge row to running
		db.update(protectHubBridges)
			.set({ containerIp, status: 'running', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.vmid, vmid))
			.run();

		// Fire-and-forget: create template if none existed
		if (!templateVmid) {
			createTemplateFromContainer(vmid).catch(() => {});
		}

		const bridge = db
			.select()
			.from(protectHubBridges)
			.where(eq(protectHubBridges.vmid, vmid))
			.get();
		return { ok: true, bridge: bridge! };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		db.update(protectHubBridges)
			.set({ status: 'failed', updatedAt: new Date().toISOString() })
			.where(eq(protectHubBridges.vmid, vmid))
			.run();
		return { ok: false, error: message };
	} finally {
		ssh.dispose();
	}
}
