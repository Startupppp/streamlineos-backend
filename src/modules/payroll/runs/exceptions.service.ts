import { BadRequestException, Injectable, Inject } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollExceptions, payrollRuns, payrollRunEvents } from "../../../db/schema";
import { users } from "../../../db/schema";
import type { ResolveExceptionInput, OverrideExceptionInput } from "./dto/runs.schemas";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { buildCursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollTextTimestampCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

const EXCEPTION_SEVERITIES = ["BLOCKER", "WARNING", "INFO"] as const;

@Injectable()
export class ExceptionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listExceptions(
    orgId: string,
    runId: number,
    severity?: string,
    status?: string,
    cursor?: string,
    limit = 50,
  ) {
    const cap = Math.min(limit, 100);
    const cursorScope = [
      "run-exceptions",
      orgId,
      runId,
      severity ?? null,
      status ?? null,
    ] as const;
    const position = decodePayrollTextTimestampCursor(cursor, cursorScope);
    if (
      position &&
      !(EXCEPTION_SEVERITIES as readonly string[]).includes(position.textValue)
    ) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const runCheck = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return null;

    const conditions = [eq(payrollExceptions.runId, runId), eq(payrollExceptions.orgId, orgId)];
    if (severity) conditions.push(eq(payrollExceptions.severity, severity as "BLOCKER" | "WARNING" | "INFO"));
    if (status) conditions.push(eq(payrollExceptions.status, status as "OPEN" | "RESOLVED" | "OVERRIDDEN"));
    if (position) {
      conditions.push(
        sql`(${payrollExceptions.severity}, ${payrollExceptions.createdAt}, ${payrollExceptions.id}) > (${sql.param(position.textValue, payrollExceptions.severity)}, ${sql.param(position.createdAt, payrollExceptions.createdAt)}, ${position.id})`,
      );
    }

    const rows = await this.db
      .select({
        id: payrollExceptions.id,
        code: payrollExceptions.code,
        severity: payrollExceptions.severity,
        status: payrollExceptions.status,
        message: payrollExceptions.message,
        metadata: payrollExceptions.metadata,
        userId: payrollExceptions.userId,
        resolvedBy: payrollExceptions.resolvedBy,
        resolvedAt: payrollExceptions.resolvedAt,
        overrideReason: payrollExceptions.overrideReason,
        createdAt: payrollExceptions.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(payrollExceptions)
      .leftJoin(users, eq(users.id, payrollExceptions.userId))
      .where(and(...conditions))
      .orderBy(
        asc(payrollExceptions.severity),
        asc(payrollExceptions.createdAt),
        asc(payrollExceptions.id),
      )
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) =>
      payrollCursorPosition(
        cursorScope,
        [row.severity, row.createdAt.toISOString()],
        row.id,
      ),
    );
  }

  async resolveException(
    orgId: string,
    runId: number,
    exceptionId: number,
    actorId: string,
    body: ResolveExceptionInput,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) return { ok: false, reason: "locked" };

    const ex = await this.db
      .select({ id: payrollExceptions.id, status: payrollExceptions.status })
      .from(payrollExceptions)
      .where(and(eq(payrollExceptions.id, exceptionId), eq(payrollExceptions.runId, runId), eq(payrollExceptions.orgId, orgId)))
      .limit(1);

    if (!ex[0]) return { ok: false, reason: "exception_not_found" };
    if (ex[0].status !== "OPEN") return { ok: false, reason: "already_resolved" };

    if (body.note) {
      await this.db
        .update(payrollExceptions)
        .set({
          status: "RESOLVED",
          resolvedBy: actorId,
          resolvedAt: new Date(),
          metadata: sql<Record<string, unknown>>`COALESCE(${payrollExceptions.metadata}, '{}')::jsonb || jsonb_build_object('resolveNote', ${body.note}::text)`,
        })
        .where(and(eq(payrollExceptions.id, exceptionId), eq(payrollExceptions.orgId, orgId)));
    } else {
      await this.db
        .update(payrollExceptions)
        .set({ status: "RESOLVED", resolvedBy: actorId, resolvedAt: new Date() })
        .where(and(eq(payrollExceptions.id, exceptionId), eq(payrollExceptions.orgId, orgId)));
    }

    return { ok: true };
  }

  async overrideException(
    orgId: string,
    runId: number,
    exceptionId: number,
    actorId: string,
    body: OverrideExceptionInput,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) return { ok: false, reason: "locked" };

    const ex = await this.db
      .select({ id: payrollExceptions.id, status: payrollExceptions.status })
      .from(payrollExceptions)
      .where(and(eq(payrollExceptions.id, exceptionId), eq(payrollExceptions.runId, runId), eq(payrollExceptions.orgId, orgId)))
      .limit(1);

    if (!ex[0]) return { ok: false, reason: "exception_not_found" };
    if (ex[0].status !== "OPEN") return { ok: false, reason: "already_resolved" };

    await this.db.transaction(async (tx) => {
      await tx
        .update(payrollExceptions)
        .set({ status: "OVERRIDDEN", resolvedBy: actorId, resolvedAt: new Date(), overrideReason: body.reason })
        .where(and(eq(payrollExceptions.id, exceptionId), eq(payrollExceptions.orgId, orgId)));

      await tx.insert(payrollRunEvents).values({
        orgId,
        runId,
        type: "EXCEPTION_OVERRIDDEN",
        actorId,
        metadata: { exceptionId, reason: body.reason },
      });

      const remainingBlockers = await tx
        .select({ one: sql`1` })
        .from(payrollExceptions)
        .where(
          and(
            eq(payrollExceptions.orgId, orgId),
            eq(payrollExceptions.runId, runId),
            eq(payrollExceptions.status, "OPEN"),
            eq(payrollExceptions.severity, "BLOCKER"),
          ),
        )
        .limit(1);

      if (remainingBlockers.length === 0 && runCheck[0].status === "EXCEPTIONS_FOUND") {
        await tx
          .update(payrollRuns)
          .set({ status: "PREVIEW_READY" })
          .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)));
      }
    });

    return { ok: true };
  }
}
