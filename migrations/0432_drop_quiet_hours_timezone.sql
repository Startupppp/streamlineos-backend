-- 0432: SCH-012 contract step.
--
-- `notification_preferences.quiet_hours_timezone` defaulted to 'UTC' while the real
-- user timezone lived in `user_preferences.timezone` ('Asia/Kolkata' for these users).
-- Quiet hours were therefore evaluated in the wrong zone — silencing notifications at
-- the wrong time of day, and letting them through at the wrong time of night.
--
-- The read path was cut over in the expand step: `resolvePrefs` takes the timezone from
-- `user_preferences`. Nothing has read this column since, and with it removed from the
-- DTO nothing can write it either. This is the contract half, deliberately in its own
-- migration rather than alongside the code that stopped reading it.

SET lock_timeout = '5s';

ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "quiet_hours_timezone";
