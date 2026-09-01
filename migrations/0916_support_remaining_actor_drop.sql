SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  target text[];
  updated_count integer;
BEGIN
  FOREACH target SLICE 1 IN ARRAY ARRAY[
    ['kb_articles', 'owner_id', 'owner_membership_id'],
    ['support_routing_rules', 'assignee_id', 'assignee_membership_id'],
    ['support_tickets', 'assignee_id', 'assignee_membership_id'],
    ['support_tickets', 'created_by', 'created_by_membership_id']
  ] LOOP
    LOOP
      EXECUTE format(
        'WITH batch AS (
           SELECT source.id,
             (SELECT om.id FROM organization_members om
              WHERE om.org_id = source.org_id AND om.user_id = source.%2$I
              ORDER BY (om.status = ''ACTIVE'') DESC, om.id DESC LIMIT 1) membership_id
           FROM %1$I source
           WHERE source.%2$I IS NOT NULL AND source.%3$I IS NULL
             AND EXISTS (SELECT 1 FROM organization_members om
               WHERE om.org_id = source.org_id AND om.user_id = source.%2$I)
           ORDER BY source.id LIMIT 1000
         )
         UPDATE %1$I source SET %3$I = batch.membership_id
         FROM batch WHERE source.id = batch.id',
        target[1], target[2], target[3]
      );
      GET DIAGNOSTICS updated_count = ROW_COUNT;
      EXIT WHEN updated_count = 0;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  unmappable_count integer;
BEGIN
  SELECT
    (SELECT count(*) FROM kb_articles WHERE owner_id IS NOT NULL AND owner_membership_id IS NULL) +
    (SELECT count(*) FROM support_routing_rules WHERE assignee_id IS NOT NULL AND assignee_membership_id IS NULL) +
    (SELECT count(*) FROM support_tickets WHERE assignee_id IS NOT NULL AND assignee_membership_id IS NULL) +
    (SELECT count(*) FROM support_tickets WHERE created_by_membership_id IS NULL)
  INTO unmappable_count;
  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0916: % support actor row(s) cannot map to org membership', unmappable_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE support_tickets
  ADD CONSTRAINT ck_support_tickets_created_actor_nn
  CHECK (created_by_membership_id IS NOT NULL) NOT VALID;
ALTER TABLE support_tickets VALIDATE CONSTRAINT ck_support_tickets_created_actor_nn;
ALTER TABLE support_tickets ALTER COLUMN created_by_membership_id SET NOT NULL;
ALTER TABLE support_tickets DROP CONSTRAINT ck_support_tickets_created_actor_nn;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_support_tickets_org_assignee;
--> statement-breakpoint

ALTER TABLE kb_articles
  DROP CONSTRAINT IF EXISTS kb_articles_owner_id_users_id_fk,
  DROP COLUMN IF EXISTS owner_id;
ALTER TABLE support_routing_rules
  DROP CONSTRAINT IF EXISTS support_routing_rules_assignee_id_users_id_fk,
  DROP COLUMN IF EXISTS assignee_id;
ALTER TABLE support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_assignee_id_users_id_fk,
  DROP COLUMN IF EXISTS assignee_id,
  DROP CONSTRAINT IF EXISTS support_tickets_created_by_users_id_fk,
  DROP COLUMN IF EXISTS created_by;
