import { NodeSSH } from 'node-ssh';
import { getSettings } from './settings';

/**
 * Connects to the Proxmox host via SSH using stored settings.
 * Caller is responsible for calling ssh.dispose() when done.
 */
export async function connectToProxmox(): Promise<NodeSSH> {
	const settings = await getSettings('proxmox_');
	let host = settings.proxmox_host;
	const username = settings.proxmox_ssh_username || 'root';
	const password = settings.proxmox_ssh_password;
	const privateKeyPath = settings.proxmox_ssh_key_path || '/root/.ssh/id_ed25519';

	if (!host) {
		throw new Error('Proxmox host not configured. Set proxmox_host in Settings.');
	}

	// Strip port if present (API uses host:8006, SSH uses port 22)
	host = host.replace(/:.*$/, '');

	const ssh = new NodeSSH();
	if (password) {
		await ssh.connect({ host, username, password });
	} else {
		await ssh.connect({ host, username, privateKeyPath });
	}
	return ssh;
}

/**
 * Regex matching transient D-Bus / systemd failures that fresh LXC containers
 * occasionally throw when a systemctl command lands mid-boot. The container's
 * systemd-dbus socket resets under load (e.g. right after npm install spikes
 * CPU), the request gets torn down, and our command exits non-zero. The error
 * text is stable across systemd versions, so a surface regex is good enough.
 */
const TRANSIENT_DBUS_ERROR =
	/D-Bus connection terminated|Failed to wait for response: Connection reset by peer|Failed to connect to bus|Transport endpoint is not connected/i;

/**
 * Executes a command inside an LXC container via pct exec on the Proxmox host.
 *
 * When the stderr matches a transient D-Bus/systemd race, retry up to 2 times
 * with a 2s backoff before giving up. Keeps non-transient failures loud.
 */
export async function executeOnContainer(
	ssh: NodeSSH,
	vmid: number,
	command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
	const escapedCommand = command.replace(/'/g, "'\\''");
	const maxAttempts = 3;
	let lastError = '';

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await ssh.execCommand(`pct exec ${vmid} -- bash -c '${escapedCommand}'`);
		const code = result.code ?? 0;

		if (code === 0) {
			return { stdout: result.stdout, stderr: result.stderr, code };
		}

		lastError = result.stderr || `Command failed with exit code ${code}`;

		if (attempt < maxAttempts && TRANSIENT_DBUS_ERROR.test(lastError)) {
			await new Promise((r) => setTimeout(r, 2000));
			continue;
		}
		throw new Error(lastError);
	}

	throw new Error(lastError);
}

/**
 * Pushes file content to a path inside an LXC container via pct push.
 */
export async function pushFileToContainer(
	ssh: NodeSSH,
	vmid: number,
	content: string,
	remotePath: string
): Promise<void> {
	const tmpPath = `/tmp/ipcam-${Date.now()}`;

	// Write content to temp file on Proxmox host
	await ssh.execCommand(`cat > ${tmpPath} << 'IPCAMEOF'\n${content}\nIPCAMEOF`);

	// Push to container
	await ssh.execCommand(`pct push ${vmid} ${tmpPath} ${remotePath}`);

	// Clean up temp file
	await ssh.execCommand(`rm ${tmpPath}`);
}

/**
 * Waits for a container to become ready by polling pct exec.
 */
export async function waitForContainerReady(
	ssh: NodeSSH,
	vmid: number,
	timeoutMs: number = 30000
): Promise<boolean> {
	const start = Date.now();
	const interval = 2000;

	while (Date.now() - start < timeoutMs) {
		try {
			const result = await ssh.execCommand(`pct exec ${vmid} -- echo ready`);
			if (result.stdout && result.stdout.includes('ready')) {
				return true;
			}
		} catch {
			// Container not ready yet, continue polling
		}

		await new Promise((resolve) => setTimeout(resolve, interval));
	}

	throw new Error('Container not ready within timeout');
}
