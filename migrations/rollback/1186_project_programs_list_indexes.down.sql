SET lock_timeout = '5s';
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.search_project_program_ids(text, integer);
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_description_trgm;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_name_trgm;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_program_projects_org_project_program;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_org_portfolio;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_org_health;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_org_owner;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_org_name_page;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_org_updated_page;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_programs_org_created_page;
