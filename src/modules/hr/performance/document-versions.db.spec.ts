/**
 * HRMS-KB PR 4 — the file history of an HR document, against a real Postgres.
 *
 * What is pinned: uploading a version changes nothing anyone can read; approving it is the moment the
 * document's file changes, and a knowledge-base entry that follows the latest changes with it while a pinned one
 * does not; a key the client chooses must be this organisation's and an HR document folder; and one tenant cannot
 * touch another's history.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=document-versions
 */
import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { HrmsKbSeed, member, type SeededOrg } from "../../../test/hrms-kb-seed.spec-fixtures";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { EntitlementsService } from "../../access/entitlements.service";
import { KbHrLinkFlagsService } from "../../kb/core/kb-hr-link-flags.service";
import { KbLinkedDocumentQueryService } from "../../kb/linked-documents/kb-linked-document-query.service";
import { DocumentVersionsService } from "./document-versions.service";
import type { ClassificationActor } from "./document-classification.service";

const describeDb = dbSpecSuite();

describeDb("document versions — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "document-versions.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let seed: HrmsKbSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let service: DocumentVersionsService;
  let query: KbLinkedDocumentQueryService;

  const actorOf = (org: SeededOrg): ClassificationActor => ({ userId: member(org, "hr").id, orgId: org.orgId, membershipId: member(org, "hr").membershipId });
  const key = (org: SeededOrg, folder = "hr-documents") => `${org.orgId}/${folder}/${randomUUID()}.pdf`;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    seed = new HrmsKbSeed(sql);
    a = await seed.org("a", ["hr", "reader"]);
    b = await seed.org("b", ["hr"]);
    const db = drizzle(sql, { schema }) as unknown as Db;
    const audit = new AuditService(db);
    const entitlements = { isModuleEnabled: jest.fn().mockResolvedValue(true) } as unknown as EntitlementsService;
    service = new DocumentVersionsService(db, audit, new KbHrLinkFlagsService(db, entitlements, audit));
    query = new KbLinkedDocumentQueryService(db);
    await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${a.orgId}, true)`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await seed.dispose();
    await sql.end({ timeout: 5 });
  });

  async function doc(org: SeededOrg, fileUrl = key(org)): Promise<number> {
    const [row] = await sql`
      insert into documents (org_id, uploaded_by, name, type, classification, file_url, file_name)
      values (${org.orgId}, ${member(org, "hr").id}, ${`doc-${randomUUID().slice(0, 8)}`}, 'POLICY', 'INTERNAL', ${fileUrl}, 'v1.pdf')
      returning id`;
    return Number(row?.id);
  }

  async function documentRow(documentId: number) {
    const [row] = await sql`select file_url, file_name, version from documents where id = ${documentId}`;
    return row as { file_url: string; file_name: string; version: number };
  }

  async function auditRows(org: SeededOrg, action: string, documentId: number) {
    return sql`select metadata from audit_logs where org_id = ${org.orgId} and action = ${action} and target_id = ${String(documentId)}`;
  }

  async function follow(documentId: number, pinnedTo?: number): Promise<number> {
    await sql`insert into document_audiences (org_id, document_id, kind) values (${a.orgId}, ${documentId}, 'ALL_EMPLOYEES')`;
    const [link] = await sql`insert into kb_linked_documents (org_id, document_id, version_mode, pinned_version) values (${a.orgId}, ${documentId}, ${pinnedTo ? "PINNED" : "FOLLOW_LATEST"}, ${pinnedTo ?? null}) returning id`;
    return Number(link?.id);
  }

  it("answers 404 while hrms.kb.link is off", async () => {
    const documentId = await doc(b);

    await expect(service.list(b.orgId, documentId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.upload(actorOf(b), documentId, { fileUrl: key(b) })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.approve(actorOf(b), documentId, 2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("shows a document nobody has revised as one approved version, without writing a row", async () => {
    const documentId = await doc(a);

    const view = await service.list(a.orgId, documentId);

    expect(view).toMatchObject({ documentId, currentVersion: 1 });
    expect(view.versions).toEqual([expect.objectContaining({ version: 1, status: "approved", isCurrent: true, fileName: "v1.pdf" })]);
    const [{ total }] = await sql`select count(*)::int as total from document_versions where document_id = ${documentId}`;
    expect(total).toBe(0);
  });

  it("records the current file as version 1 on the first upload, adds version 2 as pending, and changes nothing anyone reads", async () => {
    const original = key(a);
    const documentId = await doc(a, original);
    const linkId = await follow(documentId);
    const reader = { orgId: a.orgId, userId: member(a, "reader").id, canPublish: true };

    const view = await service.upload(actorOf(a), documentId, { fileUrl: key(a), fileName: "v2.pdf", effectiveDate: "2026-07-01" });

    expect(view.currentVersion).toBe(1);
    expect(view.versions.map((version) => [version.version, version.status, version.isCurrent])).toEqual([[1, "approved", true], [2, "pending", false]]);
    expect((await documentRow(documentId)).file_url).toBe(original);
    expect((await query.resolveFile(reader, linkId)).fileKey).toBe(original);
    expect(await auditRows(a, "hr.document.version_uploaded", documentId)).toHaveLength(1);
  });

  it("refuses a file that is not this organisation's, not an HR document folder, or not a stored file at all", async () => {
    const documentId = await doc(a);

    for (const fileUrl of [key(b), key(a, "payslips"), key(a, "kb-media"), "https://example.com/x.pdf", "../etc/passwd", `${a.orgId}/hr-documents/../../x`]) {
      await expect(service.upload(actorOf(a), documentId, { fileUrl })).rejects.toBeInstanceOf(BadRequestException);
    }
    const [{ total }] = await sql`select count(*)::int as total from document_versions where document_id = ${documentId}`;
    expect(total).toBe(0);
  });

  it("approving version 2 changes the file for everyone who reads the document, and a pinned entry does not move", async () => {
    const original = key(a);
    const revised = key(a);
    const documentId = await doc(a, original);
    const linkId = await follow(documentId);
    await service.upload(actorOf(a), documentId, { fileUrl: revised, fileName: "v2.pdf", mimeType: "application/pdf" });
    const reader = { orgId: a.orgId, userId: member(a, "reader").id, canPublish: true };

    const view = await service.approve(actorOf(a), documentId, 2);

    expect(view.currentVersion).toBe(2);
    expect(view.versions.map((version) => [version.version, version.status, version.isCurrent])).toEqual([[1, "approved", false], [2, "approved", true]]);
    expect(await documentRow(documentId)).toMatchObject({ file_url: revised, file_name: "v2.pdf", version: 2 });
    expect((await query.resolveFile(reader, linkId)).fileKey).toBe(revised);
    expect((await auditRows(a, "hr.document.version_approved", documentId))[0]?.metadata).toMatchObject({ fromVersion: 1, toVersion: 2 });

    await sql`update kb_linked_documents set version_mode = 'PINNED', pinned_version = 1 where id = ${linkId}`;
    expect((await query.resolveFile(reader, linkId)).fileKey).toBe(original);
    expect((await query.get(reader, linkId)).newerVersionAvailable).toBe(true);
  });

  it("will not approve a version that is missing, already decided, or older than the current one", async () => {
    const documentId = await doc(a);
    await service.upload(actorOf(a), documentId, { fileUrl: key(a) });
    await service.upload(actorOf(a), documentId, { fileUrl: key(a) });
    await service.approve(actorOf(a), documentId, 3);

    await expect(service.approve(actorOf(a), documentId, 9)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.approve(actorOf(a), documentId, 3)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.approve(actorOf(a), documentId, 2)).rejects.toMatchObject({ response: { code: "VERSION_SUPERSEDED" } });
    expect((await documentRow(documentId)).version).toBe(3);
  });

  it("tenant isolation: another tenant cannot list, revise or approve this document's history", async () => {
    await sql`insert into kb_settings (org_id, hrms_kb_link_enabled) values (${b.orgId}, true) on conflict (org_id) do update set hrms_kb_link_enabled = true`;
    const documentId = await doc(a);
    await service.upload(actorOf(a), documentId, { fileUrl: key(a) });

    await expect(service.list(b.orgId, documentId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.upload(actorOf(b), documentId, { fileUrl: key(b) })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.approve(actorOf(b), documentId, 2)).rejects.toBeInstanceOf(NotFoundException);
    expect((await documentRow(documentId)).version).toBe(1);
    await sql`update kb_settings set hrms_kb_link_enabled = false where org_id = ${b.orgId}`;
  });
});
