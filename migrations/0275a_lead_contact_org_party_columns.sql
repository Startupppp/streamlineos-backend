-- Custom SQL migration file, put your code below! --

-- The other three legacy tables get the same treatment `clients` did.
--
-- Phase 2, ticket 08. 0272 covered `clients`, which was the largest of the four
-- with twelve blocking columns. This is `leads` (nine), `contacts` (seven) and
-- `crm_organizations` (three) -- the rest of what `DROP TABLE` would refuse on.
--
-- `build.tickets.customer_id` appears twice across the two migrations, because
-- it genuinely points at two tables: it has a foreign key to `clients` AND one
-- to `crm_organizations`. It gets a column for each rather than one shared
-- column, since which of the two a given row means is exactly the information
-- that would be lost by merging them.
--
-- `survey_participants` likewise carries both a `lead_id` and a `contact_id`.
--
-- Expand only, same as 0272: every legacy column stays, every reader keeps
-- working, and the contract migration removes them once nothing reads them.

SET lock_timeout = '5s';

-- calendar_events.linked_lead_id -> leads
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS linked_lead_party_id text;

UPDATE calendar_events t
   SET linked_lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.linked_lead_id
   AND m.organization_id = t.org_id
   AND t.linked_lead_party_id IS NULL
   AND t.linked_lead_id IS NOT NULL;

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS fk_calendar_events_linked_lead_party_id;
ALTER TABLE calendar_events
  ADD CONSTRAINT fk_calendar_events_linked_lead_party_id
  FOREIGN KEY (org_id, linked_lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE calendar_events VALIDATE CONSTRAINT fk_calendar_events_linked_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_calendar_events_linked_lead_party_id ON calendar_events (org_id, linked_lead_party_id);

-- client_accounts.lead_id -> leads
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE client_accounts t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS fk_client_accounts_lead_party_id;
ALTER TABLE client_accounts
  ADD CONSTRAINT fk_client_accounts_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE client_accounts VALIDATE CONSTRAINT fk_client_accounts_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_client_accounts_lead_party_id ON client_accounts (org_id, lead_party_id);

-- crm_lead_touchpoints.lead_id -> leads
ALTER TABLE crm_lead_touchpoints ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE crm_lead_touchpoints t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE crm_lead_touchpoints DROP CONSTRAINT IF EXISTS fk_crm_lead_touchpoints_lead_party_id;
ALTER TABLE crm_lead_touchpoints
  ADD CONSTRAINT fk_crm_lead_touchpoints_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE crm_lead_touchpoints VALIDATE CONSTRAINT fk_crm_lead_touchpoints_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_crm_lead_touchpoints_lead_party_id ON crm_lead_touchpoints (org_id, lead_party_id);

-- deals.lead_id -> leads
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE deals t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS fk_deals_lead_party_id;
ALTER TABLE deals
  ADD CONSTRAINT fk_deals_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE deals VALIDATE CONSTRAINT fk_deals_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_deals_lead_party_id ON deals (org_id, lead_party_id);

-- lead_activities.lead_id -> leads
ALTER TABLE lead_activities ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE lead_activities t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE lead_activities DROP CONSTRAINT IF EXISTS fk_lead_activities_lead_party_id;
ALTER TABLE lead_activities
  ADD CONSTRAINT fk_lead_activities_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE lead_activities VALIDATE CONSTRAINT fk_lead_activities_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_party_id ON lead_activities (org_id, lead_party_id);

-- lead_emails.lead_id -> leads
ALTER TABLE lead_emails ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE lead_emails t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE lead_emails DROP CONSTRAINT IF EXISTS fk_lead_emails_lead_party_id;
ALTER TABLE lead_emails
  ADD CONSTRAINT fk_lead_emails_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE lead_emails VALIDATE CONSTRAINT fk_lead_emails_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_lead_emails_lead_party_id ON lead_emails (org_id, lead_party_id);

-- lead_notes.lead_id -> leads
ALTER TABLE lead_notes ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE lead_notes t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE lead_notes DROP CONSTRAINT IF EXISTS fk_lead_notes_lead_party_id;
ALTER TABLE lead_notes
  ADD CONSTRAINT fk_lead_notes_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE lead_notes VALIDATE CONSTRAINT fk_lead_notes_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_party_id ON lead_notes (org_id, lead_party_id);

-- lead_tasks.lead_id -> leads
ALTER TABLE lead_tasks ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE lead_tasks t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE lead_tasks DROP CONSTRAINT IF EXISTS fk_lead_tasks_lead_party_id;
ALTER TABLE lead_tasks
  ADD CONSTRAINT fk_lead_tasks_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE lead_tasks VALIDATE CONSTRAINT fk_lead_tasks_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead_party_id ON lead_tasks (org_id, lead_party_id);

-- survey_participants.lead_id -> leads
ALTER TABLE survey_participants ADD COLUMN IF NOT EXISTS lead_party_id text;

UPDATE survey_participants t
   SET lead_party_id = m.party_id
  FROM lead_party_map m
 WHERE m.lead_id = t.lead_id
   AND m.organization_id = t.org_id
   AND t.lead_party_id IS NULL
   AND t.lead_id IS NOT NULL;

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_lead_party_id;
ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_lead_party_id
  FOREIGN KEY (org_id, lead_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE survey_participants VALIDATE CONSTRAINT fk_survey_participants_lead_party_id;

CREATE INDEX IF NOT EXISTS idx_survey_participants_lead_party_id ON survey_participants (org_id, lead_party_id);

-- build.feedback_posts.crm_contact_id -> contacts
ALTER TABLE build.feedback_posts ADD COLUMN IF NOT EXISTS crm_contact_party_id text;

UPDATE build.feedback_posts t
   SET crm_contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.crm_contact_id
   AND m.organization_id = t.org_id
   AND t.crm_contact_party_id IS NULL
   AND t.crm_contact_id IS NOT NULL;

ALTER TABLE build.feedback_posts DROP CONSTRAINT IF EXISTS fk_feedback_posts_crm_contact_party_id;
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT fk_feedback_posts_crm_contact_party_id
  FOREIGN KEY (org_id, crm_contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE build.feedback_posts VALIDATE CONSTRAINT fk_feedback_posts_crm_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_feedback_posts_crm_contact_party_id ON build.feedback_posts (org_id, crm_contact_party_id);

-- build.feedbucket_submissions.crm_contact_id -> contacts
ALTER TABLE build.feedbucket_submissions ADD COLUMN IF NOT EXISTS crm_contact_party_id text;

UPDATE build.feedbucket_submissions t
   SET crm_contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.crm_contact_id
   AND m.organization_id = t.org_id
   AND t.crm_contact_party_id IS NULL
   AND t.crm_contact_id IS NOT NULL;

ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT IF EXISTS fk_feedbucket_submissions_crm_contact_party_id;
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT fk_feedbucket_submissions_crm_contact_party_id
  FOREIGN KEY (org_id, crm_contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE build.feedbucket_submissions VALIDATE CONSTRAINT fk_feedbucket_submissions_crm_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_feedbucket_submissions_crm_contact_party_id ON build.feedbucket_submissions (org_id, crm_contact_party_id);

-- crm_contact_channel_consent.contact_id -> contacts
ALTER TABLE crm_contact_channel_consent ADD COLUMN IF NOT EXISTS contact_party_id text;

UPDATE crm_contact_channel_consent t
   SET contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.contact_id
   AND m.organization_id = t.org_id
   AND t.contact_party_id IS NULL
   AND t.contact_id IS NOT NULL;

ALTER TABLE crm_contact_channel_consent DROP CONSTRAINT IF EXISTS fk_crm_contact_channel_consent_contact_party_id;
ALTER TABLE crm_contact_channel_consent
  ADD CONSTRAINT fk_crm_contact_channel_consent_contact_party_id
  FOREIGN KEY (org_id, contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE crm_contact_channel_consent VALIDATE CONSTRAINT fk_crm_contact_channel_consent_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_crm_contact_channel_consent_contact_party_id ON crm_contact_channel_consent (org_id, contact_party_id);

-- crm_contact_consent_events.contact_id -> contacts
ALTER TABLE crm_contact_consent_events ADD COLUMN IF NOT EXISTS contact_party_id text;

UPDATE crm_contact_consent_events t
   SET contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.contact_id
   AND m.organization_id = t.org_id
   AND t.contact_party_id IS NULL
   AND t.contact_id IS NOT NULL;

ALTER TABLE crm_contact_consent_events DROP CONSTRAINT IF EXISTS fk_crm_contact_consent_events_contact_party_id;
ALTER TABLE crm_contact_consent_events
  ADD CONSTRAINT fk_crm_contact_consent_events_contact_party_id
  FOREIGN KEY (org_id, contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE crm_contact_consent_events VALIDATE CONSTRAINT fk_crm_contact_consent_events_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_crm_contact_consent_events_contact_party_id ON crm_contact_consent_events (org_id, contact_party_id);

-- crm_contact_roles.contact_id -> contacts
ALTER TABLE crm_contact_roles ADD COLUMN IF NOT EXISTS contact_party_id text;

UPDATE crm_contact_roles t
   SET contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.contact_id
   AND m.organization_id = t.org_id
   AND t.contact_party_id IS NULL
   AND t.contact_id IS NOT NULL;

ALTER TABLE crm_contact_roles DROP CONSTRAINT IF EXISTS fk_crm_contact_roles_contact_party_id;
ALTER TABLE crm_contact_roles
  ADD CONSTRAINT fk_crm_contact_roles_contact_party_id
  FOREIGN KEY (org_id, contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE crm_contact_roles VALIDATE CONSTRAINT fk_crm_contact_roles_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_crm_contact_roles_contact_party_id ON crm_contact_roles (org_id, contact_party_id);

-- crm_deal_stakeholders.contact_id -> contacts
ALTER TABLE crm_deal_stakeholders ADD COLUMN IF NOT EXISTS contact_party_id text;

UPDATE crm_deal_stakeholders t
   SET contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.contact_id
   AND m.organization_id = t.org_id
   AND t.contact_party_id IS NULL
   AND t.contact_id IS NOT NULL;

ALTER TABLE crm_deal_stakeholders DROP CONSTRAINT IF EXISTS fk_crm_deal_stakeholders_contact_party_id;
ALTER TABLE crm_deal_stakeholders
  ADD CONSTRAINT fk_crm_deal_stakeholders_contact_party_id
  FOREIGN KEY (org_id, contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE crm_deal_stakeholders VALIDATE CONSTRAINT fk_crm_deal_stakeholders_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_crm_deal_stakeholders_contact_party_id ON crm_deal_stakeholders (org_id, contact_party_id);

-- survey_participants.contact_id -> contacts
ALTER TABLE survey_participants ADD COLUMN IF NOT EXISTS contact_party_id text;

UPDATE survey_participants t
   SET contact_party_id = m.party_id
  FROM contact_party_map m
 WHERE m.contact_id = t.contact_id
   AND m.organization_id = t.org_id
   AND t.contact_party_id IS NULL
   AND t.contact_id IS NOT NULL;

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_participants_contact_party_id;
ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_participants_contact_party_id
  FOREIGN KEY (org_id, contact_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE survey_participants VALIDATE CONSTRAINT fk_survey_participants_contact_party_id;

CREATE INDEX IF NOT EXISTS idx_survey_participants_contact_party_id ON survey_participants (org_id, contact_party_id);

-- build.feedback_posts.crm_organization_id -> crm_organizations
ALTER TABLE build.feedback_posts ADD COLUMN IF NOT EXISTS crm_organization_party_id text;

UPDATE build.feedback_posts t
   SET crm_organization_party_id = m.party_id
  FROM crm_org_party_map m
 WHERE m.crm_organization_id = t.crm_organization_id
   AND m.organization_id = t.org_id
   AND t.crm_organization_party_id IS NULL
   AND t.crm_organization_id IS NOT NULL;

ALTER TABLE build.feedback_posts DROP CONSTRAINT IF EXISTS fk_feedback_posts_crm_organization_party_id;
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT fk_feedback_posts_crm_organization_party_id
  FOREIGN KEY (org_id, crm_organization_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE build.feedback_posts VALIDATE CONSTRAINT fk_feedback_posts_crm_organization_party_id;

CREATE INDEX IF NOT EXISTS idx_feedback_posts_crm_organization_party_id ON build.feedback_posts (org_id, crm_organization_party_id);

-- build.feedbucket_submissions.crm_organization_id -> crm_organizations
ALTER TABLE build.feedbucket_submissions ADD COLUMN IF NOT EXISTS crm_organization_party_id text;

UPDATE build.feedbucket_submissions t
   SET crm_organization_party_id = m.party_id
  FROM crm_org_party_map m
 WHERE m.crm_organization_id = t.crm_organization_id
   AND m.organization_id = t.org_id
   AND t.crm_organization_party_id IS NULL
   AND t.crm_organization_id IS NOT NULL;

ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT IF EXISTS fk_feedbucket_submissions_crm_organization_party_id;
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT fk_feedbucket_submissions_crm_organization_party_id
  FOREIGN KEY (org_id, crm_organization_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE build.feedbucket_submissions VALIDATE CONSTRAINT fk_feedbucket_submissions_crm_organization_party_id;

CREATE INDEX IF NOT EXISTS idx_feedbucket_submissions_crm_organization_party_id ON build.feedbucket_submissions (org_id, crm_organization_party_id);

-- build.tickets.customer_id -> crm_organizations
ALTER TABLE build.tickets ADD COLUMN IF NOT EXISTS customer_org_party_id text;

UPDATE build.tickets t
   SET customer_org_party_id = m.party_id
  FROM crm_org_party_map m
 WHERE m.crm_organization_id = t.customer_id
   AND m.organization_id = t.org_id
   AND t.customer_org_party_id IS NULL
   AND t.customer_id IS NOT NULL;

ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS fk_tickets_customer_org_party_id;
ALTER TABLE build.tickets
  ADD CONSTRAINT fk_tickets_customer_org_party_id
  FOREIGN KEY (org_id, customer_org_party_id)
  REFERENCES business_parties (organization_id, party_id)
  ON DELETE SET NULL
  NOT VALID;
ALTER TABLE build.tickets VALIDATE CONSTRAINT fk_tickets_customer_org_party_id;

CREATE INDEX IF NOT EXISTS idx_tickets_customer_org_party_id ON build.tickets (org_id, customer_org_party_id);
