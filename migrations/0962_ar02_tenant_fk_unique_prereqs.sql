-- AR-02: parent (org_id, key) uniqueness required by the canonical composite tenant foreign keys.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_org_id_id_uniq
  UNIQUE (org_id, id);
--> statement-breakpoint
ALTER TABLE public.principal_groups
  ADD CONSTRAINT principal_groups_org_id_id_uniq
  UNIQUE (org_id, id);
--> statement-breakpoint
ALTER TABLE public.operator_access_grants
  ADD CONSTRAINT operator_access_grants_org_id_grant_id_uniq
  UNIQUE (org_id, grant_id);
