import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { attendance } from "../../../../db/schema";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { ClockRange, TimesheetAttendancePort } from "./attendance.port";
import { clockSegmentsFrom, type ClockSegment } from "./lib/clock-segments";

/**
 * Reads HR's `attendance` table. Reads it, and nothing else.
 *
 * This is the same read-only seam the payroll export and the holiday calendar
 * already use, and it is the reason the port exists: the boundary this pack
 * must not cross is `modules/hr`, HR's services and schema *changes*, not the
 * shared tables it publishes. Should HR ever offer a service or an event
 * stream, a second adapter satisfies the same interface and nothing in
 * timesheets changes.
 *
 * `checkOut IS NOT NULL` is applied in SQL rather than left to the derivation:
 * an open day cannot become a segment, so fetching it only to discard it costs
 * rows for nothing.
 */
@Injectable()
export class SchemaAttendanceAdapter implements TimesheetAttendancePort {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The `orgId` argument is honoured, not merely passed along.
   *
   * `attendance` is behind RLS, so the query needs a tenant context. Relying on
   * an ambient one would make this method mean different things depending on
   * where it was called from: inside a request it would work, and from a
   * background sweep it would raise "no tenant context" — in the background,
   * where nobody is looking. That is the exact failure that left CRM's
   * outbound webhooks dead for months.
   *
   * `runInTenantTransaction` with an explicit org reuses an ambient
   * transaction when there is one, opens one when there is not, and REFUSES
   * when the ambient context belongs to a different organisation. That last
   * case is the one worth having: a caller asking org A for data while inside
   * org B's transaction is a bug, and a silent empty result would look like
   * "no attendance recorded".
   */
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

/**
 * What an organisation with no attendance tracking gets.
 *
 * Returns nothing and says nothing. Bound only where a deployment has decided
 * attendance is not a source of truth for timesheets; the empty array is a
 * legitimate answer under the port's contract.
 */
@Injectable()
export class NoAttendanceAdapter implements TimesheetAttendancePort {
  async getClockSegments(): Promise<ClockSegment[]> {
    return [];
  }
}
