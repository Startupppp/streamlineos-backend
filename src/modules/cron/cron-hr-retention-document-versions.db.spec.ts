/**
 * HRMS-KB — retiring an HR document must retire its versions too, against a real Postgres.
 *
 * A version keeps its own copy of the file. The retention job used to look only at the document row, so a deleted
 * document left every superseded or pending version's file in storage for ever, and an anonymised one left the
 * versions readable: a knowledge-base entry pinned to a version resolves against `document_versions`, not the
 * document, so it could still hand out the file the retention policy had just redacted.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=cron-hr-retention-document-versions
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../db/schema";
import type { TenantTx } from "../../common/tenant";
import { sweepRetentionDocuments } from "./cron-hr-retention-documents";

const describeDb = dbSpecSuite();

describeDb("retention of an HR document reaches its versions — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "cron-hr-retention-document-versions.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let tx: TenantTx;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr"]);
    tx = drizzle(sql, { schema }) as unknown as TenantTx;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 60_000);

  const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000);

  /** A document with three versions, each its own file, the way a re-uploaded policy looks. */
  async function documentWithVersions(): Promise<{ id: number; keys: { current: string; older: string; pending: string } }> {
    const keys = {
      current: `${a.orgId}/hr-documents/${randomUUID()}-current.pdf`,
      older: `${a.orgId}/hr-documents/${randomUUID()}-older.pdf`,
      pending: `${a.orgId}/hr-documents/${randomUUID()}-pending.pdf`,
    };
    const [doc] = await sql`
      insert into documents (org_id, uploaded_by, name, type, classification, file_url)
      values (${a.orgId}, ${member(a, "hr").id}, ${`retire-${randomUUID().slice(0, 8)}`}, 'POLICY', 'INTERNAL', ${keys.current})
      returning id`;
    const id = Number(doc?.id);
    await sql`
      insert into document_versions (org_id, document_id, version, file_url, status, approved_at)
      values (${a.orgId}, ${id}, 1, ${keys.older}, 'approved', now()),
             (${a.orgId}, ${id}, 2, ${keys.current}, 'approved', now()),
             (${a.orgId}, ${id}, 3, ${keys.pending}, 'pending', null)`;
    return { id, keys };
  }

  const run = (action: "delete" | "anonymize") =>
    sweepRetentionDocuments(tx, { orgId: a.orgId, cutoff: tomorrow(), action, batchSize: 50, maxBatches: 5 });

  it("delete: every version's file is retired, not only the document's current one", async () => {
    const { keys } = await documentWithVersions();

    const outcome = await run("delete");

    expect(outcome.deleted).toBeGreaterThanOrEqual(1);
    expect(outcome.retiredKeys).toEqual(expect.arrayContaining([keys.current, keys.older, keys.pending]));
  });

  it("anonymize: the versions are redacted with the document, so nothing pinned to one can still serve the file, and every file is retired", async () => {
    const { id, keys } = await documentWithVersions();

    const outcome = await run("anonymize");

    expect(outcome.redacted).toBeGreaterThanOrEqual(1);
    expect(outcome.retiredKeys).toEqual(expect.arrayContaining([keys.current, keys.older, keys.pending]));
    const versions = await sql`select file_url, file_name from document_versions where document_id = ${id} order by version`;
    expect(versions).toHaveLength(3);
    for (const version of versions) {
      expect(version.file_url).toBe("retention://redacted");
      expect(version.file_name).toBe("redacted");
    }
  });

  it("leaves another organisation's versions alone", async () => {
    const other = await seed.org("b", ["hr"]);
    const [doc] = await sql`
      insert into documents (org_id, uploaded_by, name, type, classification, file_url)
      values (${other.orgId}, ${member(other, "hr").id}, 'theirs', 'POLICY', 'INTERNAL', ${`${other.orgId}/hr-documents/x.pdf`}) returning id`;
    await sql`insert into document_versions (org_id, document_id, version, file_url, status, approved_at) values (${other.orgId}, ${doc?.id}, 1, ${`${other.orgId}/hr-documents/x.pdf`}, 'approved', now())`;

    await run("anonymize");

    const [version] = await sql`select file_url from document_versions where document_id = ${doc?.id}`;
    expect(version?.file_url).toBe(`${other.orgId}/hr-documents/x.pdf`);
  });
});
