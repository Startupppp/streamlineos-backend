SET lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.communication_backfill_issues') IS NOT NULL THEN
    ALTER TABLE communication_backfill_issues ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS communication_backfill_issues_tenant_isolation ON communication_backfill_issues;
    CREATE POLICY communication_backfill_issues_tenant_isolation ON communication_backfill_issues
      USING (org_id = app.current_org_id())
      WITH CHECK (org_id = app.current_org_id());
  END IF;
  IF to_regclass('public.chat_message_reactions') IS NOT NULL THEN
    ALTER TABLE chat_message_reactions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS chat_message_reactions_tenant_isolation ON chat_message_reactions;
    CREATE POLICY chat_message_reactions_tenant_isolation ON chat_message_reactions
      USING (org_id = app.current_org_id())
      WITH CHECK (org_id = app.current_org_id());
  END IF;
END $$;
