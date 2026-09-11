import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { leaveBlackoutDates } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { BlackoutListQuery, CreateBlackoutInput } from "./dto/leave-blackout.schemas";

@Injectable()
export class HrLeaveBlackoutService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, query: BlackoutListQuery) {
    const conditions = [eq(leaveBlackoutDates.orgId, orgId)];
    if (query.from) conditions.push(gte(leaveBlackoutDates.endDate, query.from));
    if (query.to) conditions.push(lte(leaveBlackoutDates.startDate, query.to));

    return this.db.query.leaveBlackoutDates.findMany({
      where: and(...conditions),
      orderBy: [asc(leaveBlackoutDates.startDate)],
      limit: 100,
    });
  }

  create(orgId: string, userId: string, input: CreateBlackoutInput) {
    return this.db
      .insert(leaveBlackoutDates)
      .values({
        orgId,
        startDate: input.startDate,
        endDate: input.endDate,
        reason: input.reason,
        appliesTo: input.appliesTo,
        createdBy: userId,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  getById(orgId: string, id: number) {
    return this.db.query.leaveBlackoutDates
      .findFirst({
        where: and(eq(leaveBlackoutDates.id, id), eq(leaveBlackoutDates.orgId, orgId)),
        columns: { id: true },
      })
      .then((row) => row ?? null);
  }

  async remove(orgId: string, id: number) {
    await this.db.delete(leaveBlackoutDates).where(and(eq(leaveBlackoutDates.id, id), eq(leaveBlackoutDates.orgId, orgId)));
    return { success: true };
  }
}
