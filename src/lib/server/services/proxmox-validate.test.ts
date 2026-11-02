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

// Mock proxmox-api
const mockNodesGet = vi.fn();
const mockLxcGet = vi.fn();
const mockProxmoxApi = vi.fn();

vi.mock('proxmox-api', () => ({
	default: (...args: unknown[]) => mockProxmoxApi(...args)
}));

vi.mock('$lib/server/db/client', () => ({ db: {} }));

import { validateProxmoxConnection } from './proxmox';

describe('proxmox validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns valid:true with nodeName when nodes exist', async () => {
		mockGetSettings.mockResolvedValue({
			proxmox_host: '192.0.2.16',
			proxmox_token_id: 'root@pam!mytoken',
			proxmox_token_secret: 'some-uuid'
		});

		mockProxmoxApi.mockReturnValue({
			nodes: {
				$get: mockNodesGet.mockResolvedValue([{ node: 'pve' }]),
				$: (name: string) => ({
					lxc: {
						$get: mockLxcGet.mockResolvedValue([])
					}
				})
			}
		});

		const result = await validateProxmoxConnection();
		expect(result).toEqual({ valid: true, nodeName: 'pve' });
	});

	it('returns valid:false with auth error on 401', async () => {
		mockGetSettings.mockResolvedValue({
			proxmox_host: '192.0.2.16',
			proxmox_token_id: 'root@pam!mytoken',
			proxmox_token_secret: 'wrong-secret'
		});

		mockProxmoxApi.mockReturnValue({
			nodes: {
				$get: mockNodesGet.mockRejectedValue(new Error('401 Unauthorized'))
			}
		});

		const result = await validateProxmoxConnection();
		expect(result.valid).toBe(false);
		expect(result.error).toContain('Authentication failed');
	});

	it('returns valid:false with connection error on network error', async () => {
		mockGetSettings.mockResolvedValue({
			proxmox_host: '192.0.2.16',
			proxmox_token_id: 'root@pam!mytoken',
			proxmox_token_secret: 'some-uuid'
		});

		mockProxmoxApi.mockReturnValue({
			nodes: {
				$get: mockNodesGet.mockRejectedValue(new Error('ECONNREFUSED'))
			}
		});

		const result = await validateProxmoxConnection();
		expect(result.valid).toBe(false);
		expect(result.error).toContain('Cannot reach Proxmox host');
	});

	it('returns valid:false when settings are not configured', async () => {
		mockGetSettings.mockResolvedValue({});

		const result = await validateProxmoxConnection();
		expect(result.valid).toBe(false);
		expect(result.error).toContain('not configured');
	});
});
