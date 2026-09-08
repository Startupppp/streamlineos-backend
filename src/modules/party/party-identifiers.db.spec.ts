/**
 * Real-database tests for 0260's central claim: after it runs, every live party
 * holding an email address, a telephone number or a WhatsApp number has an
 * identifier row for it.
 *
 * Run via `pnpm test:db-specs`. The default hermetic jest config ignores this file.
 *   DATABASE_URL=... npx jest --config jest-db.json --runInBand --testPathPattern="party-identifiers.db"
 *
 * Totality is the one property a mocked database cannot demonstrate — a fake
 * answers whatever it was told to answer, so a backfill whose anti-join is
 * wrong, or which forgets a column, passes every unit test and then strands
 * customers behind a resolver that cannot find them.
 *
 * The second claim tested here matters as much and is easier to miss. The
 * normalisation rule exists twice: once as `normaliseIdentifier`, and once as
 * SQL inside the migration, because a migration cannot call TypeScript. Two
 * implementations of one rule disagree eventually, and disagreement here does
 * not throw — it silently splits one person into two records. So the two are
 * run against the same corpus of real-world formats and compared value by
 * value.
 *
 * Everything happens inside a transaction that is rolled back, fixtures
 * included, so the tests leave the database exactly as they found it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireApprovedDatabaseUrl } from "../../test/db-spec-guard";
import postgres from "postgres";
import { normaliseIdentifier, type IdentifierKind } from "../ingress/inbound-event";

const migration = (name: string): string =>
  readFileSync(join(__dirname, "..", "..", "..", "migrations", name), "utf8");

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

/** postgres.js errors are cross-realm, so `instanceof` is unreliable here. */
function sqlStateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function connect() {
  // DATABASE_URL, not APP_DATABASE_URL: applying the migration needs DDL rights
  // the RLS-enforced application role does not have.
  const raw = requireApprovedDatabaseUrl({
    spec: "party-identifiers.db.spec.ts",
    vars: ["DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

/**
 * The same telephone line and the same address, written the way real records
 * carry them. Each entry is one person; a formatting difference must not make
 * two.
 */
const FORMATS: { kind: IdentifierKind; written: string }[] = [
  { kind: "email", written: "Priya@Example.COM" },
  { kind: "email", written: "  ops@acme.example  " },
  { kind: "phone", written: "+1 (415) 555-1212" },
  { kind: "phone", written: "+1-415-555-1212" },
  { kind: "phone", written: "0014155551212" },
  { kind: "phone", written: "+44 20 7123 4567" },
  // Deliberately national: nothing invents a country code, so this stays as it
  // came rather than being guessed onto a country.
  { kind: "phone", written: "4155551212" },
  { kind: "whatsapp", written: "+44 7700 900123" },
  { kind: "whatsapp", written: "0044 7700 900123" },
];

describe("party identifiers — real database", () => {
  // Every test here drops party_identifiers and re-runs the backfill across the
  // tenant's whole business_parties table, which `withBackfill` already declares
  // may take up to 60s (`SET LOCAL statement_timeout`). Jest's unstated 5s default
  // contradicted that: on the production-shaped seed two tests died at 5,000 ms
  // mid-backfill and read as assertion failures. This aligns the test timeout with
  // the statement timeout the file already declares — no assertion is relaxed.
  jest.setTimeout(60_000);

  let sql: ReturnType<typeof postgres>;
  let backfill: string;

  beforeAll(() => {
    sql = connect();
    backfill = migration("0260_party_identifiers.sql");
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  /**
   * Plants parties, runs 0260, hands the transaction to the assertions and
   * rolls everything back.
   *
   * The table is dropped first so the file runs identically before and after
   * 0260 has been applied for real — `CREATE TABLE IF NOT EXISTS` would survive,
   * but `ADD CONSTRAINT` would not, and a test that only passes on a database
   * where the migration is pending stops being run the week it lands.
   */
  async function withBackfill<T>(
    body: (tx: postgres.TransactionSql, orgId: string, marker: string) => Promise<T>,
  ): Promise<T> {
    let captured: T | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL statement_timeout = '60s'").simple();
        await tx.unsafe('DROP TABLE IF EXISTS "party_identifiers" CASCADE').simple();

        const [org] = await tx`SELECT id FROM organizations LIMIT 1`;
        if (!org)
          throw new Error("party-identifiers.db.spec.ts requires at least one seeded organization");
        const orgId = org.id as string;
        const marker = randomUUID().slice(0, 8);

        for (const [index, format] of FORMATS.entries()) {
          const column =
            format.kind === "email" ? "email" : format.kind === "phone" ? "phone" : "whatsapp_phone";
          await tx.unsafe(
            `INSERT INTO business_parties (party_id, organization_id, name, ${column}) VALUES (gen_random_uuid()::text, $1, $2, $3)`,
            [orgId, `fixture ${marker} ${String(index)}`, format.written],
          );
        }

        // A soft-deleted record must not hold a claim: the deletion would
        // otherwise poison that address for everybody, permanently.
        await tx`
          INSERT INTO business_parties (party_id, organization_id, name, email, deleted_at)
          VALUES (gen_random_uuid()::text, ${orgId}, ${`deleted ${marker}`}, ${`deleted-${marker}@example.test`}, now())`;

        // Two records for one line. Exactly one of them may hold the claim.
        await tx`
          INSERT INTO business_parties (party_id, organization_id, name, phone)
          VALUES (gen_random_uuid()::text, ${orgId}, ${`contested a ${marker}`}, '+1 (212) 555-0000'),
                 (gen_random_uuid()::text, ${orgId}, ${`contested b ${marker}`}, '+12125550000')`;

        await tx.unsafe(backfill).simple();

        captured = await body(tx, orgId, marker);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return captured as T;
  }

  /**
   * The ticket's acceptance criterion, checked over every row in the org.
   *
   * "No party with one of those values lacks the matching identifier" — with
   * the one exception the unique index forces, named rather than hidden: a
   * value another party already claimed cannot be claimed twice, and the loser
   * is left as a duplicate for the merge machinery to find.
   *
   * Computed in TypeScript rather than in SQL so that the comparison uses
   * `normaliseIdentifier` itself. The test below proves the migration's SQL
   * agrees with it; using it here means this assertion is about coverage rather
   * than about whether two normalisers happen to match.
   */
  it("leaves no live party holding an address or number without an identifier", async () => {
    const stranded = await withBackfill(async (tx, orgId) => {
      const parties = await tx`
        SELECT party_id, email, phone, whatsapp_phone
        FROM business_parties
        WHERE organization_id = ${orgId} AND deleted_at IS NULL`;
      const identifiers = await tx`
        SELECT party_id, kind, normalised_value FROM party_identifiers
        WHERE organization_id = ${orgId}`;

      const held = new Set(
        identifiers.map((row) => `${String(row.party_id)}|${String(row.kind)}|${String(row.normalised_value)}`),
      );
      const claimed = new Set(
        identifiers.map((row) => `${String(row.kind)}|${String(row.normalised_value)}`),
      );

      const columns: [IdentifierKind, string][] = [
        ["email", "email"],
        ["phone", "phone"],
        ["whatsapp", "whatsapp_phone"],
      ];

      const missing: string[] = [];
      for (const party of parties)
        for (const [kind, column] of columns) {
          const raw = party[column];
          if (typeof raw !== "string" || !raw.trim()) continue;
          const normalised = normaliseIdentifier(kind, raw);
          if (!normalised) continue;
          const key = `${kind}|${normalised}`;
          if (held.has(`${String(party.party_id)}|${key}`)) continue;
          // Absent only because somebody else holds it, which is the unique
          // index working rather than the backfill missing a row.
          if (claimed.has(key)) continue;
          missing.push(`${String(party.party_id)}:${key}`);
        }
      return missing;
    });

    expect(stranded).toEqual([]);
  });

  /**
   * The two implementations of one rule, compared on real rows.
   *
   * If this fails, the migration and `normaliseIdentifier` disagree — which
   * means a party backfilled from a column will not be found by a message
   * arriving at the same address, and the customer becomes two records.
   */
  it("normalises in SQL exactly as normaliseIdentifier does in TypeScript", async () => {
    const disagreements = await withBackfill(async (tx, orgId, marker) => {
      const rows = await tx`
        SELECT i.kind, i.value, i.normalised_value
        FROM party_identifiers i
        JOIN business_parties p
          ON p.organization_id = i.organization_id AND p.party_id = i.party_id
        WHERE i.organization_id = ${orgId} AND p.name LIKE ${`fixture ${marker}%`}`;

      return rows
        .map((row) => ({
          kind: String(row.kind),
          value: String(row.value),
          sql: String(row.normalised_value),
          typescript: normaliseIdentifier(String(row.kind) as IdentifierKind, String(row.value)),
        }))
        .filter((row) => row.sql !== row.typescript);
    });

    expect(disagreements).toEqual([]);
  });

  it("writes one identifier for every way one line can be written", async () => {
    const counts = await withBackfill(async (tx, orgId, marker) => {
      const rows = await tx`
        SELECT i.normalised_value, count(*)::int AS n
        FROM party_identifiers i
        JOIN business_parties p
          ON p.organization_id = i.organization_id AND p.party_id = i.party_id
        WHERE i.organization_id = ${orgId} AND p.name LIKE ${`fixture ${marker}%`}
        GROUP BY i.normalised_value
        ORDER BY i.normalised_value`;
      return rows.map((row) => ({ value: String(row.normalised_value), n: Number(row.n) }));
    });

    // Three spellings of the American line, two of the British one, two of the
    // WhatsApp one, two addresses, and the national number that nothing guessed
    // a country for — nine fixtures reduced to six distinct identities.
    expect(counts.map((row) => row.value).sort()).toEqual([
      "+14155551212",
      "+442071234567",
      "+447700900123",
      "4155551212",
      "ops@acme.example",
      "priya@example.com",
    ]);
    expect(counts.every((row) => row.n === 1)).toBe(true);
  });

  it("gives a deleted record no claim on the address it used to hold", async () => {
    const held = await withBackfill(async (tx, orgId, marker) => {
      const rows = await tx`
        SELECT 1 FROM party_identifiers
        WHERE organization_id = ${orgId}
          AND normalised_value = ${`deleted-${marker}@example.test`}`;
      return rows.length;
    });

    expect(held).toBe(0);
  });

  /**
   * What Postgres actually does with two conflicting rows inside ONE INSERT.
   *
   * `claimIdentifiers` deduplicates in memory before it writes, and the comment
   * beside it used to justify that by claiming `ON CONFLICT DO NOTHING` raises
   * 21000 on an intra-statement duplicate. It does not — measured here on
   * PostgreSQL 18.6, it inserts one row and reports no error. Only `DO UPDATE`
   * raises, because only `DO UPDATE` has to decide which of the two writes wins.
   *
   * Both halves are asserted rather than the one the code takes, because the
   * difference is the whole reason the dedupe is a deliberate choice instead of
   * an error handler: it fixes the winner in TypeScript, in the caller's order,
   * where `DO NOTHING` would leave it to whichever tuple the executor reached
   * first. Each probe runs in its own SAVEPOINT — an expected failure without one
   * aborts the transaction and every later assertion dies 25P02 instead.
   */
  it("keeps one of two identical claims in one INSERT, and only DO UPDATE raises 21000", async () => {
    const outcome = await withBackfill(async (tx, orgId, marker) => {
      const parties = await tx`
        SELECT party_id FROM business_parties
        WHERE organization_id = ${orgId} AND name LIKE ${`fixture ${marker}%`}
        LIMIT 2`;
      const first = String(parties[0]?.party_id);
      const second = String(parties[1]?.party_id);

      const doNothingValue = `intra-nothing-${marker}@example.test`;
      let doNothing: { raised: boolean; inserted: number; code: string | null };
      try {
        const rows = await tx.savepoint(
          async (sp) => sp`
            INSERT INTO party_identifiers
              (party_identifier_id, organization_id, party_id, kind, value, normalised_value)
            VALUES (gen_random_uuid()::text, ${orgId}, ${first}, 'email',
                    ${doNothingValue}, ${doNothingValue}),
                   (gen_random_uuid()::text, ${orgId}, ${second}, 'email',
                    ${doNothingValue}, ${doNothingValue})
            ON CONFLICT DO NOTHING
            RETURNING party_id`,
        );
        doNothing = { raised: false, inserted: rows.length, code: null };
      } catch (error) {
        doNothing = { raised: true, inserted: 0, code: sqlStateOf(error) };
      }

      const doUpdateValue = `intra-update-${marker}@example.test`;
      let doUpdate: { raised: boolean; code: string | null };
      try {
        await tx.savepoint(
          async (sp) => sp`
            INSERT INTO party_identifiers
              (party_identifier_id, organization_id, party_id, kind, value, normalised_value)
            VALUES (gen_random_uuid()::text, ${orgId}, ${first}, 'email',
                    ${doUpdateValue}, ${doUpdateValue}),
                   (gen_random_uuid()::text, ${orgId}, ${second}, 'email',
                    ${doUpdateValue}, ${doUpdateValue})
            ON CONFLICT (organization_id, kind, normalised_value)
            DO UPDATE SET value = excluded.value`,
        );
        doUpdate = { raised: false, code: null };
      } catch (error) {
        doUpdate = { raised: true, code: sqlStateOf(error) };
      }

      const survived = await tx`
        SELECT count(*)::int AS n FROM party_identifiers
        WHERE organization_id = ${orgId} AND normalised_value = ${doNothingValue}`;

      return { doNothing, doUpdate, survived: Number(survived[0]?.n ?? -1) };
    });

    expect(outcome.doNothing).toEqual({ raised: false, inserted: 1, code: null });
    expect(outcome.doUpdate).toEqual({ raised: true, code: "21000" });
    expect(outcome.survived).toBe(1);
  });

  /**
   * "Impossible rather than merely unlikely" is the ticket's phrasing, and it
   * is a property of the index rather than of the code that writes through it.
   */
  it("refuses a second party a claim on a number another party already holds", async () => {
    const outcome = await withBackfill(async (tx, orgId, marker) => {
      const contested = await tx`
        SELECT count(*)::int AS n FROM party_identifiers
        WHERE organization_id = ${orgId} AND normalised_value = '+12125550000'`;

      const [victim] = await tx`
        SELECT party_id FROM business_parties
        WHERE organization_id = ${orgId} AND name = ${`contested b ${marker}`}`;

      let refused = false;
      try {
        await tx.savepoint(
          async (sp) => sp`
            INSERT INTO party_identifiers
              (party_identifier_id, organization_id, party_id, kind, value, normalised_value)
            VALUES (gen_random_uuid()::text, ${orgId}, ${String(victim?.party_id)},
                    'phone', '+1 212 555 0000', '+12125550000')`,
        );
      } catch {
        refused = true;
      }

      return { claims: Number(contested[0]?.n ?? 0), refused };
    });

    expect(outcome).toEqual({ claims: 1, refused: true });
  });
});
