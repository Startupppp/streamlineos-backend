-- Data-only. No DDL: support_channels.inbound_secret is text before and after.
--
-- Ticket 15d made the column hash-only at rest -- createChannel now stores
-- `sha256:<hex>` and hands the plaintext back exactly once, listChannels never
-- projects the column, and verifyInboundSecret dual-reads so a row still holding
-- a pre-hash plaintext is digested at read time. That dual read is what let the
-- format change ship without a migration, and it is also why this backfill is safe
-- to run at any moment: both forms verify, before and after.
--
-- Rows written before that change still hold the plaintext. They work, but they are
-- not hash-only at rest, which is the property the change exists to provide.
--
-- The digest matches the application's exactly: hashInboundSecret() in
-- support-inbound-secret.ts is `sha256:` + createHash("sha256").update(secret,"utf8")
-- .digest("hex"), and digest(text,'sha256') over a UTF8 database digests the same
-- bytes. The NOT LIKE guard makes the statement idempotent -- re-running it cannot
-- double-hash a row that is already `sha256:`-prefixed.
--
-- pgcrypto supplies digest() and is a cold-build extension (backend CLAUDE.md §3);
-- it is created in public, which is on the migration search_path.
--
-- IRREVERSIBLE FOR THE OPERATOR, deliberately. After this runs, a channel whose
-- secret was never written down elsewhere cannot be recovered and must be rotated
-- through PATCH /support/channels/:channelId with rotateInboundSecret: true. That
-- rotation path exists precisely so this migration has somewhere to land.

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE support_channels
SET inbound_secret = 'sha256:' || encode(digest(inbound_secret, 'sha256'), 'hex')
WHERE inbound_secret IS NOT NULL
  AND inbound_secret NOT LIKE 'sha256:%';
--> statement-breakpoint

DO $$
DECLARE
  plaintext_rows bigint;
BEGIN
  SELECT count(*) INTO plaintext_rows
    FROM support_channels
   WHERE inbound_secret IS NOT NULL
     AND inbound_secret NOT LIKE 'sha256:%';

  IF plaintext_rows > 0 THEN
    RAISE EXCEPTION 'support_channels still holds % plaintext inbound secret(s)', plaintext_rows;
  END IF;
END $$;
