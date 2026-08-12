-- Rollback for 0426: identity -> serial for the same 65 Build tables.
-- Restores a nextval default and an owned sequence positioned above MAX(id).
-- Column types never changed, so no foreign key is involved in either direction.
DO $$
DECLARE r record; seqname text; nxt bigint;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, a.attname AS col
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pk.conkey[1]
    WHERE n.nspname = 'public' AND array_length(pk.conkey,1) = 1
      AND a.attidentity <> '' AND format_type(a.atttypid, NULL) = 'integer'
      AND c.relname = ANY (ARRAY[
    'bugs',
    'change_requests',
    'changelog_entries',
    'cycles',
    'feedback_posts',
    'feedback_votes',
    'feedbucket_attachments',
    'feedbucket_submissions',
    'feedbucket_widgets',
    'form_submissions',
    'git_connections',
    'git_ticket_links',
    'incident_updates',
    'intake_items',
    'managed_product_releases',
    'managed_products',
    'meeting_action_items',
    'meeting_attendees',
    'meeting_standup_entries',
    'modules',
    'okr_goals',
    'okr_key_results',
    'okr_links',
    'okr_updates',
    'pages',
    'portfolio_projects',
    'program_projects',
    'project_approvals',
    'project_automations',
    'project_decisions',
    'project_forms',
    'project_incidents',
    'project_meetings',
    'project_members',
    'project_milestones',
    'project_portfolios',
    'project_programs',
    'project_releases',
    'project_risks',
    'project_statuses',
    'project_template_tickets',
    'project_templates',
    'project_views',
    'project_webhooks',
    'project_whiteboard_shares',
    'project_whiteboards',
    'projects',
    'release_tickets',
    'roadmap_items',
    'roadmap_votes',
    'sprints',
    'test_cases',
    'test_run_results',
    'test_runs',
    'test_suites',
    'ticket_attachments',
    'ticket_checklist_items',
    'ticket_checklists',
    'ticket_comment_reactions',
    'ticket_custom_field_values',
    'ticket_labels',
    'ticket_related_links',
    'tickets',
    'work_item_relations',
    'workflow_transitions'
      ])
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP IDENTITY IF EXISTS', r.tbl, r.col);
    seqname := r.tbl || '_' || r.col || '_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I OWNED BY %I.%I', seqname, r.tbl, r.col);
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) + 1 FROM %I', r.col, r.tbl) INTO nxt;
    EXECUTE format('SELECT setval(%L, %s, false)', seqname, nxt);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT nextval(%L)', r.tbl, r.col, seqname);
  END LOOP;
END $$;
