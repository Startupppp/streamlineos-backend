import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { timesheetSettings, timesheetSettingsHistory, organizationMembers } from "../../../db/schema";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
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

const MATERIAL_FIELDS = new Set([
  "workWeekStart",
  "requiredFields",
  "roundingRule",
  "maxHoursPerDay",
  "allowOverlappingEntries",
  "allowBackdatedEntries",
  "backdateLimitDays",
  "approvalMode",
  "approverSource",
  "clientApprovalEnabled",
  "lockAfterApproval",
  "lockAfterInvoice",
  "allowFutureEntries",
  "expectedDailyHours",
  "expectedWeeklyHours",
  "submissionGraceDays",
  "autoDraftFromAttendance",
]);

function isChanged(before: unknown, after: unknown): boolean {
  if (before === after) return false;
  if (before === null || before === undefined || after === null || after === undefined) {
    return true;
  }
  if (typeof after === "number" || typeof before === "number") {
    const a = Number(before);
    const b = Number(after);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a !== b;
  }
  if (typeof before === "object" || typeof after === "object") {
    return JSON.stringify(before) !== JSON.stringify(after);
  }
  return String(before) !== String(after);
}

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
    await this.fetchOrCreate(u.orgId);
    const { changeReason, ...fields } = input;

    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, u.orgId))
        .limit(1)
        .for("update");
      if (!before) throw new Error("Failed to load timesheet settings");

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      const stored = before as unknown as Record<string, unknown>;
      const materialChanges: string[] = [];

      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (PAYROLL_FIELDS.has(key)) continue;
        if (MATERIAL_FIELDS.has(key) && isChanged(stored[key], value)) {
          materialChanges.push(key);
        }
        if (key === "expectedDailyHours" || key === "expectedWeeklyHours") {
          updateData[key] = value === null ? null : String(value);
          continue;
        }
        updateData[key] = value;
      }

      if (materialChanges.length > 0 && !changeReason?.trim()) {
        throw new BadRequestException(
          `A changeReason is required when changing ${materialChanges.sort().join(", ")}`,
        );
      }

      const [actorMember] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
        .limit(1);
      const changedByMembershipId = actorMember?.id ?? null;

      await tx
        .update(timesheetSettings)
        .set(updateData)
        .where(eq(timesheetSettings.orgId, u.orgId));

      const [current] = await tx
        .select()
        .from(timesheetSettings)
        .where(eq(timesheetSettings.orgId, u.orgId))
        .limit(1);

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
        changedByMembershipId,
        changeReason: changeReason ?? null,
      });

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorMembershipId: changedByMembershipId,
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
      .limit(Math.min(limit, PAGE_SIZE_CAP));
  }
}
