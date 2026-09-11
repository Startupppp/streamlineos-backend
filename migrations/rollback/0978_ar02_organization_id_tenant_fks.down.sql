-- 0978_ar02_organization_id_tenant_fks DOWN — restores the single-column foreign keys and the duplicate composites, and returns the two rebuilt composites to NO ACTION.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  ADD CONSTRAINT "fk_worker_engagements_job_level"
  FOREIGN KEY (job_level_id) REFERENCES public.hr_job_levels (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  ADD CONSTRAINT "fk_worker_engagements_job_role"
  FOREIGN KEY (job_role_id) REFERENCES public.hr_job_roles (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.project_client_grants
  ADD CONSTRAINT "project_client_grants_project_id_fkey"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.portal_invitations
  ADD CONSTRAINT "portal_invitations_inviter_membership_id_fkey"
  FOREIGN KEY (inviter_membership_id) REFERENCES public.organization_members (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.workers
  ADD CONSTRAINT "fk_workers_organization_person_id_org"
  FOREIGN KEY (organization_id, organization_person_id) REFERENCES public.organization_people (organization_id, organization_person_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.worker_engagements
  ADD CONSTRAINT "fk_worker_engagements_worker_id_org"
  FOREIGN KEY (organization_id, worker_id) REFERENCES public.workers (organization_id, worker_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.portal_invitations
  ADD CONSTRAINT "fk_portal_invitations_accepted_portal_membership_id_org"
  FOREIGN KEY (organization_id, accepted_portal_membership_id) REFERENCES public.portal_memberships (organization_id, portal_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.party_contacts
  ADD CONSTRAINT "fk_party_contacts_party_id_org"
  FOREIGN KEY (organization_id, party_id) REFERENCES public.business_parties (organization_id, party_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_org_job_level";
--> statement-breakpoint
ALTER TABLE public.worker_engagements DROP CONSTRAINT IF EXISTS "fk_worker_engagements_org_job_role";
--> statement-breakpoint
ALTER TABLE public.project_client_grants DROP CONSTRAINT IF EXISTS "fk_project_client_grants_project_id_org";
--> statement-breakpoint
ALTER TABLE public.project_client_grants
  ADD CONSTRAINT "fk_project_client_grants_project_id_org"
  FOREIGN KEY (organization_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.portal_invitations DROP CONSTRAINT IF EXISTS "fk_portal_invitations_inviter_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.portal_invitations
  ADD CONSTRAINT "fk_portal_invitations_inviter_membership_id_org"
  FOREIGN KEY (organization_id, inviter_membership_id) REFERENCES public.organization_members (org_id, id)
  NOT VALID;
