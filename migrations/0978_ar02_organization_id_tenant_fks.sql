-- AR-02: canonical composite tenant foreign keys for relationships whose child scopes tenancy with organization_id rather than org_id; the gate could not see these because it matched only org_id.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.portal_invitations DROP CONSTRAINT IF EXISTS "fk_portal_invitations_inviter_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.portal_invitations
  ADD CONSTRAINT "fk_portal_invitations_inviter_membership_id_org"
  FOREIGN KEY (organization_id, inviter_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE SET NULL (inviter_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.portal_invitations VALIDATE CONSTRAINT "fk_portal_invitations_inviter_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.project_client_grants DROP CONSTRAINT IF EXISTS "fk_project_client_grants_project_id_org";
--> statement-breakpoint
ALTER TABLE public.project_client_grants
  ADD CONSTRAINT "fk_project_client_grants_project_id_org"
  FOREIGN KEY (organization_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.project_client_grants VALIDATE CONSTRAINT "fk_project_client_grants_project_id_org";
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_org_job_role";
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  ADD CONSTRAINT "fk_worker_engagements_org_job_role"
  FOREIGN KEY (organization_id, job_role_id)
  REFERENCES public.hr_job_roles (org_id, id)
  ON DELETE SET NULL (job_role_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.worker_engagements VALIDATE CONSTRAINT "fk_worker_engagements_org_job_role";
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_org_job_level";
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  ADD CONSTRAINT "fk_worker_engagements_org_job_level"
  FOREIGN KEY (organization_id, job_level_id)
  REFERENCES public.hr_job_levels (org_id, id)
  ON DELETE SET NULL (job_level_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.worker_engagements VALIDATE CONSTRAINT "fk_worker_engagements_org_job_level";
--> statement-breakpoint
ALTER TABLE public.party_contacts DROP CONSTRAINT IF EXISTS "fk_party_contacts_party_id_org";
--> statement-breakpoint
ALTER TABLE public.portal_invitations DROP CONSTRAINT IF EXISTS "fk_portal_invitations_accepted_portal_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_worker_id_org";
--> statement-breakpoint
ALTER TABLE public.workers DROP CONSTRAINT IF EXISTS "fk_workers_organization_person_id_org";
--> statement-breakpoint
ALTER TABLE public.portal_invitations DROP CONSTRAINT IF EXISTS "portal_invitations_inviter_membership_id_fkey";
--> statement-breakpoint
ALTER TABLE public.project_client_grants DROP CONSTRAINT IF EXISTS "project_client_grants_project_id_fkey";
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_job_role";
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_job_level";
