-- Chat channel invite tokens were stored in plaintext, so any reader of this table
-- could join any private channel it covers.
--
-- Two columns, each with one job: token_hash carries the indexed lookup on join,
-- token_encrypted carries the re-display an admin needs when re-opening the invite
-- dialog. Hashing alone would break that re-display and silently kill links already
-- shared, which is why this is not hash-only like organization invitations.
--
-- The hash is backfilled here so every link already in circulation keeps working.
-- The ciphertext CANNOT be backfilled in SQL - it needs the application's
-- ENCRYPTION_KEY - so existing rows keep their plaintext `token` until the link is
-- next regenerated, at which point the plaintext is dropped. New links never write it.

SET lock_timeout = '5s';

ALTER TABLE chat_channel_invite_links
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS token_encrypted text;

-- pgcrypto is already installed; digest() is how the application hashes on write.
UPDATE chat_channel_invite_links
SET token_hash = encode(digest(token, 'sha256'), 'hex')
WHERE token IS NOT NULL
  AND token_hash IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_invite_link_token_hash
  ON chat_channel_invite_links (token_hash);

-- Newly minted links carry no plaintext, so the old column has to allow NULL.
ALTER TABLE chat_channel_invite_links
  ALTER COLUMN token DROP NOT NULL;
