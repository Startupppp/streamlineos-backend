import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../gateway/ai-gateway.service";

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
import { throwOnAiFailure } from "./gateway-result.util";

const MAX_TEXT = 2000;

function trunc(s: string | null | undefined, max = MAX_TEXT): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function actorCharge(
  actor: { orgId: string; userId: string | null } | undefined,
): { charge: boolean | undefined } {
  return { charge: actor?.orgId ? true : undefined };
}

@Injectable()
export class CrmContentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async enrichLead(input: EnrichLeadInput, actor?: { orgId: string; userId: string | null }) {
    const resolvedActor = actor ?? { orgId: "", userId: null };
    const prompt = leadEnrichmentPrompt(input);
    const result = await this.gateway.invokeStructured({
      actor: resolvedActor,
      feature: "crm.enrich-lead",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.lead_enrichment", promptVersion: 1 },
      schema: LeadEnrichmentSchema,
      tier: "standard",
      maxTokens: 1024,
      ...actorCharge(actor),
    });
    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  private async getSender(userId: string): Promise<{ name: string; role?: string }> {
    const [user] = await this.db
      .select({ name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    return { name: user?.name || "Sales Team", role: user?.role || undefined };
  }

  private async generateFollowUpEmail(
    input: EmailGeneratorInput,
    actor: { orgId: string; userId: string | null },
  ): Promise<GeneratedEmail> {
    const prompt = emailGeneratorPrompt(input);
    const result = await this.gateway.invokeStructured({
      actor,
      feature: "crm.generate-email",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.email_generator", promptVersion: 1 },
      schema: GeneratedEmailSchema,
      tier: "fast",
      maxTokens: 1024,
      ...actorCharge(actor),
    });
    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  async generateEmail(userId: string, input: GenerateEmailInput, actor?: { orgId: string; userId: string | null }) {
    const resolvedActor = actor ?? { orgId: "", userId };
    const sender = await this.getSender(userId);
    const base = {
      leadName: input.leadName,
      company: input.company,
      designation: input.designation,
      dealStage: input.dealStage,
      lastActivityType: input.lastActivityType,
      lastActivityDate: input.lastActivityDate,
      lastActivityNotes: trunc(input.lastActivityNotes),
      potentialValue: input.potentialValue,
      senderName: sender.name,
      senderRole: sender.role,
      context: trunc(input.context),
    };

    if (input.allVariations) {
      const tones: EmailTone[] = ["formal", "friendly", "urgent"];
      const variations: Partial<Record<EmailTone, GeneratedEmail>> = {};
      for (const tone of tones) {
        variations[tone] = await this.generateFollowUpEmail({ ...base, tone }, resolvedActor);
      }
      return { variations };
    }

    return this.generateFollowUpEmail({ ...base, tone: input.tone }, resolvedActor);
  }

  async handleObjection(input: ObjectionHandlerInput, actor?: { orgId: string; userId: string | null }) {
    const resolvedActor = actor ?? { orgId: "", userId: null };
    const userPrompt = [
      `Client Objection: "${trunc(input.objection)}"`,
      `Deal Stage: ${input.dealStage}`,
      input.productName ? `Product/Service: ${input.productName}` : null,
      input.dealValue ? `Deal Value: ${input.dealValue}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const result = await this.gateway.invokeStructured({
      actor: resolvedActor,
      feature: "crm.objection-handler",
      prompt: {
        system:
          "You are an expert B2B sales coach helping Indian investment firm sales reps overcome objections. " +
          "Provide practical, culturally-aware counter-arguments. " +
          "Return 3-5 counter arguments, 3-5 talking points, and a concise suggested response script.",
        user: userPrompt,
      },
      schema: ObjectionResponseSchema,
      tier: "fast",
      maxTokens: 1024,
      ...actorCharge(actor),
    });
    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  async analyzeSentiment(input: SentimentAnalysisInput, actor?: { orgId: string; userId: string | null }) {
    const resolvedActor = actor ?? { orgId: "", userId: null };
    const userPrompt = [
      input.clientName ? `Client: ${input.clientName}` : null,
      `\nRecent Client Communications:\n${trunc(input.text)}`,
    ]
      .filter(Boolean)
      .join("\n");

    const result = await this.gateway.invokeStructured({
      actor: resolvedActor,
      feature: "crm.sentiment",
      prompt: {
        system:
          "You are a customer success analyst for a financial services CRM. Analyze client interaction text and identify sentiment, churn risk, and actionable recommendations. The score (0-100) represents client health: 0 = extremely dissatisfied/critical, 100 = extremely satisfied/promoter. Provide 2-5 risk factors and 3-5 specific, actionable recommendations.",
        user: userPrompt,
      },
      schema: SentimentSchema,
      tier: "fast",
      maxTokens: 512,
      ...actorCharge(actor),
    });
    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  async summarize(input: SummarizeInput, actor?: { orgId: string; userId: string | null }) {
    const resolvedActor = actor ?? { orgId: "", userId: null };
    const prompt = conversationSummaryPrompt(input);
    const result = await this.gateway.invokeStructured({
      actor: resolvedActor,
      feature: "crm.summarize",
      prompt: { system: prompt.system, user: prompt.user, promptKey: "crm.conversation_summary", promptVersion: 1 },
      schema: ConversationSummarySchema,
      tier: "fast",
      maxTokens: 512,
      ...actorCharge(actor),
      dedupe: true,
    });
    if (!result.ok) throwOnAiFailure(result);
    return result.data;
  }

  async narrateReport(input: ReportNarratorInput, actor?: { orgId: string; userId: string | null }) {
    const resolvedActor = actor ?? { orgId: "", userId: null };
    const result = await this.gateway.invokeText({
      actor: resolvedActor,
      feature: "crm.report-narrator",
      prompt: {
        system:
          "You are a business analyst who writes clear, insightful plain-English narratives from raw data for an Indian investment and financial services firm. Focus on key trends, notable changes, and actionable insights. Keep it concise (2-3 paragraphs). Use relevant financial context and terminology appropriate for the Indian market when applicable.",
        user: `Context: ${input.context ?? "Business performance data"}\n\nData:\n${trunc(input.data)}`,
      },
      tier: "fast",
      maxTokens: 1024,
      ...actorCharge(actor),
    });

    if (!result.ok) throwOnAiFailure(result);
    return { narrative: result.data, generatedAt: new Date().toISOString() };
  }
}
