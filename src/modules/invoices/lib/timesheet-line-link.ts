import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { timesheets } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

export interface TimesheetLinkedLine {
  timesheetEntryId?: number | undefined;
}

export async function assertTimesheetEntriesLinkable(
  db: Db,
  orgId: string,
  lines: ReadonlyArray<TimesheetLinkedLine>,
): Promise<void> {
  const requested = [
    ...new Set(
      lines
        .map((line) => line.timesheetEntryId)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  if (requested.length === 0) return;

  const rows = await db
    .select({
      id: timesheets.id,
      status: timesheets.status,
      voidedAt: timesheets.voidedAt,
    })
    .from(timesheets)
    .where(and(eq(timesheets.orgId, orgId), inArray(timesheets.id, requested)))
    .limit(requested.length);

  const byId = new Map(rows.map((row) => [row.id, row]));

  const unresolved = requested.filter((id) => !byId.has(id));
  if (unresolved.length > 0) {
    throw new BadRequestException(
      `Timesheet entry not found in this organization: ${unresolved.join(", ")}`,
    );
  }

  const voided = requested.filter((id) => byId.get(id)?.voidedAt != null);
  if (voided.length > 0) {
    throw new BadRequestException(
      `Timesheet entry has been voided and cannot be invoiced: ${voided.join(", ")}`,
    );
  }

  const unapproved = requested.filter((id) => byId.get(id)?.status !== "APPROVED");
  if (unapproved.length > 0) {
    throw new BadRequestException(
      `Timesheet entry is not approved and cannot be invoiced: ${unapproved.join(", ")}`,
    );
  }
}
