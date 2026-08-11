import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, projects, tickets } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesReadService } from "./entries-read.service";
import { EntriesPeriodService } from "./entries-period.service";
import { roundHours } from "./lib/rounding";
import { formatDateOnly } from "./lib/period.helpers";
import type {
  CreateEntryInput,
  UpdateEntryInput,
  VoidEntryInput,
  EntriesQuery,
} from "./dto/entries.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class EntriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: TimesheetsAuditService,
    private readonly reader: EntriesReadService,
    private readonly periodService: EntriesPeriodService,
  ) {}

  listEntries(u: CurrentUserContext, query: EntriesQuery) {
    return this.reader.listEntries(u, query);
  }

  getEntryById(orgId: string, entryId: number) {
    return this.reader.getEntryById(orgId, entryId);
  }

  recomputePeriodTotals(
    orgId: string,
    periodId: number,
    dbOrTx?: Pick<Db, "select" | "update">,
  ): Promise<void> {
    return this.periodService.recomputePeriodTotals(orgId, periodId, dbOrTx);
  }

  private async assertTicketInOrg(orgId: string, ticketId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Ticket not found");
  }

  private async assertProjectInOrg(orgId: string, projectId: number): Promise<void> {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException("Project not found");
  }

  async createEntry(u: CurrentUserContext, input: CreateEntryInput) {
    const settings = await this.periodService.loadSettings(u.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;
    const maxHoursPerDay = parseFloat(settings?.maxHoursPerDay ?? "24");
    const allowBackdated = settings?.allowBackdatedEntries ?? true;
    const backdateLimitDays = settings?.backdateLimitDays ?? null;
    const hours = roundHours(input.hours, settings?.roundingRule);

    const today = formatDateOnly(new Date());
    const allowFuture = settings?.allowFutureEntries ?? false;
    if (!allowFuture && input.date > today) {
      throw new BadRequestException("Future-dated entries are not allowed");
    }
    if (!allowBackdated && input.date < today) {
      throw new BadRequestException("Backdated entries are not allowed");
    }
    if (backdateLimitDays !== null && input.date < today) {
      const diffDays = Math.floor(
        (new Date(today).getTime() -
          new Date(input.date + "T12:00:00").getTime()) /
          86_400_000,
      );
      if (diffDays > backdateLimitDays) {
        throw new BadRequestException(
          `Cannot log time more than ${backdateLimitDays} days in the past`,
        );
      }
    }

    const requiredFields =
      (settings?.requiredFields as string[] | null) ?? [];
    if (
      requiredFields.includes("project") &&
      !input.projectId &&
      !input.ticketId
    ) {
      throw new BadRequestException("Field 'project' is required");
    }
    if (requiredFields.includes("description") && !input.description) {
      throw new BadRequestException("Field 'description' is required");
    }
    if (requiredFields.includes("ticket") && !input.ticketId) {
      throw new BadRequestException("Field 'ticket' is required");
    }

    const [dailyHours] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(hours::numeric), 0)::text`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, u.orgId),
          eq(timesheets.userId, u.userId),
          eq(timesheets.date, input.date),
          isNull(timesheets.voidedAt),
        ),
      );

    const currentTotal = parseFloat(dailyHours?.total ?? "0");
    if (currentTotal + hours > maxHoursPerDay) {
      throw new BadRequestException(
        `Logging ${hours}h would exceed the daily limit of ${maxHoursPerDay}h`,
      );
    }

    const billingType =
      input.billingType ?? (input.isBillable ? "BILLABLE" : "NON_BILLABLE");
    const isBillable = input.isBillable ?? billingType === "BILLABLE";

    if (input.ticketId != null || input.projectId != null) {
      await Promise.all([
        input.ticketId != null
          ? this.assertTicketInOrg(u.orgId, input.ticketId)
          : Promise.resolve(),
        input.projectId != null
          ? this.assertProjectInOrg(u.orgId, input.projectId)
          : Promise.resolve(),
      ]);
    }

    const entry = await this.db.transaction(async (tx) => {
      const periodId = await this.periodService.getOrCreatePeriod(
        u.orgId,
        u.userId,
        input.date,
        workWeekStart,
        tx,
      );

      const [inserted] = await tx
        .insert(timesheets)
        .values({
          orgId: u.orgId,
          userId: u.userId,
          ticketId: input.ticketId ?? null,
          projectId: input.projectId ?? null,
          date: input.date,
          hours: hours.toString(),
          description: input.description ?? null,
          isBillable,
          billingType,
          workLink: input.workLink ?? null,
          source: input.source ?? "MANUAL",
          timesheetPeriodId: periodId,
          status: "PENDING",
          invoicingStatus: "UNINVOICED",
          payrollStatus: "UNPROCESSED",
        })
        .returning();

      if (!inserted)
        throw new ConflictException("Could not create the time entry");

      if (input.ticketId) {
        await this.periodService.syncTicketTimeSpent(tx, u.orgId, input.ticketId);
      }

      await this.periodService.recomputePeriodTotals(u.orgId, periodId, tx);

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "entry",
        entityId: inserted.id.toString(),
        action: "entry.created",
        after: {
          hours,
          ...(hours !== input.hours ? { rawHours: input.hours } : {}),
          date: input.date,
          projectId: input.projectId,
          ticketId: input.ticketId,
        },
      });

      return inserted;
    });

    return this.reader.getEntryById(u.orgId, entry.id);
  }

  async updateEntry(
    u: CurrentUserContext,
    entryId: number,
    input: UpdateEntryInput,
  ) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

    if (entry.voidedAt)
      throw new ConflictException("Voided entries cannot be edited");
    if (entry.lockedAt)
      throw new ConflictException("Locked entries cannot be edited");
    if (entry.payrollStatus === "EXPORTED")
      throw new ConflictException("Exported entries cannot be edited");
    if (entry.invoicingStatus !== "UNINVOICED")
      throw new ConflictException("Invoiced entries cannot be edited");
    if (!["PENDING", "REJECTED"].includes(entry.status))
      throw new ConflictException(
        "Only pending or rejected entries can be edited",
      );
    if (entry.submittedAt)
      throw new ConflictException("Submitted entries cannot be edited");

    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const canManage =
      perms.has("timesheets:approvals:manage") ||
      u.isOrgOwner;
    if (!canManage && entry.userId !== u.userId) {
      throw new ForbiddenException(
        "You can only edit your own time entries",
      );
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (input.hours !== undefined) {
      const settings = await this.periodService.loadSettings(u.orgId);
      updateData.hours = roundHours(
        input.hours,
        settings?.roundingRule,
      ).toString();
    }
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.isBillable !== undefined)
      updateData.isBillable = input.isBillable;
    if (input.billingType !== undefined) {
      updateData.billingType = input.billingType;
      if (input.isBillable === undefined) {
        updateData.isBillable = input.billingType === "BILLABLE";
      }
    }
    if (input.projectId !== undefined) updateData.projectId = input.projectId;
    if (input.workLink !== undefined) updateData.workLink = input.workLink;

    if (input.projectId != null) {
      await this.assertProjectInOrg(u.orgId, input.projectId);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheets)
        .set(updateData)
        .where(
          and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)),
        );

      if (input.hours !== undefined && entry.ticketId) {
        await this.periodService.syncTicketTimeSpent(tx, u.orgId, entry.ticketId);
      }

      if (entry.timesheetPeriodId) {
        await this.periodService.recomputePeriodTotals(
          u.orgId,
          entry.timesheetPeriodId,
          tx,
        );
      }

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "entry",
        entityId: entryId.toString(),
        action: "entry.updated",
        before: { hours: entry.hours, description: entry.description },
        after: updateData,
      });
    });

    return this.reader.getEntryById(u.orgId, entryId);
  }

  async voidEntry(
    u: CurrentUserContext,
    entryId: number,
    input: VoidEntryInput,
  ) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException("Exported entries cannot be voided");
    }
    if (["INVOICE_DRAFTED", "INVOICED"].includes(entry.invoicingStatus)) {
      throw new ConflictException("Invoiced entries cannot be voided");
    }

    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const canManage =
      perms.has("timesheets:approvals:manage") ||
      u.isOrgOwner;
    if (!canManage && entry.userId !== u.userId) {
      throw new ForbiddenException(
        "You can only void your own time entries",
      );
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheets)
        .set({
          voidedAt: new Date(),
          voidReason: input.reason,
          updatedAt: new Date(),
        })
        .where(
          and(eq(timesheets.id, entryId), eq(timesheets.orgId, u.orgId)),
        );

      if (entry.ticketId) {
        await this.periodService.syncTicketTimeSpent(tx, u.orgId, entry.ticketId);
      }

      if (entry.timesheetPeriodId) {
        await this.periodService.recomputePeriodTotals(
          u.orgId,
          entry.timesheetPeriodId,
          tx,
        );
      }

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "entry",
        entityId: entryId.toString(),
        action: "entry.voided",
        reason: input.reason,
        before: { status: entry.status, hours: entry.hours },
      });
    });

    return { success: true };
  }
}
