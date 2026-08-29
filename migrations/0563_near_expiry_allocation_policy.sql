-- D2 — short-dated stock is a different question from expired stock.
--
-- `inv_settings.expiry_reservation_policy` decides whether an already-expired
-- lot may be promised at all. These two decide what happens to a lot that is
-- still good but close to its date: physically fine, saleable, and routinely
-- refused on arrival by the customer receiving it.
--
--   DEPRIORITIZE (the default) keeps it allocatable and takes it last, so a
--     warehouse ships its oldest good stock first and only reaches the
--     short-dated tier when nothing else can cover the line;
--   BLOCK refuses it automatically and leaves it for somebody holding
--     `inventory:allocation:override` to take deliberately, with a reason;
--   ALLOW restores the previous behaviour exactly — no tier, pure FEFO.
--
-- The default is DEPRIORITIZE rather than ALLOW because the old behaviour was
-- not a decision anybody made: near-expiry stock was invisible to the allocator,
-- so FEFO cheerfully promised a lot expiring on Thursday. Deprioritizing changes
-- the order and never the answer to "can this line be filled", so no
-- organisation loses an allocation it would previously have got.
--
-- The window matches G3's expiry notification sweep, so "you were warned" and
-- "the allocator stopped offering it" line up instead of being two independent
-- opinions about the same lot.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "inv_near_expiry_policy" AS ENUM ('ALLOW', 'DEPRIORITIZE', 'BLOCK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_settings"
  ADD COLUMN IF NOT EXISTS "near_expiry_policy" "inv_near_expiry_policy" DEFAULT 'DEPRIORITIZE' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings"
  ADD COLUMN IF NOT EXISTS "near_expiry_window_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
-- A window wider than the shelf life it describes silently blocks the whole
-- catalogue, which reads as "allocation is broken" rather than as a setting.
ALTER TABLE "inv_settings"
  ADD CONSTRAINT "chk_inv_settings_near_expiry_window"
  CHECK ("near_expiry_window_days" >= 0 AND "near_expiry_window_days" <= 365) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_settings" VALIDATE CONSTRAINT "chk_inv_settings_near_expiry_window";
