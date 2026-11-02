import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock $env/dynamic/private
vi.mock('$env/dynamic/private', () => ({
	env: {
		DB_ENCRYPTION_KEY: 'a'.repeat(32)
	}
}));

// Hoisted mocks
const {
	mockConnectToProxmox,
	mockExecuteOnContainer,
	mockPushFileToContainer,
	mockWaitForContainerReady,
	mockGenerateGo2rtcConfig,
	mockGenerateSystemdUnit,
	mockGetInstallCommands,
	mockCheckStreamHealth,
	mockCreateContainer,
	mockStartContainer,
	mockGetTemplateVmid,
	mockGetSettings,
	mockEncrypt,
	mockDecrypt,
	mockDbInsert,
	mockDbSelect,
	mockDbUpdate,
	mockValues,
	mockOnConflictDoUpdate,
	mockRun,
	mockWhere,
	mockAll,
	mockSet,
	mockSshDispose
} = vi.hoisted(() => ({
	mockConnectToProxmox: vi.fn(),
	mockExecuteOnContainer: vi.fn(),
	mockPushFileToContainer: vi.fn(),
	mockWaitForContainerReady: vi.fn(),
	mockGenerateGo2rtcConfig: vi.fn(),
	mockGenerateSystemdUnit: vi.fn(),
	mockGetInstallCommands: vi.fn(),
	mockCheckStreamHealth: vi.fn(),
	mockCreateContainer: vi.fn(),
	mockStartContainer: vi.fn(),
	mockGetTemplateVmid: vi.fn(),
	mockGetSettings: vi.fn(),
	mockEncrypt: vi.fn(),
	mockDecrypt: vi.fn(),
	mockDbInsert: vi.fn(),
	mockDbSelect: vi.fn(),
	mockDbUpdate: vi.fn(),
	mockValues: vi.fn(),
	mockOnConflictDoUpdate: vi.fn(),
	mockRun: vi.fn(),
	mockWhere: vi.fn(),
	mockAll: vi.fn(),
	mockSet: vi.fn(),
	mockSshDispose: vi.fn()
}));

vi.mock('./ssh', () => ({
	connectToProxmox: mockConnectToProxmox,
	executeOnContainer: mockExecuteOnContainer,
	pushFileToContainer: mockPushFileToContainer,
	waitForContainerReady: mockWaitForContainerReady
}));

vi.mock('./go2rtc', () => ({
	generateGo2rtcConfig: mockGenerateGo2rtcConfig,
	generateSystemdUnit: mockGenerateSystemdUnit,
	getInstallCommands: mockGetInstallCommands,
	checkStreamHealth: mockCheckStreamHealth,
	getOnvifAudioPatch: vi.fn().mockReturnValue('// audio patch script'),
	getOnvifInstallCommands: vi.fn().mockReturnValue(['echo install']),
	generateOnvifConfig: vi.fn().mockReturnValue('onvif: []'),
	generateOnvifSystemdUnit: vi.fn().mockReturnValue('[Service]'),
	generateGo2rtcConfigLoxone: vi.fn().mockReturnValue('streams: {}'),
	generateGo2rtcConfigBambu: vi.fn().mockReturnValue('streams: { bambu: [] }'),
	generateGo2rtcConfigBambuA1: vi.fn().mockReturnValue('streams: { bambu_a1: [] }'),
	generateNginxConfig: vi.fn().mockReturnValue('server {}'),
	getNginxInstallCommands: vi.fn().mockReturnValue(['echo nginx'])
}));

vi.mock('./proxmox', () => ({
	createContainer: mockCreateContainer,
	startContainer: mockStartContainer,
	getTemplateVmid: mockGetTemplateVmid,
	cloneFromTemplate: vi.fn(),
	createTemplateFromContainer: vi.fn()
}));

vi.mock('./settings', () => ({
	getSettings: mockGetSettings,
	getSetting: vi.fn()
}));

vi.mock('./crypto', () => ({
	encrypt: mockEncrypt,
	decrypt: mockDecrypt
}));

vi.mock('$lib/server/db/schema', () => ({
	settings: {},
	containers: {},
	cameras: { vmid: 'vmid', id: 'id', status: 'status', containerIp: 'containerIp', rtspUrl: 'rtspUrl' }
}));

vi.mock('$lib/server/db/client', () => {
	const selectChain = {
		from: () => ({
			where: (...args: unknown[]) => {
				mockWhere(...args);
				return { all: mockAll, get: () => mockAll()?.[0] };
			},
			all: mockAll
		})
	};

	const updateChain = {
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

	return {
		db: {
			insert: (...args: unknown[]) => {
				mockDbInsert(...args);
				return {
					values: (...args2: unknown[]) => {
						mockValues(...args2);
						return {
							onConflictDoUpdate: (...args3: unknown[]) => {
								mockOnConflictDoUpdate(...args3);
								return { run: mockRun };
							},
							returning: () => [{ id: 1 }],
							run: mockRun
						};
					}
				};
			},
			select: (...args: unknown[]) => {
				mockDbSelect(...args);
				return selectChain;
			},
			update: (...args: unknown[]) => {
				mockDbUpdate(...args);
				return updateChain;
			}
		}
	};
});

import {
	testMobotixConnection,
	createCameraContainer,
	configureGo2rtc,
	verifyStream,
	saveCameraRecord,
	getNextVmid
} from './onboarding';

const mockSsh = {
	execCommand: mockExecuteOnContainer,
	dispose: mockSshDispose
};

describe('onboarding service', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mockConnectToProxmox.mockResolvedValue(mockSsh);
		mockGetSettings.mockResolvedValue({
			proxmox_host: '192.0.2.16',
			proxmox_vmid_start: '200'
		});
		mockDecrypt.mockImplementation((v: string) => v);
		mockEncrypt.mockImplementation((v: string) => `enc:${v}`);
	});

	describe('testMobotixConnection', () => {
		it('calls SSH ffprobe with correct RTSP URL', async () => {
			mockExecuteOnContainer.mockResolvedValue({
				stdout: JSON.stringify({
					streams: [{
						codec_type: 'video',
						width: 1280,
						height: 720,
						r_frame_rate: '20/1'
					}]
				}),
				stderr: '',
				code: 0
			});

			const result = await testMobotixConnection('192.0.2.22', 'admin', 'secret');

			// Should have connected to proxmox
			expect(mockConnectToProxmox).toHaveBeenCalled();
			// First call is a curl model probe (/admin/version); a later call runs ffprobe.
			const cmds = mockExecuteOnContainer.mock.calls.map((c: unknown[]) => String(c[0]));
			expect(cmds[0]).toContain('curl');
			const probeCmd = cmds.find((c: string) => c.includes('ffprobe'));
			expect(probeCmd).toBeDefined();
			expect(probeCmd).toContain('192.0.2.22');
			expect(result.success).toBe(true);
		});

		it('tries alternate path on failure', async () => {
			// Call 1 = curl model probe, call 2 = primary ffprobe (fails), call 3 = alternate (succeeds)
			mockExecuteOnContainer
				.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
				.mockResolvedValueOnce({
					stdout: 'PROBE_FAILED',
					stderr: '',
					code: 0
				})
				.mockResolvedValueOnce({
					stdout: JSON.stringify({
						streams: [{
							codec_type: 'video',
							width: 640,
							height: 480,
							r_frame_rate: '15/1'
						}]
					}),
					stderr: '',
					code: 0
				});

			const result = await testMobotixConnection('192.0.2.22', 'admin', 'secret');

			// curl model probe, then primary ffprobe, then alternate ffprobe
			const cmds = mockExecuteOnContainer.mock.calls.map((c: unknown[]) => String(c[0]));
			expect(cmds).toHaveLength(3);
			expect(cmds[1]).toContain('@192.0.2.22:554/stream0/mobotix.mjpeg');
			expect(cmds[2]).toContain('@192.0.2.22:554/mobotix.mjpeg');
			expect(result.success).toBe(true);
			expect(result.streamPath).toBe('/mobotix.mjpeg');
		});
	});

	describe('createCameraContainer', () => {
		const mockCamera = {
			id: 1,
			vmid: 200,
			name: 'Einfahrt',
			ip: '192.0.2.22',
			cameraType: 'mobotix',
			streamName: 'cam-200'
		};

		beforeEach(() => {
			mockAll.mockReturnValue([mockCamera]);
			mockCreateContainer.mockResolvedValue({ status: 'created', vmid: 200 });
			mockStartContainer.mockResolvedValue(undefined);
			// No template yet -> fresh-install path (createContainer)
			mockGetTemplateVmid.mockResolvedValue(null);
			mockWaitForContainerReady.mockResolvedValue(true);
			mockExecuteOnContainer.mockResolvedValue({
				stdout: '192.168.1.5 ',
				stderr: '',
				code: 0
			});
		});

		it('calls createContainer + startContainer + waitForContainerReady', async () => {
			const result = await createCameraContainer(1);

			expect(mockCreateContainer).toHaveBeenCalled();
			expect(mockStartContainer).toHaveBeenCalledWith(200);
			expect(mockWaitForContainerReady).toHaveBeenCalled();
			expect(result.vmid).toBe(200);
		});

		it('discovers container IP via hostname -I', async () => {
			const result = await createCameraContainer(1);

			const hostnameCall = mockExecuteOnContainer.mock.calls.find(
				(c: unknown[]) => typeof c[1] === 'number' || (typeof c[1] === 'string' && c[1].includes('hostname'))
			);
			expect(hostnameCall).toBeDefined();
			expect(result.containerIp).toBe('192.168.1.5');
		});

		it('updates camera status to container_created', async () => {
			await createCameraContainer(1);

			expect(mockSet).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'container_created' })
			);
		});
	});

	describe('configureGo2rtc', () => {
		const mockCamera = {
			id: 1,
			vmid: 200,
			name: 'Einfahrt',
			ip: '192.0.2.22',
			username: 'admin',
			password: 'secret',
			streamName: 'cam-200',
			width: 1280,
			height: 720,
			fps: 20,
			bitrate: 2000,
			streamPath: '/stream0/mobotix.mjpeg',
			containerIp: '10.0.0.5'
		};

		beforeEach(() => {
			mockAll.mockReturnValue([mockCamera]);
			mockGetInstallCommands.mockReturnValue(['apt install ffmpeg', 'wget go2rtc', 'mkdir -p /etc/go2rtc']);
			mockGenerateGo2rtcConfig.mockReturnValue('streams:\n  cam: ...');
			mockGenerateSystemdUnit.mockReturnValue('[Service]\nExecStart=...');
			mockExecuteOnContainer.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
			mockPushFileToContainer.mockResolvedValue(undefined);
		});

		it('runs install commands, pushes config + unit, restarts service', async () => {
			await configureGo2rtc(1);

			// Should connect SSH
			expect(mockConnectToProxmox).toHaveBeenCalled();
			// Should run install commands
			expect(mockExecuteOnContainer).toHaveBeenCalled();
			// Should push config files
			expect(mockPushFileToContainer).toHaveBeenCalled();
			// Should generate config
			expect(mockGenerateGo2rtcConfig).toHaveBeenCalled();
			expect(mockGenerateSystemdUnit).toHaveBeenCalled();
		});

		it('updates camera status to configured', async () => {
			await configureGo2rtc(1);

			expect(mockSet).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'go2rtc_configured' })
			);
		});
	});

	describe('verifyStream', () => {
		const mockCamera = {
			id: 1,
			vmid: 200,
			containerIp: '10.0.0.5',
			streamName: 'cam-200'
		};

		it('calls checkStreamHealth and updates rtspUrl on success', async () => {
			mockAll.mockReturnValue([mockCamera]);
			mockCheckStreamHealth.mockResolvedValue({
				active: true,
				codec: 'h264',
				producers: 1,
				resolution: '1280x720'
			});

			const result = await verifyStream(1);

			expect(mockCheckStreamHealth).toHaveBeenCalledWith('10.0.0.5', 'cam-200');
			expect(result.success).toBe(true);
			expect(result.rtspUrl).toContain('rtsp://10.0.0.5:8554/cam-200');
		});

		it('returns success=false when stream not active', async () => {
			mockAll.mockReturnValue([mockCamera]);
			mockCheckStreamHealth.mockResolvedValue({
				active: false,
				codec: null,
				producers: 0,
				resolution: null
			});

			// verifyStream retries 6x with a 5 s pause; use fake timers instead of waiting 30 s
			vi.useFakeTimers();
			try {
				const pending = verifyStream(1);
				await vi.advanceTimersByTimeAsync(30_000);
				const result = await pending;
				expect(result.success).toBe(false);
				expect(mockCheckStreamHealth).toHaveBeenCalledTimes(6);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('getNextVmid', () => {
		it('returns vmid_start when no cameras exist', async () => {
			mockAll.mockReturnValue([]);
			const vmid = await getNextVmid();
			expect(vmid).toBeGreaterThanOrEqual(200);
		});
	});
});
