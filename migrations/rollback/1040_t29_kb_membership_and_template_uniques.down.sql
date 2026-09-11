-- 1040 DOWN -- drops the three uniques.
--
-- @data-loss on the way FORWARD, not on the way back: 1040's DELETEs remove
-- rows that duplicate another row on every meaningful column, and this rollback
-- cannot resurrect them. Dropping the indexes is itself lossless and returns
-- KbMembersService.add and KbPageTemplatesService.create to unguarded inserts.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_kb_page_templates_org_name";
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_kb_space_members_org_space_role";
--> statement-breakpoint

DROP INDEX IF EXISTS public."uniq_kb_space_members_org_space_membership";
