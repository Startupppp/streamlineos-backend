-- 0831 intended to convert the chat_channels creator FK but named it
-- fk_chat_channels_org_created_by_membership, while the live constraint is
-- fk_chat_channels_org_creator_membership. Its IF EXISTS guard meant the rename
-- mismatch failed silently and the constraint stayed ON DELETE RESTRICT, so a member
-- who ever created a chat channel remained undeletable (23001). Only a pg_catalog
-- diff finds a partially executed migration.
--
-- A channel creator is attribution, not authority, so the reference is cleared rather
-- than blocking removal. The column-list form is required: a bare composite SET NULL
-- would also null org_id, which is NOT NULL, and every delete would fail 23502.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE chat_channels
  DROP CONSTRAINT IF EXISTS fk_chat_channels_org_creator_membership;
--> statement-breakpoint

ALTER TABLE chat_channels
  ADD CONSTRAINT fk_chat_channels_org_creator_membership
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE chat_channels VALIDATE CONSTRAINT fk_chat_channels_org_creator_membership;
--> statement-breakpoint

DO $$
DECLARE
  deltype "char";
  cols smallint[];
  validated boolean;
BEGIN
  SELECT c.confdeltype, c.confdelsetcols, c.convalidated
    INTO deltype, cols, validated
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE r.relname = 'chat_channels'
    AND c.conname = 'fk_chat_channels_org_creator_membership';

  IF deltype IS NULL THEN
    RAISE EXCEPTION '0838: fk_chat_channels_org_creator_membership is missing';
  END IF;
  IF deltype <> 'n' THEN
    RAISE EXCEPTION '0838: fk_chat_channels_org_creator_membership is not ON DELETE SET NULL (confdeltype=%)', deltype;
  END IF;
  IF cols IS NULL OR array_length(cols, 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '0838: fk_chat_channels_org_creator_membership has no single-column SET NULL list; org_id would be nulled';
  END IF;
  IF NOT validated THEN
    RAISE EXCEPTION '0838: fk_chat_channels_org_creator_membership is NOT VALID';
  END IF;
END $$;
