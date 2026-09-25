import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";
import { KbLinkedDocumentFileService } from "./kb-linked-document-file.service";
import { KbLinkedDocumentPublishService } from "./kb-linked-document-publish.service";
import { encodeLinkedDocumentCursor } from "./kb-linked-document-cursor";
import { listLinkedDocumentsQuerySchema, linkedDocumentParamsSchema } from "./dto/kb-linked-documents.schemas";
import { kbLinkParamsSchema, publishLinkSchema, unpublishLinkSchema, updateLinkSchema } from "./dto/kb-link-publish.schemas";

const describeDb = dbSpecSuite();

const SHARED_TITLE = "Code of Conduct";
const SHARED_CATEGORY = "Policies";

describeDb("linked documents: another tenant's id, however it arrives — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-documents-cross-tenant.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let query: KbLinkedDocumentQueryService;
  let files: KbLinkedDocumentFileService;
  let publish: KbLinkedDocumentPublishService;
  let mine: { documentId: number; linkId: number };
  let theirs: { documentId: number; linkId: number };
  let foreignKeyed: { documentId: number; linkId: number };

  const signed = jest.fn(async (..._args: unknown[]) => "https://signed.example.test/x.pdf");

  const caller = (org: SeededOrg, name: string, canPublish = true): LinkedDocumentCaller => ({
    orgId: org.orgId,
    userId: member(org, name).id,
    canPublish,
  });

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("xt-a", ["hr", "reader"]);
    b = await seed.org("xt-b", ["hr", "reader"]);
    const db = drizzle(sql, { schema }) as unknown as Db;
    query = new KbLinkedDocumentQueryService(db);

    const storage = {
      getFileKeyFromUrl: (value: string) => value,
      isValidFileKey: () => true,
      getFileUrl: signed,
    };
    const audit = {
      logCritical: jest.fn().mockResolvedValue(undefined),
      logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined),
    };
    const flags = { assertEnabled: jest.fn().mockResolvedValue(undefined) };
    files = new KbLinkedDocumentFileService(query, storage as never, audit as never);
    publish = new KbLinkedDocumentPublishService(db, audit as never, flags as never);

    await employ(a, "reader");
    await employ(b, "reader");
    mine = await entry(a);
    theirs = await entry(b);
    foreignKeyed = await entry(a, `${b.orgId}/hr-documents/${randomUUID()}.pdf`);
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 120_000);

  async function employ(org: SeededOrg, name: string): Promise<void> {
    const [person] = await sql`insert into hr_people (org_id, user_id) values (${org.orgId}, ${member(org, name).id}) returning id`;
    await sql`
      insert into hr_employments (org_id, person_id, employee_number, lifecycle_status)
      values (${org.orgId}, ${person?.id}, ${`E-${randomUUID().slice(0, 8)}`}, 'ACTIVE'::hr_employment_lifecycle_status)`;
  }

  async function entry(org: SeededOrg, fileUrl?: string): Promise<{ documentId: number; linkId: number }> {
    const hr = member(org, "hr").id;
    const [doc] = await sql`
      insert into documents (org_id, uploaded_by, name, description, type, classification, file_url, file_name, category, tags)
      values (${org.orgId}, ${hr}, ${SHARED_TITLE}, 'How we work together.', 'POLICY', 'INTERNAL',
              ${fileUrl ?? `${org.orgId}/hr-documents/${randomUUID()}.pdf`}, 'file.pdf', ${SHARED_CATEGORY}, ARRAY['conduct'])
      returning id`;
    const documentId = Number(doc?.id);
    await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${org.orgId}, ${documentId}, 'ALL_EMPLOYEES', null)`;
    const [link] = await sql`insert into kb_linked_documents (org_id, document_id, published_at) values (${org.orgId}, ${documentId}, now()) returning id`;
    const linkId = Number(link?.id);
    await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind, ref_id) values (${org.orgId}, ${linkId}, 'ALL_EMPLOYEES', null)`;
    return { documentId, linkId };
  }

  describe("the fixture really is two live tenants that look alike", () => {
    it("each tenant sees its own entry, and the two entries are different rows with the same title", async () => {
      const seenByA = await query.list(caller(a, "reader", false), { limit: 100 });
      const seenByB = await query.list(caller(b, "reader", false), { limit: 100 });

      expect(theirs.linkId).not.toBe(mine.linkId);
      expect(seenByA.data.map((item) => item.id)).toContain(mine.linkId);
      expect(seenByB.data.map((item) => item.id)).toContain(theirs.linkId);
      expect(seenByA.data.find((item) => item.id === mine.linkId)?.name).toBe(SHARED_TITLE);
      expect(seenByB.data.find((item) => item.id === theirs.linkId)?.name).toBe(SHARED_TITLE);
    });
  });

  describe("every entry point, given B's id, answers A as though it did not exist", () => {
    const notFound = [
      ["read one entry", () => query.get(caller(a, "hr"), theirs.linkId)],
      ["resolve the file behind an entry", () => query.resolveFile(caller(a, "hr"), theirs.linkId)],
      ["open an entry", () => files.open(caller(a, "hr"), theirs.linkId)],
      ["read where a document stands", () => publish.getState(a.orgId, theirs.documentId)],
      ["publish a document", () => publish.publish({ ...actor(), membershipId: member(a, "hr").membershipId }, theirs.documentId, {})],
      ["re-scope an entry", () => publish.updateLink({ ...actor(), membershipId: member(a, "hr").membershipId }, theirs.documentId, { versionMode: "FOLLOW_LATEST" })],
      ["withdraw an entry", () => publish.unpublish({ ...actor(), membershipId: member(a, "hr").membershipId }, theirs.documentId, {})],
    ] as const;

    function actor() {
      return { userId: member(a, "hr").id, orgId: a.orgId };
    }

    it.each(notFound)("%s answers 404", async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    });

    it("re-checking a citation drops B's id rather than confirming it", async () => {
      await expect(query.visibleIds(caller(a, "hr"), [theirs.linkId])).resolves.toEqual(new Set());
      await expect(query.visibleIds(caller(a, "hr"), [mine.linkId])).resolves.toEqual(new Set([mine.linkId]));
    });

    it("an id carried in the QUERY — a cursor minted over B's entry — pages A's rows and never reaches B's", async () => {
      const cursor = encodeLinkedDocumentCursor({ publishedAt: new Date(Date.now() + 60_000).toISOString(), id: theirs.linkId });
      const page = await query.list(caller(a, "hr"), { limit: 100, cursor });
      const ids = page.data.map((item) => item.id);

      expect(ids).toContain(mine.linkId);
      expect(ids).not.toContain(theirs.linkId);
    });

    it("searching B's exact title and category from inside A finds only A's copy", async () => {
      const hits = await query.searchForCaller(caller(a, "hr"), SHARED_TITLE, 50);
      const ids = hits.map((hit) => hit.id);

      expect(ids).toContain(mine.linkId);
      expect(ids).not.toContain(theirs.linkId);
    });
  });

  describe("an organisation named by the caller is not an organisation", () => {
    it.each([
      ["publish", publishLinkSchema],
      ["update", updateLinkSchema],
      ["unpublish", unpublishLinkSchema],
    ])("the %s body refuses orgId, tenantId and a smuggled documentId", (_name, spec) => {
      for (const smuggled of [{ orgId: "org-b" }, { tenantId: "org-b" }, { documentId: 1 }, { linkedDocumentId: 1 }, { "x-org-id": "org-b" }]) {
        expect(spec.safeParse({ ...smuggled }).success).toBe(false);
      }
      expect(publishLinkSchema.safeParse({ audiences: [] }).success).toBe(true);
      expect(updateLinkSchema.safeParse({ versionMode: "FOLLOW_LATEST" }).success).toBe(true);
      expect(unpublishLinkSchema.safeParse({ reason: "Superseded" }).success).toBe(true);
    });

    it("the list query and the path params refuse an organisation too", () => {
      expect(listLinkedDocumentsQuerySchema.safeParse({ limit: 10, orgId: "org-b" }).success).toBe(false);
      expect(listLinkedDocumentsQuerySchema.safeParse({ limit: 10, tenantId: "org-b" }).success).toBe(false);
      expect(listLinkedDocumentsQuerySchema.safeParse({ limit: 10 }).success).toBe(true);
      expect(linkedDocumentParamsSchema.safeParse({ linkedDocumentId: 1, orgId: "org-b" }).success).toBe(false);
      expect(kbLinkParamsSchema.safeParse({ documentId: 1, orgId: "org-b" }).success).toBe(false);
    });

    it("a header naming B does not change what A is shown, because nothing reads one", async () => {
      const spoofed = { ...caller(a, "hr"), ["x-org-id"]: b.orgId } as LinkedDocumentCaller;

      const ids = (await query.list(spoofed, { limit: 100 })).data.map((item) => item.id);

      expect(ids).toContain(mine.linkId);
      expect(ids).not.toContain(theirs.linkId);
    });
  });

  describe("no signed URL is ever issued for B's object key", () => {
    it("refuses a well-formed key that belongs to the other tenant, not just a malformed one", async () => {
      signed.mockClear();

      await expect(files.open(caller(a, "hr"), foreignKeyed.linkId)).rejects.toBeInstanceOf(NotFoundException);
      expect(signed).not.toHaveBeenCalled();

      await expect(files.open(caller(a, "hr"), mine.linkId)).resolves.toMatchObject({ expiresIn: 300 });
      expect(signed).toHaveBeenCalledTimes(1);
      expect(signed.mock.calls[0]?.[0]).toBe(a.orgId);
    });
  });
});
