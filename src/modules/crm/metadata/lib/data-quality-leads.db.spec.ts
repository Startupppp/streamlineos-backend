import { drizzle } from "drizzle-orm/postgres-js";
import type { Db } from "../../../../db/drizzle.module";
import { dbSpecSessionClient, dbSpecSuite, dbSpecUrl } from "../../../../test/db-spec-gate";
import { leadsWithInvalidPhone, PHONE_BASIC_PATTERN } from "./data-quality-leads";
import { OFFENDER_LIMIT } from "./data-quality-shapes";

/**
 * The invalid-phone check, answered by Postgres.
 *
 * `leadsWithInvalidPhone` used to read every lead in the organisation and test
 * each phone in JavaScript with `JS_PHONE_RE`; it now filters in SQL with
 * `PHONE_BASIC_PATTERN`. What changed is which regex engine answers, and a mock
 * cannot evaluate `!~` — so this connects, and holds every answer to the old
 * JavaScript regex, which is the behaviour the move had to keep.
 *
 * It needs no schema. The first case selects literals; the second shadows
 * `business_parties` and `lead_party_map` with session-local temp tables that
 * carry only the columns the check reads, so it runs on an empty database and
 * never reads or writes a real row.
 *
 * Run with:
 *   DATABASE_URL=postgres://... pnpm test:db --testPathPattern=data-quality-leads
 */

/** The regex the SQL replaced. */
const JS_PHONE_RE = /^[+\d\s\-().]{7,20}$/;

/** The verbatim transliteration — kept only to prove this spec can see a disagreement. */
const VERBATIM = String.raw`^[+\d\s\-().]{7,20}$`;

const ch = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

function probeStrings(): string[] {
  const out: string[] = [];
  for (let cp = 1; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // not representable in UTF-8 text
    out.push(ch(cp).repeat(7));
  }
  // Astral decimal digits, which a collation-aware `\d` may accept, and an emoji.
  for (const cp of [0x104a0, 0x1d7ce, 0x1e950, 0x1f600]) out.push(ch(cp).repeat(7));
  for (let n = 0; n <= 22; n++) out.push("5".repeat(n), " ".repeat(n), ch(0xa0).repeat(n));
  out.push("1234567\n", "abc\n1234567", "1234567\nabc", "+1 (555) 123-4567", "555.123.4567");
  return out;
}

const SUITE = dbSpecSuite();

SUITE("CRM data quality: the invalid-phone check in SQL", () => {
  let pg: ReturnType<typeof dbSpecSessionClient> | null = null;

  beforeAll(() => {
    pg = dbSpecSessionClient(dbSpecUrl());
  });

  afterAll(async () => {
    await pg?.end();
  });

  it("agrees with the JavaScript regex on every BMP code point, under each collation provider", async () => {
    const sql = pg!;
    const inputs = JSON.stringify(probeStrings());
    const expected = JSON.stringify(probeStrings().map((s) => JS_PHONE_RE.test(s)));
    const available = await sql<{ collname: string }[]>`
      SELECT collname FROM pg_collation WHERE collname IN ('C', 'pg_c_utf8', 'und-x-icu')`;

    /** First code point of every probe on which Postgres and JavaScript disagree. */
    const disagreements = async (pattern: string, collation: string | null): Promise<string[]> => {
      const probe = collation === null ? sql`s` : sql`(s COLLATE ${sql(collation)})`;
      const rows = await sql<{ cp: string }[]>`
        SELECT to_hex(ascii(s)) AS cp
          FROM ROWS FROM (
            json_array_elements_text(${inputs}::text::json),
            json_array_elements_text(${expected}::text::json)
          ) AS t(s, js)
         WHERE (${probe} ~ ${pattern}) IS DISTINCT FROM js::bool`;
      return rows.map((r) => r.cp);
    };

    for (const collation of [null, ...available.map((r) => r.collname)]) {
      expect({ collation, mismatches: await disagreements(PHONE_BASIC_PATTERN, collation) }).toEqual({
        collation,
        mismatches: [],
      });
    }
    // Under C, `\s` is ASCII-only, so the verbatim pattern rejects a no-break
    // space JavaScript accepts. If this passes vacuously, so could the loop above.
    expect(await disagreements(VERBATIM, "C")).toContain("a0");
  });

  it("counts every offender, returns the newest ten, and skips NULL, empty, deleted and other-org phones", async () => {
    const sql = pg!;
    await sql`
      CREATE TEMP TABLE business_parties (
        party_id text PRIMARY KEY,
        organization_id text NOT NULL,
        name text NOT NULL,
        phone text,
        deleted_at timestamp,
        created_at timestamp NOT NULL
      )`;
    await sql`
      CREATE TEMP TABLE lead_party_map (
        organization_id text NOT NULL,
        lead_id integer NOT NULL,
        party_id text NOT NULL
      )`;

    const ORG = "org-dq-phone";
    const invalid = [
      "abc", "12", "123456", "1".repeat(21), "call 555 1234", "555-1234 x9", "(555)", "5551234#",
      "+44 20 7946 0958 ext", "phone",
      ch(0x661).repeat(7), // Arabic-Indic digits: not JavaScript's \d
      `123${ch(0x85)}4567`, // NEL: not JavaScript's \s
    ];
    const valid = [
      "+1 (555) 123-4567", "555.123.4567", "1234567", "1".repeat(20),
      `123${ch(0xa0)}4567`, // no-break space: JavaScript's \s
      ch(0x3000).repeat(7), // ideographic spaces only, which the old regex accepted too
    ];
    const cases: Array<{ org: string; phone: string | null; deleted: boolean }> = [
      ...invalid.map((phone) => ({ org: ORG, phone, deleted: false })),
      ...valid.map((phone) => ({ org: ORG, phone, deleted: false })),
      { org: ORG, phone: null, deleted: false },
      { org: ORG, phone: "", deleted: false },
      { org: ORG, phone: "abc", deleted: true },
      { org: "org-dq-other", phone: "abc", deleted: false },
    ];
    // 7 is coprime with the row count, so creation order interleaves offenders and the rest.
    const seeded = cases.map((c, i) => ({
      ...c,
      leadId: 1000 + i,
      partyId: `party-${i}`,
      name: `Lead ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + ((i * 7) % cases.length) * 60_000),
    }));
    for (const r of seeded) {
      await sql`
        INSERT INTO business_parties (party_id, organization_id, name, phone, deleted_at, created_at)
        VALUES (${r.partyId}, ${r.org}, ${r.name}, ${r.phone}, ${r.deleted ? r.createdAt : null}, ${r.createdAt})`;
      await sql`
        INSERT INTO lead_party_map (organization_id, lead_id, party_id)
        VALUES (${r.org}, ${r.leadId}, ${r.partyId})`;
    }

    /** The old implementation's filter, applied to what was seeded. */
    const offenders = seeded
      .filter((r) => r.org === ORG && !r.deleted)
      .filter((r) => r.phone !== null && r.phone !== "" && !JS_PHONE_RE.test(r.phone))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(offenders.length).toBeGreaterThan(OFFENDER_LIMIT);

    const result = await leadsWithInvalidPhone(drizzle(sql) as unknown as Db, ORG);

    expect(result).toEqual({
      count: offenders.length,
      offenders: offenders
        .slice(0, OFFENDER_LIMIT)
        .map((r) => ({ id: r.leadId, name: r.name, detail: r.phone })),
    });
  });
});
