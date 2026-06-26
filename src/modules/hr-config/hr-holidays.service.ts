import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { holidays } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { UpdateHolidayInput } from "./dto/holidays.schemas";

@Injectable()
export class HrHolidaysService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
}
