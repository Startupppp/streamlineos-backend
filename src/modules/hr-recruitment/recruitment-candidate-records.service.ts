import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  calibrationParticipants,
  calibrationSessions,
  candidateDocuments,
  candidateDocumentsVault,
  candidateMessages,
  candidateReferenceChecks,
  candidateReferrals,
  candidates,
  documentTemplates,
  interviews,
  users,
  vaultAccessLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { getCandidateDocumentRolloutEmail } from "../email/templates/recruitment";
import { substituteVariables } from "./document-variables.util";
import type {
  AddVaultDocumentInput,
  CreateCalibrationInput,
  CreateReferenceCheckInput,
  CreateReferralInput,
  GenerateDocumentInput,
  RolloutDocumentsInput,
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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  listCalibration(orgId: string, candidateId: number) {
    return this.db.query.calibrationSessions.findMany({
      where: and(eq(calibrationSessions.candidateId, candidateId), eq(calibrationSessions.orgId, orgId)),
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
      with: { participants: { columns: { userId: true } } },
    }).then((sessions) =>
      sessions.map(({ participants, ...s }) => ({
        ...s,
        participantIds: participants.map((p) => p.userId),
      })),
    );
  }

  async createCalibration(orgId: string, userId: string, candidateId: number, input: CreateCalibrationInput) {
    await this.ensureCandidate(orgId, candidateId);

    const session = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(calibrationSessions)
        .values({
          orgId,
          candidateId,
          jobPostingId: input.jobPostingId,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          status: input.scheduledAt ? "scheduled" : "pending",
          notes: input.notes ?? null,
          createdBy: userId,
        })
        .returning();

      if (input.participantIds.length > 0) {
        await tx.insert(calibrationParticipants).values(
          input.participantIds.map((uid) => ({ sessionId: created.id, orgId, userId: uid })),
        );
      }

      return created;
    });

    return { ...session, participantIds: input.participantIds };
  }

  async updateCalibration(orgId: string, candidateId: number, input: UpdateCalibrationInput) {
    const updates: Partial<typeof calibrationSessions.$inferInsert> = { updatedAt: new Date() };
    if (input.scheduledAt !== undefined) updates.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (input.status !== undefined) updates.status = input.status;
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.decision !== undefined) updates.decision = input.decision;

    const session = await this.db.transaction(async (tx) => {
      const [updated] = await tx
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

      if (input.participantIds !== undefined) {
        await tx
          .delete(calibrationParticipants)
          .where(eq(calibrationParticipants.sessionId, input.id));
        if (input.participantIds.length > 0) {
          await tx.insert(calibrationParticipants).values(
            input.participantIds.map((uid) => ({ sessionId: input.id, orgId, userId: uid })),
          );
        }
      }

      return updated;
    });

    let participantIds: string[];
    if (input.participantIds !== undefined) {
      participantIds = input.participantIds;
    } else {
      const rows = await this.db
        .select({ userId: calibrationParticipants.userId })
        .from(calibrationParticipants)
        .where(eq(calibrationParticipants.sessionId, input.id));
      participantIds = rows.map((r) => r.userId);
    }

    return { ...session, participantIds };
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
      .where(and(eq(candidateDocuments.candidateId, candidateId), eq(candidateDocuments.orgId, orgId)))
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

    void this.markDocumentViewed(documentId);

    return { htmlContent: doc.htmlContent, title: doc.title };
  }

  async listRolloutDocuments(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    return this.db
      .select({
        id: candidateDocuments.id,
        templateId: candidateDocuments.templateId,
        templateTitle: documentTemplates.title,
        title: candidateDocuments.title,
        status: candidateDocuments.status,
        sentAt: candidateDocuments.sentAt,
        viewedAt: candidateDocuments.viewedAt,
        signedAt: candidateDocuments.signedAt,
        declinedAt: candidateDocuments.declinedAt,
        createdAt: candidateDocuments.createdAt,
        createdBy: candidateDocuments.createdBy,
      })
      .from(candidateDocuments)
      .leftJoin(documentTemplates, eq(candidateDocuments.templateId, documentTemplates.id))
      .where(and(eq(candidateDocuments.candidateId, candidateId), eq(candidateDocuments.orgId, orgId)))
      .orderBy(desc(candidateDocuments.createdAt));
  }

  async generateRolloutDocuments(
    orgId: string,
    userId: string,
    candidateId: number,
    input: RolloutDocumentsInput,
  ) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    const templates = await this.db
      .select()
      .from(documentTemplates)
      .where(
        and(
          inArray(documentTemplates.id, input.templateIds),
          eq(documentTemplates.orgId, orgId),
          eq(documentTemplates.isActive, true),
        ),
      );
    if (templates.length === 0) {
      throw new NotFoundException("No active templates found for the provided IDs");
    }

    const missingTemplateIds = input.templateIds.filter((id) => !templates.find((t) => t.id === id));
    if (missingTemplateIds.length > 0) {
      throw new NotFoundException(`Templates not found or inactive: IDs ${missingTemplateIds.join(", ")}`);
    }

    const generatedDocs: (typeof candidateDocuments.$inferSelect)[] = [];
    const missingVarErrors: string[] = [];
    const docsToInsert: (typeof candidateDocuments.$inferInsert)[] = [];

    for (const template of templates) {
      const { result, missing } = substituteVariables(template.htmlContent, input.variables);
      if (missing.length > 0) {
        missingVarErrors.push(`"${template.title}": missing ${missing.join(", ")}`);
        continue;
      }
      docsToInsert.push({
        candidateId,
        orgId,
        templateId: template.id,
        title: template.title,
        htmlContent: result,
        status: "GENERATED" as const,
        createdBy: userId,
        ...(input.acceptanceDeadline && { acceptanceDeadline: new Date(input.acceptanceDeadline) }),
      });
    }

    if (missingVarErrors.length > 0) {
      throw new BadRequestException(`Variable substitution failed for: ${missingVarErrors.join("; ")}`);
    }

    if (docsToInsert.length > 0) {
      const inserted = await this.db.insert(candidateDocuments).values(docsToInsert).returning();
      generatedDocs.push(...inserted);
    }

    if (input.sendEmail && generatedDocs.length > 0 && candidate.email) {
      const candidateName = `${candidate.firstName} ${candidate.lastName}`;
      const documentLinks = generatedDocs.map((doc) => ({
        title: doc.title,
        url: `${appUrl}/api/hr/recruitment/candidates/${candidateId}/documents/${doc.id}/view`,
      }));
      const { subject, html: emailHtml } = getCandidateDocumentRolloutEmail({ candidateName, documentLinks });
      try {
        await this.email.sendEmail({
          to: candidate.email,
          subject,
          html: emailHtml,
        });
        const docIds = generatedDocs.map((d) => d.id);
        await this.db
          .update(candidateDocuments)
          .set({ status: "SENT", sentAt: new Date() })
          .where(and(inArray(candidateDocuments.id, docIds), eq(candidateDocuments.orgId, orgId)));
        for (const doc of generatedDocs) {
          doc.status = "SENT";
          doc.sentAt = new Date();
        }
      } catch {
        void 0;
      }
    }

    return { documents: generatedDocs, count: generatedDocs.length };
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

  async deleteVaultDocument(orgId: string, candidateId: number, documentId: number) {
    await this.ensureCandidate(orgId, candidateId);

    const existing = await this.db.query.candidateDocumentsVault.findFirst({
      where: and(
        eq(candidateDocumentsVault.id, documentId),
        eq(candidateDocumentsVault.candidateId, candidateId),
        eq(candidateDocumentsVault.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Vault document not found");

    await this.db
      .delete(candidateDocumentsVault)
      .where(
        and(
          eq(candidateDocumentsVault.id, documentId),
          eq(candidateDocumentsVault.candidateId, candidateId),
          eq(candidateDocumentsVault.orgId, orgId),
        ),
      );

    return { success: true };
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
      .where(and(eq(candidateDocumentsVault.candidateId, candidateId), eq(candidateDocumentsVault.orgId, orgId)))
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

  async getActivity(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId);

    const [auditEntries, candidateInterviews, messages, documents] = await Promise.all([
      this.db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
          userName: users.name,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.targetType, "candidate"), eq(auditLogs.targetId, String(candidateId))))
        .orderBy(desc(auditLogs.createdAt))
        .limit(100),
      this.db.query.interviews.findMany({
        where: and(eq(interviews.candidateId, candidateId), eq(interviews.orgId, orgId)),
        columns: { id: true, type: true, scheduledAt: true, result: true },
        orderBy: (t, { desc: d }) => [d(t.scheduledAt)],
      }),
      this.db.query.candidateMessages.findMany({
        where: and(eq(candidateMessages.candidateId, candidateId), eq(candidateMessages.orgId, orgId)),
        columns: { id: true, direction: true, channel: true, subject: true, sentAt: true },
        orderBy: (t, { desc: d }) => [d(t.sentAt)],
      }),
      this.db.query.candidateDocuments.findMany({
        where: and(eq(candidateDocuments.candidateId, candidateId), eq(candidateDocuments.orgId, orgId)),
        columns: { id: true, title: true, status: true, createdAt: true, sentAt: true },
        orderBy: (t, { desc: d }) => [d(t.createdAt)],
      }),
    ]);

    const events = [
      ...auditEntries.map((e) => ({
        type: "AUDIT" as const,
        id: `audit-${e.id}`,
        label: e.action,
        detail: e.metadata as Record<string, unknown> | null,
        actor: e.userName,
        at: e.createdAt,
      })),
      ...candidateInterviews.map((i) => ({
        type: "INTERVIEW" as const,
        id: `interview-${i.id}`,
        label: `Interview scheduled (${i.type})`,
        detail: { result: i.result },
        actor: null,
        at: i.scheduledAt,
      })),
      ...messages.map((m) => ({
        type: "MESSAGE" as const,
        id: `message-${m.id}`,
        label: m.direction === "OUTBOUND" ? `Message sent (${m.channel})` : `Message received (${m.channel})`,
        detail: { subject: m.subject },
        actor: null,
        at: m.sentAt,
      })),
      ...documents.map((d) => ({
        type: "DOCUMENT" as const,
        id: `document-${d.id}`,
        label: `Document ${d.status === "SENT" ? "sent" : "generated"}: ${d.title}`,
        detail: { status: d.status },
        actor: null,
        at: d.sentAt ?? d.createdAt,
      })),
    ];

    return events
      .filter((e) => e.at !== null)
      .sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime());
  }

  private async markDocumentViewed(documentId: number): Promise<void> {
    try {
      await this.db
        .update(candidateDocuments)
        .set({ viewedAt: new Date() })
        .where(eq(candidateDocuments.id, documentId));
    } catch {}
  }

  private async ensureCandidate(orgId: string, candidateId: number, message = "Candidate not found.") {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException(message);
  }
}
