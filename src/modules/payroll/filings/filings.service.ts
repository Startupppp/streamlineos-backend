import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollFilings,
} from "../../../db/schema";
import {
  getIndiaBundleForDate,
  IN_STATUTORY_RULE_BUNDLE_VERSION,
} from "../runs/lib/statutory-registry";
import {
  buildFilingExport,
  type FilingExportType,
} from "./export-builders";
import { PayrollEntitiesService } from "../entities/entities.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import {
  decodePayrollTimestampCursor,
  payrollCursorPosition,
} from "../payroll-cursor";
import { asRecord } from "../../../common/openapi/zod-operation-contracts";

export function resolveStatutoryTaxId(
  canonicalTaxId: string | null | undefined,
  canonicalPan: string | null | undefined,
): string | null {
  return canonicalTaxId?.trim() || canonicalPan?.trim() || null;
}
import { generateForm16SummaryPdf } from "./form16-pdf";
import { loadStatutorySources } from "./filings-source.service";
export type PrepareExportBody = {
  filingType: string;
  periodId?: number;
  entityId?: number;
  fiscalYear?: string;
  payload?: Record<string, unknown>;
  ruleVersion?: string;
  runId?: number;
  month?: string;
};


export const FILING_CAPABILITY = {
  mode: "export_only" as const,
  automaticFiling: false,
  automaticRemittance: false,
  providerDependent: true,
  honestyLabel: "Export prepared — external filing required",
  supportedTypes: ["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"] as const,
  ruleBundleVersion: IN_STATUTORY_RULE_BUNDLE_VERSION,
  artifactFormat: "csv" as const,
  form16Certificate: {
    mode: "period_summary_pdf" as const,
    officialForm16: false,
    honestyLabel:
      "Form 16 PDFs are period summaries for external preparation — not official Part A/B certificates",
  },
  note: "StreamlineOS prepares statutory export artifacts (CSV summaries from payroll run lines) and tracks challan/acknowledgement references. Filing with EPFO/ESIC/tax portals is not automatic until a provider is connected. Form 16 PDFs are period summaries only — not official Income-tax certificates or TRACES XML.",
};

export function isFilingExportType(value: string): value is FilingExportType {
  return FILING_CAPABILITY.supportedTypes.some((t) => t === value);
}

/**
 * Filing workflows are export-first until provider integrations exist.
 * UI must show honest labels: "Export prepared — external filing required."
 * Never claim automatic filing or remittance.
 */
@Injectable()
export class PayrollFilingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: PayrollEntitiesService,
    private readonly efService: EmploymentFactsService,
  ) {}

  capabilities() {
    const bundle = getIndiaBundleForDate();
    return {
      ...FILING_CAPABILITY,
      ruleBundleVersion: bundle.bundleVersion,
      ruleEffectiveFrom: bundle.effectiveFrom,
      formLabels: bundle.tds.formLabels,
    };
  }

  async list(orgId: string, cursor?: string, limit = 50) {
    const cap = Math.min(limit, 100);
    const cursorScope = ["filings", orgId] as const;
    const position = decodePayrollTimestampCursor(cursor, cursorScope);
    const conditions = [eq(payrollFilings.orgId, orgId)];
    if (position) {
      conditions.push(
        keysetBeforeId(payrollFilings.createdAt, payrollFilings.id, {
          sortValue: position.createdAt,
          id: String(position.id),
        }),
      );
    }

    const rows = await this.db
      .select()
      .from(payrollFilings)
      .where(and(...conditions))
      .orderBy(desc(payrollFilings.createdAt), desc(payrollFilings.id))
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) =>
      payrollCursorPosition(
        cursorScope,
        [row.createdAt.toISOString()],
        row.id,
      ),
    );
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
    const payload = asRecord(row.payload) ?? {};
    const artifact = asRecord(payload.artifact);
    const csv =
      typeof payload.csv === "string"
        ? payload.csv
        : typeof artifact?.csv === "string"
          ? artifact.csv
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

  /**
   * Form 16 period-summary PDF for one employee row on a FORM16 filing.
   * Honesty: not an official IT Form 16 Part A/B certificate.
   */
  async getForm16CertificatePdf(
    orgId: string,
    filingId: number,
    userId: string,
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const row = await this.get(orgId, filingId);
    if (row.filingType !== "FORM16") {
      throw new BadRequestException("Form 16 PDF is only available for FORM16 filings");
    }
    const payload = asRecord(row.payload) ?? {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const match = rows.find((r): r is Record<string, unknown> => {
      const rec = asRecord(r);
      return rec != null && String(rec.userId) === userId;
    });
    if (!match) {
      throw new NotFoundException("Employee row not found on this Form 16 filing");
    }

    const bundle = getIndiaBundleForDate();
    const formLabel =
      bundle.tds.formLabels.annualCertificate || "Form 16";
    const pdf = await generateForm16SummaryPdf({
      employerName: orgId,
      employeeName: String(match.employeeName ?? userId),
      employeeNumber:
        match.employeeNumber != null && match.employeeNumber !== ""
          ? String(match.employeeNumber)
          : null,
      pan: match.pan != null && match.pan !== "" ? String(match.pan) : null,
      email: match.email != null && match.email !== "" ? String(match.email) : null,
      fiscalYear: row.fiscalYear ?? null,
      periodMonth:
        typeof payload.periodMonth === "string" ? payload.periodMonth : null,
      periodGross: String(match.periodGross ?? "0"),
      periodTds: String(match.periodTds ?? "0"),
      periodNet: String(match.periodNet ?? "0"),
      ruleBundleVersion:
        row.ruleVersion ?? bundle.bundleVersion ?? IN_STATUTORY_RULE_BUNDLE_VERSION,
      formLabel,
    });

    const month =
      typeof payload.periodMonth === "string" ? payload.periodMonth : "period";
    return {
      filename: `Form16_summary_${month}_${userId}.pdf`,
      contentType: "application/pdf",
      body: pdf,
    };
  }

  /** List employee userIds on a FORM16 filing for PDF download UI. */
  async listForm16Employees(orgId: string, filingId: number) {
    const row = await this.get(orgId, filingId);
    if (row.filingType !== "FORM16") {
      throw new BadRequestException("Not a FORM16 filing");
    }
    const payload = asRecord(row.payload) ?? {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    return {
      filingId,
      honestyLabel:
        "Period summary PDFs only — not official Form 16 Part A/B certificates",
      employees: rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({
          userId: String(r.userId ?? ""),
          employeeName: String(r.employeeName ?? ""),
          employeeNumber: r.employeeNumber != null ? String(r.employeeNumber) : null,
          pan: r.pan != null && r.pan !== "" ? String(r.pan) : null,
          periodGross: String(r.periodGross ?? "0"),
          periodTds: String(r.periodTds ?? "0"),
        }))
        .filter((e) => e.userId !== ""),
    };
  }

  /**
   * Builds the CSV artifact and persists the filing row.
   * Runs on the payroll jobs worker, never on the request thread.
   */
  async prepareExport(
    orgId: string,
    actorId: string,
    body: PrepareExportBody,
  ) {
    if (!isFilingExportType(body.filingType)) {
      throw new BadRequestException(`Unsupported filing type: ${body.filingType}`);
    }
    const filingType = body.filingType;

    // Entity ownership + country isolation (India export builders only).
    let entityId = body.entityId ?? null;
    let periodId = body.periodId ?? null;
    if (entityId != null) {
      const entity = await this.entities.getEntity(orgId, entityId);
      const country = entity.countryCode.toUpperCase();
      if (country !== "IN") {
        throw new BadRequestException(
          `India statutory export builders cannot prepare filings for entity country ${country}. Non-IN local filings are not implemented.`,
        );
      }
      if (body.ruleVersion) {
        const ruleCountry = body.ruleVersion.split("-")[0] ?? "";
        if (ruleCountry.length === 2) {
          this.entities.assertNoCountryContamination(entity.countryCode, ruleCountry);
        }
      }
      // Prefer entity period when month provided and periodId omitted.
      if (periodId == null && body.month) {
        const period = await this.entities.ensurePeriod(orgId, body.month, { entityId });
        periodId = period.id;
      }
    }

    const bundle = getIndiaBundleForDate();
    // Explicit ruleVersion must not contaminate entity country (IN pack only here).
    if (body.ruleVersion && entityId != null) {
      const ruleCountry = body.ruleVersion.split("-")[0] ?? "";
      if (ruleCountry.length === 2 && ruleCountry !== "IN") {
        throw new BadRequestException(
          `Cannot apply ${body.ruleVersion} rules to an India-scoped filing export`,
        );
      }
    }

    const { employees, run, periodMonth } = await this.loadStatutorySources(
      orgId,
      body.runId,
      body.month,
      entityId,
    );

    // If run was resolved and carries a different entity, block cross-entity binding.
    if (run?.entityId != null && entityId != null && run.entityId !== entityId) {
      throw new BadRequestException(
        `Run ${run.id} belongs to entity ${run.entityId}, not entity ${entityId}`,
      );
    }
    // Prefer run's entity when caller omitted entityId.
    if (entityId == null && run?.entityId != null) {
      entityId = run.entityId;
    }

    const artifact = buildFilingExport(filingType, employees, {
      periodMonth,
      runId: run?.id ?? null,
      bundle,
    });

    const ruleVersion = body.ruleVersion ?? run?.statutoryRuleVersion ?? bundle.bundleVersion;

    const [row] = await this.db
      .insert(payrollFilings)
      .values({
        orgId,
        entityId,
        periodId,
        fiscalYear: body.fiscalYear ?? null,
        filingType: body.filingType,
        ruleVersion,
        status: "EXPORT_PREPARED",
        payload: {
          ...(body.payload ?? {}),
          capability: {
            mode: FILING_CAPABILITY.mode,
            automaticFiling: false,
            automaticRemittance: false,
          },
          entityId,
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
        entityId,
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
    if (existing.status === "ACKNOWLEDGED")
      throw new ConflictException(
        "Filing is already acknowledged — acknowledgement references are immutable",
      );

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
      .where(and(eq(payrollFilings.id, filingId), eq(payrollFilings.orgId, orgId)))
      .returning();
    return row;
  }

  private loadStatutorySources(
    orgId: string,
    runId?: number,
    month?: string,
    entityId?: number | null,
  ) {
    return loadStatutorySources(this.db, this.efService, orgId, runId, month, entityId);
  }
}
