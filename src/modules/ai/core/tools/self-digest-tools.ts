import { Injectable, Inject } from "@nestjs/common";
import { and, asc, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  attendance,
  calendarEvents,
  eventAttendees,
  leaveRequests,
  notifications,
  onboardingDocuments,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { ProjectsWorkQueryService } from "../../../build/core";
import { KbDocumentQueryService } from "../../../kb/document-query/kb-document-query.service";
import {
  defineTool,
  data,
  empty,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

type WorkRow = Awaited<ReturnType<ProjectsWorkQueryService["getAllWork"]>>["data"][number];

function projectTicketRow(row: WorkRow): Record<string, unknown> {
  return {
    id: row.id,
    ref:
      row.projectKey && row.ticketNumber
        ? `${row.projectKey}-${String(row.ticketNumber)}`
        : null,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueDate: row.dueDate,
  };
}

@AskOsTools()
@Injectable()
export class SelfDigestTools implements AskOsToolProvider {
  constructor(
    private readonly projectsWorkQuery: ProjectsWorkQueryService,
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly kbDocumentQuery: KbDocumentQueryService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [this.buildSummarizeMyDay(), this.buildSearchMyDocuments()];
  }

  private buildSummarizeMyDay(): AskOsToolDefinition {
    return defineTool({
      key: "summarizeMyDay",
      description:
        "Get a composite snapshot of the caller's day: current clock/attendance state, pending leave requests, assigned tickets, today's calendar events, and unread notification count. All five reads fire concurrently in one batch.",
      input: z.object({}),
      run: async (_input, ctx) => {
        const { userId, orgId, membershipId, today } = ctx.actor;

        const [attendanceRows, leaveRows, ticketsResult, calendarRows, notifCountRows] =
          await Promise.all([
            this.db.query.attendance.findMany({
              where: and(
                eq(attendance.orgId, orgId),
                eq(attendance.userId, userId),
                eq(attendance.date, today),
              ),
              orderBy: [desc(attendance.createdAt)],
              limit: 20,
              columns: {
                id: true,
                checkIn: true,
                checkOut: true,
                status: true,
                workHours: true,
              },
            }),
            this.db
              .select({
                id: leaveRequests.id,
                startDate: leaveRequests.startDate,
                endDate: leaveRequests.endDate,
                status: leaveRequests.status,
                reason: leaveRequests.reason,
              })
              .from(leaveRequests)
              .where(
                and(
                  eq(leaveRequests.orgId, orgId),
                  eq(leaveRequests.userId, userId),
                  eq(leaveRequests.status, "PENDING"),
                ),
              )
              .orderBy(desc(leaveRequests.id))
              .limit(10),
            this.projectsWorkQuery.getAllWork(ctx.caller, {
              scope: "mine",
              limit: 10,
              orderBy: "rank",
              status: undefined,
              priority: undefined,
              type: undefined,
              assigneeId: undefined,
              labelIds: undefined,
              cycleId: undefined,
              excludeStatus: undefined,
              projectIds: undefined,
            }),
            this.db
              .select({
                id: calendarEvents.id,
                title: calendarEvents.title,
                startDate: calendarEvents.startDate,
                endDate: calendarEvents.endDate,
                location: calendarEvents.location,
                category: calendarEvents.category,
                allDay: calendarEvents.allDay,
              })
              .from(calendarEvents)
              .leftJoin(
                eventAttendees,
                and(
                  eq(eventAttendees.orgId, calendarEvents.orgId),
                  eq(eventAttendees.eventId, calendarEvents.id),
                  eq(eventAttendees.membershipId, membershipId),
                ),
              )
              .where(
                and(
                  eq(calendarEvents.orgId, orgId),
                  sql`${calendarEvents.startDate}::date <= ${today}::date`,
                  sql`${calendarEvents.endDate}::date >= ${today}::date`,
                  or(
                    eq(calendarEvents.createdByMembershipId, membershipId),
                    isNotNull(eventAttendees.id),
                  ),
                ),
              )
              .orderBy(asc(calendarEvents.startDate))
              .limit(20),
            this.db
              .select({ unread: count() })
              .from(notifications)
              .where(
                and(
                  eq(notifications.orgId, orgId),
                  eq(notifications.membershipId, membershipId),
                  eq(notifications.isRead, false),
                  isNull(notifications.deletedAt),
                  isNull(notifications.archivedAt),
                ),
              ),
          ]);

        const openRecord =
          attendanceRows.find((r) => r.checkIn !== null && r.checkOut === null) ?? null;
        const latestRecord = openRecord ?? attendanceRows[0] ?? null;
        let clockStatus: "PRESENT" | "ON_BREAK" | "CHECKED_OUT" | "OFFLINE" = "OFFLINE";
        if (latestRecord !== null) {
          if (latestRecord.checkOut !== null) clockStatus = "CHECKED_OUT";
          else if (latestRecord.status === "ON_BREAK") clockStatus = "ON_BREAK";
          else clockStatus = "PRESENT";
        }

        return data({
          date: today,
          attendance: {
            status: clockStatus,
            clockedIn: openRecord !== null,
            lastRecord:
              latestRecord !== null
                ? {
                    checkIn: latestRecord.checkIn,
                    checkOut: latestRecord.checkOut,
                    workHours: latestRecord.workHours,
                  }
                : null,
          },
          pendingLeave: leaveRows,
          tickets: {
            items: ticketsResult.data.map(projectTicketRow),
            hasMore: ticketsResult.hasMore,
          },
          calendarEvents: calendarRows,
          unreadNotifications: Number(notifCountRows[0]?.unread ?? 0),
        });
      },
    });
  }

  private buildSearchMyDocuments(): AskOsToolDefinition {
    return defineTool({
      key: "searchMyDocuments",
      description:
        "Search the caller's own onboarding documents by file name and KB articles and pages by title. Results are strictly bound to the caller's identity and access — no other member's private documents, restricted articles, or inaccessible pages are returned.",
      input: z.object({
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      permission: "self:onboarding-docs",
      run: async (input, ctx) => {
        const { userId, orgId } = ctx.actor;
        const term = `%${input.query}%`;

        const [onboardingRows, kbDocuments] = await Promise.all([
          this.db
            .select({
              id: onboardingDocuments.id,
              fileName: onboardingDocuments.fileName,
              status: onboardingDocuments.status,
              fileSize: onboardingDocuments.fileSize,
              mimeType: onboardingDocuments.mimeType,
              createdAt: onboardingDocuments.createdAt,
            })
            .from(onboardingDocuments)
            .where(
              and(
                eq(onboardingDocuments.orgId, orgId),
                eq(onboardingDocuments.userId, userId),
                sql`${onboardingDocuments.fileName} ILIKE ${term}`,
              ),
            )
            .orderBy(desc(onboardingDocuments.createdAt))
            .limit(input.limit),
          this.kbDocumentQuery.searchDocuments(ctx.caller, input.query, input.limit),
        ]);

        if (onboardingRows.length === 0 && kbDocuments.length === 0)
          return empty("documents", `No documents matching "${input.query}" found.`);
        return data({ onboardingDocuments: onboardingRows, kbDocuments });
      },
    });
  }
}
