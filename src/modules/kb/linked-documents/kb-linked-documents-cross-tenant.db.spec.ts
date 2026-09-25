/**
 * HRMS-KB V-166 — an id belonging to another tenant is worth exactly what an id that was never issued is worth,
 * whichever way it arrives, against a real Postgres.
 *
 * The existing isolation spec covers one read path with one foreign id. What it does not cover, and what this
 * does: EVERY entry point of the feature; an id supplied somewhere other than the path; an `orgId`/`tenantId`
 * in the body or an `x-org-id` header being ignored rather than honoured; and a signed URL never being minted
 * for an object key that belongs to the other tenant — the storage guard was pinned for an INVALID key, which
 * is a different thing from a well-formed key belonging to somebody else.
 *
 * The two tenants are seeded with IDENTICAL document titles and categories on purpose: a leak that copies by
 * name rather than by id would otherwise pass, and so would an assertion that only checks a result is non-empty.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --forceExit --testPathPattern=kb-linked-documents-cross-tenant
 */
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

// Identical in both tenants, so nothing below can pass by telling the two apart on their contents.
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
    // A's own entry, but the document points at an object key inside B's prefix. The row is authorised — it is
    // A's row — so only the storage guard stands between the caller and another tenant's bytes.
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
    // Each is a way an id reaches the feature. A publisher is used deliberately: the widest authority there is
    // inside A must still be worth nothing outside it.
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
      // Positive half: A's own id survives the same call, so the empty set above is not a dead code path.
      await expect(query.visibleIds(caller(a, "hr"), [mine.linkId])).resolves.toEqual(new Set([mine.linkId]));
    });

    it("an id carried in the QUERY — a cursor minted over B's entry — pages A's rows and never reaches B's", async () => {
      // A cursor is the one place a caller legitimately hands an id back in a query string. One built over B's
      // entry must page A's own rows from that position, not become a way to name a row in another tenant.
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
    /**
     * There is no code path that reads a tenant from a body or a header, and the way that is kept true is that
     * no schema has anywhere to put one: every boundary schema is `.strict()`, so `orgId`, `tenantId` or an id
     * of any kind in a body is a 400 and never a value the service sees. The header has no reader at all.
     */
    it.each([
      ["publish", publishLinkSchema],
      ["update", updateLinkSchema],
      ["unpublish", unpublishLinkSchema],
    ])("the %s body refuses orgId, tenantId and a smuggled documentId", (_name, spec) => {
      for (const smuggled of [{ orgId: "org-b" }, { tenantId: "org-b" }, { documentId: 1 }, { linkedDocumentId: 1 }, { "x-org-id": "org-b" }]) {
        expect(spec.safeParse({ ...smuggled }).success).toBe(false);
      }
      // Positive half: the legitimate body still parses, so the refusals above are not a schema that rejects everything.
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
      // The caller is assembled from the auth context alone. Spelling B's organisation anywhere else — here, the
      // nearest thing a service-level spec has to a header — cannot reach it.
      const spoofed = { ...caller(a, "hr"), ["x-org-id"]: b.orgId } as LinkedDocumentCaller;

      const ids = (await query.list(spoofed, { limit: 100 })).data.map((item) => item.id);

      expect(ids).toContain(mine.linkId);
      expect(ids).not.toContain(theirs.linkId);
    });
  });

  describe("no signed URL is ever issued for B's object key", () => {
    it("refuses a well-formed key that belongs to the other tenant, not just a malformed one", async () => {
      signed.mockClear();

      // A's own row, A's own authority — the only thing standing between the caller and B's bytes is the key check.
      await expect(files.open(caller(a, "hr"), foreignKeyed.linkId)).rejects.toBeInstanceOf(NotFoundException);
      expect(signed).not.toHaveBeenCalled();

      // Positive half: the same call over A's own key does mint one, so the refusal above is about the key.
      await expect(files.open(caller(a, "hr"), mine.linkId)).resolves.toMatchObject({ expiresIn: 300 });
      expect(signed).toHaveBeenCalledTimes(1);
      expect(signed.mock.calls[0]?.[0]).toBe(a.orgId);
    });
  });
});
