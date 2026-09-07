/**
 * Real-database tests for the legacy backfill's central claim: that after it
 * runs, *every* row in `leads`, `clients`, `contacts` and `crm_organizations`
 * resolves to a Party.
 *
 * Run via `pnpm test:db-specs`. The default hermetic jest config ignores this file.
 *   DATABASE_URL=... npx jest --config jest-db.json --runInBand --testPathPattern="party-legacy-backfill.db"
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

/**
 * Jest's default is five seconds. Every test here opens a connection to a remote
 * Neon database and applies five migration files to it before it asserts
 * anything, and the two that run first pay the connection setup on top. Ticket
 * 25 added three of those five, which pushed exactly those two over the line —
 * they were passing at four seconds and now time out, while the same work in a
 * later test passes at one and a half.
 *
 * Raised rather than optimised, because the cost is the network and the point of
 * the file is to pay it. A failure here should mean the SQL is wrong, never that
 * the database was a little further away today.
 */
jest.setTimeout(60_000);

const migration = (name: string) =>
  readFileSync(join(__dirname, "..", "..", "..", "migrations", name), "utf8");

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  // DATABASE_URL, not APP_DATABASE_URL: applying the migration needs DDL rights
  // the RLS-enforced application role does not have.
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("party-legacy-backfill.db.spec.ts requires DATABASE_URL");
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
  unmappedOrganisations: number;
}

describe("legacy backfill — real database", () => {
  let sql: ReturnType<typeof postgres>;
  let expand: string;
  let backfill: string;
  let companyExpand: string;
  let companyMap: string;
  let companyBackfill: string;

  beforeAll(() => {
    sql = connect();
    expand = migration("0240_party_expand_legacy_fields.sql");
    backfill = migration("0241_party_legacy_backfill.sql");
    // Ticket 25: `crm_organizations` was the fifth identity table, and it joined
    // the same expand-backfill shape three migrations later.
    companyExpand = migration("0262_party_company_columns.sql");
    companyMap = migration("0263_crm_org_party_map.sql");
    companyBackfill = migration("0264_crm_org_party_backfill.sql");
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
        /**
         * 0262 is idempotent apart from its two bare `ADD CONSTRAINT`s, so once
         * it has been applied for real the replay below fails with "constraint
         * already exists" and the file only passes on a database where the
         * migration is still pending. Dropping them first makes it run
         * identically either side of that, the same reason party-identifiers
         * drops `party_identifiers`. Both drops are inside the rolled-back
         * transaction, so the real schema is untouched.
         */
        await tx
          .unsafe(
            'ALTER TABLE "business_parties" DROP CONSTRAINT IF EXISTS "fk_business_parties_employer"',
          )
          .simple();
        await tx
          .unsafe(
            'ALTER TABLE "business_parties" DROP CONSTRAINT IF EXISTS "chk_business_parties_employer_not_self"',
          )
          .simple();
        await tx.unsafe('DROP TABLE IF EXISTS "crm_org_party_map" CASCADE').simple();
        await tx.unsafe(expand).simple();
        await tx.unsafe(companyExpand).simple();
        await tx.unsafe(companyMap).simple();

        const [org] = await tx`SELECT id FROM organizations LIMIT 1`;
        if (!org) throw new Error("party-legacy-backfill.db.spec.ts requires at least one seeded organization");
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
        const [company] = await tx`
          INSERT INTO crm_organizations (org_id, name, domain, industry, size, website,
                                         linkedin_url, description, health_score, notes)
          VALUES (${orgId}, ${`company ${marker}`}, ${`${marker}.example`}, 'Manufacturing',
                  '51-200', 'https://acme.test', 'https://linkedin.test/acme',
                  'Makes things out of other things.', 64, 'Renews in March.')
          RETURNING id`;
        // The row ticket 25 exists for: a contact whose employer is a company
        // record. Before it, `contacts.organization_id` pointed at a table Party
        // could not reach, and every migrate batch left the column behind.
        const [contact] = await tx`
          INSERT INTO contacts (org_id, name, title, twitter_url, tags, organization_id)
          VALUES (${orgId}, ${`contact ${marker}`}, 'CTO', 'https://x.test/a', '["beta"]'::jsonb,
                  ${company.id as number})
          RETURNING id`;

        await tx.unsafe(backfill).simple();
        await tx.unsafe(companyBackfill).simple();

        captured = await body(tx, orgId, {
          liveLead: liveLead.id as number,
          deadLead: deadLead.id as number,
          client: client.id as number,
          contact: contact.id as number,
          company: company.id as number,
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
            WHERE m.organization_id = ct.org_id AND m.contact_id = ct.id)) AS unmapped_contacts,
        (SELECT count(*) FROM crm_organizations o
          WHERE NOT EXISTS (SELECT 1 FROM crm_org_party_map m
            WHERE m.organization_id = o.org_id AND m.crm_organization_id = o.id)) AS unmapped_orgs`;
    return {
      unmappedLeads: Number(row.unmapped_leads),
      unmappedClients: Number(row.unmapped_clients),
      unmappedContacts: Number(row.unmapped_contacts),
      unmappedOrganisations: Number(row.unmapped_orgs),
    };
  }

  it("leaves no row in any legacy table without a Party", async () => {
    const result = await withBackfill(async (tx) => probe(tx));

    expect(result).toEqual({
      unmappedLeads: 0,
      unmappedClients: 0,
      unmappedContacts: 0,
      unmappedOrganisations: 0,
    });
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

  it("carries a company's own fields onto its Party, and says it is one", async () => {
    const company = await withBackfill(async (tx, orgId, ids) => {
      const [row] = await tx`
        SELECT p.name, p.party_kind, p.domain, p.industry, p.company_size, p.website,
               p.linkedin_url, p.description, p.health_score, p.notes
        FROM crm_org_party_map m
        JOIN business_parties p
          ON p.organization_id = m.organization_id AND p.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.crm_organization_id = ${ids.company}`;
      return row;
    });

    expect(company).toMatchObject({
      party_kind: "ORGANISATION",
      industry: "Manufacturing",
      company_size: "51-200",
      website: "https://acme.test",
      linkedin_url: "https://linkedin.test/acme",
      description: "Makes things out of other things.",
      health_score: 64,
      notes: "Renews in March.",
    });
  });

  /**
   * The line the whole ticket exists for.
   *
   * `contacts.organization_id` was a foreign key to `crm_organizations` with
   * nothing on Party to point at, which is why every migrate batch left the
   * column behind as "association-only" and `contacts` could not be dropped.
   */
  it("re-points a contact's employer onto the company's Party", async () => {
    const link = await withBackfill(async (tx, orgId, ids) => {
      const [row] = await tx`
        SELECT p.employer_party_id, cm.party_id AS company_party_id
        FROM contact_party_map m
        JOIN business_parties p
          ON p.organization_id = m.organization_id AND p.party_id = m.party_id
        JOIN crm_org_party_map cm
          ON cm.organization_id = m.organization_id AND cm.crm_organization_id = ${ids.company}
        WHERE m.organization_id = ${orgId} AND m.contact_id = ${ids.contact}`;
      return row;
    });

    expect(link.employer_party_id).toBe(link.company_party_id);
    expect(link.employer_party_id).not.toBeNull();
  });

  /**
   * A company record is not a relationship.
   *
   * 0241 granted PROSPECT, CUSTOMER and CONTACT because those legacy tables each
   * record a stance towards someone. `crm_organizations` records only that a
   * company exists; CUSTOMER arrives with a deal. Granting one here would put
   * every company anybody has ever typed into the customer list.
   */
  it("grants a company no party_roles row at all", async () => {
    const roles = await withBackfill(async (tx, orgId, ids) => {
      const rows = await tx`
        SELECT r.role
        FROM crm_org_party_map m
        JOIN party_roles r
          ON r.organization_id = m.organization_id AND r.party_id = m.party_id
        WHERE m.organization_id = ${orgId} AND m.crm_organization_id = ${ids.company}`;
      return rows.map((row) => row.role as string);
    });

    expect(roles).toEqual([]);
  });

  it("creates nothing on a second run", async () => {
    const counts = await withBackfill(async (tx) => {
      const [before] = await tx`SELECT count(*) AS n FROM business_parties`;
      await tx.unsafe(backfill).simple();
      await tx.unsafe(companyBackfill).simple();
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
