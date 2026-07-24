/**
 * India statutory export artifact builders (export-only).
 * Produce structured rows + CSV for external portal filing.
 * Never claim automatic submission or remittance.
 */

import { buildCsv } from "../insights/lib/csv";
import {
  IN_STATUTORY_RULE_BUNDLE_VERSION,
  type IndiaStatutoryBundle,
} from "../runs/lib/statutory-registry";

export type FilingExportType = "PF_ECR" | "ESI" | "PT" | "TDS_24Q" | "FORM16" | "LWF";

export interface EmployeeStatutorySourceRow {
  userId: string;
  employeeNumber: string | null;
  employeeName: string;
  email: string | null;
  gross: string;
  net: string;
  /** PF Universal Account Number (12 digits) when known */
  uan: string | null;
  /** ESIC Insurance Person number when known */
  esiIpNumber: string | null;
  /** PAN for TDS filings when known */
  pan: string | null;
  /** Line code → amount (decimal string) */
  lines: Record<string, string>;
}

export interface FilingExportArtifact {
  filingType: FilingExportType;
  format: "csv";
  mode: "export_only";
  automaticFiling: false;
  automaticRemittance: false;
  honestyLabel: string;
  ruleBundleVersion: string;
  periodMonth: string | null;
  runId: number | null;
  rowCount: number;
  totals: Record<string, string>;
  missingIdentifiers: string[];
  notes: string[];
  columns: string[];
  rows: Record<string, string | number>[];
  csv: string;
}

const HONESTY = "Export prepared — external filing required";

const PF_CODES = ["EPF_EMPLOYEE", "EPF_EMPLOYER", "PF_EMP", "PF_ER", "PF_EE"] as const;
const ESI_CODES = ["ESI_EMPLOYEE", "ESI_EMPLOYER", "ESI_EMP", "ESI_ER"] as const;
const PT_CODES = ["PROFESSIONAL_TAX", "PT"] as const;
const LWF_CODES = ["LWF_EMPLOYEE", "LWF_EMPLOYER", "LWF"] as const;
const TDS_CODES = ["TDS"] as const;

function amt(lines: Record<string, string>, codes: readonly string[]): number {
  let sum = 0;
  for (const c of codes) {
    const v = lines[c];
    if (v != null && v !== "") sum += parseFloat(v) || 0;
  }
  return Math.round(sum * 100) / 100;
}

function money(n: number): string {
  return n.toFixed(2);
}

function sumField(rows: Record<string, string | number>[], key: string): string {
  let total = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number") total += v;
    else if (typeof v === "string" && v !== "") total += parseFloat(v) || 0;
  }
  return money(Math.round(total * 100) / 100);
}

function baseMeta(
  filingType: FilingExportType,
  periodMonth: string | null,
  runId: number | null,
  bundle: IndiaStatutoryBundle,
  notes: string[],
): Pick<
  FilingExportArtifact,
  | "filingType"
  | "format"
  | "mode"
  | "automaticFiling"
  | "automaticRemittance"
  | "honestyLabel"
  | "ruleBundleVersion"
  | "periodMonth"
  | "runId"
  | "notes"
> {
  return {
    filingType,
    format: "csv",
    mode: "export_only",
    automaticFiling: false,
    automaticRemittance: false,
    honestyLabel: HONESTY,
    ruleBundleVersion: bundle.bundleVersion ?? IN_STATUTORY_RULE_BUNDLE_VERSION,
    periodMonth,
    runId,
    notes,
  };
}

function finalize(
  partial: Omit<FilingExportArtifact, "csv" | "rowCount" | "totals"> & {
    totals: Record<string, string>;
  },
): FilingExportArtifact {
  const csv = buildCsv(
    partial.columns,
    partial.rows.map((r) => partial.columns.map((c) => r[c] ?? "")),
  );
  return {
    ...partial,
    rowCount: partial.rows.length,
    csv,
  };
}

/** PF ECR-style contribution summary (not EPFO text format — CSV for external prep). */
export function buildPfEcrExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const missing: string[] = [];
  const rows: Record<string, string | number>[] = [];

  for (const e of employees) {
    const empShare = amt(e.lines, ["EPF_EMPLOYEE", "PF_EMP", "PF_EE"]);
    const erShare = amt(e.lines, ["EPF_EMPLOYER", "PF_ER"]);
    if (empShare === 0 && erShare === 0) continue;
    if (!e.employeeNumber) missing.push(`${e.userId}:employeeNumber`);
    if (!e.uan) missing.push(`${e.userId}:uan`);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId,
      uan: e.uan ?? "",
      wages: e.gross,
      employeeContribution: money(empShare),
      employerContribution: money(erShare),
      totalContribution: money(empShare + erShare),
    });
  }

  const columns = [
    "employeeNumber",
    "employeeName",
    "userId",
    "uan",
    "wages",
    "employeeContribution",
    "employerContribution",
    "totalContribution",
  ];

  return finalize({
    ...baseMeta("PF_ECR", opts.periodMonth, opts.runId, opts.bundle, [
      `Rule ${opts.bundle.pf.version}: employee ${opts.bundle.pf.employeePercent}% / employer ${opts.bundle.pf.employerPercent}% on wages capped at ₹${opts.bundle.pf.monthlyWageCeiling}/mo.`,
      "CSV is StreamlineOS export format for external EPFO ECR preparation — not a live portal submission.",
      "UAN is pulled from employee bank/statutory details when captured (onboarding or sensitive tab).",
    ]),
    columns,
    rows,
    totals: {
      employeeContribution: sumField(rows, "employeeContribution"),
      employerContribution: sumField(rows, "employerContribution"),
      totalContribution: sumField(rows, "totalContribution"),
    },
    missingIdentifiers: missing,
  });
}

export function buildEsiExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const missing: string[] = [];
  const rows: Record<string, string | number>[] = [];

  for (const e of employees) {
    const empShare = amt(e.lines, ["ESI_EMPLOYEE", "ESI_EMP"]);
    const erShare = amt(e.lines, ["ESI_EMPLOYER", "ESI_ER"]);
    if (empShare === 0 && erShare === 0) continue;
    if (!e.employeeNumber) missing.push(`${e.userId}:employeeNumber`);
    if (!e.esiIpNumber) missing.push(`${e.userId}:esiIpNumber`);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId,
      ipNumber: e.esiIpNumber ?? "",
      grossWages: e.gross,
      employeeContribution: money(empShare),
      employerContribution: money(erShare),
      totalContribution: money(empShare + erShare),
    });
  }

  const columns = [
    "employeeNumber",
    "employeeName",
    "userId",
    "ipNumber",
    "grossWages",
    "employeeContribution",
    "employerContribution",
    "totalContribution",
  ];

  return finalize({
    ...baseMeta("ESI", opts.periodMonth, opts.runId, opts.bundle, [
      `Rule ${opts.bundle.esi.version}: employee ${opts.bundle.esi.employeePercent}% / employer ${opts.bundle.esi.employerPercent}% when gross ≤ ₹${opts.bundle.esi.monthlyEligibilityCeiling}.`,
      "Export-only for ESIC portal preparation. IP number from employee statutory details when captured.",
    ]),
    columns,
    rows,
    totals: {
      employeeContribution: sumField(rows, "employeeContribution"),
      employerContribution: sumField(rows, "employerContribution"),
      totalContribution: sumField(rows, "totalContribution"),
    },
    missingIdentifiers: missing,
  });
}

export function buildPtExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const rows: Record<string, string | number>[] = [];
  for (const e of employees) {
    const pt = amt(e.lines, PT_CODES);
    if (pt === 0) continue;
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId,
      professionalTax: money(pt),
      gross: e.gross,
    });
  }
  const columns = ["employeeNumber", "employeeName", "userId", "professionalTax", "gross"];
  return finalize({
    ...baseMeta("PT", opts.periodMonth, opts.runId, opts.bundle, [
      `Rule ${opts.bundle.pt.version}: state-aware PT; default ₹${opts.bundle.pt.defaultMonthly}/mo when state not mapped.`,
      "Submit on the relevant state professional tax portal.",
    ]),
    columns,
    rows,
    totals: { professionalTax: sumField(rows, "professionalTax") },
    missingIdentifiers: [],
  });
}

export function buildLwfExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const rows: Record<string, string | number>[] = [];
  for (const e of employees) {
    const emp = amt(e.lines, ["LWF_EMPLOYEE", "LWF"]);
    const er = amt(e.lines, ["LWF_EMPLOYER"]);
    if (emp === 0 && er === 0) continue;
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId,
      employeeLwf: money(emp),
      employerLwf: money(er),
      totalLwf: money(emp + er),
    });
  }
  const columns = [
    "employeeNumber",
    "employeeName",
    "userId",
    "employeeLwf",
    "employerLwf",
    "totalLwf",
  ];
  return finalize({
    ...baseMeta("LWF", opts.periodMonth, opts.runId, opts.bundle, [
      `Rule ${opts.bundle.lwf.version}: fixed employee/employer LWF with state overrides where configured.`,
      "Export-only — remittance via state LWF portal.",
    ]),
    columns,
    rows,
    totals: {
      employeeLwf: sumField(rows, "employeeLwf"),
      employerLwf: sumField(rows, "employerLwf"),
      totalLwf: sumField(rows, "totalLwf"),
    },
    missingIdentifiers: [],
  });
}

export function buildTds24qExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const rows: Record<string, string | number>[] = [];
  const missing: string[] = [];
  for (const e of employees) {
    const tds = amt(e.lines, TDS_CODES);
    if (tds === 0) continue;
    if (!e.pan) missing.push(`${e.userId}:pan`);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId,
      pan: e.pan ?? "",
      email: e.email ?? "",
      gross: e.gross,
      tdsDeducted: money(tds),
      net: e.net,
    });
  }
  const columns = [
    "employeeNumber",
    "employeeName",
    "userId",
    "pan",
    "email",
    "gross",
    "tdsDeducted",
    "net",
  ];
  return finalize({
    ...baseMeta("TDS_24Q", opts.periodMonth, opts.runId, opts.bundle, [
      `Rule ${opts.bundle.tds.version} (${opts.bundle.tds.ruleYearLabel}): quarterly ${opts.bundle.tds.formLabels.quarterlyReturn} support is export summary only.`,
      "Not a complete TRACES/e-filing XML package — prepare return externally. PAN from employee sensitive fields when captured.",
    ]),
    columns,
    rows,
    totals: { tdsDeducted: sumField(rows, "tdsDeducted") },
    missingIdentifiers: missing,
  });
}

/** Form 16 annual certificate — summary rows only; full PDF/template is not produced. */
export function buildForm16SummaryExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const rows: Record<string, string | number>[] = [];
  for (const e of employees) {
    const tds = amt(e.lines, TDS_CODES);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId,
      pan: e.pan ?? "",
      email: e.email ?? "",
      periodGross: e.gross,
      periodTds: money(tds),
      periodNet: e.net,
    });
  }
  const columns = [
    "employeeNumber",
    "employeeName",
    "userId",
    "pan",
    "email",
    "periodGross",
    "periodTds",
    "periodNet",
  ];
  return finalize({
    ...baseMeta("FORM16", opts.periodMonth, opts.runId, opts.bundle, [
      `${opts.bundle.tds.formLabels.annualCertificate} full certificate generation is not implemented.`,
      "This export is a period summary for external Form 16 preparation only.",
    ]),
    columns,
    rows,
    totals: {
      periodGross: sumField(rows, "periodGross"),
      periodTds: sumField(rows, "periodTds"),
    },
    missingIdentifiers: [],
  });
}

export function buildFilingExport(
  filingType: FilingExportType,
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  switch (filingType) {
    case "PF_ECR":
      return buildPfEcrExport(employees, opts);
    case "ESI":
      return buildEsiExport(employees, opts);
    case "PT":
      return buildPtExport(employees, opts);
    case "LWF":
      return buildLwfExport(employees, opts);
    case "TDS_24Q":
      return buildTds24qExport(employees, opts);
    case "FORM16":
      return buildForm16SummaryExport(employees, opts);
    default: {
      const _exhaustive: never = filingType;
      throw new Error(`Unsupported filing type: ${String(_exhaustive)}`);
    }
  }
}

/** Codes that participate in any statutory export (for line aggregation). */
export const STATUTORY_EXPORT_LINE_CODES = [
  ...PF_CODES,
  ...ESI_CODES,
  ...PT_CODES,
  ...LWF_CODES,
  ...TDS_CODES,
] as const;
