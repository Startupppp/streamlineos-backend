import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheets,
  organizationMembers,
} from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { PeriodsReadService } from "./periods-read.service";
import { PeriodsSubmitService } from "./periods-submit.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { weekRange } from "./lib/period.helpers";
import type { PeriodsQuery } from "./dto/periods.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reader: PeriodsReadService,
    private readonly submit: PeriodsSubmitService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  listPeriods(u: CurrentUserContext, query: PeriodsQuery) {
    return this.reader.listPeriods(u, query);
  }

  getPeriod(u: CurrentUserContext, periodId: number) {
    return this.reader.getPeriod(u, periodId);
  }

  submitPeriod(u: CurrentUserContext, periodId: number) {
    return this.submit.submitPeriod(u, periodId);
  }

  private async findOrCreateCurrentPeriod(orgId: string, userMembershipId: number, workWeekStart: number) {
    const range = weekRange(new Date(), workWeekStart);

    const [existing] = await this.db
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(and(
        eq(timesheetPeriods.orgId, orgId),
        eq(timesheetPeriods.userMembershipId, userMembershipId),
        eq(timesheetPeriods.periodStart, range.start),
        eq(timesheetPeriods.periodEnd, range.end),
      ))
      .limit(1);

    if (existing) return existing.id;

    const [created] = await this.db
      .insert(timesheetPeriods)
      .values({
        orgId, userMembershipId,
        periodStart: range.start, periodEnd: range.end,
        status: "OPEN", totalHours: "0", billableHours: "0", nonBillableHours: "0",
      })
      .returning({ id: timesheetPeriods.id });

    if (!created) throw new Error("Failed to create timesheet period");
    return created.id;
  }

  async getCurrent(u: CurrentUserContext) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      throw new UnprocessableEntityException("Cannot create a period for a non-human session");

    const settings = await this.reader.getSettings(u.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;
    const periodId = await this.findOrCreateCurrentPeriod(u.orgId, membershipId, workWeekStart);

    const [row, periodEntries] = await Promise.all([
      this.reader.getPeriodWithUser(u.orgId, periodId),
      this.db.query.timesheets.findMany({
        where: and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)),
        orderBy: [desc(timesheets.date)],
      }),
    ]);

    if (!row) throw new NotFoundException("Period not found");
    return { period: this.reader.mapPeriod(row), entries: periodEntries };
  }

  async recallPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (row.userMembershipId !== actorMembId) throw new ForbiddenException("You can only recall your own period");
    if (row.status !== "SUBMITTED") throw new ConflictException("Only submitted periods can be recalled");

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({ status: "DRAFT", submittedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx.update(timesheets)
        .set({ submittedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: actorMembId,
        entityType: "period", entityId: periodId.toString(), action: "period.recalled",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after recall");
    return this.reader.mapPeriod(updated);
  }

  async reopenPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");
    if (!["APPROVED", "LOCKED"].includes(row.status))
      throw new ConflictException("Only approved or locked periods can be reopened");

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({ status: "DRAFT", lockedAt: null, approvedAt: null, approvedByMembershipId: null, updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx.update(timesheets)
        .set({ lockedAt: null, lockedByMembershipId: null, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: actorMembId,
        entityType: "period", entityId: periodId.toString(), action: "period.reopened",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after reopen");
    return this.reader.mapPeriod(updated);
  }

  async lockPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    await this.db.transaction(async (tx) => {
      const [actorMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
        .limit(1);
      const lockedByMembershipId = actorMember?.id ?? null;

      await tx.update(timesheetPeriods)
        .set({ lockedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx.update(timesheets)
        .set({ lockedAt: new Date(), lockedByMembershipId, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: lockedByMembershipId,
        entityType: "period", entityId: periodId.toString(), action: "period.locked",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after lock");
    return this.reader.mapPeriod(updated);
  }

  async unlockPeriod(u: CurrentUserContext, periodId: number) {
    const actorMembId = actingMembershipId(u.principal);
    const row = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    await this.db.transaction(async (tx) => {
      await tx.update(timesheetPeriods)
        .set({ lockedAt: null, updatedAt: new Date() })
        .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, u.orgId)));

      await tx.update(timesheets)
        .set({ lockedAt: null, lockedByMembershipId: null, updatedAt: new Date() })
        .where(and(eq(timesheets.timesheetPeriodId, periodId), eq(timesheets.orgId, u.orgId)));

      await this.audit.record(tx, {
        orgId: u.orgId, actorMembershipId: actorMembId,
        entityType: "period", entityId: periodId.toString(), action: "period.unlocked",
      });
    });

    const updated = await this.reader.getPeriodWithUser(u.orgId, periodId);
    if (!updated) throw new NotFoundException("Period not found after unlock");
    return this.reader.mapPeriod(updated);
  }
}
