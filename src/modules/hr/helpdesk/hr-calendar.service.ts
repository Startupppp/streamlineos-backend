import { organizationWideCelebrationsRead } from "../directory/celebrations-scope";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, gt, gte, lte, eq } from "drizzle-orm";
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
import { MAX_WINDOW_DAYS, type CalendarEventType, type CalendarEvent, type HrCalendarInput } from "./dto/hr-calendar.schemas";
import { CelebrationsService } from "../directory/celebrations.service";
import { AccessService } from "../../access/access.service";
import { HR_SCAN_MAX_PAGES, HR_SCAN_PAGE } from "../hr-read-limits";

@Injectable()
export class HrCalendarService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly celebrations: CelebrationsService,
    private readonly access: AccessService,
  ) {}

  /**
   * A calendar window shows every approved leave in it or it is wrong, so this walks the
   * window in capped keyset pages on the primary key instead of truncating at one big read.
   */
  private approvedLeavePage(orgId: string, fromStr: string, toStr: string, afterId: number) {
    return this.db
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
          eq(leaveRequests.orgId, orgId),
          eq(leaveRequests.status, "APPROVED"),
          lte(leaveRequests.startDate, toStr),
          gte(leaveRequests.endDate, fromStr),
          gt(leaveRequests.id, afterId),
        ),
      )
      .orderBy(asc(leaveRequests.id))
      .limit(HR_SCAN_PAGE);
  }

  private async scanApprovedLeave(orgId: string, fromStr: string, toStr: string) {
    const rows: Awaited<ReturnType<HrCalendarService["approvedLeavePage"]>> = [];
    let afterId = 0;
    for (let page = 0; page < HR_SCAN_MAX_PAGES; page++) {
      const chunk = await this.approvedLeavePage(orgId, fromStr, toStr, afterId);
      rows.push(...chunk);
      if (chunk.length < HR_SCAN_PAGE) break;
      afterId = chunk[chunk.length - 1].id;
    }
    return rows;
  }

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

    const isAdmin = await this.access.holds(user, "hr:helpdesk:manage");
    const canSeeTravel = isAdmin || await this.access.holds(user, "hr:travel:view");
    const canSeeInterviews = isAdmin || await this.access.holds(user, "hr:interviews:view");

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
        this.scanApprovedLeave(user.orgId, fromStr, toStr).then((rows) => {
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
          .getAnniversaryFeed(organizationWideCelebrationsRead(user))
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
