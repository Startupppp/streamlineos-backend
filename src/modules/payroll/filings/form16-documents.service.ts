import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, between, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  payrollForm16Documents,
  payrollRuns,
  payslipPublications,
  users,
} from "../../../db/schema";
import { StorageService } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { AvScanner } from "../../../common/security/av-scan";
import { AuditService } from "../../../common/audit/audit.service";
import { financialYearMonths, mergeForm16Rows } from "./lib/form16-documents";

export const FORM16_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const FORM16_READ_CAP = 5000;

type Actor = { orgId: string; userId: string; membershipId: number | null };

@Injectable()
export class Form16DocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly avScanner: AvScanner,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, financialYear: string) {
    const { from, to } = financialYearMonths(financialYear);
    const [payees, documents] = await Promise.all([
      this.db
        .selectDistinct({
          userMembershipId: sql<number | null>`coalesce(${payslipPublications.userMembershipId}, ${organizationMembers.id})`,
        })
        .from(payslipPublications)
        .leftJoin(
          organizationMembers,
          and(eq(organizationMembers.orgId, payslipPublications.orgId), eq(organizationMembers.userId, payslipPublications.userId)),
        )
        .innerJoin(
          payrollRuns,
          and(eq(payrollRuns.orgId, payslipPublications.orgId), eq(payrollRuns.id, payslipPublications.runId)),
        )
        .where(
          and(
            eq(payslipPublications.orgId, orgId),
            eq(payslipPublications.status, "PUBLISHED"),
            between(payrollRuns.month, from, to),
          ),
        )
        .limit(FORM16_READ_CAP),
      this.db
        .select()
        .from(payrollForm16Documents)
        .where(and(eq(payrollForm16Documents.orgId, orgId), eq(payrollForm16Documents.financialYear, financialYear)))
        .limit(FORM16_READ_CAP),
    ]);
    const payeeIds = payees.flatMap((p) => (p.userMembershipId == null ? [] : [Number(p.userMembershipId)]));
    const people = await this.loadPeople(orgId, [...new Set([...payeeIds, ...documents.map((d) => d.userMembershipId)])]);
    return { financialYear, ...mergeForm16Rows(payeeIds, documents, people) };
  }

  async upload(actor: Actor, financialYear: string, membershipId: number, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException("No file provided");
    if (file.size > FORM16_MAX_UPLOAD_BYTES) throw new BadRequestException("File too large (max 10MB)");
    if (file.mimetype !== "application/pdf" || !validateMagicBytes(file.buffer, "application/pdf"))
      throw new BadRequestException("Form 16 must be a PDF");
    const person = await this.requireMember(actor.orgId, membershipId);

    const verdict = await this.avScanner.scan(file.buffer, file.originalname, file.mimetype);
    if (verdict.status === "infected")
      throw new UnprocessableEntityException(`Upload rejected: malware detected (${verdict.threat})`);
    if (verdict.status === "error")
      throw new ServiceUnavailableException("Malware scan unavailable — upload rejected");

    const fileName = `Form16-${financialYear}.pdf`;
    const uploaded = await this.storage.uploadFile(actor.orgId, file.buffer, "payslips", fileName, "application/pdf");
    const previous = await this.findDocument(actor.orgId, financialYear, membershipId);
    const now = new Date();
    const [row] = await this.db
      .insert(payrollForm16Documents)
      .values({
        orgId: actor.orgId,
        financialYear,
        userMembershipId: membershipId,
        fileKey: uploaded.key,
        fileName,
        fileSizeBytes: file.size,
        status: "uploaded",
        uploadedByMembershipId: actor.membershipId,
        uploadedAt: now,
      })
      .onConflictDoUpdate({
        target: [payrollForm16Documents.orgId, payrollForm16Documents.userMembershipId, payrollForm16Documents.financialYear],
        set: {
          fileKey: uploaded.key,
          fileName,
          fileSizeBytes: file.size,
          status: "uploaded",
          uploadedByMembershipId: actor.membershipId,
          uploadedAt: now,
          releasedByMembershipId: null,
          releasedAt: null,
          updatedAt: now,
        },
      })
      .returning();
    if (previous && previous.fileKey !== uploaded.key)
      await this.storage.deleteFileIfPresent(actor.orgId, previous.fileKey);
    this.audit.log({
      action: "payroll.form16.upload",
      userId: actor.userId,
      orgId: actor.orgId,
      metadata: { financialYear, membershipId, documentId: row.id, replaced: previous != null },
    });
    return this.toRow(row, person);
  }

  async release(actor: Actor, financialYear: string, membershipId: number) {
    const person = await this.requireMember(actor.orgId, membershipId);
    const existing = await this.findDocument(actor.orgId, financialYear, membershipId);
    if (!existing) throw new NotFoundException("Upload a Form 16 before releasing it");
    if (existing.status === "released") return this.toRow(existing, person);
    const [row] = await this.db
      .update(payrollForm16Documents)
      .set({ status: "released", releasedByMembershipId: actor.membershipId, releasedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(payrollForm16Documents.orgId, actor.orgId), eq(payrollForm16Documents.id, existing.id)))
      .returning();
    this.audit.log({
      action: "payroll.form16.release",
      userId: actor.userId,
      orgId: actor.orgId,
      metadata: { financialYear, membershipId, documentId: row.id },
    });
    return this.toRow(row, person);
  }

  async releaseAll(actor: Actor, financialYear: string) {
    const rows = await this.db
      .update(payrollForm16Documents)
      .set({ status: "released", releasedByMembershipId: actor.membershipId, releasedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(payrollForm16Documents.orgId, actor.orgId),
          eq(payrollForm16Documents.financialYear, financialYear),
          eq(payrollForm16Documents.status, "uploaded"),
        ),
      )
      .returning({ id: payrollForm16Documents.id });
    this.audit.log({
      action: "payroll.form16.release_all",
      userId: actor.userId,
      orgId: actor.orgId,
      metadata: { financialYear, released: rows.length },
    });
    return { financialYear, released: rows.length };
  }

  async download(orgId: string, financialYear: string, membershipId: number) {
    const doc = await this.findDocument(orgId, financialYear, membershipId);
    if (!doc) throw new NotFoundException("Form 16 not found");
    return this.stream(orgId, doc);
  }

  async listOwn(orgId: string, membershipId: number | null) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const rows = await this.db
      .select({
        financialYear: payrollForm16Documents.financialYear,
        fileName: payrollForm16Documents.fileName,
        releasedAt: payrollForm16Documents.releasedAt,
      })
      .from(payrollForm16Documents)
      .where(
        and(
          eq(payrollForm16Documents.orgId, orgId),
          eq(payrollForm16Documents.userMembershipId, membershipId),
          eq(payrollForm16Documents.status, "released"),
        ),
      )
      .limit(100);
    rows.sort((a, b) => b.financialYear.localeCompare(a.financialYear));
    return { documents: rows };
  }

  async downloadOwn(orgId: string, membershipId: number | null, financialYear: string) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required");
    const doc = await this.findDocument(orgId, financialYear, membershipId);
    if (!doc || doc.status !== "released") throw new NotFoundException("Form 16 not found");
    return this.stream(orgId, doc);
  }

  private async stream(orgId: string, doc: typeof payrollForm16Documents.$inferSelect) {
    const file = await this.storage.getFileStream(orgId, doc.fileKey);
    return new StreamableFile(file.body, {
      type: "application/pdf",
      disposition: `attachment; filename="${doc.fileName}"`,
    });
  }

  private async findDocument(orgId: string, financialYear: string, membershipId: number) {
    const [row] = await this.db
      .select()
      .from(payrollForm16Documents)
      .where(
        and(
          eq(payrollForm16Documents.orgId, orgId),
          eq(payrollForm16Documents.financialYear, financialYear),
          eq(payrollForm16Documents.userMembershipId, membershipId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async requireMember(orgId: string, membershipId: number) {
    const people = await this.loadPeople(orgId, [membershipId]);
    const person = people.get(membershipId);
    if (!person) throw new NotFoundException("Employee not found in your organization");
    return person;
  }

  private async loadPeople(orgId: string, membershipIds: number[]) {
    if (membershipIds.length === 0) return new Map<number, { employeeName: string | null; email: string | null }>();
    const rows = await this.db
      .select({ id: organizationMembers.id, employeeName: users.name, email: users.email })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.id, membershipIds)))
      .limit(FORM16_READ_CAP);
    return new Map(rows.map((r) => [r.id, { employeeName: r.employeeName, email: r.email }]));
  }

  private toRow(
    row: typeof payrollForm16Documents.$inferSelect,
    person: { employeeName: string | null; email: string | null },
  ) {
    return {
      userMembershipId: row.userMembershipId,
      employeeName: person.employeeName,
      email: person.email,
      status: row.status,
      fileName: row.fileName,
      fileSizeBytes: row.fileSizeBytes,
      uploadedAt: row.uploadedAt,
      releasedAt: row.releasedAt,
    };
  }
}
