-- v1.3 Phase 24 — Auto-Update Parity (UPD-AUTO-10)
-- Dedicated table for update run history. Replaces the JSON blob
-- previously stored in settings.update_run_history.
CREATE TABLE IF NOT EXISTS `update_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`pre_sha` text,
	`post_sha` text,
	`target_sha` text,
	`status` text DEFAULT 'running' NOT NULL,
	`stage` text,
	`error_message` text,
	`rollback_stage` text,
	`unit_name` text,
	`log_path` text,
	`backup_path` text,
	`trigger` text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `update_runs_started_at_idx` ON `update_runs` (`started_at`);
