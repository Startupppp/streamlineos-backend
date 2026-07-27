import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { filterToolsByPersona, getPersona } from "../persona-registry";
import { ModuleRef } from "@nestjs/core";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { google } from "@ai-sdk/google";
import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage } from "ai";
import { and, count, desc, eq, ilike, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  attendance,
  deals,
  leads,
  leaveRequests,
  payrolls,
  projects,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { getTodayString } from "../ai-date.util";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "../gateway/credit-ledger.interface";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";
import { AiUsageService } from "./ai-usage.service";
import { ProjectsAiService } from "./projects-ai.service";
import { KbAskService } from "../../kb/kb-ask.service";
import { ChatHistoryService } from "./chat-history.service";
import { HrCopilotTools } from "../hr-copilot-tools";
import { WorkspaceCopilotTools } from "../workspace-copilot-tools";
import { OpsCopilotTools } from "../ops-copilot-tools";
import { CrmCopilotTools } from "../crm-copilot-tools";
import { CommsCopilotTools } from "../comms-copilot-tools";
import { ProjectsCopilotTools } from "../projects-copilot-tools";
import { CommsActionsTools } from "../comms-actions-tools";
import { MailCopilotTools } from "../mail-copilot-tools";
import { ToolAccessService } from "../tool-access.service";

const DEFAULT_GOOGLE_CHAT_MODEL = "gemini-1.5-pro-latest";
const DEFAULT_OPENROUTER_CHAT_MODEL = "openai/gpt-4o";

function resolveChatModelId(): string {
  if (process.env.AI_CHAT_PROVIDER === "openrouter") {
    return DEFAULT_OPENROUTER_CHAT_MODEL;
  }
  return DEFAULT_GOOGLE_CHAT_MODEL;
}

function resolveChatModel(): LanguageModel {
  if (process.env.AI_CHAT_PROVIDER === "openrouter") {
    return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat(resolveChatModelId());
  }
  return google(resolveChatModelId());
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatContext {
  projectCount: number;
  ticketCount: number;
  todayAttendance: { checkedIn: boolean; checkedOut: boolean; workHours: string | null } | null;
  pendingLeaves: number;
  recentPayrolls: Array<{ month: string; netSalary: string; status: string }>;
  myLeadsCount: number;
  hotLeadsCount: number;
  myOpenDealsCount: number;
  topLeads: Array<{ name: string; status: string; priority: string | null }>;
}

const CHAT_FEATURE = "chat.message";

@Injectable()
export class ChatAssistantService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projectsAi: ProjectsAiService,
    private readonly history: ChatHistoryService,
    private readonly hrCopilot: HrCopilotTools,
    private readonly workspaceCopilot: WorkspaceCopilotTools,
    private readonly opsCopilot: OpsCopilotTools,
    private readonly crmCopilot: CrmCopilotTools,
    private readonly commsCopilot: CommsCopilotTools,
    private readonly projectsCopilot: ProjectsCopilotTools,
    private readonly commsActions: CommsActionsTools,
    private readonly mailCopilot: MailCopilotTools,
    private readonly toolAccess: ToolAccessService,
    private readonly moduleRef: ModuleRef,
    private readonly usageSvc: AiUsageService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
  ) {}

  private async fetchContext(userId: string, orgId: string): Promise<ChatContext> {
    const today = getTodayString();

    const [
      projectCount,
      ticketCount,
      todayAttendance,
      pendingLeaves,
      recentPayrolls,
      myLeadsResult,
      hotLeadsResult,
      myOpenDealsResult,
      topLeads,
    ] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)` }).from(projects).where(eq(projects.orgId, orgId)),
      this.db.select({ count: sql<number>`count(*)` }).from(tickets).where(eq(tickets.orgId, orgId)),
      this.db.query.attendance.findFirst({
        where: and(eq(attendance.userId, userId), eq(attendance.date, today), eq(attendance.orgId, orgId)),
      }),
      this.db.query.leaveRequests.findMany({
        where: and(
          eq(leaveRequests.userId, userId),
          eq(leaveRequests.status, "PENDING"),
          eq(leaveRequests.orgId, orgId),
        ),
        limit: 5,
      }),
      this.db.query.payrolls.findMany({
        where: and(eq(payrolls.userId, userId), eq(payrolls.orgId, orgId)),
        orderBy: [desc(payrolls.createdAt)],
        limit: 3,
      }),
      this.db.select({ count: count() }).from(leads).where(and(eq(leads.orgId, orgId), eq(leads.assignedToId, userId))),
      this.db.select({ count: count() }).from(leads).where(and(eq(leads.orgId, orgId), eq(leads.priority, "HOT"))),
      this.db
        .select({ count: count() })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            eq(deals.assignedToId, userId),
            sql`${deals.stage} NOT IN ('WON', 'LOST')`,
          ),
        ),
      this.db
        .select({ name: leads.name, status: leads.status, priority: leads.priority })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), eq(leads.assignedToId, userId)))
        .orderBy(desc(leads.createdAt))
        .limit(5),
    ]);

    return {
      projectCount: projectCount[0]?.count || 0,
      ticketCount: ticketCount[0]?.count || 0,
      todayAttendance: todayAttendance
        ? {
            checkedIn: Boolean(todayAttendance.checkIn),
            checkedOut: Boolean(todayAttendance.checkOut),
            workHours: todayAttendance.workHours,
          }
        : null,
      pendingLeaves: pendingLeaves.length,
      recentPayrolls: recentPayrolls.map((p) => ({
        month: p.month,
        netSalary: p.netSalary,
        status: p.status || "UNKNOWN",
      })),
      myLeadsCount: myLeadsResult[0]?.count ?? 0,
      hotLeadsCount: hotLeadsResult[0]?.count ?? 0,
      myOpenDealsCount: myOpenDealsResult[0]?.count ?? 0,
      topLeads,
    };
  }

  private buildContextPrompt(context: ChatContext): string {
    return `You are 'StreamlineOS', an intelligent AI assistant for the StreamlineOS platform.

## Current User Context
**Projects & Tickets**: ${context.projectCount} projects, ${context.ticketCount} tickets
**Attendance today**: ${
      context.todayAttendance
        ? `${context.todayAttendance.checkedIn ? "Checked in" : "Not checked in"}${context.todayAttendance.checkedOut ? ", checked out" : ""}${context.todayAttendance.workHours ? `, worked ${context.todayAttendance.workHours} hrs` : ""}`
        : "No attendance record"
    }
**Leaves**: ${context.pendingLeaves} pending leave requests
**Payroll**: ${context.recentPayrolls.map((p) => `${p.month} (${p.status})`).join(", ") || "None"}

## CRM Context
**My Leads**: ${context.myLeadsCount} assigned leads (${context.hotLeadsCount} HOT priority org-wide)
**My Open Deals**: ${context.myOpenDealsCount} active deals in pipeline
**Recent Leads**:
${context.topLeads.map((l) => `  - ${l.name} — ${l.status}${l.priority ? ` [${l.priority}]` : ""}`).join("\n") || "  None"}

## Capabilities
1. **HR**: Attendance, leaves, payroll, employee management, headcount, attrition, mood, policies
2. **Projects**: Tickets (read, create, update status, comment), sprints, burndown, time tracking, AI project analysis, calendar reminders from tickets
3. **CRM**: Leads, deals, pipeline, client management
4. **Calendar**: Schedule meetings and events, view your own schedule
5. **Analytics**: Team performance, conversion rates, pipeline health
6. **Knowledge Base**: Search wiki pages, uploaded documents, company policies, and notes
7. **Messaging**: Send direct messages, post to channels, send email, search chat history
8. **Inventory**: Look up product stock availability
9. **People Directory**: Find org members and their ticket stats
10. **Recognition**: Send kudos and recognition badges to team members
11. **Bonus**: Draft bonus proposals for HR review (draft only)

## Available Actions
You can take the following actions on behalf of the user when asked:

**CRM**
- **updateLeadStatus**: Change a lead's status or priority
- **createTask**: Create a new task (call, email, meeting, or custom)
- **searchLeads**: Search leads by name or company

**Projects**
- **searchProjects**: Find projects by name (use before askProjectAI / getProjectSummary)
- **askProjectAI**: Ask an AI question about a specific project
- **getProjectSummary**: Get an AI health summary for a specific project
- **readTicket**: Read a specific ticket by its numeric ID
- **searchTickets**: Search tickets by title; optionally filter by project or status
- **createTicket**: Create a new ticket (requires confirmation)
- **updateTicketStatus**: Change a ticket's status (requires confirmation)
- **addTicketComment**: Post a comment on a ticket (requires confirmation)

**Calendar**
- **scheduleEvent**: Schedule a calendar event. Always confirm details with user first.
- **getMyCalendarEvents**: View your own upcoming calendar events (max 62-day range)
- **createCalendarReminder**: Create a reminder event, optionally linked to a ticket (requires confirmation)

**Email**
- **sendEmail**: Send an email on behalf of the user (requires confirmation)

**Channel Messages**
- **postChannelMessage**: Post a message to a named channel (requires confirmation)

**Recognition**
- **grantRecognition**: Send a kudos/recognition badge to a team member (requires confirmation)

**Bonus**
- **grantBonus**: Grant a bonus to an employee — creates a PENDING bonus that a payroll admin approves before payout (requires confirmation)

**Mail**
- **listRecentEmails**: List recent emails from the user's connected inbox (requires confirmation)
- **summarizeMailThread**: Summarize an email thread and suggest a reply
- **sendMailFromAccount**: Send an email from the user's connected mail account (requires confirmation)

**Knowledge Base**
- **searchKnowledgeBase**: Search org wiki, documents, and policies

**Chat**
- **sendDirectMessage**: Send a direct message to a team member. Confirm recipient and message first.
- **searchChatMessages**: Search messages in channels you belong to

**HR Copilot**
- **askHrPolicy**: Answer questions grounded in your org's active HR policies
- **getHeadcountSummary**: Total/active/probation/notice headcount (requires hr analytics access)
- **getAttritionSummary**: Exits and attrition rate over the last 12 months (requires hr analytics access)
- **getMoodTrend**: Weekly mood check-in trend for the past 30 days (requires engagement access)
- **getLeaveUtilization**: Who is on leave, pending requests, approved this month (requires leaves access)
- **draftPerformanceReviewNote**: AI-drafted performance review note (DRAFT only, requires approval)
- **draftPromotionLetter**: AI-drafted promotion letter (DRAFT only, requires approval)

**People & Tickets**
- **findPerson**: Resolve a person's name to their org profile. ALWAYS call this first when the user asks about a specific person's work.
- **getPersonTicketStats**: Ticket totals per project for a specific person. ALWAYS call findPerson first to get their userId.

**Inventory**
- **getInventoryStock**: Search products by name and view on-hand/available stock

**Payroll & Leaves**
- **getPayrollSummary**: Payroll run summary (counts and net totals by status; never exposes individual salaries for others)
- **getMyLeaveBalances**: Your own leave balances for the current year

## Routing rules (IMPORTANT)
- For questions about a specific person's work or tickets: ALWAYS call findPerson first, then getPersonTicketStats. Never answer from memory or training data.
- When a tool returns \`{ denied: true, reason }\`: tell the user you don't have permission to access that data. Do not speculate or provide alternative data. Do not retry with different parameters.
- Always confirm details before scheduling events or sending messages on the user's behalf.

## Confirmation Protocol
When you call a consequential write tool (createTicket, updateTicketStatus, addTicketComment, createCalendarReminder, sendEmail, postChannelMessage, grantRecognition, grantBonus, sendMailFromAccount) and the tool returns { requiresConfirmation: true, proposalId, token, action, summary, preview }, you MUST output EXACTLY this JSON on a line by itself (no markdown, no extra text before or after):

CONFIRM_ACTION:{"requiresConfirmation":true,"proposalId":<id>,"token":"<token>","action":"<action>","summary":"<summary>","preview":<preview_object>}

Do not add any explanation before or after this line. The UI will render a confirmation card for the user.

Tone: Professional, concise, actionable.`;
  }

  async processChat(
    messages: ChatMessage[],
    actor: CurrentUserContext,
    conversationId?: number,
    persona?: string,
  ) {
    const { userId, orgId } = actor;

    const reserveMilli = getReserveEstimateMilli(CHAT_FEATURE);
    let reservationId = 0;
    try {
      const reserved = await this.ledger.reserve({ orgId, userId, feature: CHAT_FEATURE, credits: reserveMilli });
      reservationId = reserved.reservationId;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error.message ?? "Insufficient AI credits");
      }
      throw error;
    }

    const context = await this.fetchContext(userId, orgId);
    const basePrompt = this.buildContextPrompt(context);
    const personaConfig = persona ? getPersona(persona) : undefined;
    const contextPrompt = personaConfig ? `${personaConfig.preamble}\n\n${basePrompt}` : basePrompt;

    const latest = messages.at(-1);
    if (latest?.role === "user") {
      if (conversationId !== undefined) {
        await this.history.appendToConversation(orgId, userId, conversationId, "user", latest.content);
      } else {
        await this.history.append(orgId, userId, "user", latest.content);
      }
    }

    const modelMessages: ModelMessage[] = messages.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: m.content },
    );

    const modelId = resolveChatModelId();

    const inlineTools = {
      searchProjects: tool({
        description: "Search for projects by name to get their IDs. Use before calling askProjectAI or getProjectSummary when you only have a project name.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Partial project name to search"),
        }),
        execute: async ({ query }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:view");
          if (deny) return { denied: true, reason: deny };

          const results = await this.db
            .select({ id: projects.id, name: projects.name, key: projects.key, status: projects.status })
            .from(projects)
            .where(and(eq(projects.orgId, orgId), ne(projects.status, "ARCHIVED"), ilike(projects.name, `%${query}%`)))
            .limit(10);
          if (results.length === 0) return { results: [], message: `No projects found matching "${query}".` };
          return { results, message: `Found ${results.length} project(s).` };
        },
      }),

      askProjectAI: tool({
        description: "Ask an AI question about a specific project — e.g. what's blocked, why is it late, what are the risks. Requires a projectId; use searchProjects first if you only have a name.",
        inputSchema: z.object({
          projectId: z.number().int().positive().describe("Numeric project ID"),
          question: z.string().min(1).describe("Question to ask about the project"),
        }),
        execute: async ({ projectId, question }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:ai:use");
          if (deny) return { denied: true, reason: deny };

          try {
            return await this.projectsAi.ask(orgId, projectId, question, userId);
          } catch (_e) {
            return { success: false, message: `Project ${projectId} not found or has no ticket data.` };
          }
        },
      }),

      getProjectSummary: tool({
        description: "Get an AI-generated summary of a project's health, progress, and highlights. Requires a projectId; use searchProjects first if you only have a name.",
        inputSchema: z.object({
          projectId: z.number().int().positive().describe("Numeric project ID"),
        }),
        execute: async ({ projectId }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "build:ai:use");
          if (deny) return { denied: true, reason: deny };

          try {
            return await this.projectsAi.summarize(orgId, projectId, userId);
          } catch (_e) {
            return { success: false, message: `Project ${projectId} not found or has no ticket data.` };
          }
        },
      }),

      searchKnowledgeBase: tool({
        description:
          "Search the organization's knowledge base (wiki pages and uploaded documents/notes) to answer the user's question with grounded information. Use this whenever the user asks about company docs, policies, uploaded files, notes, or wiki content.",
        inputSchema: z.object({
          query: z.string().describe("The question to answer from the knowledge base"),
        }),
        execute: async ({ query }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "kb:articles:view");
          if (deny) return { denied: true, reason: deny };

          try {
            const kbAsk = this.moduleRef.get(KbAskService, { strict: false });
            const result = await kbAsk.ask(actor, { question: query });
            return { answer: result.answer, hasContext: result.hasContext };
          } catch (_e) {
            return { answer: "Knowledge base search is unavailable right now.", hasContext: false };
          }
        },
      }),
    };

    const allBuiltTools = {
      ...this.hrCopilot.buildTools({ orgId, userId }),
      ...this.workspaceCopilot.buildTools({ actor }),
      ...this.opsCopilot.buildTools({ actor }),
      ...this.crmCopilot.buildTools({ actor }),
      ...this.commsCopilot.buildTools({ actor }),
      ...this.projectsCopilot.buildTools({ actor }),
      ...this.commsActions.buildTools({ actor }),
      ...this.mailCopilot.buildTools({ actor }),
      ...inlineTools,
    };

    const effectiveTools = persona ? filterToolsByPersona(allBuiltTools, persona) : allBuiltTools;

    const buildStream = () => streamText({
      model: resolveChatModel(),
      messages: modelMessages,
      system: contextPrompt,
      temperature: 0.7,
      stopWhen: stepCountIs(10),
      onFinish: async ({ text, usage }) => {
        const promptTokens = usage?.inputTokens ?? 0;
        const completionTokens = usage?.outputTokens ?? 0;
        const { costUsd, milliCredits } = computeTokenCharge(modelId, promptTokens, completionTokens);
        void this.ledger.settle(reservationId, {
          actualMilli: milliCredits,
          model: modelId,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          costUsd,
        }).catch(() => undefined);
        void this.usageSvc.track({
          orgId,
          userId,
          feature: CHAT_FEATURE,
          model: modelId,
          promptTokens,
          completionTokens,
          creditsMilli: milliCredits,
        }).catch(() => undefined);
        try {
          if (conversationId !== undefined) {
            await this.history.appendToConversation(orgId, userId, conversationId, "assistant", text);
          } else {
            await this.history.append(orgId, userId, "assistant", text);
          }
        } catch (error) {
          logger.error("Failed to persist assistant chat message", { error });
        }
      },
      tools: effectiveTools,
    });

    try {
      return buildStream();
    } catch (error) {
      void this.ledger.release(reservationId, "stream_setup_error").catch(() => undefined);
      throw error;
    }
  }
}
