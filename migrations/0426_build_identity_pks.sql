-- 0426: SCH-004 / PM-011 — replace `serial` primary keys with identity columns across Build.
--
-- CLAUDE.md §19 requires every table to use a UUID or `generatedAlwaysAsIdentity()` PK and never
-- `serial`. 65 Build tables still carried `serial`, which is an `integer` column plus a `nextval`
-- default: the sequence is detached from the column, so an explicit insert or a restored dump can
-- silently reuse a live id, and `GRANT`s on the sequence are a separate object to get wrong.
--
-- This changes NO column types, so none of the 240 inbound foreign keys are touched. That is the whole
-- reason it is safe to do in one migration: `serial` -> identity is a default/ownership change, not a
-- type change. (Widening these ids to bigint IS a type change and would require every referencing
-- column to move in lockstep — deliberately not done here; see DECISIONS.md B-28.)
--
-- GENERATED ALWAYS rather than BY DEFAULT, per §19. Verified first that nothing inserts an explicit id
-- into any of these tables — the only literal `id:` inserts in Build are on `organizations`, whose PK
-- is text.
--
-- Each sequence is resolved with pg_get_serial_sequence BEFORE the default is dropped (afterwards the
-- link is gone), and each identity restarts above the current MAX(id) so no live id is ever reissued.
-- Idempotent: tables already converted have attidentity <> '' and are skipped by the cursor.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  r record;
  seq text;
  nxt bigint;
  converted int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, a.attname AS col
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pk.conkey[1]
    JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND array_length(pk.conkey, 1) = 1
      AND a.attidentity = ''
      AND format_type(a.atttypid, NULL) = 'integer'
      AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%'
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
    seq := pg_get_serial_sequence(format('public.%I', r.tbl), r.col);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', r.tbl, r.col);
    IF seq IS NOT NULL THEN
      EXECUTE format('DROP SEQUENCE IF EXISTS %s', seq);
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I ADD GENERATED ALWAYS AS IDENTITY', r.tbl, r.col);
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) + 1 FROM %I', r.col, r.tbl) INTO nxt;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I RESTART WITH %s', r.tbl, r.col, nxt);
    converted := converted + 1;
  END LOOP;
  RAISE NOTICE 'converted % serial primary keys to identity', converted;
END $$;
