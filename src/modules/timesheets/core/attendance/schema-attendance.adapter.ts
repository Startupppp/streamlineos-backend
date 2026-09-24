import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { attendance } from "../../../../db/schema";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { ClockRange, TimesheetAttendancePort } from "./attendance.port";
import { clockSegmentsFrom, type ClockSegment } from "./lib/clock-segments";

@Injectable()
export class SchemaAttendanceAdapter implements TimesheetAttendancePort {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getClockSegments(
    orgId: string,
    userId: string,
    range: ClockRange,
  ): Promise<ClockSegment[]> {
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const rows = await tx
          .select({
            date: attendance.date,
            checkIn: attendance.checkIn,
            checkOut: attendance.checkOut,
            breaks: attendance.breaks,
            autoCheckedOut: attendance.autoCheckedOut,
            status: attendance.status,
          })
          .from(attendance)
          .where(
            and(
              eq(attendance.orgId, orgId),
              eq(attendance.userId, userId),
              gte(attendance.date, range.start),
              lte(attendance.date, range.end),
              isNotNull(attendance.checkIn),
              isNotNull(attendance.checkOut),
            ),
          )
          .orderBy(asc(attendance.date));

        return clockSegmentsFrom(rows);
      },
      { orgId },
    );
  }
}
