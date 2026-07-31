import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import type {
  CreateEmailTemplateInput,
  UpdateEmailTemplateInput,
  GenerateEmailTemplateAiInput,
} from "./dto/email-templates.schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import { emailTemplates } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";

const FEATURE_KEY = "hr.email-template-generate";

const EmailTemplateAiOutputSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

@Injectable()
export class HrEmailTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.orgId, orgId))
      .orderBy(desc(emailTemplates.createdAt));
  }

  async create(orgId: string, userId: string, input: CreateEmailTemplateInput) {
    const existing = await this.db.query.emailTemplates.findFirst({
      where: and(
        eq(emailTemplates.orgId, orgId),
        sql`lower(trim(${emailTemplates.name})) = ${input.name.toLowerCase()}`,
      ),
      columns: { id: true },
    });
    if (existing)
      throw new ConflictException("A template with this name already exists.");

    const [record] = await this.db
      .insert(emailTemplates)
      .values({
        orgId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        category: input.category ?? "GENERAL",
        variables: input.variables ?? null,
        createdBy: userId,
      })
      .returning();

    return record;
  }

  async update(orgId: string, id: number, input: UpdateEmailTemplateInput) {
    const [updated] = await this.db
      .update(emailTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(emailTemplates.id, id), eq(emailTemplates.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Template not found.");
    return updated;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.id, id), eq(emailTemplates.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Template not found.");
    return { success: true };
  }

  async generateWithAi(
    orgId: string,
    userId: string,
    input: GenerateEmailTemplateAiInput,
  ) {
    const categoryLine = input.category ? `\nCategory: ${input.category}` : "";
    const subjectHint = input.subject
      ? `\nExisting subject hint: ${input.subject}`
      : "";

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      schema: EmailTemplateAiOutputSchema,
      prompt: {
        system:
          "You are an expert HR communications specialist. Generate professional, concise HR email templates. The subject should be clear and actionable. The body should be professional, empathetic, and use {{variable_name}} placeholders for dynamic fields like {{employee_name}}, {{date}}, {{manager_name}}, {{company_name}}.",
        user: `Generate an HR email template for the following:\nTemplate Name: ${input.name}${categoryLine}${subjectHint}\n\nReturn a subject line and a body. The body should be 3-5 sentences, ready to send with minimal editing. Include 2-4 relevant {{variable}} placeholders.`,
      },
    });

    if (!result.ok) {
      if (result.kind === "quota_exceeded")
        throw new BadRequestException(result.message);
      if (result.kind === "not_configured")
        throw new ServiceUnavailableException(
          "AI is not configured. Set OPENAI_API_KEY.",
        );
      throw new ServiceUnavailableException("AI is temporarily unavailable");
    }

    return { subject: result.data.subject, body: result.data.body };
  }
}
