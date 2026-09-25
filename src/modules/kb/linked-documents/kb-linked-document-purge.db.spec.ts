/**
 * HRMS-KB PR 7 — clearing the entries whose HR document was removed, against a real Postgres.
 *
 * Readers stopped seeing an entry the moment its document was removed. The entry stays as "Source removed" for 30
 * days so a publisher can find it, then it goes. What must NOT go: an entry that is still live, one withdrawn on
 * purpose, one removed less than 30 days ago, one brought back since, or anything in another organisation.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=kb-linked-document-purge
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { TenantTx } from "../../../common/tenant";
import { purgeSourceRemovedLinks, SOURCE_REMOVED_GRACE_DAYS } from "./kb-linked-document-purge";

const describeDb = dbSpecSuite();

describeDb("purging removed-source entries — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-document-purge.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let tx: TenantTx;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr"]);
    b = await seed.org("b", ["hr"]);
    tx = drizzle(sql, { schema }) as unknown as TenantTx;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  });

  /** An entry over a fresh company document, put into the given state the way the database's own triggers leave it. */
  async function entry(org: SeededOrg, status: "active" | "unpublished" | "source_removed", removedDaysAgo?: number): Promise<number> {
    const [doc] = await sql`
      insert into documents (org_id, uploaded_by, name, type, classification, file_url)
      values (${org.orgId}, ${member(org, "hr").id}, ${`doc-${randomUUID().slice(0, 8)}`}, 'POLICY', 'INTERNAL', ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`})
      returning id`;
    const [link] = await sql`insert into kb_linked_documents (org_id, document_id) values (${org.orgId}, ${doc?.id}) returning id`;
    const linkId = Number(link?.id);
    await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind) values (${org.orgId}, ${linkId}, 'ALL_EMPLOYEES')`;
    if (status === "unpublished") await sql`update kb_linked_documents set status = 'unpublished', unpublished_at = now(), unpublish_reason = 'manual' where id = ${linkId}`;
    if (status === "source_removed")
      await sql`update kb_linked_documents set status = 'source_removed', unpublished_at = now(), source_removed_at = now() - make_interval(days => ${removedDaysAgo ?? 0}) where id = ${linkId}`;
    return linkId;
  }

  const exists = async (linkId: number): Promise<boolean> => Number((await sql`select count(*)::int as n from kb_linked_documents where id = ${linkId}`)[0]?.n) === 1;
  const audienceRows = async (linkId: number): Promise<number> => Number((await sql`select count(*)::int as n from kb_linked_document_audiences where linked_document_id = ${linkId}`)[0]?.n);

  it("deletes an entry whose document was removed more than the grace period ago, and its audience rows with it", async () => {
    const due = await entry(a, "source_removed", SOURCE_REMOVED_GRACE_DAYS + 1);
    expect(await audienceRows(due)).toBe(1);

    const outcome = await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 200);

    expect(outcome.linkedDocumentIds).toContain(due);
    expect(outcome.purged).toBeGreaterThanOrEqual(1);
    expect(await exists(due)).toBe(false);
    expect(await audienceRows(due)).toBe(0);
  });

  it("keeps one removed inside the grace period, one still live, and one withdrawn on purpose", async () => {
    const recent = await entry(a, "source_removed", SOURCE_REMOVED_GRACE_DAYS - 1);
    const live = await entry(a, "active");
    const withdrawn = await entry(a, "unpublished");

    await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 200);

    expect(await exists(recent)).toBe(true);
    expect(await exists(live)).toBe(true);
    expect(await exists(withdrawn)).toBe(true);
  });

  it("purges an entry once time has passed: the same one, later", async () => {
    const recent = await entry(a, "source_removed", SOURCE_REMOVED_GRACE_DAYS - 1);

    await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 200);
    expect(await exists(recent)).toBe(true);

    const later = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    await purgeSourceRemovedLinks(tx, a.orgId, later, 200);
    expect(await exists(recent)).toBe(false);
  });

  it("tenant isolation: purging one organisation never deletes another's entries, however old", async () => {
    const theirs = await entry(b, "source_removed", SOURCE_REMOVED_GRACE_DAYS + 30);

    await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 200);

    expect(await exists(theirs)).toBe(true);
    const outcome = await purgeSourceRemovedLinks(tx, b.orgId, new Date(), 200);
    expect(outcome.linkedDocumentIds).toContain(theirs);
    expect(await exists(theirs)).toBe(false);
  });

  it("works through a backlog in bounded batches, and says when more are waiting", async () => {
    const ids = [await entry(a, "source_removed", 40), await entry(a, "source_removed", 40), await entry(a, "source_removed", 40)];

    const first = await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 2);
    expect(first.purged).toBe(2);
    expect(first.truncated).toBe(true);

    const second = await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 2);
    expect(second.purged).toBe(1);
    expect(second.truncated).toBe(false);
    for (const id of ids) expect(await exists(id)).toBe(false);
  });

  it("does nothing, and says so, when nothing is due", async () => {
    const outcome = await purgeSourceRemovedLinks(tx, a.orgId, new Date(), 200);

    expect(outcome).toEqual({ purged: 0, linkedDocumentIds: [], truncated: false });
  });
});
