import { ForbiddenException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { payrollInputs, payrollRuns, users } from "../../../db/schema";
import { buildCursorPage } from "../../../common/pagination/cursor";
import type { ScopedRead } from "../../access/scoped-read";
import { decodePayrollTextCursor, payrollCursorPosition } from "../payroll-cursor";
import type { InputsQuery } from "./dto/runs.schemas";

const inputSortName = sql<string>`coalesce(${users.name}, ${users.email})`;

type InputRow = {
  id: number;
  userId: string;
  source: string;
  scheduledDays: string;
  paidDays: string;
  lopDays: string;
  halfDays: string;
  overtimeHours: string;
  shiftAllowanceUnits: string;
  holidayWorkDays: string;
  billableHours: string;
  isOverride: boolean;
  overrideReason: string | null;
  createdAt: Date;
  userName: string | null;
  userEmail: string;
};

/** Owns authorization, stable ordering and cursor binding for a run's input page. */
export async function listPayrollInputs(
  db: Db,
  read: ScopedRead,
  runId: number,
  query: InputsQuery,
  actorMembershipId: number | null,
) {
  const orgId = read.orgId;
  const runCheck = await db
    .select({ id: payrollRuns.id, status: payrollRuns.status })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
    .limit(1);

  if (!runCheck[0]) return null;

  if (query.userId && query.userId !== read.actorId && read.discriminator !== "all") {
    throw new ForbiddenException("Not authorized to filter payroll inputs for another payee");
  }
  if (actorMembershipId == null) {
    throw new ForbiddenException("Organization membership required");
  }

  const limit = Math.min(query.limit ?? 50, 100);
  const cursorScope = [
    "run-inputs", orgId, runId, query.userId ?? null, read.discriminator, actorMembershipId,
  ] as const;
  const position = decodePayrollTextCursor(query.cursor, cursorScope);

  return read.read(
    {
      tenant: payrollInputs.orgId,
      scope: { own: eq(payrollInputs.userMembershipId, actorMembershipId) },
      and: [
        eq(payrollInputs.runId, runId),
        query.userId ? eq(payrollInputs.userId, query.userId) : undefined,
        position
          ? sql`(${inputSortName}, ${payrollInputs.id}) > (${sql.param(position.value)}, ${sql.param(position.id, payrollInputs.id)})`
          : undefined,
      ],
    },
    async ({ sql: where }) => {
      const rows: InputRow[] = await db
        .select({
          id: payrollInputs.id,
          userId: payrollInputs.userId,
          source: payrollInputs.source,
          scheduledDays: payrollInputs.scheduledDays,
          paidDays: payrollInputs.paidDays,
          lopDays: payrollInputs.lopDays,
          halfDays: payrollInputs.halfDays,
          overtimeHours: payrollInputs.overtimeHours,
          shiftAllowanceUnits: payrollInputs.shiftAllowanceUnits,
          holidayWorkDays: payrollInputs.holidayWorkDays,
          billableHours: payrollInputs.billableHours,
          isOverride: payrollInputs.isOverride,
          overrideReason: payrollInputs.overrideReason,
          createdAt: payrollInputs.createdAt,
          userName: users.name,
          userEmail: users.email,
        })
        .from(payrollInputs)
        .innerJoin(users, eq(users.id, payrollInputs.userId))
        .where(where)
        .orderBy(asc(inputSortName), asc(payrollInputs.id))
        .limit(limit + 1);

      return buildCursorPage(rows, limit, (row) =>
        payrollCursorPosition(cursorScope, [row.userName ?? row.userEmail], row.id),
      );
    },
    () => buildCursorPage<InputRow>([], limit, (row) =>
      payrollCursorPosition(cursorScope, [row.userName ?? row.userEmail], row.id),
    ),
  );
}
