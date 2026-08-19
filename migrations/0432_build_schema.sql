-- 0432: move the Build module tables into their own `build` schema.
--
-- Second and final step of the schema split (0431 moved the append-only tables to `build_events`).
-- SET SCHEMA is catalog-only: FKs, indexes, owned identity sequences and RLS policies follow the
-- table. Schema USAGE and per-schema default privileges do not, and are granted here.
--
-- search_path is NOT a safety net on this deployment -- Neon's pooled endpoint ignores per-role
-- startup settings, so an unqualified reference to a moved table fails 42P01. Every reference is
-- therefore qualified before the move: the Drizzle declarations use pgSchema("build"), the raw SQL
-- call sites name build.<table>, and the three SECURITY DEFINER resolvers below are recreated
-- against the new location. set_org_id_from_parent resolves its parent with %I through search_path,
-- so it gets an explicit function-level search_path, which Postgres does apply.

CREATE SCHEMA IF NOT EXISTS "build";
--> statement-breakpoint

GRANT USAGE ON SCHEMA "build" TO streamline_app;
--> statement-breakpoint

REVOKE CREATE ON SCHEMA "build" FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bugs', 'change_requests', 'changelog_entries', 'comment_drafts',
    'cycles', 'feedback_posts', 'feedback_votes', 'feedbucket_attachments',
    'feedbucket_submissions', 'feedbucket_widgets', 'form_submissions', 'git_connections',
    'git_ticket_links', 'incident_updates', 'intake_items', 'managed_product_releases',
    'managed_products', 'meeting_action_items', 'meeting_attendees', 'meeting_standup_entries',
    'modules', 'okr_goals', 'okr_key_results', 'okr_links',
    'okr_updates', 'pages', 'pm_workspace_memberships', 'pm_workspaces',
    'portfolio_projects', 'program_projects', 'project_approvals', 'project_automations',
    'project_daily_snapshots', 'project_decisions', 'project_forms', 'project_incidents',
    'project_meetings', 'project_members', 'project_milestones', 'project_portfolios',
    'project_programs', 'project_releases', 'project_risks', 'project_statuses',
    'project_team_assignments', 'project_team_members', 'project_teams', 'project_template_tickets',
    'project_templates', 'project_ticket_counters', 'project_views', 'project_webhooks',
    'project_whiteboard_shares', 'project_whiteboards', 'project_workspace_members', 'projects',
    'release_tickets', 'roadmap_items', 'roadmap_votes', 'sprints',
    'test_cases', 'test_run_results', 'test_runs', 'test_suites',
    'ticket_assignees', 'ticket_attachments', 'ticket_checklist_items', 'ticket_checklists',
    'ticket_comment_mentions', 'ticket_comment_reactions', 'ticket_custom_field_values', 'ticket_label_mappings',
    'ticket_labels', 'ticket_related_links', 'ticket_watchers', 'tickets',
    'webhook_deliveries', 'work_item_relations', 'workflow_transitions'
  ] LOOP
    IF to_regclass('public.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA build', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA "build"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO streamline_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA "build"
  GRANT USAGE, SELECT ON SEQUENCES TO streamline_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "build" TO streamline_app;
--> statement-breakpoint

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "build" TO streamline_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.resolve_project_org_id(p_project_id integer)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, build, public
AS $$
  SELECT org_id FROM build.projects WHERE id = p_project_id;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.resolve_git_connection_org_id(p_connection_id integer)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, build, public
AS $$
  SELECT org_id FROM build.git_connections WHERE id = p_connection_id;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_ticket_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, build, public, app
AS $$
  SELECT t.id
  FROM build.tickets t
  WHERE t.org_id = app.current_org_id()
    AND t.deleted_at IS NULL
    AND t.title ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_ticket_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_ticket_ids(text, integer) TO streamline_app;
--> statement-breakpoint

ALTER FUNCTION public.set_org_id_from_parent() SET search_path = public, build, build_events;
