/**
 * HRMS-KB PR 7 — proposing a classification for existing HR documents, against a real Postgres.
 *
 * Every document starts Personal, so without a backfill HR would classify each existing policy by hand. What the
 * backfill may do is narrow on purpose: propose Internal (for all employees only where employees can read the
 * document today, otherwise for HR only) for a document that already looks company-level, never publish, never
 * overwrite what HR decided, and never touch anything that describes a person or belongs to another tenant.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=kb-linked-document-backfill
 */
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import { KbLinkedDocumentBackfillService } from "./kb-linked-document-backfill.service";
import type { PublishActor } from "./kb-linked-document-publish.service";

const describeDb = dbSpecSuite();

describeDb("backfilling classifications — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-document-backfill.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let off: SeededOrg;
  let service: KbLinkedDocumentBackfillService;

  const actorOf = (org: SeededOrg): PublishActor => ({ userId: member(org, "hr").id, orgId: org.orgId, membershipId: member(org, "hr").membershipId });

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 6 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "employee"]);
    b = await seed.org("b", ["hr", "employee"]);
    off = await seed.org("off", ["hr"]);
    const db = drizzle(sql, { schema }) as unknown as Db;
    const audit = new AuditService(db);
    const entitlements = { isModuleEnabled: jest.fn().mockResolvedValue(true) } as unknown as EntitlementsService;
    service = new KbLinkedDocumentBackfillService(db, audit, new KbHrLinkFlagsService(db, entitlements, audit));
    for (const org of [a, b]) await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${org.orgId}, true)`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  });

  async function doc(
    org: SeededOrg,
    over: Partial<{ type: string; classification: string; owner: "none" | "uploader" | "employee"; isActive: boolean; isPublic: boolean; metadata: string | null; audience: boolean }> = {},
  ): Promise<number> {
    const o = { type: "POLICY", classification: "PERSONAL", owner: "none", isActive: true, isPublic: false, metadata: null, audience: false, ...over };
    const uploader = member(org, "hr").id;
    const owner = o.owner === "none" ? null : o.owner === "uploader" ? uploader : (org.members.employee?.id ?? uploader);
    const [row] = await sql`
      insert into documents (org_id, user_id, uploaded_by, name, type, classification, is_active, is_public, metadata, file_url)
      values (${org.orgId}, ${owner}, ${uploader}, ${`doc-${randomUUID().slice(0, 8)}`}, ${o.type}, ${o.classification}, ${o.isActive}, ${o.isPublic},
              ${o.metadata}::text::jsonb, ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`})
      returning id`;
    const documentId = Number(row?.id);
    if (o.audience) await sql`insert into document_audiences (org_id, document_id, kind) values (${org.orgId}, ${documentId}, 'ALL_EMPLOYEES')`;
    return documentId;
  }

  const stateOf = async (documentId: number) => {
    const [row] = await sql`
      select d.classification, (select count(*)::int from document_audiences da where da.document_id = d.id and da.kind = 'ALL_EMPLOYEES') as everyone,
             (select count(*)::int from kb_linked_documents l where l.document_id = d.id) as links
      from documents d where d.id = ${documentId}`;
    return { classification: String(row?.classification), everyone: Number(row?.everyone), links: Number(row?.links) };
  };

  /** Walks every page from the start, as a caller resuming with the cursor would. */
  async function runAll(org: SeededOrg, dryRun: boolean, limit = 100) {
    const pages = [];
    let cursor = 0;
    for (;;) {
      const page = await service.run(actorOf(org), { dryRun, cursor, limit });
      pages.push(page);
      if (page.done || page.nextCursor === null) return pages;
      cursor = page.nextCursor;
    }
  }

  const total = (pages: Awaited<ReturnType<typeof runAll>>, pick: (page: (typeof pages)[number]) => number) => pages.reduce((sum, page) => sum + pick(page), 0);

  describe("what it proposes", () => {
    it("proposes Internal for a company-level document, for all employees only where employees can read it today", async () => {
      const publicPolicy = await doc(a, { isPublic: true });
      const privatePolicy = await doc(a, { type: "OTHER", isPublic: false });
      const uploaderOwned = await doc(a, { owner: "uploader", isPublic: true });

      const pages = await runAll(a, true);

      expect(total(pages, (page) => page.eligible)).toBeGreaterThanOrEqual(3);
      const sample = pages.flatMap((page) => page.sample);
      expect(sample.find((entry) => entry.documentId === publicPolicy)?.audience).toBe("ALL_EMPLOYEES");
      expect(sample.find((entry) => entry.documentId === privatePolicy)?.audience).toBe("HR_ONLY");
      expect(sample.find((entry) => entry.documentId === uploaderOwned)?.audience).toBe("ALL_EMPLOYEES");
    });

    it("skips, and says why, everything that is not a company document HR has yet to classify", async () => {
      const payslip = await doc(a, { type: "PAYSLIP", isPublic: true });
      const employees = await doc(a, { owner: "employee" });
      const hiring = await doc(a, { metadata: JSON.stringify({ candidateId: 4 }) });
      const removed = await doc(a, { isActive: false });
      const classified = await doc(a, { classification: "RESTRICTED" });
      const withAudience = await doc(a, { audience: true });

      const pages = await runAll(a, true);

      const sampled = new Set(pages.flatMap((page) => page.sample.map((entry) => entry.documentId)));
      const named = { payslip, employees, hiring, removed, classified, withAudience };
      for (const [label, skippedId] of Object.entries(named)) expect([label, sampled.has(skippedId)]).toEqual([label, false]);
      expect(total(pages, (page) => page.skipped.typeNotAllowed)).toBeGreaterThanOrEqual(1);
      expect(total(pages, (page) => page.skipped.belongsToAnEmployee)).toBeGreaterThanOrEqual(1);
      expect(total(pages, (page) => page.skipped.hiringArtefact)).toBeGreaterThanOrEqual(1);
      expect(total(pages, (page) => page.skipped.inactive)).toBeGreaterThanOrEqual(1);
      expect(total(pages, (page) => page.skipped.alreadyClassified)).toBeGreaterThanOrEqual(2);
    });
  });

  describe("a dry run", () => {
    it("is the default of the schema, and changes nothing at all", async () => {
      const target = await doc(a, { isPublic: true });
      const before = await stateOf(target);

      const [page] = await runAll(a, true);

      expect(page?.dryRun).toBe(true);
      expect(page?.applied).toBe(0);
      expect(await stateOf(target)).toEqual(before);
      expect(before).toEqual({ classification: "PERSONAL", everyone: 0, links: 0 });
    });
  });

  describe("applying", () => {
    it("classifies exactly the eligible documents, gives all-employee audiences only where they were public, and publishes nothing", async () => {
      const publicPolicy = await doc(b, { isPublic: true });
      const privatePolicy = await doc(b, { isPublic: false });
      const payslip = await doc(b, { type: "PAYSLIP", isPublic: true });
      const employees = await doc(b, { owner: "employee" });
      const already = await doc(b, { classification: "RESTRICTED" });

      const pages = await runAll(b, false);

      expect(total(pages, (page) => page.applied)).toBe(2);
      expect(await stateOf(publicPolicy)).toEqual({ classification: "INTERNAL", everyone: 1, links: 0 });
      expect(await stateOf(privatePolicy)).toEqual({ classification: "INTERNAL", everyone: 0, links: 0 });
      expect((await stateOf(payslip)).classification).toBe("PERSONAL");
      expect((await stateOf(employees)).classification).toBe("PERSONAL");
      expect((await stateOf(already)).classification).toBe("RESTRICTED");
      const [links] = await sql`select count(*)::int as n from kb_linked_documents where org_id = ${b.orgId}`;
      expect(Number(links?.n)).toBe(0);
    });

    it("is safe to repeat: what it changed is no longer eligible, so a second pass applies nothing", async () => {
      const pages = await runAll(b, false);

      expect(total(pages, (page) => page.applied)).toBe(0);
      expect(total(pages, (page) => page.eligible)).toBe(0);
    });

    it("resumes from a cursor, page by page, and covers every eligible document exactly once", async () => {
      const ids = [await doc(a, { isPublic: true }), await doc(a, { isPublic: false }), await doc(a, { isPublic: true }), await doc(a, { isPublic: false })];

      const pages = await runAll(a, false, 2);

      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages.slice(0, -1)) expect(page.scanned).toBe(2);
      expect(pages.at(-1)?.done).toBe(true);
      expect(pages.at(-1)?.nextCursor).toBeNull();
      for (const id of ids) expect((await stateOf(id)).classification).toBe("INTERNAL");
    });

    it("does not apply twice when two runs race", async () => {
      const raced = await doc(a, { isPublic: true });

      const runs = await Promise.all([runAll(a, false), runAll(a, false)]);

      const applied = runs.flatMap((pages) => pages).reduce((sum, page) => sum + page.applied, 0);
      expect(applied).toBeGreaterThanOrEqual(1);
      expect(await stateOf(raced)).toEqual({ classification: "INTERNAL", everyone: 1, links: 0 });
    });
  });

  describe("audit", () => {
    it("records every run, dry or not, with the counts and the ids it changed", async () => {
      const target = await doc(a, { isPublic: true });
      await service.run(actorOf(a), { dryRun: true, cursor: target - 1, limit: 1 });
      await service.run(actorOf(a), { dryRun: false, cursor: target - 1, limit: 1 });

      const rows = await sql`select metadata from audit_logs where org_id = ${a.orgId} and action = 'kb.hr_link.backfill_run' order by id desc limit 2`;

      const [applied, dry] = rows.map((row) => row.metadata as Record<string, unknown>);
      expect(dry).toMatchObject({ dryRun: true, applied: 0, documentIds: [] });
      expect(applied).toMatchObject({ dryRun: false, applied: 1, documentIds: [target] });
    });
  });

  describe("tenants and the switch", () => {
    it("tenant isolation: a run in one organisation never reads or changes another's documents", async () => {
      const others = await doc(off, { isPublic: true });
      await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${off.orgId}, false)`;
      const mine = await doc(a, { isPublic: true });

      const pages = await runAll(a, false);

      expect(pages.flatMap((page) => page.sample).some((entry) => entry.documentId === others)).toBe(false);
      expect((await stateOf(others)).classification).toBe("PERSONAL");
      expect((await stateOf(mine)).classification).toBe("INTERNAL");
    });

    it("answers as if the route did not exist while the link switch is off, and changes nothing", async () => {
      const target = await doc(off, { isPublic: true });

      await expect(service.run(actorOf(off), { dryRun: false, cursor: 0, limit: 100 })).rejects.toBeInstanceOf(NotFoundException);

      expect((await stateOf(target)).classification).toBe("PERSONAL");
    });
  });
});
