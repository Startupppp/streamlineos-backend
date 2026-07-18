import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { timesheetSettings } from "../../db/schema";
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
    private readonly audit: TimesheetsAuditService,
  ) {}

  async getSettings(orgId: string) {
    const [settings] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);

    if (settings) return settings;

    const [created] = await this.db
      .insert(timesheetSettings)
      .values({ orgId })
      .returning();

    return created!;
  }

  async updateSettings(u: CurrentUserContext, input: UpdateCoreSettingsInput) {
    const before = await this.getSettings(u.orgId);
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

    return this.getSettings(u.orgId);
  }
}
