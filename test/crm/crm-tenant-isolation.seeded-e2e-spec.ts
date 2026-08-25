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

/** Every CRM table that carries tenant data and has a policy. */
const TENANT_TABLES = [
  "business_parties",
  "party_contacts",
  "party_roles",
  "subjects",
  "activities",
  "autonomous_decisions",
  "autonomy_switches",
  "autonomy_corrections",
  "autonomy_shadow_scores",
  "autonomy_holds",
  "autonomy_settings",
] as const;

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
