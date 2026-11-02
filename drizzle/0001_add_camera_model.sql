-- Phase 18: Bambu A1 integration — additive `model` column on `cameras`.
-- Nullable; null rows (existing H2C adoptions) get assume-H2C behavior at
-- read-time via PRINTER_CAPABILITIES fallback. No destructive ops, no backfill.

ALTER TABLE `cameras` ADD `model` text;
