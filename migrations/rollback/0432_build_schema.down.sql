-- Rollback for 0432: move the Build tables back to public. Catalog-only, no data movement.
-- The schema is dropped only if empty, so a table added later is never silently destroyed.
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
    IF to_regclass('build.' || quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE build.%I SET SCHEMA public', t);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.resolve_project_org_id(p_project_id integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT org_id FROM projects WHERE id = p_project_id; $$;

CREATE OR REPLACE FUNCTION app.resolve_git_connection_org_id(p_connection_id integer)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT org_id FROM git_connections WHERE id = p_connection_id; $$;

CREATE OR REPLACE FUNCTION app.search_ticket_ids(p_q text, p_limit integer)
RETURNS SETOF integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT t.id FROM public.tickets t
  WHERE t.org_id = app.current_org_id() AND t.deleted_at IS NULL
    AND t.title ILIKE '%' || p_q || '%'
  LIMIT p_limit
$$;

ALTER FUNCTION public.set_org_id_from_parent() RESET search_path;

DROP SCHEMA IF EXISTS "build" RESTRICT;
