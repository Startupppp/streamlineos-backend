import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  calibrationSessions,
  candidateDocuments,
  candidateDocumentsVault,
  candidateReferenceChecks,
  candidateReferrals,
  candidates,
  documentTemplates,
  users,
  vaultAccessLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { substituteVariables } from "./document-variables.util";
import type {
  AddVaultDocumentInput,
  CreateCalibrationInput,
  CreateReferenceCheckInput,
  CreateReferralInput,
  GenerateDocumentInput,
  UpdateCalibrationInput,
  UpdateReferenceCheckInput,
  UpdateReferralInput,
} from "./dto/candidate-records.schemas";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);
const ALLOWED_EXTENSIONS = /\.(pdf|docx|doc)$/i;

@Injectable()
export class RecruitmentCandidateRecordsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listCalibration(orgId: string, candidateId: number) {
    return this.db
      .select()
      .from(calibrationSessions)
      .where(and(eq(calibrationSessions.candidateId, candidateId), eq(calibrationSessions.orgId, orgId)))
      .orderBy(desc(calibrationSessions.createdAt));
  }

  async createCalibration(orgId: string, userId: string, candidateId: number, input: CreateCalibrationInput) {
    await this.ensureCandidate(orgId, candidateId);
    const [created] = await this.db
      .insert(calibrationSessions)
      .values({
        orgId,
        candidateId,
        jobPostingId: input.jobPostingId,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        status: input.scheduledAt ? "scheduled" : "pending",
        participantIds: input.participantIds,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning();
    return created;
  }

  async updateCalibration(orgId: string, candidateId: number, input: UpdateCalibrationInput) {
    const updates: Partial<typeof calibrationSessions.$inferInsert> = { updatedAt: new Date() };
    if (input.scheduledAt !== undefined) updates.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (input.status !== undefined) updates.status = input.status;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.decision !== undefined) updates.decision = input.decision;
    if (input.participantIds !== undefined) updates.participantIds = input.participantIds;

    const [updated] = await this.db
      .update(calibrationSessions)
      .set(updates)
      .where(
        and(
          eq(calibrationSessions.id, input.id),
          eq(calibrationSessions.orgId, orgId),
          eq(calibrationSessions.candidateId, candidateId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Session not found.");
    return updated;
  }

  listReferrals(orgId: string, candidateId: number) {
    return this.db
      .select()
      .from(candidateReferrals)
      .where(and(eq(candidateReferrals.candidateId, candidateId), eq(candidateReferrals.orgId, orgId)));
  }

  async createReferral(orgId: string, candidateId: number, input: CreateReferralInput) {
    await this.ensureCandidate(orgId, candidateId);
    const [created] = await this.db
      .insert(candidateReferrals)
      .values({
        orgId,
        candidateId,
        referredBy: input.referredBy,
        relationship: input.relationship ?? null,
        notes: input.notes ?? null,
        bonusEligible: input.bonusEligible,
        bonusAmount: input.bonusAmount !== undefined ? String(input.bonusAmount) : null,
      })
      .returning();
    return created;
  }

  async updateReferral(orgId: string, candidateId: number, input: UpdateReferralInput) {
    const updates: Partial<typeof candidateReferrals.$inferInsert> = {};
    if (input.bonusEligible !== undefined) updates.bonusEligible = input.bonusEligible;
    if (input.bonusAmount !== undefined) updates.bonusAmount = input.bonusAmount !== null ? String(input.bonusAmount) : null;
    if (input.bonusPaidAt !== undefined) updates.bonusPaidAt = input.bonusPaidAt ? new Date(input.bonusPaidAt) : null;
    if (input.notes !== undefined) updates.notes = input.notes;

    const [updated] = await this.db
      .update(candidateReferrals)
      .set(updates)
      .where(
        and(
          eq(candidateReferrals.id, input.id),
          eq(candidateReferrals.orgId, orgId),
          eq(candidateReferrals.candidateId, candidateId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Referral not found.");
    return updated;
  }

  async listReferenceChecks(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    return this.db.query.candidateReferenceChecks.findMany({
      where: and(eq(candidateReferenceChecks.candidateId, candidateId), eq(candidateReferenceChecks.orgId, orgId)),
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });
  }

  async createReferenceCheck(orgId: string, userId: string, candidateId: number, input: CreateReferenceCheckInput) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    const [created] = await this.db
      .insert(candidateReferenceChecks)
      .values({
        candidateId,
        orgId,
        referenceName: input.referenceName,
        referenceDesignation: input.referenceDesignation ?? null,
        referenceCompany: input.referenceCompany ?? null,
        referenceEmail: input.referenceEmail ?? null,
        referencePhone: input.referencePhone ?? null,
        relationship: input.relationship ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      })
      .returning();
    return created;
  }

  async updateReferenceCheck(orgId: string, candidateId: number, checkId: number, input: UpdateReferenceCheckInput) {
    const existing = await this.db.query.candidateReferenceChecks.findFirst({
      where: and(
        eq(candidateReferenceChecks.id, checkId),
        eq(candidateReferenceChecks.candidateId, candidateId),
        eq(candidateReferenceChecks.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Reference check not found");

    const updateData: Partial<typeof candidateReferenceChecks.$inferInsert> = { updatedAt: new Date() };
    if (input.status !== undefined) updateData.status = input.status;
    if (input.outcome !== undefined) updateData.outcome = input.outcome;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.contactedAt !== undefined) updateData.contactedAt = new Date(input.contactedAt);
    if (input.referenceDesignation !== undefined) updateData.referenceDesignation = input.referenceDesignation;
    if (input.referenceCompany !== undefined) updateData.referenceCompany = input.referenceCompany;
    if (input.referenceEmail !== undefined) updateData.referenceEmail = input.referenceEmail;
    if (input.referencePhone !== undefined) updateData.referencePhone = input.referencePhone;

    await this.db
      .update(candidateReferenceChecks)
      .set(updateData)
      .where(and(eq(candidateReferenceChecks.id, checkId), eq(candidateReferenceChecks.orgId, orgId)));
    return { success: true };
  }

  async deleteReferenceCheck(orgId: string, candidateId: number, checkId: number) {
    const existing = await this.db.query.candidateReferenceChecks.findFirst({
      where: and(
        eq(candidateReferenceChecks.id, checkId),
        eq(candidateReferenceChecks.candidateId, candidateId),
        eq(candidateReferenceChecks.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Reference check not found");

    await this.db
      .delete(candidateReferenceChecks)
      .where(and(eq(candidateReferenceChecks.id, checkId), eq(candidateReferenceChecks.orgId, orgId)));
    return { success: true };
  }

  async listDocuments(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    return this.db
      .select()
      .from(candidateDocuments)
      .where(eq(candidateDocuments.candidateId, candidateId))
      .orderBy(desc(candidateDocuments.createdAt));
  }

  async generateDocument(orgId: string, userId: string, candidateId: number, input: GenerateDocumentInput) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");

    const [template] = await this.db
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.id, input.templateId),
          eq(documentTemplates.orgId, orgId),
          eq(documentTemplates.isActive, true),
        ),
      )
      .limit(1);
    if (!template) throw new NotFoundException("Template not found or inactive");

    const { result, missing } = substituteVariables(template.htmlContent, input.variables);
    if (missing.length > 0) {
      throw new BadRequestException(`Missing variable values: ${missing.join(", ")}`);
    }

    const [doc] = await this.db
      .insert(candidateDocuments)
      .values({
        candidateId,
        orgId,
        templateId: input.templateId,
        title: template.title,
        htmlContent: result,
        status: "GENERATED",
        createdBy: userId,
      })
      .returning();
    return doc;
  }

  async viewDocument(orgId: string, candidateId: number, documentId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");

    const [doc] = await this.db
      .select({
        id: candidateDocuments.id,
        htmlContent: candidateDocuments.htmlContent,
        title: candidateDocuments.title,
      })
      .from(candidateDocuments)
      .where(
        and(
          eq(candidateDocuments.id, documentId),
          eq(candidateDocuments.candidateId, candidateId),
          eq(candidateDocuments.orgId, orgId),
        ),
      )
      .limit(1);
    if (!doc) throw new NotFoundException("Document not found");

    void this.db
      .update(candidateDocuments)
      .set({ viewedAt: new Date() })
      .where(eq(candidateDocuments.id, documentId))
      .then(() => undefined)
      .catch(() => undefined);

    return { htmlContent: doc.htmlContent, title: doc.title };
  }

  async listVault(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);
    return this.db.query.candidateDocumentsVault.findMany({
      where: and(eq(candidateDocumentsVault.candidateId, candidateId), eq(candidateDocumentsVault.orgId, orgId)),
      orderBy: (d, { desc: dd }) => [dd(d.createdAt)],
    });
  }

  async addVaultDocument(orgId: string, userId: string, candidateId: number, input: AddVaultDocumentInput) {
    await this.ensureCandidate(orgId, candidateId);

    const mimeAllowed = ALLOWED_MIME_TYPES.has(input.fileType.toLowerCase());
    const extAllowed = ALLOWED_EXTENSIONS.test(input.filename);
    if (!mimeAllowed && !extAllowed) {
      throw new UnsupportedMediaTypeException("Only PDF and DOCX files are allowed for candidate documents.");
    }

    const [doc] = await this.db
      .insert(candidateDocumentsVault)
      .values({
        candidateId,
        orgId,
        filename: input.filename,
        s3Key: input.s3Key,
        fileUrl: input.fileUrl,
        fileType: input.fileType,
        fileSize: input.fileSize,
        documentType: input.documentType ?? null,
        uploadedBy: userId,
        avResult: "PENDING",
      })
      .returning();
    return doc;
  }

  async listVaultAccessLogs(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");

    const logs = await this.db
      .select({
        id: vaultAccessLogs.id,
        action: vaultAccessLogs.action,
        accessedAt: vaultAccessLogs.accessedAt,
        fileName: candidateDocumentsVault.filename,
        documentType: candidateDocumentsVault.documentType,
        accessorName: users.name,
        accessorFirstName: users.firstName,
        accessorLastName: users.lastName,
      })
      .from(vaultAccessLogs)
      .innerJoin(candidateDocumentsVault, eq(vaultAccessLogs.vaultDocumentId, candidateDocumentsVault.id))
      .leftJoin(users, eq(vaultAccessLogs.accessedBy, users.id))
      .where(eq(candidateDocumentsVault.candidateId, candidateId))
      .orderBy(desc(vaultAccessLogs.accessedAt))
      .limit(100);

    return logs.map((l) => ({
      ...l,
      accessorDisplayName:
        l.accessorFirstName && l.accessorLastName
          ? `${l.accessorFirstName} ${l.accessorLastName}`
          : (l.accessorName ?? "Unknown"),
    }));
  }

  private async ensureCandidate(orgId: string, candidateId: number, message = "Candidate not found.") {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException(message);
  }
}
