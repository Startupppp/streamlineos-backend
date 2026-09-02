-- 1008 DOWN -- refuses, and that refusal is the point.
--
-- 1008 replaced each plaintext inbound secret with its SHA-256 digest. A digest cannot
-- be inverted, so there is no statement that restores the previous column contents; a
-- down migration that silently did nothing would report a successful revert while
-- leaving every channel hashed, which is worse than failing.
--
-- The operational undo is not a migration. Rotate the affected channel through
-- PATCH /support/channels/:channelId with rotateInboundSecret: true, which mints a new
-- secret, stores its digest and returns the plaintext once.
--
-- Reverting the CODE alone is safe and needs no database change: verifyInboundSecret
-- dual-reads, so hashed rows keep verifying against any build that still carries it.

DO $$
BEGIN
  RAISE EXCEPTION 'migration 1008 cannot be reverted: a SHA-256 digest is not invertible. Rotate the affected channels through PATCH /support/channels/:channelId instead.';
END $$;
