-- Phase 11 Plan 01: additive Bambu columns on existing `cameras` table.
-- The App-VM database predates drizzle-kit migrations; this file represents
-- the first tracked migration and contains ONLY the additive ALTER TABLE
-- statements for the two new Bambu columns. Both columns are NULLABLE; no
-- data backfill, no destructive operations. Fresh installs pick up the full
-- schema via drizzle-kit's snapshot (`meta/0000_snapshot.json`).

ALTER TABLE `cameras` ADD `access_code` text;--> statement-breakpoint
ALTER TABLE `cameras` ADD `serial_number` text;
