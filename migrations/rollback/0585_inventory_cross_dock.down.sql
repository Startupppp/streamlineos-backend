-- 0585.down — Remove the cross-dock link from GRN lines.
--
-- @data-loss: inv_grn_lines
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_grn_lines_org_cross_dock";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP CONSTRAINT IF EXISTS "inv_grn_lines_cross_dock_so_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP COLUMN IF EXISTS "cross_dock_so_id";
