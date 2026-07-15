import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { emailTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { LlmService } from "../ai/providers/llm.service";
import { AiCreditsService } from "../billing/ai-credits.service";
import { AiUsageService } from "../ai/services/ai-usage.service";
import { z } from "zod";
import type { CreateEmailTemplateInput, UpdateEmailTemplateInput, GenerateEmailTemplateAiInput } from "./dto/email-templates.schemas";

const AI_CREDIT_COST = 2;
const FEATURE_KEY = "hr.email-template-generate";
const MODEL_TIER = "fast" as const;

const EmailTemplateAiOutputSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

@Injectable()
export class HrEmailTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly credits: AiCreditsService,
    private readonly aiUsage: AiUsageService,
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
    if (existing) throw new ConflictException("A template with this name already exists.");

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

  async generateWithAi(orgId: string, userId: string, input: GenerateEmailTemplateAiInput) {
    if (!this.llm.isConfigured()) {
      throw new ServiceUnavailableException("AI is not configured. Set OPENAI_API_KEY.");
    }

    await this.credits.consumeCredits(orgId, userId, AI_CREDIT_COST, FEATURE_KEY, MODEL_TIER);

    let result: z.infer<typeof EmailTemplateAiOutputSchema>;
    try {
      const categoryLine = input.category ? `\nCategory: ${input.category}` : "";
      const subjectHint = input.subject ? `\nExisting subject hint: ${input.subject}` : "";
      result = await this.llm.invokeStructured({
        model: MODEL_TIER,
        schema: EmailTemplateAiOutputSchema,
        schemaName: "email_template",
        system: `You are an expert HR communications specialist. Generate professional, concise HR email templates. The subject should be clear and actionable. The body should be professional, empathetic, and use {{variable_name}} placeholders for dynamic fields like {{employee_name}}, {{date}}, {{manager_name}}, {{company_name}}.`,
        user: `Generate an HR email template for the following:\nTemplate Name: ${input.name}${categoryLine}${subjectHint}\n\nReturn a subject line and a body. The body should be 3-5 sentences, ready to send with minimal editing. Include 2-4 relevant {{variable}} placeholders.`,
      });
    } catch (err) {
      await this.credits.refundCredits(orgId, userId, AI_CREDIT_COST, FEATURE_KEY);
      throw err;
    }

    void this.aiUsage.track({
      orgId,
      userId,
      feature: FEATURE_KEY,
      model: MODEL_TIER,
    });

    return { subject: result.subject, body: result.body };
  }
}
