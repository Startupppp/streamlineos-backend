import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { holidays, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import type { CreateHolidayInput, UpdateHolidayInput } from "./dto/holidays.schemas";

@Injectable()
export class HrHolidaysService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  calendar(orgId: string, year: number, month: number) {
    const mm = String(month).padStart(2, "0");
    const startDate = `${year}-${mm}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

    return this.db.query.holidays.findMany({
      where: and(eq(holidays.orgId, orgId), gte(holidays.date, startDate), lte(holidays.date, endDate)),
      orderBy: [asc(holidays.date)],
    });
  }

  getById(orgId: string, id: number) {
    return this.db.query.holidays
      .findFirst({ where: and(eq(holidays.id, id), eq(holidays.orgId, orgId)) })
      .then((row) => row ?? null);
  }

  async create(orgId: string, input: CreateHolidayInput): Promise<{ ok: false } | { ok: true }> {
    const trimmedName = input.name.trim();
    const duplicate = await this.db.query.holidays.findFirst({
      where: and(
        eq(holidays.orgId, orgId),
        or(
          eq(holidays.date, input.date),
          sql`lower(trim(${holidays.name})) = ${trimmedName.toLowerCase()}`,
        ),
      ),
      columns: { id: true },
    });
    if (duplicate) return { ok: false };

    await this.db.insert(holidays).values({
      orgId,
      name: trimmedName,
      date: input.date,
      message: input.message,
      isPublic: input.isPublic ?? false,
    });

    void this.announceHoliday(orgId, input.name, input.date, input.message);

    return { ok: true };
  }

  update(orgId: string, id: number, input: UpdateHolidayInput) {
    return this.db
      .update(holidays)
      .set({ name: input.name.trim(), date: input.date, message: input.message?.trim() ?? null })
      .where(and(eq(holidays.id, id), eq(holidays.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async remove(id: number) {
    await this.db.delete(holidays).where(eq(holidays.id, id));
    return { success: true };
  }

  private async announceHoliday(
    orgId: string,
    name: string,
    date: string,
    message?: string,
  ): Promise<void> {
    try {
      const memberIds = await this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, orgId));
      if (memberIds.length === 0) return;

      const activeUsers = await this.db
        .select({ email: users.email })
        .from(users)
        .where(
          and(
            inArray(
              users.id,
              memberIds.map((m) => m.userId),
            ),
            eq(users.isActive, true),
          ),
        );

      const emails = activeUsers.map((u) => u.email).filter(Boolean);
      if (emails.length > 0) {
        await this.email.sendBulkHolidayAnnouncement(emails, name, date, message);
      }
    } catch (error) {
      logger.error("Failed to send holiday announcement", { orgId, error });
    }
  }
}
