import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrTravelVisitLogs } from "../../db/schema/hr/benefits";
import type { CreateVisitLogInput } from "./dto/benefits.schemas";

@Injectable()
export class HrTravelVisitsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listVisits(orgId: string, travelRequestId: number) {
    return this.db
      .select()
      .from(hrTravelVisitLogs)
      .where(
        and(
          eq(hrTravelVisitLogs.orgId, orgId),
          eq(hrTravelVisitLogs.travelRequestId, travelRequestId),
        ),
      )
      .orderBy(asc(hrTravelVisitLogs.visitedAt));
  }

  async addVisit(orgId: string, userId: string, data: CreateVisitLogInput) {
    const [log] = await this.db
      .insert(hrTravelVisitLogs)
      .values({
        orgId,
        userId,
        travelRequestId: data.travelRequestId,
        visitedAt: new Date(data.visitedAt),
        location: data.location,
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        note: data.note ?? null,
      })
      .returning();
    return log;
  }
}
