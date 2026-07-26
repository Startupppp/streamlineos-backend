import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetSettings } from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import type { UpdateCoreSettingsInput } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const PAYROLL_FIELDS = new Set([
  "payPeriod",
  "overtimeDailyHours",
  "overtimeWeeklyHours",
  "includeNonBillable",
  "payrollMapping",
]);

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: TimesheetsAuditService,
  ) {}

  async getSettings(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.timesheetSettings(orgId),
      () => this.fetchOrCreate(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchOrCreate(orgId: string) {
    const [existing] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);

    if (existing) return existing;

    const [created] = await this.db
      .insert(timesheetSettings)
      .values({ orgId })
      .returning();

    if (!created) throw new Error("Failed to initialize timesheet settings");
    return created;
  }

  async updateSettings(u: CurrentUserContext, input: UpdateCoreSettingsInput) {
    const before = await this.fetchOrCreate(u.orgId);
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if (PAYROLL_FIELDS.has(key)) continue;
      updateData[key] = value;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetSettings)
        .set(updateData)
        .where(eq(timesheetSettings.orgId, u.orgId));

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "settings",
        entityId: u.orgId,
        action: "settings.updated",
        before: before,
        after: updateData,
      });
    });

    await this.cache.invalidate(CACHE_KEYS.timesheetSettings(u.orgId));

    return this.fetchOrCreate(u.orgId);
  }
}
