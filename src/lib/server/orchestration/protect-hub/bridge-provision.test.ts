// v1.3 Phase 20 — Tests for bridge-provision.ts.
// Uses in-memory better-sqlite3 + Drizzle. All external services are mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('$env/dynamic/private', () => ({
	env: { DB_ENCRYPTION_KEY: 'a'.repeat(32) }
}));

const {
	memDbRef,
	mockGetNextVmid,
	mockGetTemplateVmid,
	mockCloneFromTemplate,
	mockCreateContainer,
	mockStartContainer,
	mockCreateTemplateFromContainer,
	mockGetProxmoxClient,
	mockGetNodeName,
	mockConnectToProxmox,
	mockExecuteOnContainer,
	mockPushFileToContainer,
	mockWaitForContainerReady
} = vi.hoisted(() => ({
	memDbRef: {
		db: null as ReturnType<typeof drizzle> | null,
		sqlite: null as Database.Database | null
	},
	mockGetNextVmid: vi.fn(),
	mockGetTemplateVmid: vi.fn(),
	mockCloneFromTemplate: vi.fn(),
	mockCreateContainer: vi.fn(),
	mockStartContainer: vi.fn(),
	mockCreateTemplateFromContainer: vi.fn(),
	mockGetProxmoxClient: vi.fn(),
	mockGetNodeName: vi.fn(),
	mockConnectToProxmox: vi.fn(),
	mockExecuteOnContainer: vi.fn(),
	mockPushFileToContainer: vi.fn(),
	mockWaitForContainerReady: vi.fn()
}));

vi.mock('$lib/server/db/client', () => ({
	get db() {
		return memDbRef.db;
	},
	get sqlite() {
		return memDbRef.sqlite;
	},
	DB_ABS_PATH: ':memory:'
}));

vi.mock('$lib/server/services/onboarding', () => ({
	getNextVmid: mockGetNextVmid
}));

vi.mock('$lib/server/services/proxmox', () => ({
	getTemplateVmid: mockGetTemplateVmid,
	cloneFromTemplate: mockCloneFromTemplate,
	createContainer: mockCreateContainer,
	startContainer: mockStartContainer,
	createTemplateFromContainer: mockCreateTemplateFromContainer,
	getProxmoxClient: mockGetProxmoxClient,
	getNodeName: mockGetNodeName,
	configureVaapi: vi.fn()
}));

vi.mock('$lib/server/services/ssh', () => ({
	connectToProxmox: mockConnectToProxmox,
	executeOnContainer: mockExecuteOnContainer,
	pushFileToContainer: mockPushFileToContainer,
	waitForContainerReady: mockWaitForContainerReady
}));

import * as schema from '../../db/schema';
import { provisionBridge } from './bridge-provision';

function freshDb() {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');

	sqlite.exec(`
		CREATE TABLE protect_hub_bridges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			vmid INTEGER NOT NULL UNIQUE,
			hostname TEXT NOT NULL,
			container_ip TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			last_deployed_yaml_hash TEXT,
			last_reconciled_at TEXT,
			last_health_check_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	// containers table needed by createContainer mock's side-effect path
	sqlite.exec(`
		CREATE TABLE containers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			vmid INTEGER NOT NULL UNIQUE,
			hostname TEXT NOT NULL,
			camera_name TEXT,
			camera_ip TEXT,
			camera_type TEXT,
			status TEXT NOT NULL DEFAULT 'unknown',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	memDbRef.sqlite = sqlite;
	memDbRef.db = drizzle(sqlite, { schema });
}

const mockSshDispose = vi.fn();

function setupDefaultMocks() {
	mockGetNextVmid.mockResolvedValue(2000);
	mockGetTemplateVmid.mockResolvedValue(999); // template exists
	mockCloneFromTemplate.mockResolvedValue({ status: 'cloned', vmid: 2000 });
	mockCreateContainer.mockResolvedValue({ status: 'created', vmid: 2000 });
	mockStartContainer.mockResolvedValue(undefined);
	mockCreateTemplateFromContainer.mockResolvedValue(null);
	mockGetProxmoxClient.mockResolvedValue({
		nodes: {
			$: () => ({
				storage: {
					$: () => ({
						content: {
							$get: () =>
								Promise.resolve([{ volid: 'local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst' }])
						}
					})
				}
			})
		}
	});
	mockGetNodeName.mockResolvedValue('pve');
	mockConnectToProxmox.mockResolvedValue({ dispose: mockSshDispose });
	mockExecuteOnContainer.mockResolvedValue({ stdout: '192.0.2.200 ', stderr: '', code: 0 });
	mockPushFileToContainer.mockResolvedValue(undefined);
	mockWaitForContainerReady.mockResolvedValue(true);

	// Mock global fetch for go2rtc health check
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
	);
}

beforeEach(() => {
	freshDb();
	vi.clearAllMocks();
	setupDefaultMocks();
});

describe('provisionBridge()', () => {
	it('returns existing bridge when status=running (idempotent)', async () => {
		memDbRef.sqlite!.exec(`
			INSERT INTO protect_hub_bridges (vmid, hostname, container_ip, status, created_at, updated_at)
			VALUES (1000, 'protect-hub', '192.0.2.100', 'running', datetime('now'), datetime('now'))
		`);

		const result = await provisionBridge();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bridge.vmid).toBe(1000);
			expect(result.bridge.status).toBe('running');
		}
		// Should not have called any provisioning functions
		expect(mockGetNextVmid).not.toHaveBeenCalled();
		expect(mockCloneFromTemplate).not.toHaveBeenCalled();
	});

	it('cleans up failed bridge and re-provisions', async () => {
		memDbRef.sqlite!.exec(`
			INSERT INTO protect_hub_bridges (vmid, hostname, status, created_at, updated_at)
			VALUES (1500, 'protect-hub', 'failed', datetime('now'), datetime('now'))
		`);

		const result = await provisionBridge();
		expect(result.ok).toBe(true);

		// Failed row should be deleted, new row with vmid 2000 should exist
		const rows = memDbRef.sqlite!.prepare('SELECT * FROM protect_hub_bridges').all() as Array<
			Record<string, unknown>
		>;
		expect(rows).toHaveLength(1);
		expect(rows[0].vmid).toBe(2000);
		expect(rows[0].status).toBe('running');
	});

	it('uses template clone when template exists (fast path)', async () => {
		mockGetTemplateVmid.mockResolvedValue(999);

		const result = await provisionBridge();
		expect(result.ok).toBe(true);
		expect(mockCloneFromTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				templateVmid: 999,
				vmid: 2000,
				hostname: 'protect-hub',
				memory: 1024,
				cores: 2
			})
		);
		expect(mockCreateContainer).not.toHaveBeenCalled();
		// Should NOT fire-and-forget template creation (template already exists)
		expect(mockCreateTemplateFromContainer).not.toHaveBeenCalled();
	});

	it('explicitly restarts go2rtc after pushing the bridge config', async () => {
		// Regression for the cam-2000-streams bug: the per-cam template inherits a
		// running go2rtc service with residual config in memory; `enable --now` is
		// a no-op for already-running services, so without an explicit `restart`
		// the bridge keeps serving the template's streams instead of our hello-world.
		await provisionBridge();

		const calls = mockExecuteOnContainer.mock.calls;
		const systemctlCall = calls.find(
			(call: unknown[]) =>
				typeof call[2] === 'string' && (call[2] as string).includes('systemctl')
		);
		expect(systemctlCall).toBeDefined();
		const cmd = systemctlCall![2] as string;
		expect(cmd).toContain('systemctl daemon-reload');
		expect(cmd).toContain('systemctl restart go2rtc');
	});

	it('does not pass onboot override (cloneFromTemplate default of 1 takes effect)', async () => {
		// UAT-7 regression: bridge LXC must autostart after Proxmox host reboot.
		// `cloneFromTemplate` defaults onboot to 1; we just need to NOT override
		// it to 0. Documents the contract so a future refactor doesn't silently
		// flip the default.
		mockGetTemplateVmid.mockResolvedValue(999);
		await provisionBridge();

		const cloneArgs = mockCloneFromTemplate.mock.calls[0]?.[0] as
			| { onboot?: number }
			| undefined;
		// Either omitted (relies on default=1) or explicitly 1; never 0.
		expect(cloneArgs?.onboot ?? 1).toBe(1);
	});

	it('falls back to createContainer when no template (slow path)', async () => {
		mockGetTemplateVmid.mockResolvedValue(null);

		const result = await provisionBridge();
		expect(result.ok).toBe(true);
		expect(mockCreateContainer).toHaveBeenCalledWith(
			expect.objectContaining({
				vmid: 2000,
				hostname: 'protect-hub',
				memory: 1024,
				cores: 2
			})
		);
		expect(mockCloneFromTemplate).not.toHaveBeenCalled();
		// Should fire-and-forget template creation
		expect(mockCreateTemplateFromContainer).toHaveBeenCalledWith(2000);
	});

	it('sets status=failed on error and returns error message', async () => {
		mockStartContainer.mockRejectedValue(new Error('Proxmox API timeout'));

		const result = await provisionBridge();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('Proxmox API timeout');
		}

		const row = memDbRef.sqlite!
			.prepare('SELECT * FROM protect_hub_bridges')
			.get() as Record<string, unknown>;
		expect(row.status).toBe('failed');
	});

	it(
		'sets status=failed when IP polling fails',
		async () => {
			// Return empty stdout for all IP poll attempts
			mockExecuteOnContainer.mockImplementation(
				async (_ssh: unknown, _vmid: unknown, cmd: string) => {
					if (cmd === 'hostname -I') {
						return { stdout: '', stderr: '', code: 0 };
					}
					return { stdout: '', stderr: '', code: 0 };
				}
			);

			const result = await provisionBridge();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain('Failed to obtain container IP');
			}
		},
		60_000
	);

	it('disposes SSH connection in all cases', async () => {
		mockStartContainer.mockRejectedValue(new Error('fail'));
		await provisionBridge();
		expect(mockSshDispose).toHaveBeenCalled();
	});

	it('deploys bridge config with managed-by stamp', async () => {
		await provisionBridge();

		// pushFileToContainer should have been called with the go2rtc config
		const configCall = mockPushFileToContainer.mock.calls.find(
			(call: unknown[]) => (call[3] as string) === '/etc/go2rtc/go2rtc.yaml'
		);
		expect(configCall).toBeDefined();
		const configContent = configCall![2] as string;
		expect(configContent).toMatch(/^# managed by ip-cam-master, reconcile-id/);
		expect(configContent).toContain('listen: "0.0.0.0:1984"');
		expect(configContent).toContain('ui_editor: false');
	});
});
