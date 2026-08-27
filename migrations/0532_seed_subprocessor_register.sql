-- The register that ticket 16 built and never put a row in.
--
-- `subprocessors` has a read API, rate limits and a subscriber table, and has
-- been empty since it was created: no migration inserts, and there is no
-- create/update/retire endpoint. So `GET /compliance/subprocessors` answers with
-- nothing while `/legal/privacy` renders a hardcoded eight-row table of the real
-- vendors. Two registers, one of which customers read and one of which the API
-- serves, and they have never agreed.
--
-- These eight are that page's list, copied verbatim so the two now agree. The
-- page is left as it is deliberately: it also promises thirty days' notice and
-- email to Enterprise customers before a subprocessor is added, and whether to
-- keep or amend that commitment is a decision for whoever owns it, not something
-- to settle in a migration.
--
-- `effective_from` is backdated to the platform's own start rather than now:
-- these vendors were processing data long before this row existed, and dating
-- them today would tell a customer reading `changesSince` that eight new
-- subprocessors appeared the day the register was seeded.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "subprocessors" ("subprocessor_id", "name", "purpose", "location", "effective_from")
VALUES
  (gen_random_uuid(), 'Neon (Postgres)', 'Primary database', 'AP Southeast 1 / your region', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'Cloudflare R2', 'File storage (avatars, attachments, payslips)', 'Global', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'Zoho ZeptoMail', 'Transactional email (auth, notifications)', 'India', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'Ably', 'Realtime chat and presence', 'Global edge', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'Inngest', 'Background jobs and scheduled reports', 'US / EU', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'Upstash Redis', 'Rate limiting and session cache', 'Your region', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'OpenAI / Google AI', 'Optional AI features (you can disable)', 'US', TIMESTAMP '2026-01-01 00:00:00'),
  (gen_random_uuid(), 'Vercel', 'Hosting and edge delivery', 'Global', TIMESTAMP '2026-01-01 00:00:00')
ON CONFLICT DO NOTHING;
