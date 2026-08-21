import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, gte, lte, eq } from "drizzle-orm";
import {
  leaveRequests,
  leaveTypes,
  reviewCycles,
  travelRequests,
  interviews,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { listCompatibleHolidays } from "../../../db/compat/organization-holidays";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { HrCalendarInput } from "./dto/hr-calendar.schemas";
import { CelebrationsService } from "../directory/celebrations.service";

export type CalendarEventType =
  | "HOLIDAY"
  | "LEAVE"
  | "BIRTHDAY"
  | "ANNIVERSARY"
  | "REVIEW_CYCLE"
  | "TRAVEL"
  | "INTERVIEW";

export interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
  date: string;
  endDate?: string;
  meta?: Record<string, unknown>;
}

const MAX_WINDOW_DAYS = 62;

@Injectable()
export class HrCalendarService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly celebrations: CelebrationsService,
  ) {}

  async getEvents(user: CurrentUserContext, input: HrCalendarInput): Promise<CalendarEvent[]> {
    const from = new Date(input.from);
    const to = new Date(input.to);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException("Invalid date range.");
    }

    const diffDays = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > MAX_WINDOW_DAYS) {
      throw new BadRequestException(`Date window must not exceed ${MAX_WINDOW_DAYS} days.`);
    }

    const fromStr = input.from;
    const toStr = input.to;

    const types = input.types ?? [
      "HOLIDAY",
      "LEAVE",
      "BIRTHDAY",
      "ANNIVERSARY",
      "REVIEW_CYCLE",
      "TRAVEL",
      "INTERVIEW",
    ];

    const isAdmin = user.isOrgOwner || user.permissions.includes("hr:helpdesk:manage");
    const canSeeTravel = isAdmin || user.permissions.includes("hr:travel:view");
    const canSeeInterviews = isAdmin || user.permissions.includes("hr:interviews:view");

    const events: CalendarEvent[] = [];
    const fetches: Promise<void>[] = [];

    if (types.includes("HOLIDAY")) {
      fetches.push(
        listCompatibleHolidays(this.db, user.orgId, fromStr, toStr)
          .then((rows) => {
            for (const r of rows) {
              events.push({ id: `holiday-${r.id}`, type: "HOLIDAY", title: r.name, date: r.date });
            }
          }),
      );
    }

    if (types.includes("LEAVE")) {
      fetches.push(
        this.db
          .select({
            id: leaveRequests.id,
            userId: leaveRequests.userId,
            startDate: leaveRequests.startDate,
            endDate: leaveRequests.endDate,
            typeName: leaveTypes.name,
            userName: users.name,
          })
          .from(leaveRequests)
          .leftJoin(leaveTypes, eq(leaveRequests.leaveTypeId, leaveTypes.id))
          .leftJoin(users, eq(leaveRequests.userId, users.id))
          .where(
            and(
              eq(leaveRequests.orgId, user.orgId),
              eq(leaveRequests.status, "APPROVED"),
              lte(leaveRequests.startDate, toStr),
              gte(leaveRequests.endDate, fromStr),
            ),
          )
          .limit(500)
          .then((rows) => {
            for (const r of rows) {
              events.push({
                id: `leave-${r.id}`,
                type: "LEAVE",
                title: `${r.userName ?? "Employee"} – ${r.typeName ?? "Leave"}`,
                date: r.startDate,
                endDate: r.endDate,
                meta: { userId: r.userId },
              });
            }
          }),
      );
    }

    if (types.includes("BIRTHDAY") || types.includes("ANNIVERSARY")) {
      fetches.push(
        this.celebrations
          .getAnniversaryFeed(user.orgId, user.userId, "all")
          .then((feed) => {
          for (const item of feed) {
            if (
              item.type === "BIRTHDAY" &&
              types.includes("BIRTHDAY") &&
              item.dateStr >= fromStr.slice(0, 5) &&
              item.dateStr <= toStr.slice(0, 5)
            ) {
              const year = from.getFullYear();
              events.push({
                id: `birthday-${item.userId}`,
                type: "BIRTHDAY",
                title: `${item.name ?? "Employee"}'s Birthday`,
                date: `${year}-${item.dateStr}`,
                meta: { userId: item.userId },
              });
            }
            if (
              item.type === "WORK_ANNIVERSARY" &&
              types.includes("ANNIVERSARY") &&
              item.dateStr >= fromStr.slice(0, 5) &&
              item.dateStr <= toStr.slice(0, 5)
            ) {
              const year = from.getFullYear();
              events.push({
                id: `anniversary-${item.userId}`,
                type: "ANNIVERSARY",
                title: `${item.name ?? "Employee"}'s ${item.yearsCount ?? ""} Year Anniversary`,
                date: `${year}-${item.dateStr}`,
                meta: { userId: item.userId, years: item.yearsCount },
              });
            }
          }
          }),
      );
    }

    if (types.includes("REVIEW_CYCLE")) {
      fetches.push(
        this.db
          .select({
            id: reviewCycles.id,
            name: reviewCycles.name,
            periodStart: reviewCycles.periodStart,
            periodEnd: reviewCycles.periodEnd,
            deadline: reviewCycles.deadline,
          })
          .from(reviewCycles)
          .where(
            and(
              eq(reviewCycles.orgId, user.orgId),
              lte(reviewCycles.periodStart, toStr),
              gte(reviewCycles.periodEnd, fromStr),
            ),
          )
          .limit(50)
          .then((rows) => {
            for (const r of rows) {
              events.push({
                id: `review-${r.id}`,
                type: "REVIEW_CYCLE",
                title: r.name,
                date: r.deadline ?? r.periodEnd,
                endDate: r.periodEnd,
                meta: { cycleId: r.id },
              });
            }
          }),
      );
    }

    if (types.includes("TRAVEL") && canSeeTravel) {
      fetches.push(
        this.db
          .select({
            id: travelRequests.id,
            userId: travelRequests.userId,
            destination: travelRequests.destination,
            departureDate: travelRequests.departureDate,
            returnDate: travelRequests.returnDate,
            userName: users.name,
          })
          .from(travelRequests)
          .leftJoin(users, eq(travelRequests.userId, users.id))
          .where(
            and(
              eq(travelRequests.orgId, user.orgId),
              lte(travelRequests.departureDate, toStr),
              gte(travelRequests.returnDate, fromStr),
            ),
          )
          .limit(100)
          .then((rows) => {
            for (const r of rows) {
              events.push({
                id: `travel-${r.id}`,
                type: "TRAVEL",
                title: `${r.userName ?? "Employee"} – ${r.destination}`,
                date: r.departureDate,
                endDate: r.returnDate,
                meta: { userId: r.userId },
              });
            }
          }),
      );
    }

    if (types.includes("INTERVIEW") && canSeeInterviews) {
      fetches.push(
        this.db
          .select({
            id: interviews.id,
            candidateId: interviews.candidateId,
            scheduledAt: interviews.scheduledAt,
            type: interviews.type,
          })
          .from(interviews)
          .where(
            and(
              eq(interviews.orgId, user.orgId),
              gte(interviews.scheduledAt, from),
              lte(interviews.scheduledAt, to),
            ),
          )
          .limit(100)
          .then((rows) => {
            for (const r of rows) {
              const dateStr = r.scheduledAt.toISOString().slice(0, 10);
              events.push({
                id: `interview-${r.id}`,
                type: "INTERVIEW",
                title: `Interview (${r.type})`,
                date: dateStr,
                meta: { candidateId: r.candidateId },
              });
            }
          }),
      );
    }

    await Promise.all(fetches);

    events.sort((a, b) => a.date.localeCompare(b.date));
    return events;
  }
}
