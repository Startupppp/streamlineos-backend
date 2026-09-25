/**
 * HRMS-KB PR 3 — classifying documents and setting their audiences, against a real Postgres.
 *
 * The service is the HR-side half of the link: it decides what a document IS. What these cases pin is the
 * boundary a personal file must never cross (a payslip, an employee's own contract, a hiring artefact cannot be
 * made shareable, by anyone), that the publish permission cannot be bypassed by classifying, and that changing
 * a document takes its knowledge-base entries down or narrows them in the same transaction.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=document-classification
 */
import { randomUUID } from "node:crypto";
import { HttpException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import { KbHrLinkFlagsService } from "../../kb/core/kb-hr-link-flags.service";
import { KbLinkedDocumentCeilingService } from "../../kb/linked-documents/kb-linked-document-ceiling.service";
import { DocumentClassificationService, type ClassificationActor } from "./document-classification.service";

const describeDb = dbSpecSuite();

describeDb("document classification and audiences — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "document-classification.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let service: DocumentClassificationService;
  let deptA: string;
  let locationA: string;
  let deptB: string;

  const actorOf = (org: SeededOrg): ClassificationActor => ({
    userId: member(org, "hr").id,
    orgId: org.orgId,
    membershipId: member(org, "hr").membershipId,
  });

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "employee"]);
    b = await seed.org("b", ["hr"]);

    const db = drizzle(sql, { schema }) as unknown as Db;
    const entitlements = { isModuleEnabled: jest.fn().mockResolvedValue(true) } as unknown as EntitlementsService;
    const audit = new AuditService(db);
    service = new DocumentClassificationService(
      db,
      audit,
      new KbHrLinkFlagsService(db, entitlements, audit),
      new KbLinkedDocumentCeilingService(),
    );

    deptA = await unit(a, "DEPARTMENT");
    locationA = await unit(a, "LOCATION");
    deptB = await unit(b, "DEPARTMENT");
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

  async function doc(
    org: SeededOrg,
    over: Partial<{
      type: string;
      classification: string;
      userId: string | null;
      isActive: boolean;
      metadata: string | null;
    }> = {},
  ): Promise<number> {
    const hr = member(org, "hr").id;
    const o = { type: "POLICY", classification: "PERSONAL", userId: null, isActive: true, metadata: null, ...over };
    const [row] = await sql`
      insert into documents (org_id, user_id, uploaded_by, name, type, classification, is_active, metadata, file_url)
      values (${org.orgId}, ${o.userId}, ${hr}, ${`doc-${randomUUID()}`}, ${o.type}, ${o.classification}, ${o.isActive},
              ${o.metadata}::text::jsonb, ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`})
      returning id`;
    return Number(row?.id);
  }

  async function link(org: SeededOrg, documentId: number): Promise<number> {
    const [row] = await sql`insert into kb_linked_documents (org_id, document_id) values (${org.orgId}, ${documentId}) returning id`;
    return Number(row?.id);
  }

  async function linkAudience(org: SeededOrg, linkId: number, kind: string, refId: string | null): Promise<void> {
    await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind, ref_id) values (${org.orgId}, ${linkId}, ${kind}, ${refId})`;
  }

  async function docAudience(org: SeededOrg, documentId: number, kind: string, refId: string | null): Promise<void> {
    await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${org.orgId}, ${documentId}, ${kind}, ${refId})`;
  }

  async function classificationOf(documentId: number): Promise<string> {
    const [row] = await sql`select classification from documents where id = ${documentId}`;
    return String(row?.classification);
  }

  async function auditRows(org: SeededOrg, action: string) {
    return sql`select target_id, metadata from audit_logs where org_id = ${org.orgId} and action = ${action} order by id`;
  }

  async function refusal(work: Promise<unknown>): Promise<HttpException> {
    try {
      await work;
    } catch (error) {
      if (error instanceof HttpException) return error;
      throw error;
    }
    throw new Error("expected the service to refuse this");
  }

  const bodyOf = (error: HttpException): { code?: string; details?: { blockers?: Array<{ code: string }> } } => {
    const body = error.getResponse();
    return typeof body === "object" ? body : {};
  };

  describe("the switch", () => {
    it("answers 404 for every route while hrms.kb.link is off, so the feature is not there to find", async () => {
      const documentId = await doc(b);

      await expect(service.get(b.orgId, documentId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.classify(actorOf(b), documentId, { classification: "INTERNAL" }, true)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.setAudiences(actorOf(b), documentId, { audiences: [] })).rejects.toBeInstanceOf(NotFoundException);
      expect(await classificationOf(documentId)).toBe("PERSONAL");
    });
  });

  describe("classifying", () => {
    it("makes a company policy Internal for a publisher, and audits the before and after", async () => {
      const documentId = await doc(a);

      const result = await service.classify(actorOf(a), documentId, { classification: "INTERNAL" }, true);

      expect(result).toMatchObject({ documentId, classification: "INTERNAL", publishable: true, blockers: [], linksTakenDown: 0 });
      expect(await classificationOf(documentId)).toBe("INTERNAL");
      const [row] = await auditRows(a, "hr.document.classified");
      expect(row).toMatchObject({
        target_id: String(documentId),
        metadata: { before: { classification: "PERSONAL" }, after: { classification: "INTERNAL" } },
      });
    });

    it("refuses to make a document shareable for someone without the publish permission, and says so in the audit log", async () => {
      const documentId = await doc(a);

      const error = await refusal(service.classify(actorOf(a), documentId, { classification: "INTERNAL" }, false));

      expect(error.getStatus()).toBe(403);
      expect(bodyOf(error).code).toBe("PUBLISH_PERMISSION_REQUIRED");
      expect(await classificationOf(documentId)).toBe("PERSONAL");
      const refused = (await auditRows(a, "hr.document.classification_refused")).filter((row) => row.target_id === String(documentId));
      expect(refused).toHaveLength(1);
      expect(refused[0]?.metadata).toMatchObject({ result: "FAILURE", requested: "INTERNAL", reason: "PUBLISH_PERMISSION_REQUIRED" });
    });

    it.each([
      ["a payslip", { type: "PAYSLIP" }, "TYPE_NOT_ALLOWED"],
      ["an offer letter", { type: "OFFER_LETTER" }, "TYPE_NOT_ALLOWED"],
      ["an id proof", { type: "ID_PROOF" }, "TYPE_NOT_ALLOWED"],
      ["a policy that belongs to an employee", { type: "POLICY", owner: true }, "BELONGS_TO_AN_EMPLOYEE"],
      ["a policy the recruitment hand-off created", { type: "POLICY", metadata: '{"candidateId": 42}' }, "HIRING_ARTEFACT"],
      ["a document that was removed", { type: "POLICY", isActive: false }, "DOCUMENT_INACTIVE"],
    ])("cannot make %s Internal or Restricted, even for a publisher, and the row is untouched", async (_label, spec, expected) => {
      const { owner, ...rest } = spec as { type: string; owner?: boolean; metadata?: string; isActive?: boolean };
      const documentId = await doc(a, { ...rest, userId: owner ? member(a, "employee").id : null });

      for (const target of ["INTERNAL", "RESTRICTED"] as const) {
        const error = await refusal(service.classify(actorOf(a), documentId, { classification: target }, true));
        expect(error.getStatus()).toBe(422);
        expect(bodyOf(error).code).toBe("DOCUMENT_NOT_PUBLISHABLE");
        expect(bodyOf(error).details?.blockers?.map((blocker) => blocker.code)).toContain(expected);
      }
      expect(await classificationOf(documentId)).toBe("PERSONAL");
      const refused = (await auditRows(a, "hr.document.classification_refused")).filter((row) => row.target_id === String(documentId));
      expect(refused).toHaveLength(2);
    });

    it("lets anyone who can manage documents move one OUT of the shareable set, including a payslip, without the publish permission", async () => {
      const documentId = await doc(a, { type: "PAYSLIP" });

      const result = await service.classify(actorOf(a), documentId, { classification: "CONFIDENTIAL" }, false);

      expect(result).toMatchObject({ classification: "CONFIDENTIAL", publishable: false });
      expect(result.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["CLASSIFICATION_NOT_SHAREABLE", "TYPE_NOT_ALLOWED"]));
    });

    it("needs the publish permission to move between Internal and Restricted, but not to change only the effective date", async () => {
      const documentId = await doc(a, { classification: "INTERNAL" });

      expect((await refusal(service.classify(actorOf(a), documentId, { classification: "RESTRICTED" }, false))).getStatus()).toBe(403);
      const dated = await service.classify(actorOf(a), documentId, { classification: "INTERNAL", effectiveDate: "2026-01-15" }, false);
      expect(dated).toMatchObject({ classification: "INTERNAL", effectiveDate: "2026-01-15" });
      const cleared = await service.classify(actorOf(a), documentId, { classification: "INTERNAL", effectiveDate: null }, false);
      expect(cleared.effectiveDate).toBeNull();
    });

    it("writes nothing and audits nothing when the request changes nothing", async () => {
      const documentId = await doc(a, { classification: "INTERNAL" });
      const before = (await auditRows(a, "hr.document.classified")).filter((row) => row.target_id === String(documentId));

      const result = await service.classify(actorOf(a), documentId, { classification: "INTERNAL" }, true);

      expect(result.classification).toBe("INTERNAL");
      expect((await auditRows(a, "hr.document.classified")).filter((row) => row.target_id === String(documentId))).toHaveLength(before.length);
    });

    it("takes the knowledge-base entry down and forgets the audience when a document leaves the shareable set", async () => {
      const documentId = await doc(a, { classification: "INTERNAL" });
      await docAudience(a, documentId, "DEPARTMENT", deptA);
      const linkId = await link(a, documentId);
      await linkAudience(a, linkId, "DEPARTMENT", deptA);

      const result = await service.classify(actorOf(a), documentId, { classification: "PERSONAL" }, false);

      expect(result).toMatchObject({ classification: "PERSONAL", linksTakenDown: 1, audiences: [] });
      const [entry] = await sql`select status, unpublished_at from kb_linked_documents where id = ${linkId}`;
      expect(entry?.status).toBe("unpublished");
      expect(entry?.unpublished_at).not.toBeNull();
      const [{ remaining }] = await sql`select count(*)::int as remaining from document_audiences where document_id = ${documentId}`;
      expect(remaining).toBe(0);
      const [row] = (await auditRows(a, "hr.document.classified")).filter((r) => r.target_id === String(documentId));
      expect(row?.metadata).toMatchObject({ linksTakenDown: 1, audiencesCleared: 1 });
    });

    it("tenant isolation: a document from another tenant cannot be read or changed, and answers as one that does not exist", async () => {
      await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${b.orgId}, true) on conflict (org_id) do update set hrms_kb_link_enabled = true`;
      const inA = await doc(a);

      await expect(service.get(b.orgId, inA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.classify(actorOf(b), inA, { classification: "INTERNAL" }, true)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.setAudiences(actorOf(b), inA, { audiences: [] })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.get(b.orgId, 2_000_000_000)).rejects.toBeInstanceOf(NotFoundException);
      expect(await classificationOf(inA)).toBe("PERSONAL");
      await sql`update kb_settings set hrms_kb_link_enabled = false where org_id = ${b.orgId}`;
    });
  });

  describe("audiences", () => {
    it("replaces the whole set, de-duplicates it, names each unit, and is a no-op the second time", async () => {
      const documentId = await doc(a, { classification: "INTERNAL" });

      const first = await service.setAudiences(actorOf(a), documentId, {
        audiences: [
          { kind: "DEPARTMENT", refId: deptA },
          { kind: "DEPARTMENT", refId: deptA },
          { kind: "LOCATION", refId: locationA },
        ],
      });
      expect(first.audiences.map((audience) => [audience.kind, audience.refId])).toEqual([
        ["DEPARTMENT", deptA],
        ["LOCATION", locationA],
      ]);
      expect(first.audiences.every((audience) => (audience.label ?? "").length > 0)).toBe(true);

      const rowsAfterFirst = (await auditRows(a, "hr.document.audience_changed")).filter((row) => row.target_id === String(documentId));
      await service.setAudiences(actorOf(a), documentId, { audiences: [{ kind: "LOCATION", refId: locationA }, { kind: "DEPARTMENT", refId: deptA }] });
      expect((await auditRows(a, "hr.document.audience_changed")).filter((row) => row.target_id === String(documentId))).toHaveLength(rowsAfterFirst.length);

      const swapped = await service.setAudiences(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }] });
      expect(swapped.audiences.map((audience) => audience.kind)).toEqual(["ALL_EMPLOYEES"]);
      const swap = (await auditRows(a, "hr.document.audience_changed")).filter((row) => row.target_id === String(documentId)).at(-1);
      expect(swap?.metadata).toMatchObject({ after: { audiences: [{ kind: "ALL_EMPLOYEES", refId: null }] } });
    });

    it("will not give a document that cannot be shared an audience, but does let its audience be emptied", async () => {
      const documentId = await doc(a, { classification: "PERSONAL" });

      const error = await refusal(service.setAudiences(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }] }));
      expect(error.getStatus()).toBe(422);
      expect(bodyOf(error).code).toBe("DOCUMENT_NOT_PUBLISHABLE");

      await expect(service.setAudiences(actorOf(a), documentId, { audiences: [] })).resolves.toMatchObject({ audiences: [] });
    });

    it.each([
      ["a department that does not exist", () => ({ kind: "DEPARTMENT" as const, refId: randomUUID() })],
      ["a department that belongs to another tenant", () => ({ kind: "DEPARTMENT" as const, refId: deptB })],
      ["a location named as a department", () => ({ kind: "DEPARTMENT" as const, refId: locationA })],
      ["a department named as a location", () => ({ kind: "LOCATION" as const, refId: deptA })],
    ])("refuses %s, and cannot tell those apart", async (_label, entry) => {
      const documentId = await doc(a, { classification: "INTERNAL" });

      const error = await refusal(service.setAudiences(actorOf(a), documentId, { audiences: [entry()] }));

      expect(error.getStatus()).toBe(422);
      expect(bodyOf(error).code).toBe("AUDIENCE_TARGET_NOT_FOUND");
      const [{ total }] = await sql`select count(*)::int as total from document_audiences where document_id = ${documentId}`;
      expect(total).toBe(0);
    });

    it("narrows a knowledge-base entry's audience in the same call when the document's ceiling shrinks", async () => {
      const documentId = await doc(a, { classification: "INTERNAL" });
      await service.setAudiences(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }] });
      const linkId = await link(a, documentId);
      await linkAudience(a, linkId, "DEPARTMENT", deptA);
      await linkAudience(a, linkId, "LOCATION", locationA);
      const remaining = async () =>
        (await sql`select kind, ref_id from kb_linked_document_audiences where linked_document_id = ${linkId} order by kind`).map((row) => [row.kind, row.ref_id]);

      // Any single audience is inside "all employees", so nothing is removed.
      expect((await service.setAudiences(actorOf(a), documentId, { audiences: [{ kind: "ALL_EMPLOYEES" }, { kind: "DEPARTMENT", refId: deptA }] })).linkAudiencesNarrowed).toBe(0);
      expect(await remaining()).toEqual([["DEPARTMENT", deptA], ["LOCATION", locationA]]);

      // Only the department is left in the ceiling, so the location leaves the entry.
      const narrowed = await service.setAudiences(actorOf(a), documentId, { audiences: [{ kind: "DEPARTMENT", refId: deptA }] });
      expect(narrowed.linkAudiencesNarrowed).toBe(1);
      expect(await remaining()).toEqual([["DEPARTMENT", deptA]]);

      // Empty ceiling: HR only, and the entry keeps no audience at all.
      const emptied = await service.setAudiences(actorOf(a), documentId, { audiences: [] });
      expect(emptied.linkAudiencesNarrowed).toBe(1);
      expect(await remaining()).toEqual([]);
      const [entry] = await sql`select status from kb_linked_documents where id = ${linkId}`;
      expect(entry?.status).toBe("active");
    });

    it("does not narrow another tenant's or another document's entries", async () => {
      const target = await doc(a, { classification: "INTERNAL" });
      const bystander = await doc(a, { classification: "INTERNAL" });
      await docAudience(a, bystander, "DEPARTMENT", deptA);
      const bystanderLink = await link(a, bystander);
      await linkAudience(a, bystanderLink, "DEPARTMENT", deptA);
      await service.setAudiences(actorOf(a), target, { audiences: [{ kind: "ALL_EMPLOYEES" }] });

      await service.setAudiences(actorOf(a), target, { audiences: [] });

      const [{ kept }] = await sql`select count(*)::int as kept from kb_linked_document_audiences where linked_document_id = ${bystanderLink}`;
      expect(kept).toBe(1);
    });
  });

  describe("reading", () => {
    it("reports why a document cannot be shared, in the order a person should fix it", async () => {
      const documentId = await doc(a, { type: "CONTRACT", userId: member(a, "employee").id });

      const view = await service.get(a.orgId, documentId);

      expect(view.publishable).toBe(false);
      expect(view.blockers.map((blocker) => blocker.code)).toEqual(["CLASSIFICATION_NOT_SHAREABLE", "TYPE_NOT_ALLOWED", "BELONGS_TO_AN_EMPLOYEE"]);
    });
  });
});
