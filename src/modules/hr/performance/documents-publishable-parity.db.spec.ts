/**
 * HRMS-KB PR 2 — the two definitions of "this document may be linked" must not drift apart.
 *
 * The database function `app.hr_document_is_publishable` (migration 1200) is what actually stops a write; the
 * TypeScript `isPublishableDocument` lets the service refuse first, with a message. `companyLevelDocumentSql`
 * is the SQL twin of `isCompanyLevelDocument`, used by the read path. If any pair disagrees on any row, one of
 * them is either refusing a document it should allow (a support ticket) or allowing one it should refuse (the
 * invariant this whole project exists to protect). So this feeds every combination of the inputs the rules read
 * through both and requires the answers to be identical.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=documents-publishable-parity
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as dsql } from "drizzle-orm";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import { companyLevelDocumentSql, isCompanyLevelDocument, isPublishableDocument } from "./documents-helpers";

const describeDb = dbSpecSuite();

const TYPES = ["CONTRACT", "CERTIFICATE", "ID_PROOF", "PAYSLIP", "POLICY", "OFFER_LETTER", "RESUME", "OTHER"] as const;
const CLASSIFICATIONS = ["PERSONAL", "CONFIDENTIAL", "RESTRICTED", "INTERNAL"] as const;
const METADATA: ReadonlyArray<Record<string, unknown> | null> = [
  null,
  {},
  { candidateId: 7 },
  { offerId: "o-1" },
  { source: "upload", unrelated: true },
];

describeDb("publishability: TypeScript and database agree — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "documents-publishable-parity.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let seed: HrmsKbSeed;
  let org: SeededOrg;
  let rows: Array<{
    id: number;
    type: string;
    classification: string;
    userId: string | null;
    uploadedBy: string | null;
    isActive: boolean;
    metadata: Record<string, unknown> | null;
  }>;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });
    seed = new HrmsKbSeed(sql);
    org = await seed.org("parity", ["hr", "employee"]);
    const hr = member(org, "hr").id;
    const employee = member(org, "employee").id;

    const owners: ReadonlyArray<{ userId: string | null; uploadedBy: string | null }> = [
      { userId: null, uploadedBy: null }, // nobody's, no uploader recorded
      { userId: null, uploadedBy: hr }, // nobody's, filed by HR
      { userId: hr, uploadedBy: hr }, // an HR-uploaded handbook: the uploader is the owner
      { userId: employee, uploadedBy: hr }, // an employee's file that HR filed
      { userId: employee, uploadedBy: null }, // an owner and no uploader: import, onboarding, recruitment handoff
    ];
    const inserts: Array<Record<string, unknown>> = [];
    for (const type of TYPES)
      for (const classification of CLASSIFICATIONS)
        for (const owner of owners)
          for (const isActive of [true, false])
            for (const metadata of METADATA)
              inserts.push({
                org_id: org.orgId,
                user_id: owner.userId,
                uploaded_by: owner.uploadedBy,
                name: `parity-${inserts.length}`,
                type,
                classification,
                is_active: isActive,
                // Omitted, not null: jsonb_to_recordset reads a JSON null as the jsonb value `null`, not SQL NULL.
                ...(metadata === null ? {} : { metadata }),
                file_url: `${org.orgId}/hr-documents/${randomUUID()}.pdf`,
              });
    expect(inserts).toHaveLength(TYPES.length * CLASSIFICATIONS.length * owners.length * 2 * METADATA.length);
    // One JSON document, expanded server-side. Passing each row's metadata as a bind parameter stores a JSON
    // STRING (postgres-js encodes the text once more), which no key test can ever match — an earlier draft of this
    // spec passed for exactly that reason. The self-check below fails if metadata is not a real object.
    await sql`
      insert into documents (org_id, user_id, uploaded_by, name, type, classification, is_active, metadata, file_url)
      select r.org_id, r.user_id, r.uploaded_by, r.name, r.type::document_type, r.classification::document_classification,
             r.is_active, r.metadata, r.file_url
      from jsonb_to_recordset(${JSON.stringify(inserts)}::text::jsonb) as r(
        org_id text, user_id text, uploaded_by text, name text, type text, classification text,
        is_active boolean, metadata jsonb, file_url text)`;
    rows = (
      await sql<Array<{ id: number; type: string; classification: string; user_id: string | null; uploaded_by: string | null; is_active: boolean; metadata: Record<string, unknown> | null }>>`
        select id, type::text as type, classification::text as classification, user_id, uploaded_by, is_active, metadata
        from documents where org_id = ${org.orgId}`
    ).map((r) => ({
      id: r.id,
      type: r.type,
      classification: r.classification,
      userId: r.user_id,
      uploadedBy: r.uploaded_by,
      isActive: r.is_active,
      metadata: r.metadata,
    }));
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  });

  it("self-check: every non-null metadata value in the grid is a JSON object, so the key rule is actually exercised", async () => {
    const [bad] = await sql`
      select count(*)::int as n from documents
      where org_id = ${org.orgId} and metadata is not null and jsonb_typeof(metadata) <> 'object'`;
    const [withKey] = await sql`
      select count(*)::int as n from documents
      where org_id = ${org.orgId} and metadata ?| array['candidateId', 'offerId']`;

    expect(bad?.n).toBe(0);
    expect(withKey?.n).toBeGreaterThan(0);
    // ...and TypeScript, reading those rows back, sees them as objects with the keys.
    expect(rows.some((row) => row.metadata !== null && Object.hasOwn(row.metadata, "candidateId"))).toBe(true);
  });

  it("a new document is PERSONAL when the writer never mentions classification (the fail-closed default)", async () => {
    const [row] = await sql`
      insert into documents (org_id, name, type, file_url)
      values (${org.orgId}, ${"legacy writer"}, ${"POLICY"}, ${`${org.orgId}/hr-documents/x.pdf`})
      returning classification::text as classification`;

    expect(row?.classification).toBe("PERSONAL");
  });

  it("the database function and isPublishableDocument agree on every row", async () => {
    const answers = await db.execute<{ id: number; sql_publishable: boolean }>(
      dsql`select id, app.hr_document_is_publishable(documents) as sql_publishable from documents where org_id = ${org.orgId}`,
    );
    const bySqlId = new Map(Array.from(answers).map((a) => [Number(a.id), a.sql_publishable]));

    const disagreements = rows.filter((row) => isPublishableDocument(row) !== bySqlId.get(row.id));
    expect(disagreements).toEqual([]);

    // Not vacuous: the grid contains both answers, so agreement means something.
    const publishable = rows.filter((row) => isPublishableDocument(row)).length;
    expect(publishable).toBeGreaterThan(0);
    expect(publishable).toBeLessThan(rows.length);
  });

  it("companyLevelDocumentSql and isCompanyLevelDocument agree on every row", async () => {
    const answers = await db.execute<{ id: number; sql_company: boolean }>(
      dsql`select id, ${companyLevelDocumentSql()} as sql_company from documents where org_id = ${org.orgId}`,
    );
    const bySqlId = new Map(Array.from(answers).map((a) => [Number(a.id), a.sql_company]));

    expect(rows.filter((row) => isCompanyLevelDocument(row) !== bySqlId.get(row.id))).toEqual([]);
  });

  it("no document is publishable unless a person classified it INTERNAL or RESTRICTED", () => {
    const wrong = rows.filter(
      (row) => isPublishableDocument(row) && row.classification !== "INTERNAL" && row.classification !== "RESTRICTED",
    );
    expect(wrong).toEqual([]);
  });

  it("no personal document type is ever publishable, however it is classified or owned", () => {
    const personalTypes = new Set(["CONTRACT", "CERTIFICATE", "ID_PROOF", "PAYSLIP", "OFFER_LETTER", "RESUME"]);
    expect(rows.filter((row) => personalTypes.has(row.type) && isPublishableDocument(row))).toEqual([]);
  });

  it("no document owned by a different person is ever publishable", () => {
    const wrong = rows.filter(
      (row) => row.userId !== null && row.userId !== row.uploadedBy && isPublishableDocument(row),
    );
    expect(wrong).toEqual([]);
  });
});
