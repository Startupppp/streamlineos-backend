DELETE FROM invitations i1
WHERE accepted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM invitations i2
    WHERE i2.org_id = i1.org_id
      AND i2.email = i1.email
      AND i2.accepted_at IS NULL
      AND i2.created_at > i1.created_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_invitations_org_email_pending
  ON invitations (org_id, email)
  WHERE accepted_at IS NULL;
