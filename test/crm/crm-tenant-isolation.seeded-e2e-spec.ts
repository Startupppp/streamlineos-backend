import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * Tenant isolation, proved against a real database as the real application role.
 *
 * The PRD asks for two things this file exists to answer, and neither can be
 * answered by a mocked test:
 *
 *   "Never write a test that passes with row-level security disabled — the owner
 *    role bypasses RLS and its results hide every isolation bug."
 *
 * So every assertion below runs as `streamline_app`, which has no BYPASSRLS.
 * Running the same file as the owner would pass every case while proving
 * nothing, which is exactly the failure mode being guarded against.
 *
 * Skipped, loudly, when APP_DATABASE_URL is absent — a silent skip would look
 * like a green isolation suite to anybody reading CI.
 */
/**
 * The suite provisions its own application-role credential.
 *
 * `streamline_app` exists with no BYPASSRLS, but its password cannot be set
 * durably from SQL: Neon manages role credentials in its control plane, so an
 * `ALTER ROLE ... PASSWORD` authenticates immediately and reverts when the
 * compute suspends. Rather than depend on a credential that stops working
 * overnight — or skip the only test that proves isolation is real — this mints
 * a fresh one per run using the owner connection it already has.
 *
 * `APP_DATABASE_URL` still wins when it is set, because a deployment with a
 * properly provisioned role should be tested with that one.
 */
const OWNER_URL = process.env.DATABASE_URL;
const describeIfAppRole = OWNER_URL ? describe : describe.skip;

/**
 * Every CRM table that carries tenant data and has a policy.
 *
 * Asked of the database, not assembled by hand. The hand-written version claimed
 * to be exhaustive while naming 11 of the 23 tables migrations 0206-0231 enable
 * RLS on, and when the drift guard below was added to stop that happening again
 * it found 48 more — every automation, blueprint, pipeline, sequence, pricebook
 * and quote table in the module, plus `party_identifiers` and three of the four
 * legacy identity maps. All of them had a policy nobody had ever proved fails
 * closed.
 *
 * Three of those maps escaped the guard as well, because it matched table names
 * by prefix and `lead_party_map`, `client_party_map` and `contact_party_map`
 * begin with the legacy entity rather than with `crm_` or `party_`. The fourth,
 * `crm_org_party_map`, was caught only because ticket 25 happened to name it
 * after the module. A guard whose reach depends on a naming coincidence is a
 * guard for the tables somebody remembered to name well.
 */
const TENANT_TABLES = [
  "activities",
  "activity_participants",
  "autonomous_decisions",
  "autonomy_corrections",
  "autonomy_holds",
  "autonomy_settings",
  "autonomy_shadow_scores",
  "autonomy_switches",
  "business_parties",
  "client_party_map",
  "contact_party_map",
  "crm_activities",
  "crm_automation_actions",
  "crm_automation_events",
  "crm_automation_rules",
  "crm_automation_runs",
  "crm_blueprint_transitions",
  "crm_blueprints",
  "crm_campaigns",
  "crm_companies",
  "crm_connector_records",
  "crm_connector_syncs",
  "crm_contact_channel_consent",
  "crm_contact_consent_events",
  "crm_contact_roles",
  "crm_deal_competitors",
  "crm_deal_stakeholders",
  "crm_deals",
  "crm_email_templates",
  "crm_forecast_snapshots",
  "crm_import_rows",
  "crm_imports",
  "crm_lead_touchpoints",
  "crm_mailbox_sync",
  "crm_monthly_metrics",
  "crm_options",
  "crm_org_party_map",
  // The legacy table, still here because 0278 drops it only under
  // `app.allow_legacy_identity_drop`. Nothing writes it, but it carries the
  // tenant policy and must fail closed like the rest. Remove it with 0278.
  "crm_organizations",
  // `crm_organizations` stood here. 0278 dropped it with the other three legacy
  // identity tables; `crm_org_party_map` above is what a bookmarked id of one
  // now resolves through.
  "crm_people",
  "crm_pipeline_stages",
  "crm_pipelines",
  "crm_pricebook_entries",
  "crm_pricebooks",
  "crm_products",
  "crm_quote_settings",
  "crm_quote_templates",
  "crm_sequence_enrollments",
  "crm_sequence_steps",
  "crm_sequences",
  "crm_sla_breach_log",
  "crm_sla_policies",
  "crm_support_tickets",
  "crm_suppression_hashes",
  "crm_team_performance",
  "crm_ui_metadata",
  "crm_validation_rules",
  "deal_activities",
  "deal_approval_rules",
  "deal_approvals",
  "deal_meeting_attendees",
  "deal_meetings",
  "deal_stage_transitions",
  "deals",
  "inbound_events",
  "lead_party_map",
  "party_contacts",
  "party_duplicate_candidates",
  "party_identifiers",
  "party_merges",
  "party_roles",
  // Not a CRM table by name, so `CRM_TABLE_PATTERN` below never finds it — it is
  // listed here by hand precisely because the guard cannot. Ticket 20's
  // arrangements are per tenant, and an arrangement readable organisation-wide
  // would tell any tenant which fields another one has stopped using.
  "record_layout_adjustments",
  // Phase 4 ticket 01. Derived from `activities`, and exactly as disclosive as
  // the mail they were folded from — how quickly a tenant's customers answer and
  // who is on their threads. Added to `CRM_TABLE_PATTERN` below as well, so the
  // fourth relationship table somebody writes is caught by the guard rather than
  // by whether they remembered this list.
  "relationship_participants",
  "relationship_states",
  "relationship_threads",
  "subject_party_links",
  "subject_types",
  "subjects",

  /**
   * Wave 4 and Wave 5, which reached a database for the first time when their
   * twenty-seven migrations were finally journalled. Their RLS was written all
   * along; until the tables existed, this file could not prove any of it, and
   * an absent case reads exactly like a passing one.
   */
  "autonomy_repair_policies",
  "autonomy_repairs",
  "crm_call_analyses",
  "crm_call_analysis_refusals",
  "crm_call_analysis_releases",
  "crm_call_recording_consent",
  "crm_cold_outbound_settings",
  "crm_commission_accrual_parts",
  "crm_commission_accrual_snapshots",
  "crm_commission_assignments",
  "crm_commission_earnings",
  "crm_commission_plan_versions",
  "crm_commission_plans",
  "crm_deal_forecast_models",
  "crm_deal_forecast_scores",
  "crm_nurture_enrollments",
  "crm_nurture_sequence_steps",
  "crm_nurture_sequences",
  "crm_nurture_step_attempts",
  "crm_outbound_class_stops",
  "crm_outbound_messages",
  "crm_report_definitions",
  "crm_report_runs",
  "crm_sending_domains",
  "crm_whatsapp_channels",

  /**
   * Phase 2 and 3, and the reason the guard below is worth its own case.
   *
   * Five tables reached the database with RLS written and nothing proving it
   * fails closed: competitor suggestions, the MCP agent-access decision, saved
   * segments, and the two halves of a report schedule — the recipient list
   * included, which is a list of customer email addresses. None of them was an
   * assertion that failed. Each was an assertion nobody had made, which is the
   * failure this list reads as green.
   */
  "crm_deal_competitor_suggestions",
  "crm_mcp_settings",
  "crm_report_schedule_recipients",
  "crm_report_schedules",
  "crm_segments",
] as const;

/**
 * What a CRM table is called, for the drift guard below.
 *
 * Name-matched rather than hand-listed a second time: a second hand list would
 * drift in exactly the way the first one did.
 */
const CRM_TABLE_PATTERN =
  "^(business_parties|party_|subject|deal|activit|inbound_events|crm_|autonom|relationship_)|_party_map$";

/**
 * A short-lived password for `streamline_app`, set through the owner connection.
 *
 * Never reused and never written anywhere: it exists for the length of this
 * suite. If the role is absent the caller sees the connection fail, which is
 * the right outcome — a missing application role means RLS is not being
 * enforced anywhere, and that should be loud.
 */
async function provisionAppRoleUrl(ownerUrl: string): Promise<string> {
  const password = randomBytes(24).toString("base64url");
  const owner = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await owner.unsafe(`ALTER ROLE "streamline_app" WITH LOGIN PASSWORD '${password}'`);
  } finally {
    await owner.end();
  }

  const url = new URL(ownerUrl);
  url.username = "streamline_app";
  url.password = password;
  return url.toString();
}

describeIfAppRole("[seeded-e2e] CRM tenant isolation, as the application role", () => {
  let seededApp: SeededE2eApp;
  let appSql: postgres.Sql;
  let orgA: string;
  let orgB: string;
  const partyA = randomUUID();
  const partyB = randomUUID();

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();

    const appUrl = process.env.APP_DATABASE_URL ?? (await provisionAppRoleUrl(OWNER_URL!));
    appSql = postgres(appUrl, { max: 2, prepare: false });

    const a = await seedOrg(seededApp.seedDb).addMember("owner-a").build();
    const b = await seedOrg(seededApp.seedDb).addMember("owner-b").build();
    orgA = a.orgId;
    orgB = b.orgId;

    // Seeded as the owner, because the point is to read them as somebody else.
    await seededApp.seedDb.execute(sql`
      INSERT INTO business_parties (party_id, organization_id, name, party_type)
      VALUES (${partyA}, ${orgA}, 'Isolation Probe A', 'CUSTOMER'),
             (${partyB}, ${orgB}, 'Isolation Probe B', 'CUSTOMER')`);
  }, 180_000);

  afterAll(async () => {
    await seededApp.seedDb
      .execute(sql`DELETE FROM business_parties WHERE party_id IN (${partyA}, ${partyB})`)
      .catch(() => undefined);
    await appSql?.end();
    await seededApp?.close();
  });

  it("connects as a role that cannot bypass row-level security", async () => {
    // If this ever fails, every other assertion in the file is meaningless.
    const [row] = await appSql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    expect(row?.bypass).toBe(false);
  });

  it("matches the tables RLS is actually enabled on", async () => {
    /**
     * The list above is the input to every case below, so a table missing from
     * it is not a failing test — it is an absent one, which reads as green.
     */
    const enabled = await appSql.unsafe(
      `SELECT c.relname AS table
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relrowsecurity
          AND c.relname ~ $1
        ORDER BY c.relname`,
      [CRM_TABLE_PATTERN],
    );
    const unproven = enabled
      .map((row) => (row as unknown as { table: string }).table)
      .filter((table: string) => !TENANT_TABLES.includes(table as (typeof TENANT_TABLES)[number]));
    expect(unproven).toEqual([]);
  });

  describe("with no tenant context at all", () => {
    it.each(TENANT_TABLES)("%s fails closed rather than returning rows", async (table) => {
      /**
       * The failure this catches is not a leak — it is a silent empty result.
       * A policy written as `org_id = current_setting(...)` with no GUC returns
       * nothing and looks like "no data", so a broken tenant path reads as an
       * empty screen rather than an error anybody investigates.
       */
      await expect(appSql.unsafe(`SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  describe("with one organisation's context", () => {
    it("reads its own rows", async () => {
      await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgA}, true)`;
        const rows = await tx`SELECT name FROM business_parties WHERE party_id = ${partyA}`;
        expect(rows).toHaveLength(1);
      });
    });

    it("cannot see another organisation's row, even addressed by its exact id", async () => {
      await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgA}, true)`;
        const rows = await tx`SELECT name FROM business_parties WHERE party_id = ${partyB}`;
        // Not forbidden — invisible. Which is what makes the API's 404 honest
        // rather than a 403 that confirms the record exists.
        expect(rows).toHaveLength(0);
      });
    });

    it("cannot write a row into another organisation", async () => {
      await appSql
        .begin(async (tx) => {
          await tx`SELECT set_config('app.organization_id', ${orgA}, true)`;
          await tx`
            INSERT INTO business_parties (party_id, organization_id, name, party_type)
            VALUES (${randomUUID()}, ${orgB}, 'Cross-tenant write', 'CUSTOMER')`;
        })
        .then(
          () => {
            throw new Error("the WITH CHECK clause did not refuse a cross-tenant insert");
          },
          (error: { code?: string }) => {
            expect(error.code).toBe("42501");
          },
        );
    });

    it("cannot update another organisation's row into its own", async () => {
      await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgA}, true)`;
        // The row is invisible, so the UPDATE matches nothing rather than
        // erroring — the outcome that matters is that org B's row is unchanged.
        const updated = await tx`
          UPDATE business_parties SET name = 'stolen' WHERE party_id = ${partyB} RETURNING party_id`;
        expect(updated).toHaveLength(0);
      });

      const [check] = await seededApp.seedDb.execute(
        sql`SELECT name FROM business_parties WHERE party_id = ${partyB}`,
      );
      expect(check).toMatchObject({ name: "Isolation Probe B" });
    });
  });
});
