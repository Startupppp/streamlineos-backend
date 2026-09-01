import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollLineItems,
  payrollRunEmployees,
  payrollRuns,
} from "../../../db/schema";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import {
  type EmployeeStatutorySourceRow,
} from "./export-builders";
import { payrollSubjectKeyFromRunEmployee } from "../lib/payroll-subject";
import { loadRunEmployeePayees } from "../lib/payroll-run-payee";

export async function loadStatutorySources(
  db: Db,
  efService: EmploymentFactsService,
  orgId: string,
  runId?: number,
  month?: string,
  entityId?: number | null,
): Promise<{
  employees: EmployeeStatutorySourceRow[];
  run: typeof payrollRuns.$inferSelect | null;
  periodMonth: string | null;
}> {
  let run: typeof payrollRuns.$inferSelect | null = null;

  if (runId != null) {
    run =
      (await db.query.payrollRuns.findFirst({
        where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
      })) ?? null;
    if (!run) throw new NotFoundException("Payroll run not found");
    if (entityId != null && run.entityId != null && run.entityId !== entityId) {
      throw new BadRequestException(
        `Run ${runId} is bound to entity ${run.entityId}, not entity ${entityId}`,
      );
    }
  } else if (month) {
    const conditions: SQL[] = [
      eq(payrollRuns.orgId, orgId),
      eq(payrollRuns.month, month),
      eq(payrollRuns.runType, "REGULAR"),
    ];
    if (entityId != null) {
      conditions.push(eq(payrollRuns.entityId, entityId));
    }
    const rows = await db
      .select()
      .from(payrollRuns)
      .where(and(...conditions))
      .limit(1);
    run = rows[0] ?? null;
    // Month without a run is allowed: empty artifact with honesty notes
  }

  if (!run) {
    return { employees: [], run: null, periodMonth: month ?? null };
  }

  const [runEmployeeRows, payees] = await Promise.all([
    db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        workerId: payrollRunEmployees.workerId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
      })
      .from(payrollRunEmployees)
      .where(
        and(
          eq(payrollRunEmployees.orgId, orgId),
          eq(payrollRunEmployees.runId, run.id),
        ),
      ),
    loadRunEmployeePayees(db, orgId, run.id, efService),
  ]);

  if (runEmployeeRows.length === 0) {
    return { employees: [], run, periodMonth: run.month };
  }

  const payeeByRunEmployee = new Map(payees.map((payee) => [payee.runEmployeeId, payee]));

  const lineRows = await db
    .select({
      runEmployeeId: payrollLineItems.runEmployeeId,
      code: payrollLineItems.code,
      amount: payrollLineItems.amount,
    })
    .from(payrollLineItems)
    .where(
      and(eq(payrollLineItems.orgId, orgId), eq(payrollLineItems.runId, run.id)),
    );

  const linesByRe = new Map<number, Record<string, string>>();
  for (const li of lineRows) {
    const map = linesByRe.get(li.runEmployeeId) ?? {};
    const prev = parseFloat(map[li.code] ?? "0") || 0;
    const next = parseFloat(li.amount) || 0;
    map[li.code] = (prev + next).toFixed(2);
    linesByRe.set(li.runEmployeeId, map);
  }

  const employees: EmployeeStatutorySourceRow[] = runEmployeeRows.map((employee) => {
    const payee = payeeByRunEmployee.get(employee.id);
    const bank = payee?.bankDetails ?? null;
    const uan = bank?.pfUanNumber?.trim() || null;
    const esiIpNumber = bank?.esiIpNumber?.trim() || null;
    const pan = payee?.taxId?.trim() || payee?.panNumber?.trim() || null;

    return {
      subjectKey: payrollSubjectKeyFromRunEmployee(employee),
      userId: employee.userId,
      workerId: employee.workerId,
      employeeNumber: payee?.employeeId ?? payee?.workerNumber ?? null,
      employeeName: payee?.displayName ?? employee.userId ?? employee.workerId ?? "Payee",
      email: payee?.email ?? null,
      gross: employee.gross ?? "0",
      net: employee.net ?? "0",
      uan: uan || null,
      esiIpNumber: esiIpNumber || null,
      pan: pan || null,
      lines: linesByRe.get(employee.id) ?? {},
    };
  });

  return { employees, run, periodMonth: run.month };
}
