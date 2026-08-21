-- 0405: Reservations gain idempotency. A retried allocation currently creates a
-- second reservation and double-increments committed, with nothing to stop it.
-- The source-line uniqueness is partial on ACTIVE so a released reservation can
-- be legitimately re-created for the same line.
-- coalesce(col, '') is this repo's sentinel convention (see
-- uniq_inv_stock_levels_natural_key); nullsNotDistinct is not used anywhere here.

SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "inv_stock_reservations" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_reservations_org_idem"
  ON "inv_stock_reservations" ("org_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_reservations_org_source_active"
  ON "inv_stock_reservations" ("org_id", "source_type", "source_id", coalesce("source_line_id", ''))
  WHERE "status" = 'ACTIVE';
