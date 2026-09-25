import { randomUUID } from "node:crypto";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import { KbHrLinkFlagsService } from "../core/kb-hr-link-flags.service";
import { KbLinkedDocumentPublishService, type PublishActor } from "./kb-linked-document-publish.service";
import { KbLinkedDocumentQueryService } from "./kb-linked-document-query.service";

const describeDb = dbSpecSuite();

describeDb("publishing a document to the knowledge base — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-document-publish.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let service: KbLinkedDocumentPublishService;
  let query: KbLinkedDocumentQueryService;
  let deptOne: string;
  let deptTwo: string;
  let locationOne: string;

  const actorOf = (org: SeededOrg): PublishActor => ({ userId: member(org, "hr").id, orgId: org.orgId, membershipId: member(org, "hr").membershipId });

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 6 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "onedept", "twodept"]);
    b = await seed.org("b", ["hr"]);
    const db = drizzle(sql, { schema }) as unknown as Db;
    const audit = new AuditService(db);
    const entitlements = { isModuleEnabled: jest.fn().mockResolvedValue(true) } as unknown as EntitlementsService;
    service = new KbLinkedDocumentPublishService(db, audit, new KbHrLinkFlagsService(db, entitlements, audit));
    query = new KbLinkedDocumentQueryService(db);
    deptOne = await unit(a, "DEPARTMENT");
    deptTwo = await unit(a, "DEPARTMENT");
    locationOne = await unit(a, "LOCATION");
    await employ(a, "onedept", deptOne);
    await employ(a, "twodept", deptTwo);
    await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${a.orgId}, true)`;
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

  async function employ(org: SeededOrg, name: string, department: string): Promise<void> {
    const [person] = await sql`insert into hr_people (org_id, user_id) values (${org.orgId}, ${member(org, name).id}) returning id`;
    await sql`insert into hr_employments (org_id, person_id, employee_number, department_id) values (${org.orgId}, ${person?.id}, ${`E-${randomUUID().slice(0, 8)}`}, ${department})`;
  }

  type Audience = readonly [kind: string, ref: string | null];

  async function doc(
    org: SeededOrg,
    over: Partial<{ type: string; classification: string; owner: string | null; isActive: boolean; metadata: string | null; ceiling: readonly Audience[] }> = {},
  ): Promise<number> {
    const o = { type: "POLICY", classification: "INTERNAL", owner: null, isActive: true, metadata: null, ceiling: [["ALL_EMPLOYEES", null]] as readonly Audience[], ...over };
    const [row] = await sql`
      insert into documents (org_id, user_id, uploaded_by, name, type, classification, is_active, metadata, file_url)
      values (${org.orgId}, ${o.owner}, ${member(org, "hr").id}, ${`doc-${randomUUID().slice(0, 8)}`}, ${o.type}, ${o.classification}, ${o.isActive},
              ${o.metadata}::text::jsonb, ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`})
      returning id`;
    const documentId = Number(row?.id);
    for (const [kind, ref] of o.ceiling)
      await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${org.orgId}, ${documentId}, ${kind}, ${ref})`;
    return documentId;
  }

  async function refusal(work: Promise<unknown>): Promise<HttpException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof HttpException) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  const codeOf = (error: HttpException): string | undefined => {
    const body = error.getResponse();
    return typeof body === "object" && "code" in body ? String(body.code) : undefined;
  };

  async function auditRows(org: SeededOrg, action: string, documentId: number) {
    return sql`select metadata from audit_logs where org_id = ${org.orgId} and action = ${action} and target_id = ${String(documentId)} order by id`;
  }

  async function linkRows(documentId: number): Promise<number> {
    const [row] = await sql`select count(*)::int as total from kb_linked_documents where document_id = ${documentId}`;
    return Number(row?.total);
  }

  describe("the switch", () => {
    it("answers 404 while hrms.kb.link is off, and writes nothing", async () => {
      const documentId = await doc(b);

      await expect(service.getState(b.orgId, documentId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.publish(actorOf(b), documentId, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updateLink(actorOf(b), documentId, { audiences: [] })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.unpublish(actorOf(b), documentId)).rejects.toBeInstanceOf(NotFoundException);
      expect(await linkRows(documentId)).toBe(0);
    });
  });

  describe("publishing", () => {
    it("publishes a company policy for the audience the document is for, audits it, and readers can then see it", async () => {
      const documentId = await doc(a, { ceiling: [["DEPARTMENT", deptOne]] });

      const state = await service.publish(actorOf(a), documentId, {});

      expect(state.link).toMatchObject({ status: "active", versionMode: "FOLLOW_LATEST", pinnedVersion: null });
      expect(state.link?.audiences.map((audience) => [audience.kind, audience.refId])).toEqual([["DEPARTMENT", deptOne]]);
      const [row] = await auditRows(a, "hr.document.kb_published", documentId);
      expect(row?.metadata).toMatchObject({ linkId: state.link?.id, reactivated: false, versionMode: "FOLLOW_LATEST" });

      const viaQuery = async (name: string) => (await query.list({ orgId: a.orgId, userId: member(a, name).id, canPublish: false }, { limit: 100 })).data.map((item) => item.id);
      expect(await viaQuery("onedept")).toContain(state.link?.id);
      expect(await viaQuery("twodept")).not.toContain(state.link?.id);
    });

    it.each([
      ["a payslip", { type: "PAYSLIP" }, "TYPE_NOT_ALLOWED"],
      ["a policy owned by an employee", { owner: "employee" }, "BELONGS_TO_AN_EMPLOYEE"],
      ["a policy from the recruitment hand-off", { metadata: '{"offerId": 9}' }, "HIRING_ARTEFACT"],
      ["a removed document", { isActive: false }, "DOCUMENT_INACTIVE"],
      ["a personal document", { classification: "PERSONAL" }, "CLASSIFICATION_NOT_SHAREABLE"],
      ["a confidential document", { classification: "CONFIDENTIAL" }, "CLASSIFICATION_NOT_SHAREABLE"],
    ])("cannot publish %s, whatever the request says: 422, audited, and no entry exists", async (_label, over, expected) => {
      const { owner, ...rest } = over as { owner?: string; type?: string; metadata?: string; isActive?: boolean; classification?: string };
      const documentId = await doc(a, { ...rest, owner: owner === "employee" ? member(a, "onedept").id : null });

      const error = await refusal(service.publish(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }] }));

      expect(error.getStatus()).toBe(422);
      expect(codeOf(error)).toBe("DOCUMENT_NOT_PUBLISHABLE");
      expect(JSON.stringify(error.getResponse())).toContain(expected);
      expect(await linkRows(documentId)).toBe(0);
      const refused = await auditRows(a, "kb.hr_link.publish_refused", documentId);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.metadata).toMatchObject({ attempted: "publish", reason: "DOCUMENT_NOT_PUBLISHABLE", result: "FAILURE" });
    });

    it("answers 409 for a document that is already in the knowledge base, even when two publishes race", async () => {
      const documentId = await doc(a);

      const results = await Promise.allSettled([service.publish(actorOf(a), documentId, {}), service.publish(actorOf(a), documentId, {})]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ConflictException);
      expect(await linkRows(documentId)).toBe(1);
    });

    it("lets HR publish for nobody yet (HR only), which readers cannot see", async () => {
      const documentId = await doc(a);

      const state = await service.publish(actorOf(a), documentId, { audiences: [] });

      expect(state.link?.audiences).toEqual([]);
      const seen = await query.list({ orgId: a.orgId, userId: member(a, "onedept").id, canPublish: false }, { limit: 100 });
      expect(seen.data.map((item) => item.id)).not.toContain(state.link?.id);
    });
  });

  describe("the ceiling", () => {
    it.each([
      ["all employees under a department document", [["DEPARTMENT", "one"]] as const, [{ kind: "ALL_EMPLOYEES" as const }]],
      ["another department", [["DEPARTMENT", "one"]] as const, [{ kind: "DEPARTMENT" as const, refId: "two" }]],
      ["a location under a department document", [["DEPARTMENT", "one"]] as const, [{ kind: "LOCATION" as const, refId: "loc" }]],
      ["anyone under a document that is HR only", [] as const, [{ kind: "ALL_EMPLOYEES" as const }]],
    ])("refuses %s: the entry cannot show it to more people than the document is for", async (_label, ceilingSpec, requested) => {
      const resolve = (ref: string | null) => (ref === "one" ? deptOne : ref === "two" ? deptTwo : ref === "loc" ? locationOne : ref);
      const documentId = await doc(a, { ceiling: ceilingSpec.map(([kind, ref]) => [kind, resolve(ref)] as const) });

      const error = await refusal(service.publish(actorOf(a), documentId, { audiences: requested.map((entry) => ({ kind: entry.kind, refId: "refId" in entry ? resolve(entry.refId) : null })) }));

      expect(error.getStatus()).toBe(422);
      expect(codeOf(error)).toBe("AUDIENCE_EXCEEDS_DOCUMENT");
      expect(await linkRows(documentId)).toBe(0);
      expect(await auditRows(a, "kb.hr_link.publish_refused", documentId)).toHaveLength(1);
    });

    it("accepts a narrower audience: any unit under all employees, and the same unit under itself", async () => {
      const wide = await doc(a, { ceiling: [["ALL_EMPLOYEES", null]] });
      const narrow = await doc(a, { ceiling: [["DEPARTMENT", deptOne]] });

      const first = await service.publish(actorOf(a), wide, { audiences: [{ kind: "DEPARTMENT", refId: deptTwo }, { kind: "LOCATION", refId: locationOne }] });
      const second = await service.publish(actorOf(a), narrow, { audiences: [{ kind: "DEPARTMENT", refId: deptOne }] });

      expect(first.link?.audiences).toHaveLength(2);
      expect(second.link?.audiences).toHaveLength(1);
    });

    it("refuses a department that does not exist or belongs to another tenant, with the same answer", async () => {
      const documentId = await doc(a);
      const foreign = await unit(b, "DEPARTMENT");

      for (const refId of [randomUUID(), foreign]) {
        const error = await refusal(service.publish(actorOf(a), documentId, { audiences: [{ kind: "DEPARTMENT", refId }] }));
        expect(codeOf(error)).toBe("AUDIENCE_TARGET_NOT_FOUND");
      }
      expect(await linkRows(documentId)).toBe(0);
    });
  });

  describe("withdrawing and bringing back", () => {
    it("withdraws an entry, hides it from readers, and brings the same entry back with its id and a fresh audience", async () => {
      const documentId = await doc(a, { ceiling: [["ALL_EMPLOYEES", null]] });
      const published = await service.publish(actorOf(a), documentId, { audiences: [{ kind: "DEPARTMENT", refId: deptOne }] });
      const linkId = published.link?.id;

      const withdrawn = await service.unpublish(actorOf(a), documentId);
      expect(withdrawn.link).toMatchObject({ id: linkId, status: "unpublished", unpublishReason: "manual" });
      const asReader = { orgId: a.orgId, userId: member(a, "onedept").id, canPublish: false };
      expect((await query.list(asReader, { limit: 100 })).data.map((item) => item.id)).not.toContain(linkId);
      expect((await auditRows(a, "hr.document.kb_unpublished", documentId))).toHaveLength(1);

      const again = await refusal(service.unpublish(actorOf(a), documentId));
      expect(again).toBeInstanceOf(NotFoundException);

      const back = await service.publish(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }] });
      expect(back.link).toMatchObject({ id: linkId, status: "active", unpublishReason: null });
      expect(back.link?.audiences.map((audience) => audience.kind)).toEqual(["ALL_EMPLOYEES"]);
      expect(await linkRows(documentId)).toBe(1);
      const [row] = (await auditRows(a, "hr.document.kb_published", documentId)).slice(-1);
      expect(row?.metadata).toMatchObject({ reactivated: true });
    });

    it("records the reason a person gives for withdrawing, on the entry and in the audit row, with who did it and when", async () => {
      const documentId = await doc(a);
      const published = await service.publish(actorOf(a), documentId, {});

      const withdrawn = await service.unpublish(actorOf(a), documentId, { reason: "Superseded by the 2026 handbook" });

      expect(withdrawn.link).toMatchObject({ id: published.link?.id, status: "unpublished", unpublishReason: "Superseded by the 2026 handbook" });
      const [row] = await sql`
        select user_id, created_at, metadata from audit_logs
        where org_id = ${a.orgId} and action = 'hr.document.kb_unpublished' and target_id = ${String(documentId)}`;
      expect(row?.user_id).toBe(member(a, "hr").id);
      expect(String(row?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(row?.metadata).toMatchObject({ linkId: published.link?.id, reason: "Superseded by the 2026 handbook", reasonGiven: true });
    });

    it("says in the audit row that no reason was given, rather than passing a default off as one", async () => {
      const documentId = await doc(a);
      await service.publish(actorOf(a), documentId, {});

      await service.unpublish(actorOf(a), documentId);

      const [row] = await auditRows(a, "hr.document.kb_unpublished", documentId);
      expect(row?.metadata).toMatchObject({ reason: "manual", reasonGiven: false });
    });

    it("hides the entry from readers whatever reason is given, and keeps the reason from the readers", async () => {
      const documentId = await doc(a);
      const published = await service.publish(actorOf(a), documentId, {});
      const linkId = published.link?.id ?? -1;
      await service.unpublish(actorOf(a), documentId, { reason: "Contains an outdated salary table" });

      const asReader = { orgId: a.orgId, userId: member(a, "onedept").id, canPublish: false };
      expect((await query.list(asReader, { limit: 100 })).data.map((item) => item.id)).not.toContain(linkId);
      await expect(query.get(asReader, linkId)).rejects.toBeInstanceOf(NotFoundException);
      const asPublisher = await query.get({ orgId: a.orgId, userId: member(a, "hr").id, canPublish: true }, linkId);
      expect(asPublisher.unpublishReason).toBe("Contains an outdated salary table");
    });

    it("shows a publisher that the document taking itself out of the shareable set also took the entry down, and says why", async () => {
      const documentId = await doc(a);
      const published = await service.publish(actorOf(a), documentId, {});
      await sql`update documents set classification = 'PERSONAL' where id = ${documentId}`;

      const state = await service.getState(a.orgId, documentId);

      expect(state.link).toMatchObject({ id: published.link?.id, status: "unpublished", unpublishReason: "source_no_longer_publishable" });
      expect(state.publishable).toBe(false);
      expect(state.blockers.map((blocker) => blocker.code)).toContain("CLASSIFICATION_NOT_SHAREABLE");
    });
  });

  describe("re-scoping", () => {
    it("narrows the audience within the ceiling, audits before and after, and refuses to widen", async () => {
      const documentId = await doc(a, { ceiling: [["DEPARTMENT", deptOne], ["DEPARTMENT", deptTwo]] });
      await service.publish(actorOf(a), documentId, {});

      const narrowed = await service.updateLink(actorOf(a), documentId, { audiences: [{ kind: "DEPARTMENT", refId: deptOne }] });
      expect(narrowed.link?.audiences.map((audience) => audience.refId)).toEqual([deptOne]);
      const [row] = await auditRows(a, "hr.document.kb_link_updated", documentId);
      expect(row?.metadata).toMatchObject({ before: { audiences: expect.any(Array) }, after: { audiences: [{ kind: "DEPARTMENT", refId: deptOne }] } });

      const error = await refusal(service.updateLink(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }] }));
      expect(codeOf(error)).toBe("AUDIENCE_EXCEEDS_DOCUMENT");
      expect((await service.getState(a.orgId, documentId)).link?.audiences.map((audience) => audience.refId)).toEqual([deptOne]);
    });

    it("pins to a version only when that version exists and is approved", async () => {
      const documentId = await doc(a);
      await service.publish(actorOf(a), documentId, {});

      const missing = await refusal(service.updateLink(actorOf(a), documentId, { versionMode: "PINNED", pinnedVersion: 3 }));
      expect(codeOf(missing)).toBe("PINNED_VERSION_NOT_FOUND");

      await sql`insert into document_versions (org_id, document_id, version, file_url, status, approved_at) values (${a.orgId}, ${documentId}, 1, ${`${a.orgId}/hr-documents/v1.pdf`}, 'approved', now())`;
      await sql`insert into document_versions (org_id, document_id, version, file_url, status) values (${a.orgId}, ${documentId}, 2, ${`${a.orgId}/hr-documents/v2.pdf`}, 'pending')`;
      const pending = await refusal(service.updateLink(actorOf(a), documentId, { versionMode: "PINNED", pinnedVersion: 2 }));
      expect(codeOf(pending)).toBe("PINNED_VERSION_NOT_FOUND");

      const pinned = await service.updateLink(actorOf(a), documentId, { versionMode: "PINNED", pinnedVersion: 1 });
      expect(pinned.link).toMatchObject({ versionMode: "PINNED", pinnedVersion: 1, newerVersionAvailable: false });
      await sql`update document_versions set status = 'approved', approved_at = now() where document_id = ${documentId} and version = 2`;
      expect((await service.getState(a.orgId, documentId)).link?.newerVersionAvailable).toBe(true);
    });

    it("refuses to follow the latest version of a document that has no approved version at all", async () => {
      const documentId = await doc(a);
      await sql`update documents set file_url = '' where id = ${documentId}`;
      await sql`insert into document_versions (org_id, document_id, version, file_url, status) values (${a.orgId}, ${documentId}, 1, ${`${a.orgId}/hr-documents/draft.pdf`}, 'pending')`;

      const refused = await refusal(service.publish(actorOf(a), documentId, {}));
      expect(codeOf(refused)).toBe("DOCUMENT_VERSION_NOT_APPROVED");
      expect(refused.getStatus()).toBe(422);
      expect((await service.getState(a.orgId, documentId)).link).toBeNull();

      await sql`update document_versions set status = 'approved', approved_at = now() where document_id = ${documentId} and version = 1`;
      expect((await service.publish(actorOf(a), documentId, {})).link).toMatchObject({ status: "active", versionMode: "FOLLOW_LATEST" });
    });

    it("lets a document with no version history at all follow the latest: its file IS the document", async () => {
      const documentId = await doc(a);

      expect((await service.publish(actorOf(a), documentId, {})).link).toMatchObject({ status: "active", versionMode: "FOLLOW_LATEST" });
    });

    it("answers 404 when there is no live entry to change", async () => {
      const documentId = await doc(a);

      await expect(service.updateLink(actorOf(a), documentId, { audiences: [] })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("tenants", () => {
    it("tenant isolation: another tenant cannot publish, read, change or withdraw this document", async () => {
      await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${b.orgId}, true) on conflict (org_id) do update set hrms_kb_link_enabled = true`;
      const mine = await doc(a);
      const published = await service.publish(actorOf(a), mine, {});

      await expect(service.getState(b.orgId, mine)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.publish(actorOf(b), mine, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updateLink(actorOf(b), mine, { audiences: [] })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.unpublish(actorOf(b), mine)).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.getState(a.orgId, mine)).link).toMatchObject({ id: published.link?.id, status: "active" });
      await sql`update kb_settings set hrms_kb_link_enabled = false where org_id = ${b.orgId}`;
    });
  });
});
