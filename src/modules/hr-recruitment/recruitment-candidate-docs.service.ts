import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  candidateDocuments,
  candidates,
  documentTemplates,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { appUrl } from "../email/app-url";
import { getCandidateDocumentRolloutEmail } from "../email/templates/recruitment";
import { substituteVariables } from "./document-variables.util";
import type {
  GenerateDocumentInput,
  RolloutDocumentsInput,
} from "./dto/candidate-records.schemas";

@Injectable()
export class RecruitmentCandidateDocsService {
  private readonly logger = new Logger(RecruitmentCandidateDocsService.name);
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async listDocuments(orgId: string, candidateId: number) {
    await this.ensureCandidate(orgId, candidateId, "Candidate not found");
    return this.db
      .select()
      .from(candidateDocuments)
      .where(
        and(
          eq(candidateDocuments.candidateId, candidateId),
          eq(candidateDocuments.orgId, orgId),
        ),
      )
      .orderBy(desc(candidateDocuments.createdAt));
  }

  async generateDocument(
    orgId: string,
    userId: string,
    candidateId: number,
    input: GenerateDocumentInput,
  ) {
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

    const { result, missing } = substituteVariables(
      template.htmlContent,
      input.variables,
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing variable values: ${missing.join(", ")}`,
      );
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
      .leftJoin(
        documentTemplates,
        eq(candidateDocuments.templateId, documentTemplates.id),
      )
      .where(
        and(
          eq(candidateDocuments.candidateId, candidateId),
          eq(candidateDocuments.orgId, orgId),
        ),
      )
      .orderBy(desc(candidateDocuments.createdAt));
  }

  async generateRolloutDocuments(
    orgId: string,
    userId: string,
    candidateId: number,
    input: RolloutDocumentsInput,
  ) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(
        eq(candidates.id, candidateId),
        eq(candidates.orgId, orgId),
      ),
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
      throw new NotFoundException(
        "No active templates found for the provided IDs",
      );
    }

    const missingTemplateIds = input.templateIds.filter(
      (id) => !templates.find((t) => t.id === id),
    );
    if (missingTemplateIds.length > 0) {
      throw new NotFoundException(
        `Templates not found or inactive: IDs ${missingTemplateIds.join(", ")}`,
      );
    }

    const generatedDocs: (typeof candidateDocuments.$inferSelect)[] = [];
    const missingVarErrors: string[] = [];
    const docsToInsert: (typeof candidateDocuments.$inferInsert)[] = [];

    for (const template of templates) {
      const { result, missing } = substituteVariables(
        template.htmlContent,
        input.variables,
      );
      if (missing.length > 0) {
        missingVarErrors.push(
          `"${template.title}": missing ${missing.join(", ")}`,
        );
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
        ...(input.acceptanceDeadline && {
          acceptanceDeadline: new Date(input.acceptanceDeadline),
        }),
      });
    }

    if (missingVarErrors.length > 0) {
      throw new BadRequestException(
        `Variable substitution failed for: ${missingVarErrors.join("; ")}`,
      );
    }

    if (docsToInsert.length > 0) {
      const inserted = await this.db
        .insert(candidateDocuments)
        .values(docsToInsert)
        .returning();
      generatedDocs.push(...inserted);
    }

    if (input.sendEmail && generatedDocs.length > 0 && candidate.email) {
      const candidateName = `${candidate.firstName} ${candidate.lastName}`;
      const documentLinks = generatedDocs.map((doc) => ({
        title: doc.title,
        url: `${appUrl}/api/hr/recruitment/candidates/${candidateId}/documents/${doc.id}/view`,
      }));
      const { subject, html: emailHtml } = getCandidateDocumentRolloutEmail({
        candidateName,
        documentLinks,
      });
      try {
        await this.email.sendEmail({ to: candidate.email, subject, html: emailHtml });
        const docIds = generatedDocs.map((d) => d.id);
        await this.db
          .update(candidateDocuments)
          .set({ status: "SENT", sentAt: new Date() })
          .where(
            and(
              inArray(candidateDocuments.id, docIds),
              eq(candidateDocuments.orgId, orgId),
            ),
          );
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

  private async markDocumentViewed(documentId: number): Promise<void> {
    try {
      await this.db
        .update(candidateDocuments)
        .set({ viewedAt: new Date() })
        .where(eq(candidateDocuments.id, documentId));
    } catch (err) {
      this.logger.warn(`markDocumentViewed failed for document ${documentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async ensureCandidate(
    orgId: string,
    candidateId: number,
    message = "Candidate not found.",
  ): Promise<void> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException(message);
  }
}
