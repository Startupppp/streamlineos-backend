-- Custom SQL migration file, put your code below! --

-- Recording and analysis, gated on the consent rules of the jurisdiction the
-- call took place in.
--
-- Phase 5 ticket 03. In a two-party (all-party) consent jurisdiction, recording
-- a conversation without every participant's agreement is a criminal offence,
-- and running a model over such a recording compounds it. That is a legal
-- constraint on the product, not a setting: there is no tenant column in this
-- file that reaches the rule, no `enabled` flag, and no per-organisation
-- jurisdiction override. The rule itself is `src/modules/calls/call-recording-consent.ts`
-- and `consent-is-not-a-setting.spec.ts` pins the absence, exactly as
-- `send-guardrails.ts` and its spec do for outbound.
--
-- The rule fails closed: everywhere is all-party until the register in that file
-- says otherwise, and a call whose jurisdiction nobody recorded is refused. A
-- register of *strict* places consulted with "not listed means fine" makes every
-- omission a silent hole -- a jurisdiction nobody researched would read
-- identically to one somebody cleared. Inverted, an omission is a refusal, and a
-- refusal lands in the ledger below where somebody can see it.
--
-- Two tables. The first is the evidence, the second is the gap.
--
-- What is NOT here, on purpose: the counterparty's standing PHONE opt-in. That
-- lives in `crm_contact_channel_consent` with its own append-only event history,
-- and copying it here would create a second answer to "has this person opted
-- out?" that drifts the moment somebody unsubscribes. The service reads both.
--
-- Authored by hand against `db/schema/crm/call-analysis.ts`, column for column:
-- `drizzle-kit generate` is unusable in this repository (see 0205).

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_call_recording_consent" (
  "call_recording_consent_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,

  -- The call. Not a foreign key to `activities`, the same choice
  -- `crm_call_analyses.activity_id` and `crm_call_analysis_releases.activity_id`
  -- make: a timeline delete must not erase the evidence that a recording was
  -- lawful. That evidence is the organisation's defence and has to outlive the
  -- row that prompted it.
  "activity_id" text NOT NULL,

  -- ISO 3166-1 alpha-2, optionally with an ISO 3166-2 subdivision -- `DE`,
  -- `US-CA`. Never derived from the counterparty's phone number: an area code
  -- says where a number was issued, not where its holder was sitting, and a
  -- mobile carries its issuing region across borders for life.
  "jurisdiction" text NOT NULL,

  -- Our own side. Written rather than assumed, so an adapter-delivered call with
  -- nobody attributed has no row here and is refused rather than waved through.
  -- Our rep is a party to the conversation exactly as the customer is; consenting
  -- on their behalf because they are an employee is the assumption an all-party
  -- jurisdiction exists to refuse.
  "org_party_consented_at" timestamp,
  "org_party_method" text,

  -- The per-call form of the customer's agreement -- the recording notice played
  -- and acknowledged, or a signed clause. Null when the only evidence is the
  -- standing PHONE opt-in, which is read from `crm_contact_channel_consent`.
  "counterparty_consented_at" timestamp,
  "counterparty_method" text,

  -- They asked, on this call, that it not be processed. Distinct from a
  -- channel-wide opt-out: somebody can be happy to be phoned and unhappy to be
  -- recorded, and collapsing the two would either over-block every future call
  -- or lose this one.
  "counterparty_withdrawn_at" timestamp,

  "note" text,

  -- No foreign key to `users`, the house rule on every actor column in this
  -- schema (see `activities.actor_user_id`, and 0223): `scripts/purge-user.mjs`
  -- deletes by reference without consulting the delete rule, so offboarding
  -- somebody would delete the compliance record they signed.
  "attested_by_user_id" text NOT NULL,

  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- The shape the rule's register is keyed on. Without the constraint a free-text
-- "California" is stored, matches no register entry, and resolves to all-party --
-- the right answer arrived at by accident, which stops being right the day
-- somebody adds a case-insensitive or fuzzy lookup.
ALTER TABLE "crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_jurisdiction"
  CHECK ("jurisdiction" ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$');

--> statement-breakpoint
-- A note is a sentence, not a thread. Same bound and same reason as
-- `chk_crm_call_analysis_releases_note` in 0542: without it the column becomes a
-- comment field by accretion, with no retention rule over text an attester may
-- well paste a customer's words into.
ALTER TABLE "crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_note"
  CHECK ("note" IS NULL OR char_length("note") <= 500);

--> statement-breakpoint
-- A method with no timestamp is a claim with no date on it, and a timestamp with
-- no method is evidence that cannot be reviewed. Either both or neither, on each
-- side independently.
ALTER TABLE "crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_org_pair"
  CHECK (("org_party_consented_at" IS NULL) = ("org_party_method" IS NULL));
--> statement-breakpoint
ALTER TABLE "crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_other_pair"
  CHECK (("counterparty_consented_at" IS NULL) = ("counterparty_method" IS NULL));

--> statement-breakpoint
-- NOT VALID then VALIDATE, so adding the edge does not hold ACCESS EXCLUSIVE on
-- organizations while it runs.
ALTER TABLE "crm_call_recording_consent" ADD CONSTRAINT "fk_crm_call_recording_consent_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_call_recording_consent" VALIDATE CONSTRAINT "fk_crm_call_recording_consent_org";

--> statement-breakpoint
-- One attestation per call. Two rows would make "where did this happen" a
-- question with two answers, and the rule would then be picking which evidence
-- to believe. The service upserts onto exactly this pair.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_call_recording_consent"
  ON "crm_call_recording_consent" ("organization_id", "activity_id");

--> statement-breakpoint
-- Without a policy the table is readable organisation-wide: grants arrive
-- through ALTER DEFAULT PRIVILEGES, so a missing policy is silent. What leaks
-- here is who was recorded, where, and whatever the attester wrote.
ALTER TABLE "crm_call_recording_consent" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_call_recording_consent";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_call_recording_consent"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_call_recording_consent" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_call_recording_consent" TO streamline_app;

--> statement-breakpoint
-- The refusal ledger. Without it a refusal is indistinguishable from a call
-- nobody thought to analyse: both render as an empty panel, and a team whose
-- jurisdiction field is never filled in concludes the feature is broken rather
-- than that they are missing a compliance record.
--
-- It carries no transcript, no quote and no analysis -- the refusal exists
-- precisely because none of that may be produced. A ledger that quoted the call
-- to explain why the call could not be quoted would be the disclosure the
-- refusal prevented.
CREATE TABLE IF NOT EXISTS "crm_call_analysis_refusals" (
  "call_analysis_refusal_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "activity_id" text NOT NULL,

  -- Null exactly when the reason is `jurisdiction-unrecorded`.
  "jurisdiction" text,

  -- A `CallConsentRefusal`. Text rather than an enum: adding a clause to the
  -- rule must not require a migration before the ledger can name it, or the new
  -- clause records itself as something else, or not at all.
  "reason" text NOT NULL,

  -- `RECORDING_CONSENT_RULE_VERSION`. In the unique key below, so a rule change
  -- starts a fresh row rather than overwriting the count of what the previous
  -- rule refused.
  "rule_version" integer NOT NULL,

  -- The rule's own sentence, stored so the ledger still reads correctly a year
  -- later after the wording in the source has been improved.
  "note" text NOT NULL,

  "first_refused_at" timestamp DEFAULT now() NOT NULL,
  "last_refused_at" timestamp DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,

  -- No foreign key to `users` -- see the note on `attested_by_user_id` above.
  "last_requested_by_user_id" text,

  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "crm_call_analysis_refusals" ADD CONSTRAINT "chk_crm_call_analysis_refusals_attempts"
  CHECK ("attempts" >= 1);

--> statement-breakpoint
ALTER TABLE "crm_call_analysis_refusals" ADD CONSTRAINT "fk_crm_call_analysis_refusals_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_call_analysis_refusals" VALIDATE CONSTRAINT "fk_crm_call_analysis_refusals_org";

--> statement-breakpoint
-- Upserted, not appended. A timeline that re-renders refuses again, and an
-- append-only ledger would grow a row per page load: the signal a compliance
-- officer needs is "which calls", not "how many times somebody scrolled past
-- one". `attempts` keeps the volume without keeping the rows.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_call_analysis_refusals"
  ON "crm_call_analysis_refusals" ("organization_id", "activity_id", "rule_version");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_call_analysis_refusals_org"
  ON "crm_call_analysis_refusals" ("organization_id", "last_refused_at");

--> statement-breakpoint
ALTER TABLE "crm_call_analysis_refusals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_call_analysis_refusals";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_call_analysis_refusals"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_call_analysis_refusals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_call_analysis_refusals" TO streamline_app;

--> statement-breakpoint
-- `crm:call-recording-consent:attest` -- the key that lets somebody assert, for
-- the record, that a call was lawfully recorded. Catalogued in
-- `permissions/crm.ts` and backfilled here onto organisations that already
-- exist, because a catalogued key with no backfill works for every organisation
-- created after it ships and 403s for every one that existed beforehand.
--
-- The key does NOT end in `:view` or `:read`, and here that is a decision rather
-- than a coincidence. `buildModuleMemberPermissionKeys` hands every key with
-- those suffixes to `CRM_MODULE_MEMBER`, so a name like
-- `crm:call-recording-consent:view` would have given every rep the ability to
-- attest. A rep is the person who knows whether the notice was played -- and
-- also the person with a reason to say it was when it was not, because the
-- attestation is what unlocks the analysis of their own call. A compliance
-- assertion that the person it benefits can sign for themselves is not evidence
-- of anything. So it stops at the two admin rungs, there is deliberately no
-- CRM_MODULE_MEMBER statement in this file, and
-- `call-recording-consent-permissions.spec.ts` asserts that absence rather than
-- leaving it to be noticed.
--
-- There is no `:override`, `:waive` or `:disable` key here and there must never
-- be one. A permission that let an administrator skip the consent rule would
-- make the rule advisory, which for a criminal-law constraint is the same as not
-- having it. The refusal ledger's read is gated on the existing
-- `crm:call-analysis:view-team`; no new key is minted for it.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN`, which is what `seedSystemRolesForOrg`
-- actually mints -- NOT `CRM_ADMIN`, which is a `ROLE_TEMPLATES` slug an
-- administrator may create a role from and which no organisation is seeded with.
-- Seven CRM migrations in the 02xx series granted to `CRM_ADMIN`, matched zero
-- rows, and reported themselves clean; `backfill-slugs-exist.spec.ts` exists
-- because of that.
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:call-recording-consent:attest', 'crm:call-recording-consent', 'attest',
   'Record where a call took place and who consented to it being recorded, and read the ledger of calls the consent rule refused to analyse',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:call-recording-consent:attest', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:call-recording-consent:attest')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at
-- once; a role that gained a key and a cache that has not heard about it is a
-- 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();

--> statement-breakpoint
ANALYZE "crm_call_recording_consent";
--> statement-breakpoint
ANALYZE "crm_call_analysis_refusals";
