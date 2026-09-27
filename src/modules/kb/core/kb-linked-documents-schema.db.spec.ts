import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbHrLinkFlagsService } from "./kb-hr-link-flags.service";

const describeDb = dbSpecSuite();

describeDb("linked documents: schema, guard and tenant isolation — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "kb-linked-documents-schema.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    const [grants] = await sql`select has_table_privilege('streamline_app', 'documents', 'SELECT') and has_table_privilege('streamline_app', 'kb_settings', 'SELECT') as ok`;
    if (!grants?.ok)
      throw new Error("streamline_app lacks table grants on this database: run pnpm db:bootstrap-role against it (or GRANT SELECT, INSERT, UPDATE, DELETE on the public tables) before this spec.");
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "employee"]);
    b = await seed.org("b", ["hr"]);
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  }, 120_000);

  async function doc(
    org: SeededOrg,
    over: Partial<{
      type: string;
      classification: string;
      userId: string | null;
      uploadedBy: string | null;
      isActive: boolean;
      metadata: string | null;
    }> = {},
  ): Promise<number> {
    const hr = member(org, "hr").id;
    const o = { type: "POLICY", classification: "INTERNAL", userId: null, uploadedBy: hr, isActive: true, metadata: null, ...over };
    const [row] = await sql`
      insert into documents (org_id, user_id, uploaded_by, name, type, classification, is_active, metadata, file_url)
      values (${org.orgId}, ${o.userId}, ${o.uploadedBy}, ${`doc-${randomUUID()}`}, ${o.type}, ${o.classification}, ${o.isActive},
              ${o.metadata}::text::jsonb, ${`${org.orgId}/hr-documents/${randomUUID()}.pdf`})
      returning id`;
    return Number(row?.id);
  }

  async function link(org: SeededOrg, documentId: number, over: { status?: string; extra?: string } = {}): Promise<number> {
    const status = over.status ?? "active";
    const [row] = await sql`
      insert into kb_linked_documents (org_id, document_id, status, unpublished_at)
      values (${org.orgId}, ${documentId}, ${status}, ${status === "active" ? null : sql`now()`})
      returning id`;
    return Number(row?.id);
  }

  async function statusOf(linkId: number): Promise<{ status: string; document_id: number | null; reason: string | null; removed: Date | null }> {
    const [row] = await sql`select status, document_id, unpublish_reason as reason, source_removed_at as removed from kb_linked_documents where id = ${linkId}`;
    return row as never;
  }

  async function violation(work: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
      await work;
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: String(e.code), message: String(e.message) };
    }
    throw new Error("expected the database to refuse this");
  }

  async function auditRows(org: SeededOrg, action: string) {
    return sql`select target_id, metadata from audit_logs where org_id = ${org.orgId} and action = ${action} order by id`;
  }

  describe("constraints", () => {
    it("kb_settings switches default to off and cannot be set out of order", async () => {
      const [row] = await sql`insert into kb_settings (org_id) values (${a.orgId}) returning hrms_kb_link_enabled l, hrms_kb_search_enabled s, hrms_kb_ai_enabled i`;
      expect(row).toEqual({ l: false, s: false, i: false });

      expect((await violation(sql`update kb_settings set hrms_kb_search_enabled = true where org_id = ${a.orgId}`)).code).toBe("23514");
      expect((await violation(sql`update kb_settings set hrms_kb_link_enabled = true, hrms_kb_ai_enabled = true where org_id = ${a.orgId}`)).code).toBe("23514");
      await sql`update kb_settings set hrms_kb_link_enabled = true, hrms_kb_search_enabled = true where org_id = ${a.orgId}`;
    });

    it("an audience names nobody for ALL_EMPLOYEES and somebody for the other kinds, once", async () => {
      const documentId = await doc(a);
      expect((await violation(sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${a.orgId}, ${documentId}, 'ALL_EMPLOYEES', 'x')`)).code).toBe("23514");
      expect((await violation(sql`insert into document_audiences (org_id, document_id, kind) values (${a.orgId}, ${documentId}, 'DEPARTMENT')`)).code).toBe("23514");
      expect((await violation(sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${a.orgId}, ${documentId}, 'TEAM', 'x')`)).code).toBe("23514");

      await sql`insert into document_audiences (org_id, document_id, kind) values (${a.orgId}, ${documentId}, 'ALL_EMPLOYEES')`;
      await sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${a.orgId}, ${documentId}, 'DEPARTMENT', 'dept-1')`;
      expect((await violation(sql`insert into document_audiences (org_id, document_id, kind) values (${a.orgId}, ${documentId}, 'ALL_EMPLOYEES')`)).code).toBe("23505");
      expect((await violation(sql`insert into document_audiences (org_id, document_id, kind, ref_id) values (${a.orgId}, ${documentId}, 'DEPARTMENT', 'dept-1')`)).code).toBe("23505");
    });

    it("a version number is unique per document and an approved version is stamped", async () => {
      const documentId = await doc(a);
      await sql`insert into document_versions (org_id, document_id, version, file_url) values (${a.orgId}, ${documentId}, 2, 'k/2.pdf')`;
      expect((await violation(sql`insert into document_versions (org_id, document_id, version, file_url) values (${a.orgId}, ${documentId}, 2, 'k/2b.pdf')`)).code).toBe("23505");
      expect((await violation(sql`insert into document_versions (org_id, document_id, version, file_url, status) values (${a.orgId}, ${documentId}, 3, 'k/3.pdf', 'approved')`)).code).toBe("23514");
      expect((await violation(sql`insert into document_versions (org_id, document_id, version, file_url) values (${a.orgId}, ${documentId}, 0, 'k/0.pdf')`)).code).toBe("23514");
    });

    it("a link's pin, status stamps and uniqueness are enforced", async () => {
      const documentId = await doc(a);
      expect((await violation(sql`insert into kb_linked_documents (org_id, document_id, version_mode) values (${a.orgId}, ${documentId}, 'PINNED')`)).code).toBe("23514");
      expect((await violation(sql`insert into kb_linked_documents (org_id, document_id, pinned_version) values (${a.orgId}, ${documentId}, 2)`)).code).toBe("23514");
      expect((await violation(sql`insert into kb_linked_documents (org_id, document_id, status) values (${a.orgId}, ${documentId}, 'unpublished')`)).code).toBe("23514");
      expect((await violation(sql`insert into kb_linked_documents (org_id, document_id, status, unpublished_at) values (${a.orgId}, ${documentId}, 'source_removed', now())`)).code).toBe("23514");

      await link(a, documentId);
      expect((await violation(link(a, documentId))).code).toBe("23505");
    });

    it("admits a second unpublished link for a document that already has a live one, because the one-live-link unique index is partial and history must not count against it", async () => {
      const documentId = await doc(a);

      await link(a, documentId);
      expect((await violation(link(a, documentId))).code).toBe("23505");

      await expect(link(a, documentId, { status: "unpublished" })).resolves.toBeDefined();
    });

    it("a link cannot point at another organisation's document", async () => {
      const foreign = await doc(a);

      const error = await violation(sql`insert into kb_linked_documents (org_id, document_id, status, unpublished_at) values (${b.orgId}, ${foreign}, 'unpublished', now())`);

      expect(error.code).toBe("23503");
    });
  });

  describe("the guard on links", () => {
    it("refuses to link a document that has not been classified, whoever asks", async () => {
      const documentId = await doc(a, { classification: "PERSONAL" });

      const error = await violation(link(a, documentId));

      expect(error.code).toBe("23514");
      expect(error.message).toContain("DOCUMENT_NOT_PUBLISHABLE");
    });

    it.each([
      ["CONFIDENTIAL", { classification: "CONFIDENTIAL" }],
      ["a payslip", { type: "PAYSLIP" }],
      ["an ID proof", { type: "ID_PROOF" }],
      ["a document owned by an employee", { userId: "OWNER" }],
      ["an inactive document", { isActive: false }],
      ["a hiring artefact", { metadata: JSON.stringify({ candidateId: 4 }) }],
    ])("refuses to link %s", async (_label, over) => {
      const employee = member(a, "employee").id;
      const documentId = await doc(a, { ...over, userId: (over as { userId?: string }).userId === "OWNER" ? employee : null });

      expect((await violation(link(a, documentId))).message).toContain("DOCUMENT_NOT_PUBLISHABLE");
    });

    it.each(["INTERNAL", "RESTRICTED"])("links a %s company document", async (classification) => {
      const documentId = await doc(a, { classification });

      await expect(link(a, documentId)).resolves.toBeGreaterThan(0);
    });

    it("links a policy HR uploaded without choosing an employee (owner = uploader)", async () => {
      const hr = member(a, "hr").id;
      const documentId = await doc(a, { userId: hr, uploadedBy: hr });

      await expect(link(a, documentId)).resolves.toBeGreaterThan(0);
    });

    it("lets history exist for a document that is no longer publishable, but not a re-activation", async () => {
      const documentId = await doc(a);
      const linkId = await link(a, documentId);
      await sql`update documents set classification = 'CONFIDENTIAL' where id = ${documentId}`;
      expect((await statusOf(linkId)).status).toBe("unpublished");

      const error = await violation(sql`update kb_linked_documents set status = 'active', unpublished_at = null where id = ${linkId}`);

      expect(error.message).toContain("DOCUMENT_NOT_PUBLISHABLE");
    });
  });

  describe("a linked document that stops being publishable is unlinked in the same transaction", () => {
    it.each([
      ["raised to CONFIDENTIAL", "update documents set classification = 'CONFIDENTIAL' where id = $1"],
      ["dropped back to PERSONAL", "update documents set classification = 'PERSONAL' where id = $1"],
      ["retyped to a payslip (the shape a CSV re-import can produce)", "update documents set type = 'PAYSLIP' where id = $1"],
      ["handed to an employee", "update documents set user_id = (select id from users where id like 'qa-employee-%' order by id limit 1) where id = $1"],
    ])("when it is %s", async (_label, statement) => {
      const documentId = await doc(a);
      const linkId = await link(a, documentId);
      const before = (await auditRows(a, "kb.hr_link.auto_unpublished")).length;

      await sql.unsafe(statement, [documentId]);

      const after = await statusOf(linkId);
      expect(after.status).toBe("unpublished");
      expect(after.reason).toBe("source_no_longer_publishable");
      const audits = await auditRows(a, "kb.hr_link.auto_unpublished");
      expect(audits.length).toBe(before + 1);
      expect(audits.at(-1)).toMatchObject({ target_id: String(documentId), metadata: { systemActor: "document-guard-trigger", linksAffected: 1 } });
    });

    it("marks the link source_removed when the document is soft-deleted", async () => {
      const documentId = await doc(a);
      const linkId = await link(a, documentId);

      await sql`update documents set is_active = false where id = ${documentId}`;

      const after = await statusOf(linkId);
      expect(after.status).toBe("source_removed");
      expect(after.removed).not.toBeNull();
    });

    it("does nothing, and audits nothing, for edits that keep the document publishable", async () => {
      const documentId = await doc(a);
      const linkId = await link(a, documentId);
      const before = (await auditRows(a, "kb.hr_link.auto_unpublished")).length;

      await sql`update documents set name = 'Renamed', description = 'x', expiry_date = '2031-01-01', category = 'Policies' where id = ${documentId}`;
      await sql`update documents set classification = 'RESTRICTED' where id = ${documentId}`;

      expect((await statusOf(linkId)).status).toBe("active");
      expect((await auditRows(a, "kb.hr_link.auto_unpublished")).length).toBe(before);
    });

    it("audits nothing for a document nobody linked", async () => {
      const documentId = await doc(a, { classification: "INTERNAL" });
      const before = (await auditRows(a, "kb.hr_link.auto_unpublished")).length;

      await sql`update documents set classification = 'PERSONAL' where id = ${documentId}`;

      expect((await auditRows(a, "kb.hr_link.auto_unpublished")).length).toBe(before);
    });
  });

  describe("deleting", () => {
    it("lets a document with a live link be hard-deleted; the pointer is cleared and readers cannot reach it", async () => {
      const documentId = await doc(a);
      const linkId = await link(a, documentId);

      await sql`delete from documents where id = ${documentId}`;

      const after = await statusOf(linkId);
      expect(after.document_id).toBeNull();
      expect(after.status).toBe("active");
    });

    it("lets an organisation be purged with links, audiences, versions, settings and a classification-change audit row in it", async () => {
      const doomed = await seed.org("doomed", ["hr"]);
      const documentId = await doc(doomed);
      const linkId = await link(doomed, documentId);
      await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind) values (${doomed.orgId}, ${linkId}, 'ALL_EMPLOYEES')`;
      await sql`insert into document_audiences (org_id, document_id, kind) values (${doomed.orgId}, ${documentId}, 'ALL_EMPLOYEES')`;
      await sql`insert into document_versions (org_id, document_id, version, file_url) values (${doomed.orgId}, ${documentId}, 2, 'k/2.pdf')`;
      await sql`insert into kb_settings (org_id) values (${doomed.orgId})`;
      await sql`update documents set classification = 'CONFIDENTIAL' where id = ${documentId}`;

      await seed.dispose();

      const [left] = await sql`select (select count(*) from kb_linked_documents where org_id = ${doomed.orgId})::int as links`;
      expect(left?.links).toBe(0);
      a = await seed.org("a2", ["hr", "employee"]);
      b = await seed.org("b2", ["hr"]);
    }, 60_000);
  });

  describe("row-level security, as the role the application connects with", () => {
    async function asApp<T>(orgId: string, work: (tx: typeof sql) => Promise<T>): Promise<T> {
      let result: T | undefined;
      await sql
        .begin(async (tx) => {
          await tx`set local role streamline_app`;
          await tx`select set_config('app.organization_id', ${orgId}, true)`;
          result = await work(tx as unknown as typeof sql);
          throw new RollbackSignal();
        })
        .catch((error: unknown) => {
          if (!(error instanceof RollbackSignal)) throw error;
        });
      return result as T;
    }
    class RollbackSignal extends Error {}

    it("shows each tenant only its own rows in every new table", async () => {
      const docA = await doc(a);
      const docB = await doc(b);
      const linkA = await link(a, docA);
      const linkB = await link(b, docB);
      await sql`insert into kb_linked_document_audiences (org_id, linked_document_id, kind) values (${a.orgId}, ${linkA}, 'ALL_EMPLOYEES'), (${b.orgId}, ${linkB}, 'ALL_EMPLOYEES')`;
      await sql`insert into document_audiences (org_id, document_id, kind) values (${a.orgId}, ${docA}, 'ALL_EMPLOYEES'), (${b.orgId}, ${docB}, 'ALL_EMPLOYEES')`;
      await sql`insert into document_versions (org_id, document_id, version, file_url) values (${a.orgId}, ${docA}, 2, 'k/a.pdf'), (${b.orgId}, ${docB}, 2, 'k/b.pdf')`;
      await sql`insert into kb_settings (org_id) values (${b.orgId})`;

      type Counts = { mine: number; theirs: number };
      const seen = await asApp(a.orgId, async (tx) => {
        const rows = await Promise.all(
          ["kb_linked_documents", "kb_linked_document_audiences", "document_audiences", "document_versions", "kb_settings"].map(
            async (table) => {
              const [row] = await tx.unsafe<Counts[]>(
                `select count(*) filter (where org_id = $1)::int as mine, count(*) filter (where org_id <> $1)::int as theirs from ${table}`,
                [a.orgId],
              );
              return [table, row ?? { mine: 0, theirs: -1 }] as const;
            },
          ),
        );
        return Object.fromEntries(rows);
      });

      for (const [table, counts] of Object.entries(seen)) expect({ table, theirs: counts.theirs }).toEqual({ table, theirs: 0 });
      expect(seen["kb_linked_documents"]?.mine).toBeGreaterThan(0);
    });

    it("refuses a write that names another tenant", async () => {
      const docB = await doc(b);

      const error = await violation(
        asApp(a.orgId, (tx) =>
          tx`insert into kb_linked_documents (org_id, document_id, status, unpublished_at) values (${b.orgId}, ${docB}, 'unpublished', now())`,
        ),
      );

      expect(error.code).toBe("42501");
    });

    it("cannot update or delete another tenant's link (zero rows, no error)", async () => {
      const docB = await doc(b);
      const linkB = await link(b, docB);

      const touched = await asApp(a.orgId, async (tx) => {
        const updated = await tx`update kb_linked_documents set unpublish_reason = 'x' where id = ${linkB} returning id`;
        const deleted = await tx`delete from kb_linked_documents where id = ${linkB} returning id`;
        return updated.length + deleted.length;
      });

      expect(touched).toBe(0);
      expect((await statusOf(linkB)).reason).toBeNull();
    });

    it("lets the application role run the guard (functions and triggers execute under it)", async () => {
      const documentId = await doc(a);
      const created = await asApp(a.orgId, async (tx) => {
        const [row] = await tx`insert into kb_linked_documents (org_id, document_id) values (${a.orgId}, ${documentId}) returning id`;
        await tx`update documents set classification = 'PERSONAL' where id = ${documentId}`;
        const [after] = await tx`select status from kb_linked_documents where id = ${row?.id}`;
        return after?.status;
      });

      expect(created).toBe("unpublished");
    });
  });

  describe("KbHrLinkFlagsService against the real table", () => {
    const actor = (org: SeededOrg): CurrentUserContext => ({
      userId: member(org, "hr").id,
      orgId: org.orgId,
      role: "ADMIN",
      isOrgOwner: true,
      sessionId: "s",
      tokenScopes: null,
      principal: humanSessionPrincipal(member(org, "hr").membershipId, false),
    });
    const build = (hrEnabled: boolean) => {
      const db = drizzle(sql, { schema }) as unknown as Db;
      const audit = { logCritical: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
      const entitlements = { isModuleEnabled: jest.fn().mockResolvedValue(hrEnabled) } as unknown as EntitlementsService;
      return new KbHrLinkFlagsService(db, entitlements, audit);
    };

    it("creates the row on first use, persists each switch, and cascades an OFF through the database", async () => {
      const service = build(true);

      expect((await service.getAdmin(a.orgId)).stored).toEqual({ link: false, search: false, ai: false });
      await service.update(actor(a), { link: true, search: true });
      await service.update(actor(a), { ai: true });
      const on = await service.getAdmin(a.orgId);
      expect(on.stored).toEqual({ link: true, search: true, ai: true });
      expect(on.effective).toEqual({ link: true, search: true, ai: true });

      await service.update(actor(a), { link: false });
      const [row] = await sql`select hrms_kb_link_enabled l, hrms_kb_search_enabled s, hrms_kb_ai_enabled i from kb_settings where org_id = ${a.orgId}`;
      expect(row).toEqual({ l: false, s: false, i: false });
    });

    it("keeps one tenant's switches off when another turns them on", async () => {
      const service = build(true);

      await service.update(actor(b), { link: true });

      expect((await service.getEffective(b.orgId)).link).toBe(true);
      expect((await service.getEffective(a.orgId)).link).toBe(false);
    });

    it("reads as off for a tenant whose HR module is not enabled, whatever is stored", async () => {
      await build(true).update(actor(a), { link: true });

      expect(await build(false).getEffective(a.orgId)).toEqual({ link: false, search: false, ai: false });
    });
  });
});
