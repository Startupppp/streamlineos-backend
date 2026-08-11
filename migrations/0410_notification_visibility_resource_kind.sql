-- 0409: PIPE-003. Nothing in the notification path ever re-checked whether a
-- recipient could still see the thing being notified about — the only gate was
-- ACTIVE org membership, evaluated at enqueue. A user removed from a project
-- between enqueue and send still received the ticket title and body.
--
-- An event declares WHICH resource kind guards it. NULL means the event is
-- self-scoped (your payslip, your role change) and membership is the whole
-- authorization. Non-NULL means a resolver must be registered for that kind, and
-- a missing resolver denies (fail closed, CLAUDE.md §0.5).
--
-- Nullable and additive: every one of the 126 seeded events keeps NULL and is
-- unaffected until its catalog entry opts in.

ALTER TABLE "notification_events" ADD COLUMN IF NOT EXISTS "visibility_resource_kind" text;
