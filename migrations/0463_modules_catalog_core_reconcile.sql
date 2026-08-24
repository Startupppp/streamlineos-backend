-- The module registry and modules_catalog disagreed about which modules are core, and
-- nothing said so: `onModuleInit` unioned the two, which made the disagreement invisible
-- by making it harmless. The registry now derives core from `!planGated` and reconciles
-- loudly instead, and this brings the stored rows up to match.
--
-- The registry's nine: kb, home, chat, mail, calendar, notifications, workflows, blog,
-- directory. The database had eight of them and was missing `notifications`.
--
-- Idempotent on both sides: it inserts the row only if absent and corrects `is_core`
-- only where it differs, so a database already in agreement is untouched.

SET lock_timeout = '5s';

INSERT INTO modules_catalog (module_key, name, is_core, is_paid_only, sort_order, status)
VALUES ('notifications', 'Notifications', true, false, 90, 'ACTIVE')
ON CONFLICT (module_key) DO UPDATE SET is_core = true;

UPDATE modules_catalog
   SET is_core = true
 WHERE module_key IN ('kb','home','chat','mail','calendar','notifications','workflows','blog','directory')
   AND is_core IS DISTINCT FROM true;

UPDATE modules_catalog
   SET is_core = false
 WHERE module_key NOT IN ('kb','home','chat','mail','calendar','notifications','workflows','blog','directory')
   AND is_core IS DISTINCT FROM false;
