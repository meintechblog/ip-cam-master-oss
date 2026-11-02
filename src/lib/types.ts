import type { CameraType } from '$lib/server/db/schema';

export type ContainerStatus = 'running' | 'stopped' | 'error' | 'unknown';
// Phase 18 / WR-03: Re-export CameraType from the DB schema so both layers
// share one source of truth. The previous local declaration had two extra
// variants ('onvif', 'other') that were never produced by any writer; keeping
// them around meant consumer code had unreachable branches that diverged from
// reality. `import type` is erased at compile time, so re-exporting from the
// server-only schema module is safe for client bundles.
export type { CameraType };

export interface ProxmoxSettings {
	proxmox_host: string;
	proxmox_token_id: string;
	proxmox_token_secret: string;
	proxmox_storage: string;
	proxmox_bridge: string;
	proxmox_vmid_start: string;
}

export interface UnifiSettings {
	unifi_host: string;
	unifi_username: string;
	unifi_password: string;
}

export interface ContainerInfo {
	vmid: number;
	hostname: string;
	cameraName?: string;
	cameraIp?: string;
	cameraType?: CameraType;
	status: ContainerStatus;
	cpu?: number;
	memory?: { used: number; total: number };
	mac?: string | null;
}

export interface ValidationResult {
	valid: boolean;
	error?: string;
	nodeName?: string;
}

export interface SettingRecord {
	key: string;
	value: string;
	encrypted: boolean;
}

export type CameraStatus = 'pending' | 'container_created' | 'go2rtc_configured' | 'configured' | 'verified';

export const CAMERA_STATUS = {
	PENDING: 'pending',
	CONTAINER_CREATED: 'container_created',
	GO2RTC_CONFIGURED: 'go2rtc_configured',
	CONFIGURED: 'configured',
	VERIFIED: 'verified'
} as const satisfies Record<string, CameraStatus>;

export interface TranscodeParams {
	width: number;
	height: number;
	fps: number;
	bitrate: number;
}

export interface Camera {
	id: number;
	vmid: number;
	name: string;
	ip: string;
	username: string;
	password: string;
	cameraType: CameraType;
	streamPath: string;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	streamName: string;
	rtspUrl: string | null;
	containerIp: string | null;
	status: CameraStatus;
	accessCode: string | null;
	serialNumber: string | null;
	// Bambu model code from SSDP (e.g. 'A1', 'H2C', 'O1C2'). Nullable:
	// null = assume H2C for pre-Phase-18 rows. Mirrors the schema column added
	// in Plan 18-01; used by the Phase 18 A1 branch in configureGo2rtc.
	model: string | null;
	printState: string | null;
	streamMode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface OnboardingState {
	currentStep: number;
	cameraId: number | null;
	status: CameraStatus;
	error: string | null;
}

export interface StreamInfo {
	active: boolean;
	codec: string | null;
	audioCodec: string | null;
	producers: number;
	resolution: string | null;
	unifiConnected?: boolean;
	unifiStreams?: number;
}

/**
 * Per-model capability matrix (Phase 18 / D-07).
 * Mirrors the server-side `PRINTER_CAPABILITIES` export in
 * `src/lib/server/services/bambu-discovery.ts`. The server attaches this
 * to the Bambu camera payload so the dashboard can gate UI panels without
 * hardcoded model checks.
 */
export interface PrinterCapabilities {
	chamberHeater: boolean;
	ams: 'none' | 'lite' | 'full';
	xcamFeatures: readonly string[];
	cameraResolution: '480p' | '1080p' | '4k';
	cameraTransport: 'rtsps-322' | 'jpeg-tls-6000';
}

export interface CameraCardData {
	// Camera DB info
	id: number;
	vmid: number;
	name: string;
	cameraIp: string;
	cameraType: CameraType;
	containerIp: string | null;
	streamName: string;
	rtspUrl: string | null;
	status: CameraStatus;
	rtspAuthEnabled: boolean;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	// Live status
	containerStatus: ContainerStatus;
	go2rtcRunning: boolean;
	onvifRunning: boolean;
	streamInfo: StreamInfo | null;
	connectedClients: number;
	snapshotUrl: string | null;
	go2rtcWebUrl: string | null;
	cameraWebUrl: string | null;
	cameraModel: string | null;
	firmwareVersion: string | null;
	liveFps: number | null;
	lxcCpu: number | null;
	lxcMemory: { used: number; total: number } | null;
	lxcMac: string | null;
	protectStatus?: ProtectCameraMatch | null;
	protectConfigured?: boolean;
	protectUrl?: string | null;
	flapping?: boolean;
	// Bambu-only — populated when cameraType === 'bambu'
	printState?: string | null;
	streamMode?: string | null;
	bambuError?: string | null;
	bambuMqttConnected?: boolean;
	// Phase 18 / BAMBU-A1-11: capability-gated UI.
	// Present only for Bambu cameras (derived from cameras.model via
	// PRINTER_CAPABILITIES in the /api/cameras/status endpoint).
	capabilities?: PrinterCapabilities;

	// v1.3 Phase 22 — Hub-related scalar fields exposed via /api/cameras/status.
	// Populated for every cam row (managed defaults to source='managed', kind='unknown').
	// Plan 03's `/kameras` partition reads `source` to split managed vs external sections;
	// ExternalCamCard reads kind/manufacturer/modelName/externalId/hubBridgeId for badges.
	source: CameraSource;
	kind: CameraKind;
	manufacturer: string | null;
	modelName: string | null;
	externalId: string | null;
	hubBridgeId: number | null;
	// Cam MAC (cameras.mac column — not the LXC container MAC at lxcMac).
	// For external Protect cams: required by Plan 03 ExternalCamCard / ProtectHubGuide
	// / OutputsSubsection to derive go2rtc stream slug via deriveSlug(mac, outputType).
	// For managed cams: typically null (the LXC's mac is at lxcMac instead).
	// Added in Plan 03 Task 2 (Rule 3 deviation — Plan 02 missed this when extending
	// the type with the 6 hub fields above; the slug pipeline is unusable without it).
	mac: string | null;

	// v1.3 Phase 22 — Catalog + outputs arrays consumed by /kameras ExternalCamCard (Plan 03).
	// Empty for managed cams (no extra DB cost — batched JOIN filters by source='external').
	streamCatalog: StreamCatalogRow[];
	outputs: CameraOutputRow[];
}

/**
 * Per-cam Protect bootstrap stream catalog row, projected into the wire shape
 * consumed by Plan 03 ExternalCamCard's read-only catalog table.
 * Narrower than `protectStreamCatalog.$inferSelect` (drops cameraId, rtspUrl,
 * shareEnabled, cachedAt — those are server-only join + caching metadata).
 */
export type StreamCatalogRow = {
	quality: string;
	codec: string | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	bitrate: number | null;
};

/**
 * Per-cam output configuration row, projected for /kameras OutputsSubsection initial state.
 * Narrower than `cameraOutputs.$inferSelect` (drops cameraId, config blob, timestamps).
 */
export type CameraOutputRow = {
	outputType: 'loxone-mjpeg' | 'frigate-rtsp';
	enabled: boolean;
};

/**
 * Discriminator for the v1.3 cameras table extension (Phase 19, per L-2).
 * - 'managed': this app provisions the LXC container and owns the stream lifecycle.
 * - 'external': read-only Protect cam, owned by Protect itself; cached for catalog UI.
 * - 'external_archived': soft-deleted external cam (P21+); not yet emitted in P19.
 */
export type CameraSource = 'managed' | 'external' | 'external_archived';

/**
 * Cam classification per amended D-CLASS-01.
 * Derived in Plan 03 from `cam.isThirdPartyCamera`:
 *   false → 'first-party' | true → 'third-party' | undefined/null → 'unknown'.
 */
export type CameraKind = 'first-party' | 'third-party' | 'unknown';

export interface ProtectCamera {
	id: string;
	name: string;
	type: string;
	modelKey: string;
	host: string;
	mac: string;
	state: string;
	isAdopted: boolean;
	isAdopting: boolean;
	isThirdPartyCamera: boolean;
	connectedSince: number;
	lastSeen: number;
	thirdPartyCameraInfo?: {
		port: number;
		rtspUrl: string;
		rtspUrlLQ: string;
		snapshotUrl: string;
	};
}

export interface ProtectCameraMatch {
	protectId: string;
	protectName: string;
	state: string;
	isAdopted: boolean;
	connectedSince: number | null;
	isThirdPartyCamera: boolean;
}

export type EventType = 'camera_disconnect' | 'camera_reconnect' | 'stream_failed' | 'adoption_changed' | 'aiport_error';
export type EventSeverity = 'info' | 'warning' | 'error';
export type EventSource = 'protect_api' | 'ssh_logs' | 'app';

export interface CameraEvent {
	id: number;
	cameraId: number | null;
	cameraName: string | null;
	eventType: EventType;
	severity: EventSeverity;
	message: string;
	source: EventSource;
	timestamp: string;
}

export interface ProtectStatus {
	connected: boolean;
	adoptedCount: number;
	connectedCount: number;
	totalProtectCameras: number;
	cameras: Map<number, ProtectCameraMatch>;
}

// ────────────────────────────────────────────────────────────────────────────
// Quick-task 260530-fff — Debug-Platform Tier-1 #1.
// Read-only multi-layer health of ONE camera, aggregated server-side and served
// by GET /api/cameras/[id]/debug. Each layer is fail-soft: a probe failure
// surfaces as that layer's own `{ error }` and never 500s the endpoint.
// SECURITY (T-fff-02): NEVER carry decrypted credentials / encryption keys here.
// ────────────────────────────────────────────────────────────────────────────

/** Direct device-HTTP reachability — only applicable for Mobotix-class cams. */
export interface DebugLayerDevice {
	applicable: boolean;
	reachable: boolean;
	detail?: string;
	error?: string;
}

/** go2rtc :1984 stream probe — mirrors the exported Go2rtcProbe field set. */
export interface DebugLayerGo2rtc {
	reachable: boolean;
	streamFound: boolean;
	producersConfigured?: number;
	producersStarted: number;
	consumers: number;
	bytesRecv: number;
	// Quick-task 260531-3gh — additive stream-quality fields (safe fields only,
	// never producer.source/url). Static codec info from the first video receiver;
	// summed packet counter. bitrate/packet-rate are delta-based and NOT surfaced
	// here (the debug endpoint has no prev sample) — see camera-debug-health.ts.
	packets?: number;
	codecName?: string | null;
	codecProfile?: string | null;
	codecLevel?: number | null;
	error?: string;
}

/** Best-effort ONVIF/HTTP port probe — applicable for ONVIF-capable cams. */
export interface DebugLayerOnvif {
	applicable: boolean;
	reachable: boolean;
	error?: string;
}

/** UniFi Protect controller's view of the matched camera. */
export interface DebugLayerProtect {
	matched: boolean;
	state: string;
	isRecording?: boolean;
	lastSeenAgeSeconds: number;
	recordingEndAgeSeconds: number;
	phantom: boolean;
}

/** Latest persisted snapshot from the stream_health table (null if no row). */
export interface DebugLayerSnapshot {
	status: string;
	producerAlive: boolean;
	consumers: number;
	recordingEndAgeSeconds: number;
	phantomAdoption: boolean;
	lastProbedAt: string;
}

export interface CameraDebugHealth {
	camera: {
		id: number;
		name: string;
		cameraType: string | null;
		source: string;
		status: string;
		containerIp: string | null;
		streamName: string;
		vmid: number;
	};
	layers: {
		device: DebugLayerDevice;
		go2rtc: DebugLayerGo2rtc;
		onvif: DebugLayerOnvif;
		protect: DebugLayerProtect;
		snapshot: DebugLayerSnapshot | null;
	};
	recentEvents: CameraEvent[];
	probedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Quick-task 260531-2zx — Debug-Platform Tier-1 #4 (cross-cam health ampel).
// Per-managed-cam status summary for the homepage health strip. Shared between
// GET /api/cameras/health-summary and CamHealthStrip.svelte so the response
// contract has a single source of truth. Read-only and deliberately limited to
// 5 non-sensitive fields (no credentials/IPs/SSH) per the status-endpoint CR-01
// lesson. A managed cam without a stream_health row → status 'unknown'.
// ────────────────────────────────────────────────────────────────────────────
export type CamHealthStatus =
	| 'healthy'
	| 'phantom'
	| 'producer_dead'
	| 'unreachable'
	| 'unknown';

export interface CamHealthSummary {
	cameraId: number;
	name: string;
	status: CamHealthStatus;
	phantomAdoption: boolean;
	lastProbedAt: string | null;
}
