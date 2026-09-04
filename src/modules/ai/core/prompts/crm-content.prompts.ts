import type { EmailTone } from "../dto/output.schemas";

/**
 * Prompts that ask the model to WRITE something a person will read — a
 * conversation summary, an enrichment note, a follow-up email. Consumed by
 * `CrmContentService`.
 *
 * Separated from the scoring rubrics in `crm-scoring.prompts.ts`: these carry
 * tone and length instructions rather than a scoring scale, and they change with
 * the brand voice rather than with the sales model.
 */

export interface ConversationSummaryInput {
  activityType: string;
  subject?: string;
  notes: string;
  leadName?: string;
  dealName?: string;
}

export function conversationSummaryPrompt(input: ConversationSummaryInput) {
  return {
    system: `You are a sales assistant. Summarize this ${input.activityType} log into structured insights.
Return JSON:
{
  "summary": "<1-2 sentence summary>",
  "keyPoints": ["<point1>", "<point2>"],
  "actionItems": ["<action1>", "<action2>"],
  "sentiment": "<positive|neutral|negative>"
}`,
    user: `Summarize this ${input.activityType}:
${input.subject ? `Subject: ${input.subject}` : ""}
${input.leadName ? `Lead: ${input.leadName}` : ""}${input.dealName ? `Deal: ${input.dealName}` : ""}
Notes: ${input.notes}`,
  };
}

export interface LeadEnrichmentInput {
  name: string;
  company?: string | null;
  email?: string | null;
  designation?: string | null;
  city?: string | null;
}

export function leadEnrichmentPrompt(input: LeadEnrichmentInput) {
  return {
    system: `You are a sales research assistant for an Indian investment/financial services company.
Given a lead's basic info, generate a research brief to help the sales rep prepare.
Base your analysis on the company name, designation, and city. Make educated estimates.

Return JSON:
{
  "companyInsight": "<1-2 sentences about the company or type of business>",
  "estimatedCompanySize": "<e.g. 50-200 employees, Mid-market>",
  "industry": "<industry sector>",
  "talkingPoints": ["<point1>", "<point2>", "<point3>"],
  "potentialNeeds": ["<need1>", "<need2>"],
  "recommendedApproach": "<1 sentence recommended sales approach>"
}`,
    user: `Research brief for:
Name: ${input.name}
Company: ${input.company || "Unknown"}
Email: ${input.email || "Not provided"}
Designation: ${input.designation || "Not provided"}
City: ${input.city || "Not provided"}`,
  };
}

export interface EmailGeneratorInput {
  leadName: string;
  company?: string | null;
  designation?: string | null;
  dealStage?: string | null;
  lastActivityType?: string | null;
  lastActivityDate?: string | null;
  lastActivityNotes?: string | null;
  potentialValue?: string | null;
  senderName: string;
  senderRole?: string | null;
  tone: EmailTone;
  context?: string;
}

const TONE_INSTRUCTIONS: Record<EmailTone, string> = {
  formal: "Use formal, professional business language. Address with 'Dear'. Sign off with 'Best regards'.",
  friendly: "Use warm, conversational tone. First-name basis. Sign off with 'Cheers' or 'Looking forward'.",
  urgent: "Convey time-sensitivity. Mention deadlines or limited availability. Be direct and action-oriented.",
};

export function emailGeneratorPrompt(input: EmailGeneratorInput) {
  return {
    system: `You are a sales email copywriter for an Indian investment/financial services company.
Write a short, compelling follow-up email (max 150 words body).
${TONE_INSTRUCTIONS[input.tone]}

Rules:
- Do NOT use placeholder brackets like [Company] or [Name] — use actual values provided
- Keep subject line under 60 characters
- Include one clear call-to-action
- Reference the last interaction if provided
- Amounts are in Indian Rupees (₹)
- Do NOT include email headers (From, To, Date) — just subject and body

Return JSON:
{
  "subject": "<email subject>",
  "body": "<email body text>"
}`,
    user: `Write a ${input.tone} follow-up email:

To: ${input.leadName}${input.designation ? `, ${input.designation}` : ""}${input.company ? ` at ${input.company}` : ""}
From: ${input.senderName}${input.senderRole ? `, ${input.senderRole}` : ""}
${input.dealStage ? `Deal Stage: ${input.dealStage}` : ""}
${input.potentialValue ? `Deal Value: ₹${input.potentialValue}` : ""}
${input.lastActivityType ? `Last Activity: ${input.lastActivityType} on ${input.lastActivityDate || "recently"}` : "No previous activity"}
${input.lastActivityNotes ? `Notes: ${input.lastActivityNotes}` : ""}
${input.context ? `Additional context: ${input.context}` : ""}`,
  };
}
