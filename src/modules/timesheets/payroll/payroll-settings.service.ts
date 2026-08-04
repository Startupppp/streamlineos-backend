import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheetSettings } from "../../../db/schema";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
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
    private readonly audit: AuditService,
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
    const current = await this.fetchOrCreate(orgId);

    const updates: Partial<typeof timesheetSettings.$inferInsert> = {};
    if (input.payPeriod !== undefined) updates.payPeriod = input.payPeriod;
    if (input.overtimeDailyHours !== undefined) updates.overtimeDailyHours = input.overtimeDailyHours.toString();
    if (input.overtimeWeeklyHours !== undefined) updates.overtimeWeeklyHours = input.overtimeWeeklyHours.toString();
    if (input.includeNonBillable !== undefined) updates.includeNonBillable = input.includeNonBillable;
    if (input.payrollMapping !== undefined) updates.payrollMapping = input.payrollMapping;

    const [updated] = await this.db
      .update(timesheetSettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(timesheetSettings.orgId, orgId))
      .returning();

    if (!updated) throw new InternalServerErrorException("Timesheet settings could not be updated");

    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.payrollSettingsNamespace(orgId)),
      // Both APIs project the same timesheet_settings row.
      this.cache.invalidateNamespace(CACHE_KEYS.timesheetSettingsNamespace(orgId)),
    ]);
    if (
      input.overtimeDailyHours !== undefined ||
      input.overtimeWeeklyHours !== undefined ||
      input.includeNonBillable !== undefined
    ) {
      await this.cache.invalidateNamespace(CACHE_KEYS.payrollSummaryNamespace(orgId));
    }

    this.audit.log({
      action: "timesheets.payroll.settings_updated",
      userId,
      orgId,
      metadata: { before: current, after: input },
    });

    return toSettingsDto(updated);
  }
}
