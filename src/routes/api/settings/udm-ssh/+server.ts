import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSetting, getSettings } from '$lib/server/services/settings';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NodeSSH } from 'node-ssh';

/** POST — generate SSH key pair and deploy to UDM via password-based SSH */
export const POST: RequestHandler = async () => {
	try {
		const keyPath =
			(await getSetting('udm_ssh_key_path')) || '/opt/ip-cam-master/data/udm_key';

		// Ensure parent directory exists
		mkdirSync(dirname(keyPath), { recursive: true });

		// Generate ed25519 key pair (overwrite if exists)
		execSync(`ssh-keygen -t ed25519 -f ${keyPath} -N "" -q <<< y`, {
			shell: '/bin/bash'
		});

		const publicKey = readFileSync(`${keyPath}.pub`, 'utf-8').trim();

		// Try to deploy the key to the UDM using the saved root password
		const host = await getSetting('unifi_host');
		const password = await getSetting('udm_ssh_password');

		if (host && password) {
			const sshHost = host.replace(/:.*$/, '');
			const ssh = new NodeSSH();
			try {
				// UDM/UDM Pro requires keyboard-interactive auth (not plain password)
				await ssh.connect({
					host: sshHost,
					username: 'root',
					password,
					tryKeyboard: true,
					onKeyboardInteractive(_name: string, _instructions: string, _instructionsLang: string, _prompts: any[], finish: (responses: string[]) => void) {
						finish([password]);
					},
					readyTimeout: 10000
				});
				await ssh.execCommand(`mkdir -p ~/.ssh && chmod 700 ~/.ssh`);
				// Append public key if not already present
				await ssh.execCommand(
					`grep -qF "${publicKey}" ~/.ssh/authorized_keys 2>/dev/null || echo "${publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
				);
				ssh.dispose();
				return json({ success: true, publicKey, deployed: true });
			} catch (deployErr) {
				// Key was generated but couldn't be deployed — return key for manual install
				const msg = deployErr instanceof Error ? deployErr.message : 'Unknown error';
				return json({ success: true, publicKey, deployed: false, deployError: msg });
			}
		}

		return json({ success: true, publicKey, deployed: false, deployError: 'UDM-Zugangsdaten nicht konfiguriert — Key muss manuell installiert werden.' });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ success: false, error: message }, { status: 500 });
	}
};

/** PUT — test SSH connection to UDM */
export const PUT: RequestHandler = async () => {
	try {
		const settings = await getSettings('unifi_');
		const host = settings.unifi_host;
		if (!host) {
			return json({ success: false, error: 'UniFi Host nicht konfiguriert.' }, { status: 400 });
		}

		const sshHost = host.replace(/:.*$/, '');
		const keyPath =
			(await getSetting('udm_ssh_key_path')) || '/opt/ip-cam-master/data/udm_key';

		if (!existsSync(keyPath)) {
			return json(
				{ success: false, error: 'SSH-Key nicht gefunden. Bitte zuerst generieren.' },
				{ status: 400 }
			);
		}

		const ssh = new NodeSSH();
		await ssh.connect({
			host: sshHost,
			username: 'root',
			privateKeyPath: keyPath,
			readyTimeout: 10000
		});

		// Quick connectivity check
		const result = await ssh.execCommand('echo ok');
		ssh.dispose();

		if (result.stdout.trim() === 'ok') {
			return json({ success: true });
		} else {
			return json({ success: false, error: 'Unerwartete Antwort vom UDM.' }, { status: 500 });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return json({ success: false, error: message }, { status: 500 });
	}
};
