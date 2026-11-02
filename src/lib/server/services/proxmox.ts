import proxmoxApi from 'proxmox-api';
import { getSettings } from './settings';
import { db } from '$lib/server/db/client';
import { containers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { ContainerInfo, ContainerStatus, CameraType } from '$lib/types';

// Allow self-signed certificates for Proxmox
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Cache node name to avoid repeated API calls
let cachedNodeName: string | null = null;

/**
 * Module-level MAC cache. Keyed by vmid.
 * Populated lazily by listContainers() for uncached vmids, with a one-off fallback
 * in getContainerStatus(). Cleanup happens in listContainers() by diffing live vmids.
 */
const macCache = new Map<number, string>();

/**
 * Parses the `hwaddr=...` value out of a Proxmox LXC net0 config string.
 * Example input: `name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=dhcp,type=veth`
 */
function parseMacFromNet0(net0?: string): string | null {
	if (!net0) return null;
	const match = net0.match(/hwaddr=([0-9A-Fa-f:]{17})/i);
	return match ? match[1].toUpperCase() : null;
}

/**
 * Returns a configured proxmox-api client instance.
 */
export async function getProxmoxClient() {
	const settings = await getSettings('proxmox_');
	if (
		!settings.proxmox_host ||
		!settings.proxmox_token_id ||
		!settings.proxmox_token_secret
	) {
		throw new Error('Proxmox not configured. Fill in all fields.');
	}

	// Strip port from host — proxmox-api adds :8006 automatically
	const host = settings.proxmox_host.replace(/:.*$/, '');

	return proxmoxApi({
		host,
		port: 8006,
		tokenID: settings.proxmox_token_id,
		tokenSecret: settings.proxmox_token_secret
	});
}

/**
 * Gets the first node name from the Proxmox cluster. Cached after first call.
 */
export async function getNodeName(proxmox?: ReturnType<typeof proxmoxApi>): Promise<string> {
	if (cachedNodeName) return cachedNodeName;

	const client = proxmox || (await getProxmoxClient());
	const nodes = await client.nodes.$get();
	if (!nodes || nodes.length === 0) {
		throw new Error('No Proxmox nodes found. Check API token permissions.');
	}

	cachedNodeName = nodes[0].node;
	return cachedNodeName;
}

/**
 * Resets the cached node name (useful for testing).
 */
export function resetNodeCache(): void {
	cachedNodeName = null;
}

/**
 * Creates an LXC container on Proxmox with idempotency check (LXC-07).
 * If VMID already exists, updates config instead of creating a duplicate.
 * Automatically configures VAAPI passthrough after creation.
 */
export async function createContainer(params: {
	vmid: number;
	hostname: string;
	ostemplate: string;
	memory?: number;
	cores?: number;
	cameraName?: string;
	cameraIp?: string;
	cameraType?: string;
}): Promise<{ status: 'created' | 'updated'; vmid: number }> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);
	const settings = await getSettings('proxmox_');
	const bridge = settings.proxmox_bridge || 'vmbr0';
	const storage = settings.proxmox_storage || 'local-lvm';

	// Idempotency check: see if container with this VMID already exists
	const existing = await proxmox.nodes.$(node).lxc.$get();
	const alreadyExists = existing.find((c: { vmid: number }) => c.vmid === params.vmid);

	if (alreadyExists) {
		// Update config instead of creating a duplicate. onboot is set unconditionally so containers from older versions get backfilled on the next config touch.
		const updateParams: Record<string, unknown> = { onboot: 1 };
		if (params.memory) updateParams.memory = params.memory;
		if (params.cores) updateParams.cores = params.cores;

		await proxmox.nodes.$(node).lxc.$(params.vmid).config.$put(updateParams as any);

		// Upsert DB record
		db.insert(containers)
			.values({
				vmid: params.vmid,
				hostname: params.hostname,
				cameraName: params.cameraName || null,
				cameraIp: params.cameraIp || null,
				cameraType: params.cameraType || null,
				status: 'stopped',
				updatedAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: containers.vmid,
				set: {
					hostname: params.hostname,
					cameraName: params.cameraName || null,
					cameraIp: params.cameraIp || null,
					cameraType: params.cameraType || null,
					updatedAt: new Date().toISOString()
				}
			})
			.run();

		return { status: 'updated', vmid: params.vmid };
	}

	// Create new container
	await proxmox.nodes.$(node).lxc.$post({
		vmid: params.vmid,
		hostname: params.hostname,
		ostemplate: params.ostemplate,
		rootfs: `${storage}:4`,
		memory: params.memory || 192,
		cores: params.cores || 1,
		net0: `name=eth0,bridge=${bridge},ip=dhcp`,
		onboot: 1,
		start: false
	} as any);

	// Configure VAAPI passthrough (LXC-02)
	await configureVaapi(node, params.vmid);

	// Insert/upsert container record in local DB
	db.insert(containers)
		.values({
			vmid: params.vmid,
			hostname: params.hostname,
			cameraName: params.cameraName || null,
			cameraIp: params.cameraIp || null,
			cameraType: params.cameraType || null,
			status: 'stopped',
			updatedAt: new Date().toISOString()
		})
		.onConflictDoUpdate({
			target: containers.vmid,
			set: {
				hostname: params.hostname,
				cameraName: params.cameraName || null,
				cameraIp: params.cameraIp || null,
				cameraType: params.cameraType || null,
				updatedAt: new Date().toISOString()
			}
		})
		.run();

	return { status: 'created', vmid: params.vmid };
}

/**
 * Configures VAAPI device passthrough on an LXC container.
 * Uses cgroup2 device allow + bind mount of /dev/dri (same method as proven
 * with Fileflows on Arrow Lake). The PVE dev0 method doesn't work reliably
 * on newer Intel GPUs (Arrow Lake, Lunar Lake).
 */
export async function configureVaapi(node: string, vmid: number): Promise<void> {
	const { connectToProxmox: connectSSH } = await import('./ssh');
	const ssh = await connectSSH();

	try {
		const confPath = `/etc/pve/lxc/${vmid}.conf`;
		// Check if already configured
		const { stdout } = await ssh.execCommand(`grep 'lxc.mount.entry.*dev/dri' ${confPath}`);
		if (stdout && stdout.includes('dev/dri')) {
			return; // Already configured
		}

		// Remove old dev0 style passthrough if present
		await ssh.execCommand(`sed -i '/^dev0:.*renderD128/d' ${confPath}`);

		// Container must be privileged for bind mounts to work
		await ssh.execCommand(`sed -i '/^unprivileged:/d' ${confPath}`);

		// Add cgroup + bind mount (proven method for all Intel GPU generations)
		await ssh.execCommand(
			`echo 'lxc.cgroup2.devices.allow: c 226:* rwm' >> ${confPath} && ` +
			`echo 'lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir' >> ${confPath}`
		);
	} finally {
		ssh.dispose();
	}
}

// ── Container Template Management ─────────────────────
// After first full onboarding (go2rtc + onvif installed), the container is
// cloned as a template. Subsequent containers clone from this template,
// skipping the 3-5 minute package installation.

const TEMPLATE_TAG = 'ipcm-base';

/**
 * Checks if a pre-built camera template exists on Proxmox.
 */
export async function getTemplateVmid(): Promise<number | null> {
	const { connectToProxmox: connectSSH } = await import('./ssh');
	const ssh = await connectSSH();
	try {
		const node = await getNodeName();
		const result = await ssh.execCommand(
			`pct list | grep "${TEMPLATE_TAG}" | awk '{print $1}' | head -1`
		);
		const vmid = parseInt(result.stdout.trim());
		return vmid > 0 ? vmid : null;
	} catch {
		return null;
	} finally {
		ssh.dispose();
	}
}

/**
 * Creates a reusable template from a fully provisioned container.
 * Called after the first successful onboarding.
 */
export async function createTemplateFromContainer(sourceVmid: number): Promise<number | null> {
	const { connectToProxmox: connectSSH } = await import('./ssh');
	const ssh = await connectSSH();
	try {
		const node = await getNodeName();

		// Get next VMID for the template
		const proxmox = await getProxmoxClient();
		const templateVmid = await proxmox.cluster.nextid.$get() as unknown as number;

		// Stop source container
		await ssh.execCommand(`pct stop ${sourceVmid} 2>/dev/null; sleep 2`);

		// Clean camera-specific configs from the source before cloning
		await ssh.execCommand(`pct exec ${sourceVmid} -- bash -c "rm -f /etc/go2rtc/go2rtc.yaml /root/onvif-server/config.yaml /etc/nginx/nginx.conf 2>/dev/null"`);

		// Clone the container
		const cloneResult = await ssh.execCommand(
			`pct clone ${sourceVmid} ${templateVmid} --hostname ${TEMPLATE_TAG} --full`
		);
		if (cloneResult.code && cloneResult.code !== 0) {
			console.error('[template] Clone failed:', cloneResult.stderr);
			// Restart source
			await ssh.execCommand(`pct start ${sourceVmid}`);
			return null;
		}

		// Convert clone to template
		await ssh.execCommand(`pct template ${templateVmid}`);

		// Restart the source container
		await ssh.execCommand(`pct start ${sourceVmid}`);

		console.log(`[template] Created template VMID ${templateVmid} from ${sourceVmid}`);
		return templateVmid;
	} catch (err) {
		console.error('[template] Error:', err);
		return null;
	} finally {
		ssh.dispose();
	}
}

/**
 * Creates a container by cloning from the template.
 * Much faster than fresh install (~10s vs 3-5min).
 */
export async function cloneFromTemplate(params: {
	templateVmid: number;
	vmid: number;
	hostname: string;
	cameraName?: string;
	cameraIp?: string;
	cameraType?: string;
	/**
	 * Override container RAM in MB after cloning. Default (unset) keeps the
	 * template's memory config (192 MB). Phase 18: Bambu A1 transcoding peaks
	 * at ~180 MB (ffmpeg libx264/vaapi encode + node .mjs), so the default is
	 * too tight — pass >= 1024 for A1 to avoid swap thrash + clean exits.
	 */
	memory?: number;
	/**
	 * Override container CPU core count after cloning. Default (unset) keeps
	 * the template's `cores` config (1). Phase 20 bridge LXC needs 2 per
	 * locked decision (P20 §"Bridge sizing: 1024 MB / 2 cores").
	 */
	cores?: number;
	/**
	 * Set Proxmox onboot flag (auto-start after host reboot). Default is 1 —
	 * matches createContainer's behavior so bridges and cams come back online
	 * automatically. Set to 0 for one-shot/throwaway LXCs (e.g. spike runs).
	 */
	onboot?: number;
}): Promise<{ status: 'cloned'; vmid: number }> {
	const { connectToProxmox: connectSSH } = await import('./ssh');
	const ssh = await connectSSH();
	const node = await getNodeName();
	const settings = await getSettings('proxmox_');
	const storage = settings.proxmox_storage || 'local-lvm';

	try {
		const cloneResult = await ssh.execCommand(
			`pct clone ${params.templateVmid} ${params.vmid} --hostname ${params.hostname} --storage ${storage} --full`
		);
		if (cloneResult.code && cloneResult.code !== 0) {
			throw new Error(`Clone failed: ${cloneResult.stderr}`);
		}

		// Apply per-camera RAM override post-clone (template cannot be parameterized).
		if (params.memory && Number.isInteger(params.memory) && params.memory >= 256) {
			const memResult = await ssh.execCommand(
				`pct set ${params.vmid} -memory ${params.memory}`
			);
			if (memResult.code && memResult.code !== 0) {
				throw new Error(`Memory override failed: ${memResult.stderr}`);
			}
		}

		// Apply CPU cores override post-clone.
		if (params.cores && Number.isInteger(params.cores) && params.cores >= 1) {
			const coresResult = await ssh.execCommand(
				`pct set ${params.vmid} -cores ${params.cores}`
			);
			if (coresResult.code && coresResult.code !== 0) {
				throw new Error(`Cores override failed: ${coresResult.stderr}`);
			}
		}

		// Set onboot=1 by default so the container auto-starts after a Proxmox
		// host reboot — matches createContainer's slow-path default. The clone
		// otherwise inherits the template's onboot=0 and would stay stopped on
		// host boot. Pass `onboot: 0` to opt out (e.g. one-shot spike LXCs).
		const onbootValue = params.onboot ?? 1;
		const onbootResult = await ssh.execCommand(
			`pct set ${params.vmid} -onboot ${onbootValue}`
		);
		if (onbootResult.code && onbootResult.code !== 0) {
			throw new Error(`onboot override failed: ${onbootResult.stderr}`);
		}

		// Configure VAAPI passthrough
		await configureVaapi(node, params.vmid);

		// Insert DB record
		db.insert(containers)
			.values({
				vmid: params.vmid,
				hostname: params.hostname,
				cameraName: params.cameraName || null,
				cameraIp: params.cameraIp || null,
				cameraType: params.cameraType || null,
				status: 'stopped',
				updatedAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: containers.vmid,
				set: {
					hostname: params.hostname,
					cameraName: params.cameraName || null,
					cameraIp: params.cameraIp || null,
					cameraType: params.cameraType || null,
					updatedAt: new Date().toISOString()
				}
			})
			.run();

		return { status: 'cloned', vmid: params.vmid };
	} finally {
		ssh.dispose();
	}
}

/**
 * Starts an LXC container.
 */
export async function startContainer(vmid: number): Promise<void> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);

	await proxmox.nodes.$(node).lxc.$(vmid).status.start.$post();

	// Update local DB status
	db.update(containers)
		.set({ status: 'running', updatedAt: new Date().toISOString() })
		.where(eq(containers.vmid, vmid))
		.run();
}

/**
 * Stops an LXC container.
 */
export async function stopContainer(vmid: number): Promise<void> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);

	await proxmox.nodes.$(node).lxc.$(vmid).status.stop.$post();

	// Update local DB status
	db.update(containers)
		.set({ status: 'stopped', updatedAt: new Date().toISOString() })
		.where(eq(containers.vmid, vmid))
		.run();
}

/**
 * Restarts an LXC container.
 */
export async function restartContainer(vmid: number): Promise<void> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);

	await proxmox.nodes.$(node).lxc.$(vmid).status.reboot.$post();

	// Update local DB status
	db.update(containers)
		.set({ status: 'running', updatedAt: new Date().toISOString() })
		.where(eq(containers.vmid, vmid))
		.run();
}

/**
 * Deletes an LXC container. Stops it first if running.
 */
export async function deleteContainer(vmid: number): Promise<void> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);

	// Check if container is running, stop first and wait
	try {
		const status = await proxmox.nodes.$(node).lxc.$(vmid).status.current.$get();
		if (status && (status as any).status === 'running') {
			await proxmox.nodes.$(node).lxc.$(vmid).status.stop.$post();
			// Wait for container to actually stop
			for (let i = 0; i < 15; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				try {
					const s = await proxmox.nodes.$(node).lxc.$(vmid).status.current.$get();
					if ((s as any).status === 'stopped') break;
				} catch { break; }
			}
		}
	} catch {
		// Container may already be stopped or not exist
	}

	await proxmox.nodes.$(node).lxc.$(vmid).$delete();

	// Remove from local DB
	db.delete(containers)
		.where(eq(containers.vmid, vmid))
		.run();
}

/**
 * Lists all containers, merging Proxmox API data with local DB records.
 */
export async function listContainers(): Promise<ContainerInfo[]> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);

	// Get containers from Proxmox API
	const apiContainers = await proxmox.nodes.$(node).lxc.$get();

	// Determine vmids missing from the MAC cache
	const uncachedVmids = apiContainers
		.map((c: any) => c.vmid as number)
		.filter((vmid: number) => !macCache.has(vmid));

	// Fetch configs in parallel; tolerate per-vmid failures
	if (uncachedVmids.length > 0) {
		await Promise.all(
			uncachedVmids.map(async (vmid: number) => {
				try {
					const cfg = await proxmox.nodes.$(node).lxc.$(vmid).config.$get() as any;
					const mac = parseMacFromNet0(cfg?.net0);
					if (mac) macCache.set(vmid, mac);
				} catch {
					// Skip — MAC will resolve to null for this vmid this round
				}
			})
		);
	}

	// Drop cache entries for vmids that no longer exist
	const liveVmids = new Set(apiContainers.map((c: any) => c.vmid as number));
	for (const vmid of macCache.keys()) {
		if (!liveVmids.has(vmid)) macCache.delete(vmid);
	}

	// Get local DB records for camera metadata
	const dbRecords = db.select().from(containers).all();
	const dbMap = new Map(dbRecords.map((r: any) => [r.vmid, r]));

	const result = apiContainers.map((c: any) => {
		const dbRecord = dbMap.get(c.vmid);
		return {
			vmid: c.vmid,
			hostname: c.name || dbRecord?.hostname || `ct-${c.vmid}`,
			cameraName: dbRecord?.cameraName || undefined,
			cameraIp: dbRecord?.cameraIp || undefined,
			cameraType: dbRecord?.cameraType as CameraType | undefined,
			status: (c.status as ContainerStatus) || 'unknown',
			cpu: c.cpu,
			memory: c.maxmem
				? { used: c.mem || 0, total: c.maxmem }
				: undefined,
			mac: macCache.get(c.vmid) ?? null
		} satisfies ContainerInfo;
	});

	result.sort((a, b) => a.vmid - b.vmid);
	return result;
}

/**
 * Gets the status of a single container.
 */
export async function getContainerStatus(vmid: number): Promise<ContainerInfo> {
	const proxmox = await getProxmoxClient();
	const node = await getNodeName(proxmox);

	const status = await proxmox.nodes.$(node).lxc.$(vmid).status.current.$get() as any;

	// Populate MAC from cache; fall back to a one-off config fetch if missing
	if (!macCache.has(vmid)) {
		try {
			const cfg = await proxmox.nodes.$(node).lxc.$(vmid).config.$get() as any;
			const mac = parseMacFromNet0(cfg?.net0);
			if (mac) macCache.set(vmid, mac);
		} catch {
			// Ignore — mac stays null
		}
	}

	// Get local DB record for camera metadata
	const dbRecords = db.select().from(containers).where(eq(containers.vmid, vmid)).all();
	const dbRecord = dbRecords[0] as any;

	return {
		vmid: status.vmid || vmid,
		hostname: status.name || dbRecord?.hostname || `ct-${vmid}`,
		cameraName: dbRecord?.cameraName || undefined,
		cameraIp: dbRecord?.cameraIp || undefined,
		cameraType: dbRecord?.cameraType as CameraType | undefined,
		status: (status.status as ContainerStatus) || 'unknown',
		cpu: status.cpu,
		memory: status.maxmem
			? { used: status.mem || 0, total: status.maxmem }
			: undefined,
		mac: macCache.get(vmid) ?? null
	};
}

/**
 * Validates the Proxmox connection. (From Plan 01)
 */
export async function validateProxmoxConnection(): Promise<{
	valid: boolean;
	error?: string;
	nodeName?: string;
}> {
	try {
		const settings = await getSettings('proxmox_');
		if (
			!settings.proxmox_host ||
			!settings.proxmox_token_id ||
			!settings.proxmox_token_secret
		) {
			return { valid: false, error: 'Proxmox not configured. Fill in all fields.' };
		}

		const proxmox = proxmoxApi({
			host: settings.proxmox_host,
			tokenID: settings.proxmox_token_id,
			tokenSecret: settings.proxmox_token_secret
		});

		const nodes = await proxmox.nodes.$get();
		if (!nodes || nodes.length === 0) {
			return { valid: false, error: 'No nodes found. Check API token permissions.' };
		}

		const nodeName = nodes[0].node;
		// Verify LXC access by listing containers
		await proxmox.nodes.$(nodeName).lxc.$get();

		return { valid: true, nodeName };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('401')) {
			return {
				valid: false,
				error: 'Authentication failed. Verify token ID (format: user@realm!tokenname) and secret.'
			};
		}
		if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
			return { valid: false, error: 'Cannot reach Proxmox host. Check IP/hostname.' };
		}
		return { valid: false, error: `Connection failed: ${message}` };
	}
}
