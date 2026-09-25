import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { KbLinkedDocumentQueryService, type LinkedDocumentCaller } from "./kb-linked-document-query.service";

const describeDb = dbSpecSuite();

describeDb("linked documents: what a reader can see — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-documents-read.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let service: KbLinkedDocumentQueryService;
  let deptOne: string;
  let deptTwo: string;
  let locationOne: string;

  const reader = (org: SeededOrg, name: string, canPublish = false): LinkedDocumentCaller => ({
    orgId: org.orgId,
    userId: member(org, name).id,
    canPublish,
  });

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "onedept", "twodept", "contractor", "exited"]);
    b = await seed.org("b", ["hr", "outsider"]);
    service = new KbLinkedDocumentQueryService(drizzle(sql, { schema }) as unknown as Db);

    deptOne = await unit(a, "DEPARTMENT");
    deptTwo = await unit(a, "DEPARTMENT");
    locationOne = await unit(a, "LOCATION");
    await employ(a, "onedept", "ACTIVE", deptOne, locationOne);
    await employ(a, "twodept", "PROBATION", deptTwo, null);
    await employ(a, "exited", "EXITED", deptOne, locationOne);
    await employ(b, "outsider", "ACTIVE", null, null);
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 120_000);

  async function unit(org: SeededOrg, kind: "DEPARTMENT" | "LOCATION"): Promise<string> {
    const id = randomUUID();
    await sql`insert into org_units (id, org_id, kind, name, code) values (${id}, ${org.orgId}, ${kind}, ${`${kind}-${id.slice(0, 6)}`}, ${id.slice(0, 8)})`;
    return id;
  }

  async function employ(org: SeededOrg, name: string, status: string, department: string | null, location: string | null): Promise<void> {
    const [person] = await sql`insert into hr_people (org_id, user_id) values (${org.orgId}, ${member(org, name).id}) returning id`;
    await sql`
      insert into hr_employments (org_id, person_id, employee_number, lifecycle_status, department_id, location_id)
      values (${org.orgId}, ${person?.id}, ${`E-${randomUUID().slice(0, 8)}`}, ${status}::hr_employment_lifecycle_status, ${department}, ${location})`;
  }

  type Audience = readonly [kind: string, ref: string | null];

  async function entry(
    org: SeededOrg,
    opts: {
      ceiling: readonly Audience[];
      link: readonly Audience[];
      classification?: string;
      fileUrl?: string;
      type?: string;
      publishedAt?: string;
    },
  ): Promise<{ documentId: number; linkId: number }> {
    const hr = member(org, "hr").id;
    const [doc] = await sql`
      insert into documents (org_id, uploaded_by, name, description, type, classification, file_url, file_name, category, tags)
      values (${org.orgId}, ${hr}, ${`doc-${randomUUID().slice(0, 8)}`}, 'desc', ${opts.type ?? "POLICY"}, ${opts.classification ?? "INTERNAL"},
              ${opts.fileUrl ?? `${org.orgId}/hr-documents/${randomUUID()}.pdf`}, 'file.pdf', 'Policies', ARRAY['a','b'])
      returning id`;
    const documentId = Number(doc?.id);
    for (const [kind, ref] of opts.ceiling)
      await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${org.orgId}, ${documentId}, ${kind}, ${ref})`;
    const [link] = await sql`
      insert into kb_linked_documents (org_id, document_id, published_at)
      values (${org.orgId}, ${documentId}, ${opts.publishedAt ?? new Date().toISOString()})
      returning id`;
    const linkId = Number(link?.id);
    for (const [kind, ref] of opts.link)
      await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind, ref_id) values (${org.orgId}, ${linkId}, ${kind}, ${ref})`;
    return { documentId, linkId };
  }

  const ids = async (caller: LinkedDocumentCaller): Promise<number[]> =>
    (await service.list(caller, { limit: 100 })).data.map((item) => item.id);

  describe("audience", () => {
    it("shows an entry only to people inside its audience, judged from live employment", async () => {
      const everyone = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });
      const deptOnly = await entry(a, { ceiling: [["DEPARTMENT", deptOne]], link: [["DEPARTMENT", deptOne]] });
      const locationOnly = await entry(a, { ceiling: [["LOCATION", locationOne]], link: [["LOCATION", locationOne]] });

      const one = await ids(reader(a, "onedept"));
      expect(one).toEqual(expect.arrayContaining([everyone.linkId, deptOnly.linkId, locationOnly.linkId]));

      const two = await ids(reader(a, "twodept"));
      expect(two).toContain(everyone.linkId);
      expect(two).not.toContain(deptOnly.linkId);
      expect(two).not.toContain(locationOnly.linkId);
    });

    it("shows nothing to a member with no employment, and nothing to an employee who has exited", async () => {
      const everyone = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });

      expect(await ids(reader(a, "contractor"))).not.toContain(everyone.linkId);
      expect(await ids(reader(a, "exited"))).not.toContain(everyone.linkId);
      expect(await ids(reader(a, "onedept"))).toContain(everyone.linkId);
    });

    it("hides an entry with no audience from everyone but a publisher, who sees it", async () => {
      const hrOnly = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [] });

      expect(await ids(reader(a, "onedept"))).not.toContain(hrOnly.linkId);
      expect(await ids(reader(a, "hr", true))).toContain(hrOnly.linkId);
    });

    it("stops honouring an entry audience the moment the document's own audiences no longer cover it", async () => {
      const narrowed = await entry(a, { ceiling: [["DEPARTMENT", deptOne]], link: [["DEPARTMENT", deptOne]] });
      expect(await ids(reader(a, "onedept"))).toContain(narrowed.linkId);

      await sql`delete from document_audiences where document_id = ${narrowed.documentId}`;
      await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${a.orgId}, ${narrowed.documentId}, 'DEPARTMENT', ${deptTwo})`;

      expect(await ids(reader(a, "onedept"))).not.toContain(narrowed.linkId);
      await expect(service.get(reader(a, "onedept"), narrowed.linkId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("the live guard", () => {
    it("takes an entry away from every reader, publishers included, when its document stops being publishable", async () => {
      const shown = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });
      expect(await ids(reader(a, "onedept"))).toContain(shown.linkId);

      await sql`update documents set classification = 'PERSONAL' where id = ${shown.documentId}`;

      expect(await ids(reader(a, "onedept"))).not.toContain(shown.linkId);
      expect(await ids(reader(a, "hr", true))).not.toContain(shown.linkId);
      await expect(service.get(reader(a, "onedept"), shown.linkId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("holds even if nothing took the entry down: the read path judges the document itself", async () => {
      const shown = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });
      await sql.begin(async (tx) => {
        await tx`alter table documents disable trigger trg_documents_unlink_when_unpublishable`;
        try {
          await tx`update documents set classification = 'PERSONAL' where id = ${shown.documentId}`;
        } finally {
          await tx`alter table documents enable trigger trg_documents_unlink_when_unpublishable`;
        }
      });
      const [still] = await sql`select status from kb_linked_documents where id = ${shown.linkId}`;
      expect(still?.status).toBe("active");

      expect(await ids(reader(a, "onedept"))).not.toContain(shown.linkId);
      expect(await ids(reader(a, "hr", true))).not.toContain(shown.linkId);
      await expect(service.get(reader(a, "hr", true), shown.linkId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("hides a removed document's entry, and lets a publisher list it as source removed", async () => {
      const removed = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });
      await sql`update documents set is_active = false where id = ${removed.documentId}`;

      expect(await ids(reader(a, "onedept"))).not.toContain(removed.linkId);
      const listed = await service.list(reader(a, "hr", true), { limit: 100, status: "source_removed" });
      expect(listed.data.map((item) => item.id)).toContain(removed.linkId);
      const refused = await service.list(reader(a, "onedept"), { limit: 100, status: "source_removed" });
      expect(refused.data).toEqual([]);
      expect(refused.pagination.hasMore).toBe(false);
    });
  });

  describe("tenants", () => {
    it("tenant isolation: another tenant's reader sees nothing, and a foreign id answers exactly as an unknown one", async () => {
      const mine = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });

      expect(await ids(reader(b, "outsider"))).not.toContain(mine.linkId);
      expect(await ids(reader(b, "hr", true))).not.toContain(mine.linkId);
      await expect(service.get(reader(b, "hr", true), mine.linkId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.get(reader(b, "hr", true), 2_000_000_000)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.resolveFile(reader(b, "hr", true), mine.linkId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("projection", () => {
    it("carries a small badge-ready projection and never the storage key, the metadata or the owner", async () => {
      const shown = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });

      const item = await service.get(reader(a, "onedept"), shown.linkId);

      expect(item).toMatchObject({ source: "HR_DOCUMENT", status: "active", hasFile: true, tags: ["a", "b"], audiences: null, newerVersionAvailable: null });
      expect(Object.keys(item).sort()).toEqual(
        [
          "audiences", "category", "description", "documentType", "effectiveDate", "fileName", "fileSize", "hasFile", "id", "mimeType",
          "name", "newerVersionAvailable", "pinnedVersion", "publishedAt", "source", "status", "tags", "unpublishReason", "version", "versionMode",
        ].sort(),
      );
    });

    it("tells a publisher how the entry is scoped, and nobody else", async () => {
      const shown = await entry(a, { ceiling: [["DEPARTMENT", deptOne]], link: [["DEPARTMENT", deptOne]] });

      const asPublisher = await service.get(reader(a, "hr", true), shown.linkId);
      const asReader = await service.get(reader(a, "onedept"), shown.linkId);

      expect(asPublisher.audiences?.map((audience) => [audience.kind, audience.refId])).toEqual([["DEPARTMENT", deptOne]]);
      expect(asReader.audiences).toBeNull();
    });

    it("has no file to open for an external link, and reads a pinned entry from its pinned version", async () => {
      const external = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]], fileUrl: "https://example.com/handbook.pdf" });
      expect((await service.get(reader(a, "onedept"), external.linkId)).hasFile).toBe(false);
      await expect(service.resolveFile(reader(a, "onedept"), external.linkId)).rejects.toBeInstanceOf(NotFoundException);

      const pinnedDoc = await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]] });
      const v1 = `${a.orgId}/hr-documents/v1-${randomUUID()}.pdf`;
      const v2 = `${a.orgId}/hr-documents/v2-${randomUUID()}.pdf`;
      await sql`insert into document_versions (org_id, document_id, version, file_url, file_name, status, approved_at) values (${a.orgId}, ${pinnedDoc.documentId}, 1, ${v1}, 'v1.pdf', 'approved', now())`;
      await sql`insert into document_versions (org_id, document_id, version, file_url, file_name, status, approved_at) values (${a.orgId}, ${pinnedDoc.documentId}, 2, ${v2}, 'v2.pdf', 'approved', now())`;
      await sql`update kb_linked_documents set version_mode = 'PINNED', pinned_version = 1 where id = ${pinnedDoc.linkId}`;

      expect((await service.resolveFile(reader(a, "onedept"), pinnedDoc.linkId)).fileKey).toBe(v1);
      const detail = await service.get(reader(a, "onedept"), pinnedDoc.linkId);
      expect(detail).toMatchObject({ version: 1, fileName: "v1.pdf", versionMode: "PINNED" });
      expect(detail.newerVersionAvailable).toBeNull();
      expect((await service.get(reader(a, "hr", true), pinnedDoc.linkId)).newerVersionAvailable).toBe(true);
    });
  });

  describe("paging", () => {
    it("walks a long list by cursor without repeating or skipping an entry", async () => {
      const created: number[] = [];
      const base = Date.now();
      for (let index = 0; index < 5; index += 1)
        created.push((await entry(a, { ceiling: [["ALL_EMPLOYEES", null]], link: [["ALL_EMPLOYEES", null]], publishedAt: new Date(base + index * 1000).toISOString() })).linkId);

      const seen: number[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await service.list(reader(a, "onedept"), { limit: 2, cursor });
        expect(page.data.length).toBeLessThanOrEqual(2);
        seen.push(...page.data.map((item) => item.id));
        if (!page.pagination.hasMore) break;
        cursor = page.pagination.nextCursor ?? undefined;
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining(created));
      expect(seen.filter((id) => created.includes(id))).toEqual([...created].reverse());
    });

    it("refuses a cursor it did not issue", async () => {
      await expect(service.list(reader(a, "onedept"), { limit: 5, cursor: "not-a-cursor" })).rejects.toMatchObject({ status: 400 });
    });
  });
});
