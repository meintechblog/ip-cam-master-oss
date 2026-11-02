import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export type CameraType = 'mobotix' | 'mobotix-onvif' | 'loxone' | 'bambu';

export const settings = sqliteTable('settings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	key: text('key').notNull().unique(),
	value: text('value').notNull(),
	encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

export const containers = sqliteTable('containers', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	vmid: integer('vmid').notNull().unique(),
	hostname: text('hostname').notNull(),
	cameraName: text('camera_name'),
	cameraIp: text('camera_ip'),
	cameraType: text('camera_type'),
	status: text('status').notNull().default('unknown'),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

export const cameras = sqliteTable('cameras', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	vmid: integer('vmid').notNull(),
	name: text('name').notNull(),
	ip: text('ip').notNull(),
	username: text('username').notNull(),
	password: text('password').notNull(),
	cameraType: text('camera_type').notNull().default('mobotix'),
	streamPath: text('stream_path').notNull().default('/stream0/mobotix.mjpeg'),
	width: integer('width').notNull().default(1280),
	height: integer('height').notNull().default(720),
	fps: integer('fps').notNull().default(20),
	bitrate: integer('bitrate').notNull().default(2000),
	streamName: text('stream_name').notNull(),
	rtspUrl: text('rtsp_url'),
	containerIp: text('container_ip'),
	status: text('status').notNull().default('pending'),
	accessCode: text('access_code'),
	serialNumber: text('serial_number'),
	// Bambu model code from SSDP (e.g. 'A1', 'H2C', 'O1C2'). Nullable:
	// null = assume H2C for backward-compat with pre-Phase-18 rows (per BAMBU-A1-02).
	// Used by preflight model-split (Plan 04) and UI capability gating (Plan 06).
	model: text('model'),
	printState: text('print_state'),
	streamMode: text('stream_mode').default('adaptive'),
	rtspAuthEnabled: integer('rtsp_auth_enabled', { mode: 'boolean' }).notNull().default(false),
	// v1.3 Phase 19 — Protect Stream Hub schema lock (per L-1, L-28).
	// `source` discriminates managed cams (this app provisions them) from external
	// Protect cams (read-only catalog). 'external_archived' is reserved for P21+ soft-delete.
	source: text('source').notNull().default('managed'),
	// MAC normalised to lowercase, no separators (e.g. 'aabbccddeeff'). Effective PK
	// for source='external' rows. SQLite ALTER TABLE cannot add NOT NULL without a
	// default, so the NOT-NULL invariant is enforced in catalog upsert (Plan 03).
	mac: text('mac'),
	// Protect cam UUID — denormalised cache only; never used as a join key (per L-1).
	externalId: text('external_id'),
	// Logical FK → protect_hub_bridges.id (no SQLite enforcement; app-level invariant).
	// NULL for managed cams.
	hubBridgeId: integer('hub_bridge_id'),
	// Derived hint: 'Ubiquiti' for first-party, first token of marketName for third-party,
	// 'Unknown' otherwise. NOT read directly from the lib —
	// see protect-bridge.ts deriveManufacturerHint() (Plan 03).
	manufacturer: text('manufacturer'),
	// Protect marketName (e.g. 'G4 Bullet', 'Mobotix S15'). Distinct from Phase 18's
	// `model` column above which holds Bambu SSDP codes ('A1', 'H2C', 'O1C2').
	modelName: text('model_name'),
	// 'first-party' | 'third-party' | 'unknown' — derived via classifyKind()
	// per amended D-CLASS-01 (uses cam.isThirdPartyCamera).
	kind: text('kind').notNull().default('unknown'),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

export type CredentialType = 'mobotix' | 'bambu';

export const credentials = sqliteTable('credentials', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	type: text('type').notNull().default('mobotix'),
	username: text('username').notNull(),
	password: text('password').notNull(),
	accessCode: text('access_code'),
	serialNumber: text('serial_number'),
	priority: integer('priority').notNull().default(0),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull(),
	passwordHash: text('password_hash').notNull(),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

export const events = sqliteTable('events', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cameraId: integer('camera_id'),
	cameraName: text('camera_name'),
	eventType: text('event_type').notNull(),
	severity: text('severity').notNull().default('info'),
	message: text('message').notNull(),
	source: text('source').notNull(),
	timestamp: text('timestamp')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

// v1.3 Phase 19 — Protect Stream Hub: bridge LXC tracking (per ARCH §1.2).
// One row per bridge container provisioned in P20. P19 only locks the schema —
// no rows are inserted in this phase.
export const protectHubBridges = sqliteTable('protect_hub_bridges', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	vmid: integer('vmid').notNull().unique(),
	hostname: text('hostname').notNull(),
	containerIp: text('container_ip'),
	status: text('status').notNull().default('pending'),
	lastDeployedYamlHash: text('last_deployed_yaml_hash'),
	lastReconciledAt: text('last_reconciled_at'),
	lastHealthCheckAt: text('last_health_check_at'),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

// v1.3 Phase 19 — per-cam output configuration (per L-4: separate table, not JSON column).
// outputType is open-ended ('loxone-mjpeg' | 'frigate-rtsp' in P21; extends in later phases).
// `config` is a JSON-serialised string per-output settings blob.
export const cameraOutputs = sqliteTable('camera_outputs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cameraId: integer('camera_id').notNull(),
	outputType: text('output_type').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
	config: text('config').notNull().default('{}'),
	createdAt: text('created_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text('updated_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

// v1.3 Phase 19 — Protect bootstrap stream catalog cache (per ARCH §1.2).
// One row per (cameraId, quality). Codec is camera-level in protect-types.ts:1053
// but stored per-row here for forward-compat with mixed-codec firmware.
// `bitrate` is bps (NOT kbps; the lib reports raw values).
export const protectStreamCatalog = sqliteTable('protect_stream_catalog', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cameraId: integer('camera_id').notNull(),
	quality: text('quality').notNull(),
	codec: text('codec'),
	width: integer('width'),
	height: integer('height'),
	fps: integer('fps'),
	bitrate: integer('bitrate'),
	rtspUrl: text('rtsp_url'),
	shareEnabled: integer('share_enabled', { mode: 'boolean' }).notNull().default(false),
	cachedAt: text('cached_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});

// v1.3 Phase 24 — Auto-Update Parity (per UPD-AUTO-10).
// One row per update run (manual or auto). Replaces the JSON blob in
// settings.update_run_history. Crash-safe: rows for in-flight updates start
// with status='running' and are reconciled at boot via the exitcode file.
export type UpdateRunStatus = 'running' | 'success' | 'failed' | 'rolled_back';
export type UpdateRunTrigger = 'manual' | 'auto';
export type UpdateRunRollbackStage = 'stage1' | 'stage2';
export type UpdateRunStage =
	| 'preflight'
	| 'snapshot'
	| 'drain'
	| 'stop'
	| 'fetch'
	| 'install'
	| 'build'
	| 'start'
	| 'verify';

export const updateRuns = sqliteTable('update_runs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	startedAt: text('started_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	finishedAt: text('finished_at'),
	preSha: text('pre_sha'),
	postSha: text('post_sha'),
	targetSha: text('target_sha'),
	status: text('status').notNull().default('running'),
	stage: text('stage'),
	errorMessage: text('error_message'),
	rollbackStage: text('rollback_stage'),
	unitName: text('unit_name'),
	logPath: text('log_path'),
	backupPath: text('backup_path'),
	trigger: text('trigger').notNull().default('manual')
});

// v1.3 Phase 21 — Reconcile run audit log (per D-RCN-04 + L-14).
// One row per reconcile pass. Drives drift indicator + reconcile log UI in P23.
// Mirrors the updateRuns shape from P24 — proven cross-process audit pattern.
// status enum (verbatim per D-RCN-04): running | success | no_op | bridge_unreachable | error
export type ReconcileRunStatus = 'running' | 'success' | 'no_op' | 'bridge_unreachable' | 'error';

export const protectHubReconcileRuns = sqliteTable('protect_hub_reconcile_runs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	reconcileId: text('reconcile_id').notNull(),
	startedAt: text('started_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	completedAt: text('completed_at'),
	status: text('status').notNull().default('running'),
	hashChanged: integer('hash_changed', { mode: 'boolean' }).notNull().default(false),
	deployedYamlHash: text('deployed_yaml_hash'),
	error: text('error')
});

// v1.3 Phase 22 — Wizard step-pointer table (per L-15 + HUB-WIZ-09).
// Single-row table (logical singleton — id=1 always upserted).
// Persists wizard progress so resumability survives browser-close + SvelteKit restart.
// setPointer() upserts; resetPointer() deletes; completePointer() flips status='completed'.
// HUB-WIZ-10: completePointer() is the gate Plan 02's wizard/complete endpoint flips
// protect_hub_enabled atomically against — DO NOT delete the row on completion.
export type HubOnboardingStep = 1 | 2 | 3 | 4 | 5 | 6;
export type HubOnboardingStatus = 'in_progress' | 'completed' | 'reset';

export const hubOnboardingState = sqliteTable('hub_onboarding_state', {
	id: integer('id').primaryKey().default(1),
	step: integer('step').notNull(),
	status: text('status').notNull().default('in_progress'),
	lastActivityAt: text('last_activity_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	error: text('error')
});

// Quick-task 260530-bv1 — current-snapshot per managed stream; Influx owns
// history, this holds only the latest state for fast non-Influx UI reads
// (Debug-Platform Tier-1 #3). Upsert-keyed on stream_key — one row per stream,
// bounded by #managed cams (no unbounded growth). The sampler writes it each
// tick alongside (additive to) the existing Influx recordMetric calls.
export const streamHealth = sqliteTable('stream_health', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cameraId: integer('camera_id'),
	cameraName: text('camera_name'),
	streamKey: text('stream_key').notNull().unique(),
	status: text('status').notNull(), // 'healthy' | 'phantom' | 'producer_dead' | 'unreachable'
	errorReason: text('error_reason'),
	producerAlive: integer('producer_alive', { mode: 'boolean' }).notNull().default(false),
	consumers: integer('consumers').notNull().default(0),
	recordingEndAgeSeconds: integer('recording_end_age_seconds').notNull().default(-1),
	phantomAdoption: integer('phantom_adoption', { mode: 'boolean' }).notNull().default(false),
	lastProbedAt: text('last_probed_at')
		.notNull()
		.$defaultFn(() => new Date().toISOString())
});
