-- E1 — the four packs, as columns on `inv_settings`.
--
-- A pack is a bundle of domain rules only some organisations want: HSN codes and
-- tax treatment (gst), MRP and LASA handling (pharmacy), loose versus packed
-- selling units (kirana). Warehouse is the core product, so it defaults on; the
-- other three default off, because a field that is mandatory for a pharmacy is
-- noise for a distributor and a validation rule nobody asked for reads as a bug
-- from the operator's side of the screen.
--
-- Additive and defaulted, so every existing organisation lands on warehouse-only
-- with no backfill and no behaviour change. Turning a pack off later hides its
-- navigation, fields and validation; it never deletes the rows already captured,
-- so a pack switched off and on again finds its data intact.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "pack_warehouse" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "pack_kirana" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "pack_pharmacy" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "pack_gst" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- At least one pack must stay on. The service refuses it too, with a legible
-- message; this is what makes it true against a direct write.
ALTER TABLE "inv_settings"
  ADD CONSTRAINT "chk_inv_settings_one_pack"
  CHECK ("pack_warehouse" OR "pack_kirana" OR "pack_pharmacy" OR "pack_gst") NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_settings" VALIDATE CONSTRAINT "chk_inv_settings_one_pack";
