SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0389 — drop `users.has_dashboard_access`.
--
-- A second, weaker `is_active`: every creation path wrote `true` while the column
-- default was `false`, no screen rendered or toggled it, and a row created
-- outside those paths lost the whole application shell with no way to recover.
-- Home-module reachability is not a per-user flag.
--
-- Verified before dropping: zero symbol references, zero raw-SQL references, and
-- no FK, index, view or constraint depends on it.

ALTER TABLE "users" DROP COLUMN IF EXISTS "has_dashboard_access";
