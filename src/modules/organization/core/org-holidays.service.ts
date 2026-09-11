import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { orgHolidays } from "../../../db/schema";
import type { CreateHolidayInput } from "./dto/organization.schemas";

/**
 * The organization holiday calendar. It is an org-owned entity with its own
 * table, its own audit vocabulary and its own readers (the unified calendar
 * aggregates it), not a field of the settings record — so it does not belong on
 * `OrganizationSettingsService`, whose surface is the `organizations` row plus
 * its security policy.
 */
@Injectable()
export class OrgHolidaysService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listHolidays(orgId: string) {
    return this.db
      .select()
      .from(orgHolidays)
      .where(eq(orgHolidays.orgId, orgId))
      .orderBy(orgHolidays.date)
      .limit(1000);
  }

  async createHoliday(orgId: string, userId: string, input: CreateHolidayInput) {
    const id = randomUUID();
    const [holiday] = await this.db
      .insert(orgHolidays)
      .values({
        id,
        orgId,
        name: input.name,
        date: input.date,
        recurring: input.recurring ?? false,
        createdBy: userId,
      })
      .returning();
    this.audit.log({
      action: "org.holiday.created",
      userId,
      orgId,
      targetId: id,
      targetType: "org_holiday",
      metadata: input,
    });
    return holiday;
  }

  async deleteHoliday(orgId: string, userId: string, holidayId: string) {
    await this.db
      .delete(orgHolidays)
      .where(and(eq(orgHolidays.id, holidayId), eq(orgHolidays.orgId, orgId)));
    this.audit.log({
      action: "org.holiday.deleted",
      userId,
      orgId,
      targetId: holidayId,
      targetType: "org_holiday",
    });
    return { success: true };
  }
}
