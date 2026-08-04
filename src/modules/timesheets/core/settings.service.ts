import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { timesheetSettings, timesheetSettingsHistory } from "../../../db/schema";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import type { UpdateCoreSettingsInput } from "./dto/settings.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
    return this.cache.cachedVersioned(
      CACHE_KEYS.timesheetSettingsNamespace(orgId),
      "settings",
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
    const { changeReason, ...fields } = input;

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (PAYROLL_FIELDS.has(key)) continue;
      if (key === "expectedDailyHours" || key === "expectedWeeklyHours") {
        updateData[key] = value === null ? null : String(value);
        continue;
      }
      updateData[key] = value;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(timesheetSettings)
        .set(updateData)
        .where(eq(timesheetSettings.orgId, u.orgId));

      const [current] = await tx
        .select()
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, u.orgId))
        .limit(1);

      // Append-only version history: every change produces a new numbered
      // snapshot so historical periods stay explainable after policy changes.
      const [latest] = await tx
        .select({ version: timesheetSettingsHistory.version })
        .from(timesheetSettingsHistory)
        .where(eq(timesheetSettingsHistory.orgId, u.orgId))
        .orderBy(desc(timesheetSettingsHistory.version))
        .limit(1)
        .for("update");

      await tx.insert(timesheetSettingsHistory).values({
        orgId: u.orgId,
        version: (latest?.version ?? 0) + 1,
        settings: current ?? updateData,
        changedBy: u.userId,
        changeReason: changeReason ?? null,
      });

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorUserId: u.userId,
        entityType: "settings",
        entityId: u.orgId,
        action: "settings.updated",
        before: before,
        after: updateData,
        reason: changeReason,
      });
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.timesheetSettingsNamespace(u.orgId));

    return this.fetchOrCreate(u.orgId);
  }

  async getSettingsHistory(orgId: string, limit = 50) {
    return this.db
      .select()
      .from(timesheetSettingsHistory)
      .where(eq(timesheetSettingsHistory.orgId, orgId))
      .orderBy(desc(timesheetSettingsHistory.version))
      .limit(Math.min(limit, 200));
  }
}
