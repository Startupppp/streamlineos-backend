import { Inject, Injectable } from "@nestjs/common";
import { google } from "@ai-sdk/google";
import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import {
  attendance,
  deals,
  leads,
  leaveRequests,
  payrolls,
  projects,
  tasks,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { getTodayString } from "../ai-date.util";

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

@Injectable()
export class ChatAssistantService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
1. **HR**: Attendance, leaves, payroll, employee management
2. **Projects**: Tickets, sprints, burndown, time tracking
3. **CRM**: Leads, deals, pipeline, client management
4. **Analytics**: Team performance, conversion rates, pipeline health

## Available Actions
You can take the following actions on behalf of the user when asked:
- **updateLeadStatus**: Change a lead's status (NEW/CONTACTED/INTERESTED/QUALIFIED/CONVERTED/LOST) or priority (HOT/WARM/COLD)
- **createTask**: Create a new task (call, email, meeting, or custom) with optional due date
- **searchLeads**: Search leads by name or company to answer questions

Tone: Professional, concise, actionable. Always confirm before taking destructive actions.`;
  }

  async processChat(messages: ChatMessage[], userId: string, orgId: string) {
    const context = await this.fetchContext(userId, orgId);
    const contextPrompt = this.buildContextPrompt(context);

    const modelMessages: ModelMessage[] = messages.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: m.content },
    );

    return streamText({
      model: google("gemini-1.5-pro-latest"),
      messages: modelMessages,
      system: contextPrompt,
      temperature: 0.7,
      stopWhen: stepCountIs(5),
      tools: {
        updateLeadStatus: tool({
          description:
            "Update the status or priority of a lead by name or ID. Use when the user asks to move, update, or change a lead's status/priority.",
          inputSchema: z.object({
            leadIdentifier: z.string().describe("Lead name (partial) or numeric ID"),
            status: z.enum(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"]).optional(),
            priority: z.enum(["HOT", "WARM", "COLD"]).optional(),
          }),
          execute: async ({ leadIdentifier, status, priority }) => {
            const isNumeric = /^\d+$/.test(leadIdentifier.trim());
            const lead = await this.db.query.leads.findFirst({
              where: isNumeric
                ? and(eq(leads.id, Number(leadIdentifier)), eq(leads.orgId, orgId))
                : and(eq(leads.orgId, orgId), ilike(leads.name, `%${leadIdentifier}%`)),
            });
            if (!lead) return { success: false, message: `Lead "${leadIdentifier}" not found.` };

            const updateData: Partial<{ status: typeof lead.status; priority: typeof lead.priority }> = {};
            if (status) updateData.status = status;
            if (priority) updateData.priority = priority;
            if (Object.keys(updateData).length === 0) {
              return { success: false, message: "No status or priority provided to update." };
            }

            await this.db.update(leads).set(updateData).where(eq(leads.id, lead.id));
            return {
              success: true,
              message: `Lead "${lead.name}" updated: ${status ? `status → ${status}` : ""}${status && priority ? ", " : ""}${priority ? `priority → ${priority}` : ""}`,
            };
          },
        }),

        createTask: tool({
          description:
            "Create a new task for the user. Use when the user asks to create, add, or remind about a task.",
          inputSchema: z.object({
            title: z.string().min(1).max(200).describe("Task title"),
            notes: z.string().optional().describe("Additional notes"),
            type: z.enum(["CALL", "EMAIL", "MEETING", "CUSTOM"]).default("CUSTOM"),
            dueDate: z.string().optional().describe("ISO date string for due date, e.g. 2026-04-15"),
          }),
          execute: async ({ title, notes, type, dueDate }) => {
            await this.db.insert(tasks).values({
              orgId,
              title,
              notes: notes ?? null,
              type,
              status: "pending",
              assigneeId: userId,
              createdBy: userId,
              dueDate: dueDate ? new Date(dueDate) : null,
            });
            return { success: true, message: `Task "${title}" created successfully.` };
          },
        }),

        searchLeads: tool({
          description:
            "Search for leads by name, company, or status to answer user questions about their pipeline.",
          inputSchema: z.object({
            query: z.string().describe("Name, company, or partial match to search"),
            status: z.enum(["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"]).optional(),
            limit: z.number().int().min(1).max(10).default(5),
          }),
          execute: async ({ query, status, limit }) => {
            const results = await this.db.query.leads.findMany({
              where: and(
                eq(leads.orgId, orgId),
                ilike(leads.name, `%${query}%`),
                status ? eq(leads.status, status) : undefined,
              ),
              columns: { id: true, name: true, status: true, priority: true, company: true, potentialValue: true },
              orderBy: [desc(leads.createdAt)],
              limit,
            });
            if (results.length === 0) return { results: [], message: `No leads found matching "${query}".` };
            return { results, message: `Found ${results.length} lead(s).` };
          },
        }),
      },
    });
  }
}
