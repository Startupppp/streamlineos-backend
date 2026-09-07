import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrTravelVisitLogs } from "../../../db/schema/hr/benefits";
import { travelRequests } from "../../../db/schema/hr/travel";
import type { CreateVisitLogInput, ListVisitLogsInput } from "./dto/benefits.schemas";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterId } from "../../../common/pagination/keyset";

@Injectable()
export class HrTravelVisitsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listVisits(orgId: string, travelRequestId: number, query: ListVisitLogsInput) {
    const request = await this.db.query.travelRequests.findFirst({
      columns: { id: true },
      where: and(eq(travelRequests.id, travelRequestId), eq(travelRequests.orgId, orgId)),
    });
    if (!request) throw new NotFoundException("Travel request not found");

    const conditions: SQL[] = [
      eq(hrTravelVisitLogs.orgId, orgId),
      eq(hrTravelVisitLogs.travelRequestId, travelRequestId),
    ];
    const position = decodeCursor(query.cursor);
    if (position)
      conditions.push(
        keysetAfterId(hrTravelVisitLogs.visitedAt, hrTravelVisitLogs.id, position),
      );

    const rows = await this.db
      .select()
      .from(hrTravelVisitLogs)
      .where(and(...conditions))
      .orderBy(asc(hrTravelVisitLogs.visitedAt), asc(hrTravelVisitLogs.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.visitedAt.toISOString(),
      id: String(row.id),
    }));
  }

  async addVisit(orgId: string, userId: string, membershipId: number | null, data: CreateVisitLogInput) {
    if (membershipId == null) throw new ForbiddenException("Organization membership required.");
    const [log] = await this.db
      .insert(hrTravelVisitLogs)
      .values({
        orgId,
        userId,
        userMembershipId: membershipId,
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
