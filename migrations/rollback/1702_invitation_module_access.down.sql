SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "invitation_module_access"
  DROP CONSTRAINT IF EXISTS "fk_ima_invitation";
--> statement-breakpoint

ALTER TABLE "invitation_module_access"
  DROP CONSTRAINT IF EXISTS "fk_ima_org";
--> statement-breakpoint

DROP TABLE IF EXISTS "invitation_module_access";
--> statement-breakpoint
