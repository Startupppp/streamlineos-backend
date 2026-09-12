import { BadRequestException, Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers, timesheetSettings, timesheetSettingsHistory } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { TimesheetsAuditService } from "../core/timesheets-audit.service";
import { resolveMapping } from "./lib/payroll-calc";
import type { UpdateSettingsInput, PayrollSettingsDto } from "./dto/payroll.schemas";

function toSettingsDto(row: typeof timesheetSettings.$inferSelect): PayrollSettingsDto {
  return {
    payPeriod: row.payPeriod,
    overtimeDailyHours: parseFloat(row.overtimeDailyHours),
    overtimeWeeklyHours: parseFloat(row.overtimeWeeklyHours),
    includeNonBillable: row.includeNonBillable,
    payrollMapping: resolveMapping(row.payrollMapping),
  };
}

@Injectable()
export class PayrollSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async getSettings(orgId: string): Promise<PayrollSettingsDto> {
    return this.cache.cachedVersioned(
      CACHE_KEYS.payrollSettingsNamespace(orgId),
      "settings",
      () => this.fetchOrCreate(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchOrCreate(orgId: string): Promise<PayrollSettingsDto> {
    await this.db
      .insert(timesheetSettings)
      .values({ orgId })
      .onConflictDoNothing();

    const [row] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);

    if (!row) throw new InternalServerErrorException("Timesheet settings could not be initialized");
    return toSettingsDto(row);
  }

  async updateSettings(orgId: string, userId: string, input: UpdateSettingsInput): Promise<PayrollSettingsDto> {
    await this.fetchOrCreate(orgId);

    const { changeReason, ...fields } = input;
    const hasChange =
      fields.payPeriod !== undefined ||
      fields.overtimeDailyHours !== undefined ||
      fields.overtimeWeeklyHours !== undefined ||
      fields.includeNonBillable !== undefined ||
      fields.payrollMapping !== undefined;
    if (hasChange && !changeReason?.trim()) {
      throw new BadRequestException("A changeReason is required when changing payroll settings");
    }

    const updated = await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, orgId))
        .limit(1)
        .for("update");
      if (!before) throw new InternalServerErrorException("Timesheet settings could not be initialized");

      const updates: Partial<typeof timesheetSettings.$inferInsert> = { updatedAt: new Date() };
      if (fields.payPeriod !== undefined) updates.payPeriod = fields.payPeriod;
      if (fields.overtimeDailyHours !== undefined) updates.overtimeDailyHours = fields.overtimeDailyHours.toString();
      if (fields.overtimeWeeklyHours !== undefined) updates.overtimeWeeklyHours = fields.overtimeWeeklyHours.toString();
      if (fields.includeNonBillable !== undefined) updates.includeNonBillable = fields.includeNonBillable;
      if (fields.payrollMapping !== undefined) updates.payrollMapping = fields.payrollMapping;

      const [row] = await tx
        .update(timesheetSettings)
        .set(updates)
        .where(eq(timesheetSettings.orgId, orgId))
        .returning();
      if (!row) throw new InternalServerErrorException("Timesheet settings could not be updated");

      const [actorMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
        .limit(1);
      const changedByMembershipId = actorMember?.id ?? null;

      const [latest] = await tx
        .select({ version: timesheetSettingsHistory.version })
        .from(timesheetSettingsHistory)
        .where(eq(timesheetSettingsHistory.orgId, orgId))
        .orderBy(desc(timesheetSettingsHistory.version))
        .limit(1)
        .for("update");

      await tx.insert(timesheetSettingsHistory).values({
        orgId,
        version: (latest?.version ?? 0) + 1,
        settings: row,
        changedByMembershipId,
        changeReason: changeReason ?? null,
      });

      await this.audit.record(tx, {
        orgId,
        actorMembershipId: changedByMembershipId,
        entityType: "settings",
        entityId: orgId,
        action: "settings.updated",
        before,
        after: updates,
        reason: changeReason,
      });

      return row;
    });

    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.payrollSettingsNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.timesheetSettingsNamespace(orgId)),
    ]);
    if (
      fields.overtimeDailyHours !== undefined ||
      fields.overtimeWeeklyHours !== undefined ||
      fields.includeNonBillable !== undefined
    ) {
      await this.cache.invalidateNamespace(CACHE_KEYS.payrollSummaryNamespace(orgId));
    }

    return toSettingsDto(updated);
  }
}
