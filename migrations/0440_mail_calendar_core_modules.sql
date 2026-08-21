-- Ticket 12 blocker. `assertModuleAccessPolicy` refuses before any authority check when
-- `isModuleEnabled` is false, and `isModuleEnabled` answers true only for a module the catalog
-- marks core or an organisation has explicitly enabled. Mail and calendar have neither, so adding
-- them to the managed set would have made every mail and calendar access screen throw
-- "The mail module is not enabled" for every organisation.
--
-- Root CLAUDE.md §8 already settles what they are: mail, chat and the one unified calendar are
-- platform core that every active member keeps, never paid entitlements. Recording that in the
-- catalog is the fix, and it also keeps them out of plan gating for good.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "modules_catalog" ("module_key", "name", "description", "is_core", "is_paid_only", "sort_order", "status")
VALUES
  ('mail', 'Mail', 'Unified mail inbox available to every active member', true, false, 910, 'ACTIVE'),
  ('calendar', 'Calendar', 'One unified calendar serving every active member', true, false, 920, 'ACTIVE')
ON CONFLICT ("module_key") DO UPDATE
SET "is_core" = true,
    "is_paid_only" = false,
    "status" = 'ACTIVE';
--> statement-breakpoint
-- Chat is already core by fallback; make the catalog say so rather than relying on the fallback.
UPDATE "modules_catalog"
SET "is_core" = true, "is_paid_only" = false
WHERE "module_key" IN ('chat', 'kb');
