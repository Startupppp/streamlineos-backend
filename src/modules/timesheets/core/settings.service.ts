import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { timesheetSettings, timesheetSettingsHistory } from "../../../db/schema";
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

/**
 * TS-16. The settings whose change requires somebody to say why.
 *
 * The line is not "important" — that would be all of them. It is: does changing
 * this alter what a *past or in-flight* timesheet means, or what somebody is
 * allowed to do with one? Every field here does. Lowering `maxHoursPerDay`
 * makes yesterday's entry invalid; moving `workWeekStart` re-cuts which days
 * fall in which period; turning off `lockAfterApproval` reopens hours somebody
 * has already signed; `autoDraftFromAttendance` starts writing rows into other
 * people's timesheets. Each of those is a question an auditor will eventually
 * ask about a specific period, and the answer has to be somewhere.
 *
 * `reminderRules` is deliberately absent. Changing the reminder cadence sends
 * more or fewer emails and changes nothing about what a timesheet is or who may
 * touch it — demanding a justification for it would train people to type "." to
 * get past the dialog, which is how a required field stops meaning anything.
 */
const MATERIAL_FIELDS = new Set([
  "workWeekStart",
  "requiredFields",
  "roundingRule",
  "maxHoursPerDay",
  "allowOverlappingEntries",
  "allowBackdatedEntries",
  "backdateLimitDays",
  "approvalMode",
  "clientApprovalEnabled",
  "lockAfterApproval",
  "lockAfterInvoice",
  "allowFutureEntries",
  "expectedDailyHours",
  "expectedWeeklyHours",
  "submissionGraceDays",
  "autoDraftFromAttendance",
]);

/**
 * Compares a submitted value against what is stored, tolerating the shapes the
 * two sides legitimately use for the same thing.
 *
 * The numeric settings are `decimal` columns, so they come back as strings:
 * `expectedDailyHours` stored as `"8.00"` against a submitted `8` is not a
 * change, and treating it as one would demand a reason for a no-op save — the
 * fastest possible way to make the requirement feel like noise.
 */
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
    const before = await this.fetchOrCreate(u.orgId);
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    const { changeReason, ...fields } = input;
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

    /**
     * TS-16. Required on a material change, and only on one.
     *
     * Checked against what is actually stored rather than against what the
     * payload mentions: a settings screen that PATCHes every field on every
     * save would otherwise demand a justification for pressing Save with
     * nothing altered, and a requirement that fires when nothing happened is
     * one people learn to satisfy with a full stop.
     *
     * A 400 rather than a silently-null history row. The history table has
     * carried a nullable `change_reason` since it shipped and nothing has ever
     * required it, so the column is full of nulls for changes nobody can now
     * explain — which is the failure this ticket exists to stop repeating.
     */
    if (materialChanges.length > 0 && !changeReason?.trim()) {
      throw new BadRequestException(
        `A changeReason is required when changing ${materialChanges.sort().join(", ")}`,
      );
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

  /**
   * TS-34. Capped at the platform ceiling of 100, not the 200 this used to
   * allow. Backend §3 makes 100/page absolute for every list endpoint, and the
   * previous cap quietly exceeded it — one of the two places in this module
   * where a list could return more rows than the platform permits.
   */
  async getSettingsHistory(orgId: string, limit = 50) {
    return this.db
      .select()
      .from(timesheetSettingsHistory)
      .where(eq(timesheetSettingsHistory.orgId, orgId))
      .orderBy(desc(timesheetSettingsHistory.version))
      .limit(Math.min(limit, PAGE_SIZE_CAP));
  }
}
