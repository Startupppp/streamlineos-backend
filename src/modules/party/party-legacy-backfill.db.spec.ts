/**
 * Real-database tests for the legacy backfill's central claim: that after it
 * runs, *every* row in `leads`, `clients` and `contacts` resolves to a Party.
 *
 * Guarded by CRM_DB_TESTS=1 so the default hermetic `jest` run is unaffected and
 * CI without a database does not fail. Run with:
 *   CRM_DB_TESTS=1 npx jest --runInBand --testPathPattern="party-legacy-backfill.db"
 *
 * Totality is the whole point of the map, and it is the one property a mocked
 * database cannot demonstrate — a fake answers whatever it was told to answer,
 * so a backfill that skips soft-deleted rows, or one whose anti-join is wrong,
 * passes every unit test and then strands records in production. Only running
 * the actual SQL over actual rows proves it.
 *
 * Everything happens inside a transaction that is rolled back, fixtures
 * included, so the tests leave the database exactly as they found it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";

const ENABLED = process.env.CRM_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

/** Read on demand: the default hermetic run loads this file only to skip it. */
const migration = (name: string) =>
  readFileSync(join(__dirname, "..", "..", "..", "migrations", name), "utf8");

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  // DATABASE_URL, not APP_DATABASE_URL: applying the migration needs DDL rights
  // the RLS-enforced application role does not have.
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for CRM_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  // Notices are expected here -- the expand is idempotent and says so loudly.
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

interface Probe {
  unmappedLeads: number;
  unmappedClients: number;
  unmappedContacts: number;
}

describeDb("legacy backfill — real database", () => {
  let sql: ReturnType<typeof postgres>;
  let expand: string;
  let backfill: string;

  beforeAll(() => {
    sql = connect();
    expand = migration("0240_party_expand_legacy_fields.sql");
    backfill = migration("0241_party_legacy_backfill.sql");
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  /**
   * Applies the expand, plants one row in each legacy table, runs the backfill,
   * hands the transaction to the assertions, and rolls everything back.
   */
  async function withBackfill<T>(
    body: (tx: postgres.TransactionSql, orgId: string, ids: Record<string, number>) => Promise<T>,
  ): Promise<T> {
    let captured: T | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL statement_timeout = '60s'").simple();
        await tx.unsafe(expand).simple();

        const [org] = await tx`SELECT id FROM organizations LIMIT 1`;
        if (!org) throw new Error("CRM_DB_TESTS needs at least one organization to scope fixtures to");
        const orgId = org.id as string;

        const marker = randomUUID();
        const [liveLead] = await tx`
          INSERT INTO leads (org_id, name, email, company, designation, city, status, priority, score, tags)
          VALUES (${orgId}, ${`live ${marker}`}, ${`live-${marker}@example.test`}, 'Acme',
                  'Head of Ops', 'Pune', 'QUALIFIED', 'HOT', 71, ARRAY['vip'])
          RETURNING id`;
        // A soft-deleted lead is still a lead. If the backfill filtered these out
        // the resolver would be partial and every consumer would need a branch.
        const [deadLead] = await tx`
          INSERT INTO leads (org_id, name, deleted_at)
          VALUES (${orgId}, ${`deleted ${marker}`}, now())
          RETURNING id`;
        const [client] = await tx`
          INSERT INTO clients (org_id, name, gstin, is_vendor, investment_value, health_score)
          VALUES (${orgId}, ${`client ${marker}`}, '29ABCDE1234F1Z5', true, 125000.00, 82)
          RETURNING id`;
        const [contact] = await tx`
          INSERT INTO contacts (org_id, name, title, twitter_url, tags)
          VALUES (${orgId}, ${`contact ${marker}`}, 'CTO', 'https://x.test/a', '["beta"]'::jsonb)
          RETURNING id`;

        await tx.unsafe(backfill).simple();

        captured = await body(tx, orgId, {
          liveLead: liveLead.id as number,
          deadLead: deadLead.id as number,
          client: client.id as number,
          contact: contact.id as number,
        });

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return captured as T;
  }

  async function probe(tx: postgres.TransactionSql): Promise<Probe> {
    const [row] = await tx`
      SELECT
        (SELECT count(*) FROM leads l
          WHERE NOT EXISTS (SELECT 1 FROM lead_party_map m
            WHERE m.organization_id = l.org_id AND m.lead_id = l.id)) AS unmapped_leads,
        (SELECT count(*) FROM clients c
          WHERE NOT EXISTS (SELECT 1 FROM client_party_map m
            WHERE m.organization_id = c.org_id AND m.client_id = c.id)) AS unmapped_clients,
        (SELECT count(*) FROM contacts ct
          WHERE NOT EXISTS (SELECT 1 FROM contact_party_map m
            WHERE m.organization_id = ct.org_id AND m.contact_id = ct.id)) AS unmapped_contacts`;
    return {
      unmappedLeads: Number(row.unmapped_leads),
      unmappedClients: Number(row.unmapped_clients),
      unmappedContacts: Number(row.unmapped_contacts),
    };
  }

  it("leaves no row in any legacy table without a Party", async () => {
    const result = await withBackfill(async (tx) => probe(tx));

    expect(result).toEqual({ unmappedLeads: 0, unmappedClients: 0, unmappedContacts: 0 });
  });

  it("resolves each legacy id to the Party carrying that record's own fields", async () => {
    const resolved = await withBackfill(async (tx, orgId, ids) => {
      const [lead] = await tx`
        SELECT p.name, p.lifecycle_stage, p.priority, p.qualification_score,
               p.job_title, p.company_name, p.city, p.tags
        FROM lead_party_map m
        JOIN business_parties p
          ON p.organization_id = m.organization_id AND p.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.lead_id = ${ids.liveLead}`;
      const [client] = await tx`
        SELECT p.tax_number, p.party_type, p.lifetime_value, p.health_score, p.lifecycle_stage
        FROM client_party_map m
        JOIN business_parties p
          ON p.organization_id = m.organization_id AND p.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.client_id = ${ids.client}`;
      const [contact] = await tx`
        SELECT p.job_title, p.social_profiles, p.tags
        FROM contact_party_map m
        JOIN business_parties p
          ON p.organization_id = m.organization_id AND p.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.contact_id = ${ids.contact}`;
      return { lead, client, contact };
    });

    expect(resolved.lead).toMatchObject({
      lifecycle_stage: "QUALIFIED",
      priority: "HOT",
      qualification_score: 71,
      job_title: "Head of Ops",
      company_name: "Acme",
      city: "Pune",
      tags: ["vip"],
    });
    // `gstin` lands in `tax_number`, and `is_vendor` in the party type and a role.
    expect(resolved.client).toMatchObject({
      tax_number: "29ABCDE1234F1Z5",
      party_type: "BOTH",
      lifetime_value: "125000.00",
      health_score: 82,
      lifecycle_stage: "CUSTOMER",
    });
    // `contacts.title` is a job title, and its jsonb tag array becomes text[].
    expect(resolved.contact).toMatchObject({
      job_title: "CTO",
      social_profiles: { twitter: "https://x.test/a" },
      tags: ["beta"],
    });
  });

  it("gives a soft-deleted legacy row a Party too, soft-deleted to match", async () => {
    const lead = await withBackfill(async (tx, orgId, ids) => {
      const [row] = await tx`
        SELECT p.deleted_at
        FROM lead_party_map m
        JOIN business_parties p
          ON p.organization_id = m.organization_id AND p.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.lead_id = ${ids.deadLead}`;
      return row;
    });

    expect(lead).toBeDefined();
    expect(lead.deleted_at).not.toBeNull();
  });

  it("puts `is_vendor` in party_roles, where Phase 1 models being two things at once", async () => {
    const roles = await withBackfill(async (tx, orgId, ids) => {
      const rows = await tx`
        SELECT r.role
        FROM client_party_map m
        JOIN party_roles r
          ON r.organization_id = m.organization_id AND r.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.client_id = ${ids.client}
        ORDER BY r.role`;
      return rows.map((row) => row.role as string);
    });

    expect(roles).toEqual(["CUSTOMER", "VENDOR"]);
  });

  it("creates nothing on a second run", async () => {
    const counts = await withBackfill(async (tx) => {
      const [before] = await tx`SELECT count(*) AS n FROM business_parties`;
      await tx.unsafe(backfill).simple();
      const [after] = await tx`SELECT count(*) AS n FROM business_parties`;
      return { before: Number(before.n), after: Number(after.n) };
    });

    expect(counts.after).toBe(counts.before);
  });

  it("re-applies the expand without complaint", async () => {
    const columns = await withBackfill(async (tx) => {
      await tx.unsafe(expand).simple();
      const [row] = await tx`
        SELECT count(*) AS n FROM information_schema.columns
        WHERE table_name = 'business_parties'`;
      return Number(row.n);
    });

    expect(columns).toBeGreaterThan(40);
  });
});
