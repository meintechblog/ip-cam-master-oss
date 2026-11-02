import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock $env/dynamic/private
vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'a'.repeat(32)
	}
}));

// Mock the settings module
const mockGetSettings = vi.fn();
vi.mock('./settings', () => ({
	getSettings: (...args: unknown[]) => mockGetSettings(...args)
}));

// Mock the SSH layer (VAAPI passthrough is configured over SSH, not the API)
const mockSshExec = vi.fn();
const mockSshDispose = vi.fn();
vi.mock('./ssh', () => ({
	connectToProxmox: async () => ({ execCommand: mockSshExec, dispose: mockSshDispose })
}));

// Mock proxmox-api
const mockNodesGet = vi.fn();
const mockLxcGet = vi.fn();
const mockLxcPost = vi.fn();
const mockConfigPut = vi.fn();
const mockLxcDelete = vi.fn();
const mockStartPost = vi.fn();
const mockStopPost = vi.fn();
const mockRebootPost = vi.fn();
const mockStatusCurrentGet = vi.fn();
const mockProxmoxApi = vi.fn();

vi.mock('proxmox-api', () => ({
	default: (...args: unknown[]) => mockProxmoxApi(...args)
}));

// Mock db client with in-memory SQLite
const mockDbInsert = vi.fn();
const mockDbSelect = vi.fn();
const mockDbDelete = vi.fn();
const mockDbUpdate = vi.fn();

// We'll mock the db module to track calls
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockRun = vi.fn();
const mockWhere = vi.fn();
const mockAll = vi.fn();
const mockSet = vi.fn();

vi.mock('$lib/server/db/client', () => {
	const mockChain = {
		values: (...args: unknown[]) => {
			mockValues(...args);
			return {
				onConflictDoUpdate: (...args2: unknown[]) => {
					mockOnConflictDoUpdate(...args2);
					return { run: mockRun };
				},
				run: mockRun
			};
		}
	};

	const mockSelectChain = {
		from: () => ({
			where: (...args: unknown[]) => {
				mockWhere(...args);
				return { all: mockAll };
			},
			all: mockAll
		})
	};

	const mockUpdateChain = {
		set: (...args: unknown[]) => {
			mockSet(...args);
			return {
				where: (...args2: unknown[]) => {
					mockWhere(...args2);
					return { run: mockRun };
				}
			};
		}
	};

	const mockDeleteChain = {
		where: (...args: unknown[]) => {
			mockWhere(...args);
			return { run: mockRun };
		}
	};

	return {
		db: {
			insert: (...args: unknown[]) => {
				mockDbInsert(...args);
				return mockChain;
			},
			select: (...args: unknown[]) => {
				mockDbSelect(...args);
				return mockSelectChain;
			},
			delete: (...args: unknown[]) => {
				mockDbDelete(...args);
				return mockDeleteChain;
			},
			update: (...args: unknown[]) => {
				mockDbUpdate(...args);
				return mockUpdateChain;
			}
		}
	};
});

vi.mock('$lib/server/db/schema', () => ({
	containers: { vmid: 'vmid', hostname: 'hostname', status: 'status' },
	settings: {}
}));

import {
	createContainer,
	configureVaapi,
	startContainer,
	stopContainer,
	restartContainer,
	deleteContainer,
	listContainers,
	getContainerStatus,
	getProxmoxClient
} from './proxmox';

function setupMockProxmox() {
	const mockProxy = {
		nodes: {
			$get: mockNodesGet.mockResolvedValue([{ node: 'pve' }]),
			$: (name: string) => ({
				lxc: {
					$get: mockLxcGet,
					$post: mockLxcPost,
					$: (vmid: number) => ({
						config: {
							$put: mockConfigPut
						},
						status: {
							start: { $post: mockStartPost },
							stop: { $post: mockStopPost },
							reboot: { $post: mockRebootPost },
							current: { $get: mockStatusCurrentGet }
						},
						$delete: mockLxcDelete
					})
				}
			})
		}
	};

	mockProxmoxApi.mockReturnValue(mockProxy);

	mockGetSettings.mockResolvedValue({
		proxmox_host: '192.0.2.16',
		proxmox_token_id: 'root@pam!mytoken',
		proxmox_token_secret: 'some-uuid',
		proxmox_bridge: 'vmbr0'
	});

	return mockProxy;
}

describe('proxmox service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSshExec.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
	});

	describe('getProxmoxClient', () => {
		it('returns a configured proxmox-api instance', async () => {
			setupMockProxmox();
			const client = await getProxmoxClient();
			expect(client).toBeDefined();
			expect(mockProxmoxApi).toHaveBeenCalledWith({
				host: '192.0.2.16',
				port: 8006,
				tokenID: 'root@pam!mytoken',
				tokenSecret: 'some-uuid'
			});
		});
	});

	describe('create', () => {
		it('creates a new container via Proxmox API and inserts DB record', async () => {
			setupMockProxmox();
			mockLxcGet.mockResolvedValue([]);
			mockLxcPost.mockResolvedValue('UPID:pve:123');
			mockConfigPut.mockResolvedValue(undefined);

			const result = await createContainer({
				vmid: 200,
				hostname: 'cam-front',
				ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst'
			});

			expect(result.status).toBe('created');
			expect(result.vmid).toBe(200);
			expect(mockLxcPost).toHaveBeenCalledWith(
				expect.objectContaining({ onboot: 1, start: false })
			);
			expect(mockDbInsert).toHaveBeenCalled();
			expect(mockOnConflictDoUpdate).toHaveBeenCalled();
			expect(mockSshDispose).toHaveBeenCalled();
		});
	});

	describe('vaapi', () => {
		it('configures VAAPI passthrough via cgroup2 allow + /dev/dri bind mount over SSH', async () => {
			setupMockProxmox();

			await configureVaapi('pve', 200);

			const cmds = mockSshExec.mock.calls.map((c: unknown[]) => String(c[0]));
			const write = cmds.find((c: string) => c.startsWith('echo') && c.includes('lxc.mount.entry'));
			expect(write).toBeDefined();
			expect(write).toContain('/etc/pve/lxc/200.conf');
			expect(write).toContain('lxc.cgroup2.devices.allow: c 226:* rwm');
			expect(write).toContain('lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir');
			expect(cmds).toContainEqual(expect.stringContaining("sed -i '/^unprivileged:/d' /etc/pve/lxc/200.conf"));
			expect(mockSshDispose).toHaveBeenCalled();
		});

		it('skips when /dev/dri passthrough is already configured', async () => {
			setupMockProxmox();
			mockSshExec.mockResolvedValue({
				stdout: 'lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir',
				stderr: '',
				code: 0
			});

			await configureVaapi('pve', 200);

			expect(mockSshExec).toHaveBeenCalledTimes(1);
		});
	});

	describe('lifecycle', () => {
		it('starts a container', async () => {
			setupMockProxmox();
			mockStartPost.mockResolvedValue('UPID:pve:start');

			await startContainer(200);

			expect(mockStartPost).toHaveBeenCalled();
			expect(mockDbUpdate).toHaveBeenCalled();
		});

		it('stops a container', async () => {
			setupMockProxmox();
			mockStopPost.mockResolvedValue('UPID:pve:stop');

			await stopContainer(200);

			expect(mockStopPost).toHaveBeenCalled();
			expect(mockDbUpdate).toHaveBeenCalled();
		});

		it('restarts a container', async () => {
			setupMockProxmox();
			mockRebootPost.mockResolvedValue('UPID:pve:reboot');

			await restartContainer(200);

			expect(mockRebootPost).toHaveBeenCalled();
			expect(mockDbUpdate).toHaveBeenCalled();
		});
	});

	describe('delete', () => {
		it('stops and deletes a container, removes DB record', async () => {
			setupMockProxmox();
			// running before stop, stopped on the first poll (avoids the 15 s wait loop)
			mockStatusCurrentGet
				.mockResolvedValueOnce({ status: 'running' })
				.mockResolvedValue({ status: 'stopped' });
			mockStopPost.mockResolvedValue('UPID:pve:stop');
			mockLxcDelete.mockResolvedValue('UPID:pve:delete');

			await deleteContainer(200);

			expect(mockStopPost).toHaveBeenCalled();
			expect(mockLxcDelete).toHaveBeenCalled();
			expect(mockDbDelete).toHaveBeenCalled();
		});
	});

	describe('idempotent', () => {
		it('updates config instead of creating when VMID already exists', async () => {
			setupMockProxmox();
			mockLxcGet.mockResolvedValue([{ vmid: 200, name: 'cam-front' }]);
			mockConfigPut.mockResolvedValue(undefined);

			const result = await createContainer({
				vmid: 200,
				hostname: 'cam-front',
				ostemplate: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst',
				memory: 1024
			});

			expect(result.status).toBe('updated');
			expect(result.vmid).toBe(200);
			expect(mockConfigPut).toHaveBeenCalledWith(
				expect.objectContaining({ onboot: 1, memory: 1024 })
			);
			expect(mockLxcPost).not.toHaveBeenCalled();
		});
	});

	describe('listContainers', () => {
		it('returns ContainerInfo array merged from API and DB', async () => {
			setupMockProxmox();
			mockLxcGet.mockResolvedValue([
				{ vmid: 200, name: 'cam-front', status: 'running', cpu: 0.05, maxmem: 536870912, mem: 134217728 }
			]);
			mockAll.mockReturnValue([
				{ vmid: 200, hostname: 'cam-front', cameraName: 'Front Door', cameraIp: '192.0.2.22', cameraType: 'mobotix', status: 'running' }
			]);

			const containers = await listContainers();

			expect(containers).toBeInstanceOf(Array);
			expect(containers.length).toBe(1);
			expect(containers[0].vmid).toBe(200);
			expect(containers[0].cameraName).toBe('Front Door');
			expect(containers[0].status).toBe('running');
		});
	});

	describe('getContainerStatus', () => {
		it('returns single container status', async () => {
			setupMockProxmox();
			mockStatusCurrentGet.mockResolvedValue({
				vmid: 200,
				name: 'cam-front',
				status: 'running',
				cpu: 0.05,
				maxmem: 536870912,
				mem: 134217728
			});
			mockAll.mockReturnValue([
				{ vmid: 200, hostname: 'cam-front', cameraName: 'Front Door', cameraIp: '192.0.2.22', cameraType: 'mobotix', status: 'running' }
			]);

			const status = await getContainerStatus(200);

			expect(status.vmid).toBe(200);
			expect(status.status).toBe('running');
		});
	});
});
