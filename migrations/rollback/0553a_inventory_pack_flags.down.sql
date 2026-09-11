-- 0553.down — Remove the vertical pack flags from inv_settings.
--
-- @data-loss: inv_settings
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_settings" DROP CONSTRAINT IF EXISTS "chk_inv_settings_one_pack";
--> statement-breakpoint
ALTER TABLE "inv_settings"
  DROP COLUMN IF EXISTS "pack_pharmacy",
  DROP COLUMN IF EXISTS "pack_kirana",
  DROP COLUMN IF EXISTS "pack_warehouse",
  DROP COLUMN IF EXISTS "pack_gst";
