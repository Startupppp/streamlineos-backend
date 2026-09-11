import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  candidates,
  jobPostings,
  offerLetterTemplates,
  organizations,
  richDocuments,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { renderOfferLetterPdf } from "./offer-pdf.util";
import type {
  CreateOfferTemplateInput,
  GenerateOfferPdfInput,
  OfferLetterInput,
  UpdateOfferTemplateInput,
} from "./dto/hr-interviews.schemas";

@Injectable()
export class HrOffersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listTemplates(orgId: string) {
    return this.db.query.offerLetterTemplates.findMany({
      where: eq(offerLetterTemplates.orgId, orgId),
      limit: 100,
      with: { creator: { columns: { id: true, name: true } } },
      orderBy: [desc(offerLetterTemplates.createdAt)],
    });
  }

  async createTemplate(orgId: string, userId: string, input: CreateOfferTemplateInput) {
    if (input.isDefault) {
      await this.db
        .update(offerLetterTemplates)
        .set({ isDefault: false })
        .where(eq(offerLetterTemplates.orgId, orgId));
    }

    const [template] = await this.db
      .insert(offerLetterTemplates)
      .values({
        orgId,
        name: input.name,
        htmlContent: input.htmlContent,
        isDefault: input.isDefault ?? false,
        createdBy: userId,
      })
      .returning();

    return template;
  }

  async updateTemplate(orgId: string, id: number, input: UpdateOfferTemplateInput) {
    if (input.isDefault) {
      await this.db
        .update(offerLetterTemplates)
        .set({ isDefault: false })
        .where(eq(offerLetterTemplates.orgId, orgId));
    }

    const [updated] = await this.db
      .update(offerLetterTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(offerLetterTemplates.id, id), eq(offerLetterTemplates.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Template not found");
    return updated;
  }

  async deleteTemplate(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(offerLetterTemplates)
      .where(and(eq(offerLetterTemplates.id, id), eq(offerLetterTemplates.orgId, orgId)))
      .returning({ id: offerLetterTemplates.id });

    if (!deleted) throw new NotFoundException("Template not found");
    return { success: true };
  }

  async generatePdf(orgId: string, id: number, input: GenerateOfferPdfInput) {
    const template = await this.db.query.offerLetterTemplates.findFirst({
      where: and(eq(offerLetterTemplates.id, id), eq(offerLetterTemplates.orgId, orgId)),
      columns: { htmlContent: true },
    });
    if (!template) throw new NotFoundException("Template not found");

    const base64 = await renderOfferLetterPdf(template.htmlContent, {
      candidateName: input.candidateName,
      designation: input.designation,
      salary: input.salary,
      joiningDate: input.joiningDate,
      validUntil: input.validUntil,
      orgName: input.orgName,
    });

    return {
      base64,
      mimeType: "application/pdf",
      fileName: `offer-letter-${input.candidateName.replace(/\s+/g, "-")}.pdf`,
    };
  }

  async generateOfferLetter(orgId: string, userId: string, input: OfferLetterInput) {
    const [candidate, job, org] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, input.candidateId), eq(candidates.orgId, orgId)),
        columns: { firstName: true, lastName: true },
      }),
      this.db.query.jobPostings.findFirst({
        where: and(eq(jobPostings.id, input.jobPostingId), eq(jobPostings.orgId, orgId)),
        columns: { title: true, location: true },
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
    ]);

    if (!candidate) throw new NotFoundException("Candidate not found.");
    if (!job) throw new NotFoundException("Job posting not found.");

    const companyName = org?.name ?? "Our Organization";
    const candidateName = `${candidate.firstName} ${candidate.lastName}`;
    const dateLabel = new Date().toLocaleDateString("en-IN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Offer Letter" }] },
        { type: "paragraph", content: [{ type: "text", text: `Date: ${dateLabel}` }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: `Dear ${candidateName},` }] },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `We are pleased to offer you the position of ${job.title} at ${companyName}. Your start date will be ${input.startDate}.`,
            },
          ],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Compensation" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Annual CTC: ₹${input.salary}` }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Position: ${job.title}` }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Location: ${job.location ?? "As per company policy"}` }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `Start Date: ${input.startDate}` }] }] },
          ],
        },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Please confirm your acceptance by signing below within 7 business days." }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "We look forward to having you on our team!" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Best regards," }] },
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: `HR Team — ${companyName}` }] },
      ],
    };

    const [doc] = await this.db
      .insert(richDocuments)
      .values({
        orgId,
        title: `Offer Letter - ${candidateName} - ${job.title}`,
        contentJson: content,
        templateType: "offer_letter",
        isPublished: false,
        version: 1,
        createdBy: userId,
      })
      .returning();

    return { documentId: doc.id, title: doc.title };
  }
}
