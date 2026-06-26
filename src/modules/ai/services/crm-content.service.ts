import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { LlmService } from "../providers/llm.service";
import {
  conversationSummaryPrompt,
  emailGeneratorPrompt,
  leadEnrichmentPrompt,
  type EmailGeneratorInput,
} from "../prompts/crm.prompts";
import {
  ConversationSummarySchema,
  GeneratedEmailSchema,
  LeadEnrichmentSchema,
  ObjectionResponseSchema,
  SentimentSchema,
  type EmailTone,
  type GeneratedEmail,
} from "../dto/output.schemas";
import type {
  EnrichLeadInput,
  GenerateEmailInput,
  ObjectionHandlerInput,
  ReportNarratorInput,
  SentimentAnalysisInput,
  SummarizeInput,
} from "../dto/request.schemas";

@Injectable()
export class CrmContentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
  ) {}

  enrichLead(input: EnrichLeadInput) {
    const prompt = leadEnrichmentPrompt(input);
    return this.llm.invokeStructured({
      model: "standard",
      schema: LeadEnrichmentSchema,
      schemaName: "lead_enrichment",
      system: prompt.system,
      user: prompt.user,
    });
  }

  private async getSender(userId: string): Promise<{ name: string; role?: string }> {
    const [user] = await this.db
      .select({ name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    return { name: user?.name || "Sales Team", role: user?.role || undefined };
  }

  private generateFollowUpEmail(input: EmailGeneratorInput): Promise<GeneratedEmail> {
    const prompt = emailGeneratorPrompt(input);
    return this.llm.invokeStructured({
      model: "fast",
      schema: GeneratedEmailSchema,
      schemaName: "generated_email",
      system: prompt.system,
      user: prompt.user,
    });
  }

  async generateEmail(userId: string, input: GenerateEmailInput) {
    const sender = await this.getSender(userId);
    const base = {
      leadName: input.leadName,
      company: input.company,
      designation: input.designation,
      dealStage: input.dealStage,
      lastActivityType: input.lastActivityType,
      lastActivityDate: input.lastActivityDate,
      lastActivityNotes: input.lastActivityNotes,
      potentialValue: input.potentialValue,
      senderName: sender.name,
      senderRole: sender.role,
      context: input.context,
    };

    if (input.allVariations) {
      const tones: EmailTone[] = ["formal", "friendly", "urgent"];
      const variations: Partial<Record<EmailTone, GeneratedEmail>> = {};
      for (const tone of tones) {
        variations[tone] = await this.generateFollowUpEmail({ ...base, tone });
      }
      return { variations };
    }

    return this.generateFollowUpEmail({ ...base, tone: input.tone });
  }

  handleObjection(input: ObjectionHandlerInput) {
    const userPrompt = [
      `Client Objection: "${input.objection}"`,
      `Deal Stage: ${input.dealStage}`,
      input.productName ? `Product/Service: ${input.productName}` : null,
      input.dealValue ? `Deal Value: ${input.dealValue}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return this.llm.invokeStructured({
      model: "fast",
      schema: ObjectionResponseSchema,
      schemaName: "objection_response",
      system:
        "You are an expert B2B sales coach helping Indian investment firm sales reps overcome objections. " +
        "Provide practical, culturally-aware counter-arguments. " +
        "Return 3-5 counter arguments, 3-5 talking points, and a concise suggested response script.",
      user: userPrompt,
    });
  }

  analyzeSentiment(input: SentimentAnalysisInput) {
    const userPrompt = [
      input.clientName ? `Client: ${input.clientName}` : null,
      `\nRecent Client Communications:\n${input.text}`,
    ]
      .filter(Boolean)
      .join("\n");

    return this.llm.invokeStructured({
      model: "fast",
      schema: SentimentSchema,
      schemaName: "sentiment_analysis",
      system:
        "You are a customer success analyst for a financial services CRM. Analyze client interaction text and identify sentiment, churn risk, and actionable recommendations. The score (0-100) represents client health: 0 = extremely dissatisfied/critical, 100 = extremely satisfied/promoter. Provide 2-5 risk factors and 3-5 specific, actionable recommendations.",
      user: userPrompt,
    });
  }

  summarize(input: SummarizeInput) {
    const prompt = conversationSummaryPrompt(input);
    return this.llm.invokeStructured({
      model: "fast",
      schema: ConversationSummarySchema,
      schemaName: "conversation_summary",
      system: prompt.system,
      user: prompt.user,
    });
  }

  async narrateReport(input: ReportNarratorInput) {
    const narrative = await this.llm.invokeText({
      model: "fast",
      system:
        "You are a business analyst who writes clear, insightful plain-English narratives from raw data for an Indian investment and financial services firm. Focus on key trends, notable changes, and actionable insights. Keep it concise (2-3 paragraphs). Use relevant financial context and terminology appropriate for the Indian market when applicable.",
      user: `Context: ${input.context ?? "Business performance data"}

Data:
${input.data}`,
    });

    return { narrative, generatedAt: new Date().toISOString() };
  }
}
