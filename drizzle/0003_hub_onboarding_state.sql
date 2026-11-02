-- v1.3 Phase 22 — Wizard step-pointer (HUB-WIZ-09 + HUB-WIZ-10)
-- Single-row table (id=1 always upserted). Persists wizard progress so
-- resumability survives browser-close and SvelteKit restart. Plan 02's
-- wizard/complete endpoint flips protect_hub_enabled atomically against
-- this row — completePointer() must NOT delete it.
CREATE TABLE IF NOT EXISTS `hub_onboarding_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`step` integer NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`last_activity_at` text NOT NULL DEFAULT (datetime('now')),
	`error` text
);
--> statement-breakpoint
