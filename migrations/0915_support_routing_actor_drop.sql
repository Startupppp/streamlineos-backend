-- 0915: contract support routing and mention targets to org memberships.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  target text[];
  updated_count integer;
BEGIN
  FOREACH target SLICE 1 IN ARRAY ARRAY[
    ['support_agent_skills', 'user_id', 'user_membership_id'],
    ['support_agent_availability', 'user_id', 'user_membership_id'],
    ['support_message_mentions', 'mentioned_user_id', 'mentioned_user_membership_id']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target[1] AND column_name = target[2]
    ) THEN
      CONTINUE;
    END IF;
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
DECLARE unmappable_count integer;
BEGIN
  SELECT
    (SELECT count(*) FROM support_agent_skills WHERE user_membership_id IS NULL) +
    (SELECT count(*) FROM support_agent_availability WHERE user_membership_id IS NULL) +
    (SELECT count(*) FROM support_message_mentions WHERE mentioned_user_membership_id IS NULL)
  INTO unmappable_count;
  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0915: % support actor row(s) cannot map to org membership', unmappable_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE support_agent_skills
  ADD CONSTRAINT ck_support_agent_skills_membership_nn
  CHECK (user_membership_id IS NOT NULL) NOT VALID;
ALTER TABLE support_agent_skills VALIDATE CONSTRAINT ck_support_agent_skills_membership_nn;
ALTER TABLE support_agent_skills ALTER COLUMN user_membership_id SET NOT NULL;
ALTER TABLE support_agent_skills DROP CONSTRAINT ck_support_agent_skills_membership_nn;
--> statement-breakpoint

ALTER TABLE support_agent_availability
  ADD CONSTRAINT ck_support_agent_availability_membership_nn
  CHECK (user_membership_id IS NOT NULL) NOT VALID;
ALTER TABLE support_agent_availability VALIDATE CONSTRAINT ck_support_agent_availability_membership_nn;
ALTER TABLE support_agent_availability ALTER COLUMN user_membership_id SET NOT NULL;
ALTER TABLE support_agent_availability DROP CONSTRAINT ck_support_agent_availability_membership_nn;
--> statement-breakpoint

ALTER TABLE support_message_mentions
  ADD CONSTRAINT ck_support_message_mentions_membership_nn
  CHECK (mentioned_user_membership_id IS NOT NULL) NOT VALID;
ALTER TABLE support_message_mentions VALIDATE CONSTRAINT ck_support_message_mentions_membership_nn;
ALTER TABLE support_message_mentions ALTER COLUMN mentioned_user_membership_id SET NOT NULL;
ALTER TABLE support_message_mentions DROP CONSTRAINT ck_support_message_mentions_membership_nn;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_support_agent_skills_org_user_skill;
DROP INDEX IF EXISTS uniq_support_agent_availability_org_user;
DROP INDEX IF EXISTS uniq_support_message_mentions_message_user;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_agent_skills_org_membership_skill
  ON support_agent_skills(org_id, user_membership_id, skill);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_agent_availability_org_membership
  ON support_agent_availability(org_id, user_membership_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_message_mentions_message_membership
  ON support_message_mentions(message_id, mentioned_user_membership_id);
--> statement-breakpoint

ALTER TABLE support_agent_skills
  DROP CONSTRAINT IF EXISTS support_agent_skills_user_id_users_id_fk,
  DROP COLUMN IF EXISTS user_id;
ALTER TABLE support_agent_availability
  DROP CONSTRAINT IF EXISTS support_agent_availability_user_id_users_id_fk,
  DROP COLUMN IF EXISTS user_id;
ALTER TABLE support_message_mentions
  DROP CONSTRAINT IF EXISTS support_message_mentions_mentioned_user_id_users_id_fk,
  DROP COLUMN IF EXISTS mentioned_user_id;
