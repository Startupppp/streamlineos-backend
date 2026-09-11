import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, projects, tickets } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { applyScope } from "../../access/apply-scope";
import { resolveEntriesScope } from "./timesheets-core-scope";
import { buildEntryShape } from "./lib/entry-shape";
import type { EntriesQuery } from "./dto/entries.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class EntriesReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listEntries(u: CurrentUserContext, query: EntriesQuery) {
    const scope = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const offset = (query.page - 1) * limit;

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      applyScope(scope, u.orgId, u.userId, { ownerColumn: timesheets.userId }),
    ];

    if (query.userId && scope === "all")
      conditions.push(eq(timesheets.userId, query.userId));
    if (query.projectId)
      conditions.push(eq(timesheets.projectId, query.projectId));
    if (query.ticketId)
      conditions.push(eq(timesheets.ticketId, query.ticketId));
    if (query.status) conditions.push(eq(timesheets.status, query.status));
    if (query.startDate)
      conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.billable === "true")
      conditions.push(eq(timesheets.isBillable, true));
    if (query.billable === "false")
      conditions.push(eq(timesheets.isBillable, false));

    const dp = alias(projects, "dp");
    const tp = alias(projects, "tp");

    const rows = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userId: timesheets.userId,
        ticketId: timesheets.ticketId,
        projectId: timesheets.projectId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billingType: timesheets.billingType,
        status: timesheets.status,
        submittedAt: timesheets.submittedAt,
        approvedBy: timesheets.approvedBy,
        approvedAt: timesheets.approvedAt,
        rejectionReason: timesheets.rejectionReason,
        lockedAt: timesheets.lockedAt,
        voidedAt: timesheets.voidedAt,
        invoicingStatus: timesheets.invoicingStatus,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        rateSource: timesheets.rateSource,
        source: timesheets.source,
        workLink: timesheets.workLink,
        timesheetPeriodId: timesheets.timesheetPeriodId,
        createdAt: timesheets.createdAt,
        updatedAt: timesheets.updatedAt,
        directProjectId: dp.id,
        directProjectName: dp.name,
        ticketRowId: tickets.id,
        ticketTitle: tickets.title,
        ticketTicketNumber: tickets.ticketNumber,
        ticketProjectId: tp.id,
        ticketProjectName: tp.name,
      })
      .from(timesheets)
      .leftJoin(dp, eq(timesheets.projectId, dp.id))
      .leftJoin(tickets, and(eq(timesheets.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .leftJoin(tp, eq(tickets.projectId, tp.id))
      .where(and(...conditions))
      .orderBy(desc(timesheets.date))
      .limit(limit)
      .offset(offset);

    return rows.map(buildEntryShape);
  }

  /**
   * One entry, WITHOUT a scope check — for handing back a row the caller has
   * just written.
   *
   * `listEntries` above applies `applyScope(..., { ownerColumn: timesheets.userId })`,
   * so a person with `own` scope sees only their own entries. This applies
   * nothing, and what it returns includes `billRate`, `currency`, `description`
   * and `workLink` — a colleague's commercial rate among them.
   *
   * That is safe today only because nothing routes to it: its two callers are
   * `createEntry` and `updateEntry`, both returning the row they have just
   * written after their own guards have run (`updateEntry` refuses unless the
   * caller manages entries or owns this one). A third caller was a public
   * passthrough on `EntriesService` with no caller of its own, now deleted.
   *
   * The name carries the warning because the next person to want "get one
   * entry" will find this first. Give a routed read its own method that takes
   * `CurrentUserContext` and applies the scope — do not add a parameter here.
   */
  async getEntryUnscoped(orgId: string, entryId: number) {
    const dp = alias(projects, "dp");
    const tp = alias(projects, "tp");

    const [row] = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userId: timesheets.userId,
        ticketId: timesheets.ticketId,
        projectId: timesheets.projectId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billingType: timesheets.billingType,
        status: timesheets.status,
        submittedAt: timesheets.submittedAt,
        approvedBy: timesheets.approvedBy,
        approvedAt: timesheets.approvedAt,
        rejectionReason: timesheets.rejectionReason,
        lockedAt: timesheets.lockedAt,
        voidedAt: timesheets.voidedAt,
        invoicingStatus: timesheets.invoicingStatus,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        rateSource: timesheets.rateSource,
        source: timesheets.source,
        workLink: timesheets.workLink,
        timesheetPeriodId: timesheets.timesheetPeriodId,
        createdAt: timesheets.createdAt,
        updatedAt: timesheets.updatedAt,
        directProjectId: dp.id,
        directProjectName: dp.name,
        ticketRowId: tickets.id,
        ticketTitle: tickets.title,
        ticketTicketNumber: tickets.ticketNumber,
        ticketProjectId: tp.id,
        ticketProjectName: tp.name,
      })
      .from(timesheets)
      .leftJoin(dp, eq(timesheets.projectId, dp.id))
      .leftJoin(tickets, and(eq(timesheets.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .leftJoin(tp, eq(tickets.projectId, tp.id))
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, orgId)));

    if (!row) throw new NotFoundException("Time entry not found");
    return buildEntryShape(row);
  }
}
