SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.managed_products
  DROP CONSTRAINT IF EXISTS fk_managed_products_owner_membership;
--> statement-breakpoint
ALTER TABLE build.managed_products
  ADD CONSTRAINT fk_managed_products_owner_membership
    FOREIGN KEY (org_id, owner_membership_id)
    REFERENCES public.organization_members (org_id, id)
    ON DELETE SET NULL (owner_membership_id)
    NOT VALID;
--> statement-breakpoint
ALTER TABLE build.managed_products
  VALIDATE CONSTRAINT fk_managed_products_owner_membership;
