import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock $env/dynamic/private
vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'a'.repeat(32)
	}
}));

// Mock node-ssh
const { mockConnect, mockExecCommand, mockDispose } = vi.hoisted(() => ({
	mockConnect: vi.fn(),
	mockExecCommand: vi.fn(),
	mockDispose: vi.fn()
}));

vi.mock('node-ssh', () => ({
	NodeSSH: class {
		connect = mockConnect;
		execCommand = mockExecCommand;
		dispose = mockDispose;
	}
}));

// Mock settings
const mockGetSettings = vi.fn();
vi.mock('./settings', () => ({
	getSettings: (...args: unknown[]) => mockGetSettings(...args)
}));

// Mock db
vi.mock('$lib/server/db/client', () => ({
	db: {}
}));
vi.mock('$lib/server/db/schema', () => ({
	settings: {},
	containers: {},
	cameras: {}
}));

import { connectToProxmox, executeOnContainer, pushFileToContainer, waitForContainerReady } from './ssh';

describe('ssh service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSettings.mockResolvedValue({
			proxmox_host: '192.0.2.16',
			proxmox_ssh_username: 'root',
			proxmox_ssh_password: 'testpass'
		});
		mockConnect.mockResolvedValue(undefined);
	});

	describe('connectToProxmox', () => {
		it('connects via SSH with correct host/username/password from settings', async () => {
			const ssh = await connectToProxmox();

			expect(mockConnect).toHaveBeenCalledWith({
				host: '192.0.2.16',
				username: 'root',
				password: 'testpass'
			});
			expect(ssh).toBeDefined();
		});

		it('defaults username to root when not set', async () => {
			mockGetSettings.mockResolvedValue({
				proxmox_host: '192.0.2.16',
				proxmox_ssh_password: 'testpass'
			});

			await connectToProxmox();

			expect(mockConnect).toHaveBeenCalledWith(
				expect.objectContaining({ username: 'root' })
			);
		});
	});

	describe('executeOnContainer', () => {
		it('sends correct pct exec command for given vmid', async () => {
			mockExecCommand.mockResolvedValue({
				stdout: 'hello',
				stderr: '',
				code: 0
			});

			const ssh = await connectToProxmox();
			const result = await executeOnContainer(ssh, 200, 'echo hello');

			expect(mockExecCommand).toHaveBeenCalledWith(
				expect.stringContaining('pct exec 200')
			);
			expect(result.stdout).toBe('hello');
			expect(result.code).toBe(0);
		});

		it('throws on non-zero exit code', async () => {
			mockExecCommand.mockResolvedValue({
				stdout: '',
				stderr: 'command not found',
				code: 127
			});

			const ssh = await connectToProxmox();

			await expect(
				executeOnContainer(ssh, 200, 'invalidcmd')
			).rejects.toThrow('command not found');
		});
	});

	describe('pushFileToContainer', () => {
		it('writes temp file, pushes via pct push, and cleans up', async () => {
			mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

			const ssh = await connectToProxmox();
			await pushFileToContainer(ssh, 200, 'file content', '/etc/go2rtc/go2rtc.yaml');

			const calls = mockExecCommand.mock.calls.map((c: unknown[]) => c[0] as string);

			// Should have at least 3 calls: write temp, pct push, rm temp
			expect(calls.length).toBeGreaterThanOrEqual(3);
			// One call should contain pct push
			expect(calls.some((c: string) => c.includes('pct push 200'))).toBe(true);
			// One call should contain rm /tmp/ipcam-
			expect(calls.some((c: string) => c.includes('rm /tmp/ipcam-'))).toBe(true);
		});
	});

	describe('waitForContainerReady', () => {
		it('resolves when container responds with ready', async () => {
			mockExecCommand.mockResolvedValue({
				stdout: 'ready',
				stderr: '',
				code: 0
			});

			const ssh = await connectToProxmox();
			const result = await waitForContainerReady(ssh, 200);

			expect(result).toBe(true);
		});

		it('throws after timeout when container never becomes ready', async () => {
			mockExecCommand.mockRejectedValue(new Error('container not running'));

			const ssh = await connectToProxmox();

			await expect(
				waitForContainerReady(ssh, 200, 3000)
			).rejects.toThrow('Container not ready within timeout');
		}, 10000);
	});
});
