-- 0408: The notification_category enum was missing ACCOUNTING while 19 catalog
-- events declared it, so every accounting notification died 22P02 at the
-- notifications insert and was swallowed by the after-commit error handler.
-- The module had never delivered a notification.
--
-- This file contains one statement deliberately. PostgreSQL 12+ allows
-- ALTER TYPE ... ADD VALUE inside a transaction block (Drizzle wraps each
-- migration in one), but the new label cannot be USED until that transaction
-- commits. Anything referencing 'ACCOUNTING' must ship in a later migration.
--
-- IF NOT EXISTS keeps it idempotent: the label was applied directly to the dev
-- database ahead of this file, so a later db:migrate re-run is a no-op.
-- Not reversible — PostgreSQL cannot drop an enum label. Additive and unused
-- on rollback; see docs/refactor/notifications-phase1-rollback.sql.

ALTER TYPE "notification_category" ADD VALUE IF NOT EXISTS 'ACCOUNTING';
