/**
 * HRMS-KB PR 1 — `documents.is_public`, and acknowledgment recipients, against a real Postgres.
 *
 * `is_public` was accepted on any document type and widened `getFileReference` for every viewer, while
 * ids are serial integers: a payslip or ID proof someone marked public was enumerable through
 * `GET /hr/documents/:id/file`. The recipient list of `POST /hr/compliance` was written to the table
 * without checking that the ids were members of the caller's organisation.
 *
 * Mocks cannot show either: the defect is the predicate the database evaluates and the rows it stores.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=documents-public-flag
 */
import { randomUUID } from "node:crypto";
import { HttpException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { ScopedRead } from "../../access/scoped-read";
import { DocumentsService } from "./documents.service";
import { ComplianceService } from "./compliance.service";

const describeDb = dbSpecSuite();

interface SeededOrg {
  orgId: string;
  users: Record<string, { id: string; membershipId: number }>;
}

describeDb("documents.is_public and acknowledgment recipients — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "documents-public-flag.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let documents: DocumentsService;
  let compliance: ComplianceService;
  let a: SeededOrg;
  let b: SeededOrg;
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const cleanup: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

  /** organizations.owner_membership_id and organization_members.org_id reference each other; one transaction satisfies the deferred FK. */
  async function seedOrg(label: string, names: string[]): Promise<SeededOrg> {
    const orgId = `qa-pub-${label}-${randomUUID()}`;
    cleanup.orgs.push(orgId);
    const users: SeededOrg["users"] = {};
    await sql.begin(async (tx) => {
      const ids = names.map((name) => ({ name, id: `qa-${name}-${randomUUID()}` }));
      for (const { name, id } of ids) {
        cleanup.users.push(id);
        await tx`insert into users (id, email, name) values (${id}, ${`${id}@example.com`}, ${name})`;
      }
      const memberships = await Promise.all(
        ids.map(async () => {
          const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
          return Number(row?.id);
        }),
      );
      const first = memberships[0];
      if (first === undefined) throw new Error("no memberships");
      await tx`insert into organizations (id, name, slug, owner_membership_id) values (${orgId}, ${`QA ${label}`}, ${orgId}, ${first})`;
      for (const [index, { name, id }] of ids.entries()) {
        const membershipId = memberships[index];
        if (membershipId === undefined) throw new Error("membership missing");
        await tx`
          insert into organization_members (id, org_id, user_id, role, status, is_owner)
          values (${membershipId}, ${orgId}, ${id}, ${index === 0 ? "ORG_ADMIN" : "MEMBER"}, ${"ACTIVE"}, ${index === 0})
        `;
        users[name] = { id, membershipId };
      }
    });
    return { orgId, users };
  }

  async function insertDocument(row: {
    type: string;
    userId: string | null;
    uploadedBy: string | null;
    isPublic: boolean;
    isActive?: boolean;
  }): Promise<number> {
    const [inserted] = await sql`
      insert into documents (org_id, user_id, uploaded_by, name, type, file_url, is_public, is_active)
      values (${a.orgId}, ${row.userId}, ${row.uploadedBy}, ${`QA ${row.type}`}, ${row.type}::document_type,
              ${`${a.orgId}/hr-documents/${randomUUID()}.pdf`}, ${row.isPublic}, ${row.isActive ?? true})
      returning id
    `;
    return Number(inserted?.id);
  }

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });
    documents = new DocumentsService(db as unknown as Db, audit as never);
    compliance = new ComplianceService(db as unknown as Db);
    a = await seedOrg("a", ["hr", "employee", "viewer"]);
    b = await seedOrg("b", ["outsider"]);
  });

  afterAll(async () => {
    if (!sql) return;
    for (const orgId of cleanup.orgs) await sql`delete from organizations where id = ${orgId}`;
    for (const id of cleanup.users) await sql`delete from users where id = ${id}`;
    await sql.end({ timeout: 5 });
  });

  const viewer = () => a.users["viewer"] ?? (() => { throw new Error("viewer"); })();
  const hr = () => a.users["hr"] ?? (() => { throw new Error("hr"); })();
  const employee = () => a.users["employee"] ?? (() => { throw new Error("employee"); })();

  /** A viewer whose scope is `own`: the only thing that can widen their reach is the public flag. */
  const readAsViewer = (documentId: number) =>
    documents.getFileReference(ScopedRead.of(a.orgId, viewer().id, "own"), documentId, viewer().membershipId);

  describe("GET /hr/documents/:id/file honours is_public only on a company-level document", () => {
    it.each([
      ["a payslip owned by an employee", "PAYSLIP"],
      ["an ID proof owned by an employee", "ID_PROOF"],
      ["an offer letter owned by an employee", "OFFER_LETTER"],
      ["a resume owned by an employee", "RESUME"],
    ])("does not widen %s", async (_label, type) => {
      const id = await insertDocument({ type, userId: employee().id, uploadedBy: hr().id, isPublic: true });

      await expect(readAsViewer(id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("does not widen a POLICY that belongs to a different employee", async () => {
      const id = await insertDocument({ type: "POLICY", userId: employee().id, uploadedBy: hr().id, isPublic: true });

      await expect(readAsViewer(id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("does not widen an OTHER document an import attached to an employee (no uploader recorded)", async () => {
      const id = await insertDocument({ type: "OTHER", userId: employee().id, uploadedBy: null, isPublic: true });

      await expect(readAsViewer(id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("still serves a public policy filed by HR with no employee chosen (owner = uploader)", async () => {
      const id = await insertDocument({ type: "POLICY", userId: hr().id, uploadedBy: hr().id, isPublic: true });

      await expect(readAsViewer(id)).resolves.toMatchObject({ documentId: id });
    });

    it("still serves an organisation-wide public policy (no owner)", async () => {
      const id = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: true });

      await expect(readAsViewer(id)).resolves.toMatchObject({ documentId: id });
    });

    it("still requires the flag: a company policy that is not public is not readable by this viewer", async () => {
      const id = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: false });

      await expect(readAsViewer(id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("does not change what an all-scope reader sees (control: the flag never mattered to them)", async () => {
      const id = await insertDocument({ type: "PAYSLIP", userId: employee().id, uploadedBy: hr().id, isPublic: false });

      await expect(
        documents.getFileReference(ScopedRead.of(a.orgId, hr().id, "all"), id, hr().membershipId),
      ).resolves.toMatchObject({ documentId: id });
    });
  });

  describe("the write path refuses is_public on a personal document", () => {
    const asHr = () => ScopedRead.of(a.orgId, hr().id, "all");

    async function rejection(promise: Promise<unknown>): Promise<HttpException> {
      try {
        await promise;
      } catch (error) {
        if (error instanceof HttpException) return error;
        throw error;
      }
      throw new Error("expected the call to be refused");
    }

    it("refuses to create a public payslip with 422 DOCUMENT_NOT_PUBLIC_ELIGIBLE", async () => {
      const error = await rejection(
        documents.createDocument(
          asHr(),
          { name: "Jan payslip", type: "PAYSLIP", fileUrl: `${a.orgId}/hr-documents/x.pdf`, userId: employee().id, isPublic: true },
          hr().membershipId,
        ),
      );

      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: "DOCUMENT_NOT_PUBLIC_ELIGIBLE" });
    });

    it("creates a public policy that HR uploaded without choosing an employee", async () => {
      const created = await documents.createDocument(
        asHr(),
        { name: "Handbook", type: "POLICY", fileUrl: `${a.orgId}/hr-documents/${randomUUID()}.pdf`, isPublic: true },
        hr().membershipId,
      );

      expect(created).toMatchObject({ isPublic: true, userId: hr().id });
    });

    it("refuses to flip an existing payslip public", async () => {
      const id = await insertDocument({ type: "PAYSLIP", userId: employee().id, uploadedBy: hr().id, isPublic: false });

      const error = await rejection(documents.updateDocument(asHr(), id, { isPublic: true }, hr().membershipId));

      expect(error.getResponse()).toMatchObject({ code: "DOCUMENT_NOT_PUBLIC_ELIGIBLE" });
    });

    it("refuses to retype a public policy into a payslip", async () => {
      const id = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: true });

      const error = await rejection(documents.updateDocument(asHr(), id, { type: "PAYSLIP" }, hr().membershipId));

      expect(error.getResponse()).toMatchObject({ code: "DOCUMENT_NOT_PUBLIC_ELIGIBLE" });
    });

    it("refuses to hand a public policy to an employee", async () => {
      const id = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: true });

      const error = await rejection(
        documents.updateDocument(asHr(), id, { userId: employee().id }, hr().membershipId),
      );

      expect(error.getResponse()).toMatchObject({ code: "DOCUMENT_NOT_PUBLIC_ELIGIBLE" });
    });

    it("lets HR edit an unrelated field on a legacy row that is already public and personal (the read path is what closes it)", async () => {
      const id = await insertDocument({ type: "PAYSLIP", userId: employee().id, uploadedBy: hr().id, isPublic: true });

      await expect(
        documents.updateDocument(asHr(), id, { description: "corrected note" }, hr().membershipId),
      ).resolves.toMatchObject({ description: "corrected note" });
      await expect(readAsViewer(id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("POST /hr/compliance recipients", () => {
    async function ackRows(documentId: number) {
      return sql`select user_id, user_membership_id, status from policy_acknowledgments where org_id = ${a.orgId} and document_id = ${documentId} order by id`;
    }

    it("refuses a recipient who belongs to another organisation and stores nothing", async () => {
      const documentId = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: false });
      const outsider = b.users["outsider"];
      if (!outsider) throw new Error("outsider");

      await expect(
        compliance.sendAcknowledgments(a.orgId, { documentId, userIds: [employee().id, outsider.id] }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(await ackRows(documentId)).toHaveLength(0);
    });

    it("refuses an id that names nobody", async () => {
      const documentId = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: false });

      await expect(
        compliance.sendAcknowledgments(a.orgId, { documentId, userIds: ["no-such-user"] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("records the recipient's membership and does not stack a second pending request", async () => {
      const documentId = await insertDocument({ type: "POLICY", userId: null, uploadedBy: null, isPublic: false });

      const first = await compliance.sendAcknowledgments(a.orgId, { documentId, userIds: [employee().id, employee().id] });
      const second = await compliance.sendAcknowledgments(a.orgId, { documentId, userIds: [employee().id, viewer().id] });

      expect(first).toEqual({ success: true, sent: 1 });
      expect(second).toEqual({ success: true, sent: 1 });
      const rows = await ackRows(documentId);
      expect(rows.map((row) => row["user_id"])).toEqual([employee().id, viewer().id]);
      expect(rows.map((row) => Number(row["user_membership_id"]))).toEqual([employee().membershipId, viewer().membershipId]);
    });
  });
});
