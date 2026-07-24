import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollFilings,
  payrollLineItems,
  payrollRunEmployees,
  payrollRuns,
  users,
} from "../../../db/schema";
import {
  hrEmployments,
  hrEmployeeSensitiveFields,
  hrPeople,
} from "../../../db/schema/hr/core-people";
import {
  getIndiaBundleForDate,
  IN_STATUTORY_RULE_BUNDLE_VERSION,
} from "../runs/lib/statutory-registry";
import { decryptBankDetails } from "../../hr-payroll/lib/encryption";
import {
  buildFilingExport,
  type EmployeeStatutorySourceRow,
  type FilingExportType,
} from "./export-builders";

export const FILING_CAPABILITY = {
  mode: "export_only" as const,
  automaticFiling: false,
  automaticRemittance: false,
  providerDependent: true,
  honestyLabel: "Export prepared — external filing required",
  supportedTypes: ["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"] as const,
  ruleBundleVersion: IN_STATUTORY_RULE_BUNDLE_VERSION,
  artifactFormat: "csv" as const,
  note: "StreamlineOS prepares statutory export artifacts (CSV summaries from payroll run lines) and tracks challan/acknowledgement references. Filing with EPFO/ESIC/tax portals is not automatic until a provider is connected. Form 16 full certificate generation is not implemented.",
};

/**
 * Filing workflows are export-first until provider integrations exist.
 * UI must show honest labels: "Export prepared — external filing required."
 * Never claim automatic filing or remittance.
 */
@Injectable()
export class PayrollFilingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  capabilities() {
    const bundle = getIndiaBundleForDate();
    return {
      ...FILING_CAPABILITY,
      ruleBundleVersion: bundle.bundleVersion,
      ruleEffectiveFrom: bundle.effectiveFrom,
      formLabels: bundle.tds.formLabels,
    };
  }

  list(orgId: string) {
    return this.db
      .select()
      .from(payrollFilings)
      .where(eq(payrollFilings.orgId, orgId))
      .orderBy(desc(payrollFilings.createdAt))
      .limit(100);
  }

  async get(orgId: string, filingId: number) {
    const row = await this.db.query.payrollFilings.findFirst({
      where: and(eq(payrollFilings.id, filingId), eq(payrollFilings.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Filing not found");
    return {
      ...row,
      capability: FILING_CAPABILITY,
    };
  }

  /**
   * Download CSV artifact stored on the filing payload.
   */
  async getExportCsv(orgId: string, filingId: number): Promise<{
    filename: string;
    contentType: string;
    body: string;
  }> {
    const row = await this.get(orgId, filingId);
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const csv =
      typeof payload.csv === "string"
        ? payload.csv
        : typeof (payload.artifact as { csv?: string } | undefined)?.csv === "string"
          ? (payload.artifact as { csv: string }).csv
          : null;
    if (!csv) {
      throw new NotFoundException("Export CSV not available for this filing");
    }
    const month =
      typeof payload.periodMonth === "string" ? payload.periodMonth : "period";
    const type = row.filingType ?? "filing";
    return {
      filename: `${type}_${month}_${filingId}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: csv,
    };
  }

  async prepareExport(
    orgId: string,
    actorId: string,
    body: {
      filingType: string;
      periodId?: number;
      entityId?: number;
      fiscalYear?: string;
      payload?: Record<string, unknown>;
      ruleVersion?: string;
      runId?: number;
      month?: string;
    },
  ) {
    const filingType = body.filingType as FilingExportType;
    if (!FILING_CAPABILITY.supportedTypes.includes(filingType)) {
      throw new BadRequestException(`Unsupported filing type: ${body.filingType}`);
    }

    const bundle = getIndiaBundleForDate();
    const { employees, run, periodMonth } = await this.loadStatutorySources(
      orgId,
      body.runId,
      body.month,
    );

    const artifact = buildFilingExport(filingType, employees, {
      periodMonth,
      runId: run?.id ?? null,
      bundle,
    });

    const [row] = await this.db
      .insert(payrollFilings)
      .values({
        orgId,
        entityId: body.entityId ?? null,
        periodId: body.periodId ?? null,
        fiscalYear: body.fiscalYear ?? null,
        filingType: body.filingType,
        ruleVersion: body.ruleVersion ?? bundle.bundleVersion,
        status: "EXPORT_PREPARED",
        payload: {
          ...(body.payload ?? {}),
          capability: {
            mode: FILING_CAPABILITY.mode,
            automaticFiling: false,
            automaticRemittance: false,
          },
          periodMonth: artifact.periodMonth,
          runId: artifact.runId,
          rowCount: artifact.rowCount,
          totals: artifact.totals,
          missingIdentifiers: artifact.missingIdentifiers,
          notes: artifact.notes,
          columns: artifact.columns,
          // Keep row samples small in DB; full rows for short exports, cap large ones
          rows: artifact.rows.slice(0, 500),
          csv: artifact.csv,
          artifact: {
            format: artifact.format,
            ruleBundleVersion: artifact.ruleBundleVersion,
            honestyLabel: artifact.honestyLabel,
          },
        },
        artifactKey: `filings/${orgId}/${filingType}/${artifact.periodMonth ?? "na"}/${Date.now()}.csv`,
        externalFilingRequired: true,
        statusLabel: FILING_CAPABILITY.honestyLabel,
        createdBy: actorId,
      })
      .returning();

    return {
      ...row,
      capability: FILING_CAPABILITY,
      exportSummary: {
        rowCount: artifact.rowCount,
        totals: artifact.totals,
        missingIdentifiers: artifact.missingIdentifiers,
        notes: artifact.notes,
        periodMonth: artifact.periodMonth,
        runId: artifact.runId,
        ruleBundleVersion: artifact.ruleBundleVersion,
      },
    };
  }

  async attachAcknowledgement(
    orgId: string,
    filingId: number,
    body: { challanRef?: string; acknowledgementRef?: string },
  ) {
    const existing = await this.db.query.payrollFilings.findFirst({
      where: and(eq(payrollFilings.id, filingId), eq(payrollFilings.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Filing not found");

    const hasAck = !!(body.acknowledgementRef || body.challanRef);
    const [row] = await this.db
      .update(payrollFilings)
      .set({
        challanRef: body.challanRef ?? existing.challanRef,
        acknowledgementRef: body.acknowledgementRef ?? existing.acknowledgementRef,
        status: hasAck ? "ACKNOWLEDGED" : existing.status,
        statusLabel: hasAck
          ? "Acknowledged — reconciliation pending"
          : existing.statusLabel,
        submittedAt: hasAck ? new Date() : existing.submittedAt,
      })
      .where(eq(payrollFilings.id, filingId))
      .returning();
    return row;
  }

  private async loadStatutorySources(
    orgId: string,
    runId?: number,
    month?: string,
  ): Promise<{
    employees: EmployeeStatutorySourceRow[];
    run: typeof payrollRuns.$inferSelect | null;
    periodMonth: string | null;
  }> {
    let run: typeof payrollRuns.$inferSelect | null = null;

    if (runId != null) {
      run =
        (await this.db.query.payrollRuns.findFirst({
          where: and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)),
        })) ?? null;
      if (!run) throw new NotFoundException("Payroll run not found");
    } else if (month) {
      const rows = await this.db
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.month, month),
            eq(payrollRuns.runType, "REGULAR"),
          ),
        )
        .limit(1);
      run = rows[0] ?? null;
      // Month without a run is allowed: empty artifact with honesty notes
    }

    if (!run) {
      return { employees: [], run: null, periodMonth: month ?? null };
    }

    const runEmployees = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
        name: users.name,
        email: users.email,
        bankDetails: users.bankDetails,
        taxId: users.taxId,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(users.id, payrollRunEmployees.userId))
      .where(
        and(
          eq(payrollRunEmployees.orgId, orgId),
          eq(payrollRunEmployees.runId, run.id),
        ),
      );

    if (runEmployees.length === 0) {
      return { employees: [], run, periodMonth: run.month };
    }

    const userIds = runEmployees.map((e) => e.userId);
    const employments = await this.db
      .select({
        userId: hrPeople.userId,
        employmentId: hrEmployments.id,
        employeeNumber: hrEmployments.employeeNumber,
      })
      .from(hrEmployments)
      .innerJoin(hrPeople, eq(hrPeople.id, hrEmployments.personId))
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          inArray(hrPeople.userId, userIds),
          eq(hrEmployments.isPrimary, true),
        ),
      );

    const empNumByUser = new Map(
      employments
        .filter((e): e is typeof e & { userId: string } => e.userId != null)
        .map((e) => [e.userId, e.employeeNumber]),
    );
    const employmentIdByUser = new Map(
      employments
        .filter((e): e is typeof e & { userId: string } => e.userId != null)
        .map((e) => [e.userId, e.employmentId]),
    );

    const employmentIds = employments.map((e) => e.employmentId);
    const sensitiveRows =
      employmentIds.length > 0
        ? await this.db
            .select({
              employmentId: hrEmployeeSensitiveFields.employmentId,
              panNumber: hrEmployeeSensitiveFields.panNumber,
              bankDetails: hrEmployeeSensitiveFields.bankDetails,
            })
            .from(hrEmployeeSensitiveFields)
            .where(
              and(
                eq(hrEmployeeSensitiveFields.orgId, orgId),
                inArray(hrEmployeeSensitiveFields.employmentId, employmentIds),
              ),
            )
        : [];

    const sensitiveByEmployment = new Map(
      sensitiveRows.map((s) => [s.employmentId, s]),
    );

    const lineRows = await this.db
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
      // Sum duplicate codes if any
      const prev = parseFloat(map[li.code] ?? "0") || 0;
      const next = parseFloat(li.amount) || 0;
      map[li.code] = (prev + next).toFixed(2);
      linesByRe.set(li.runEmployeeId, map);
    }

    const employees: EmployeeStatutorySourceRow[] = runEmployees.map((e) => {
      const userBank = decryptBankDetails(e.bankDetails ?? null);
      const empId = employmentIdByUser.get(e.userId);
      const sens = empId != null ? sensitiveByEmployment.get(empId) : undefined;
      const sensBank = sens?.bankDetails ?? null;

      const uan =
        (userBank?.pfUanNumber?.trim() ||
          sensBank?.pfUanNumber?.trim() ||
          null) ?? null;
      const esiIpNumber =
        (userBank?.esiIpNumber?.trim() ||
          sensBank?.esiIpNumber?.trim() ||
          null) ?? null;
      const pan =
        (sens?.panNumber?.trim() ||
          // taxId sometimes holds PAN when not using sensitive fields
          (typeof e.taxId === "string" ? e.taxId.trim() : "") ||
          null) || null;

      return {
        userId: e.userId,
        employeeNumber: empNumByUser.get(e.userId) ?? null,
        employeeName: e.name?.trim() || e.email || e.userId,
        email: e.email,
        gross: e.gross ?? "0",
        net: e.net ?? "0",
        uan: uan || null,
        esiIpNumber: esiIpNumber || null,
        pan: pan || null,
        lines: linesByRe.get(e.id) ?? {},
      };
    });

    return { employees, run, periodMonth: run.month };
  }
}
