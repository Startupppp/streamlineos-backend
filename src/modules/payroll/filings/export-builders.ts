/**
 * India statutory export artifact builders (export-only).
 * Produce structured rows + CSV for external portal filing.
 * Never claim automatic submission or remittance.
 */

import { assertNever } from "../../../common/types/assert-never";
import { buildCsv } from "../insights/lib/csv";
import {
  IN_STATUTORY_RULE_BUNDLE_VERSION,
  type IndiaStatutoryBundle,
} from "../runs/lib/statutory-registry";
import { toPaise } from "../runs/lib/money";

export type FilingExportType = "PF_ECR" | "PF_ECR_TXT" | "ESI" | "PT" | "TDS_24Q" | "FORM16" | "LWF";

export interface EmployeeStatutorySourceRow {
  subjectKey: string;
  userId: string | null;
  workerId: string | null;
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
  ncpDays?: string;
}

export interface FilingExportArtifact {
  filingType: FilingExportType;
  format: "csv" | "txt";
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

const PT_CODES = ["PROFESSIONAL_TAX", "PT"] as const;
const TDS_CODES = ["TDS"] as const;

function amt(lines: Record<string, string>, codes: readonly string[]): number {
  let sumPaise = 0;
  for (const c of codes) {
    const v = lines[c];
    if (v != null && v !== "") sumPaise += toPaise(v);
  }
  return sumPaise / 100;
}

function money(n: number): string {
  return n.toFixed(2);
}

function sumField(rows: Record<string, string | number>[], key: string): string {
  let totalPaise = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number") totalPaise += Math.round(v * 100);
    else if (typeof v === "string" && v !== "") totalPaise += toPaise(v);
  }
  return money(totalPaise / 100);
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
    if (!e.employeeNumber) missing.push(`${e.subjectKey}:employeeNumber`);
    if (!e.uan) missing.push(`${e.subjectKey}:uan`);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId ?? e.subjectKey,
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

const EPS_PERCENT = 8.33;

function wholeRupees(paise: number): number {
  return Math.floor((paise + 50) / 100);
}

export function buildPfEcrTxtExport(
  employees: EmployeeStatutorySourceRow[],
  opts: { periodMonth: string | null; runId: number | null; bundle: IndiaStatutoryBundle },
): FilingExportArtifact {
  const missing: string[] = [];
  const rows: Record<string, string | number>[] = [];
  const ceilingPaise = toPaise(opts.bundle.pf.monthlyWageCeiling);
  const eePercent = Number(opts.bundle.pf.employeePercent);

  for (const e of employees) {
    const eePaise = Math.round(amt(e.lines, ["EPF_EMPLOYEE", "PF_EMP", "PF_EE"]) * 100);
    const erPaise = Math.round(amt(e.lines, ["EPF_EMPLOYER", "PF_ER"]) * 100);
    if (eePaise === 0 && erPaise === 0) continue;
    const uan = e.uan?.trim() ?? "";
    if (!uan) {
      missing.push(`${e.subjectKey}:uan`);
      continue;
    }
    const epfWagesPaise = eePercent > 0 ? Math.round((eePaise * 100) / eePercent) : 0;
    const epsWagesPaise = Math.min(epfWagesPaise, ceilingPaise);
    const erRupees = wholeRupees(erPaise);
    const epsRupees = Math.min(erRupees, wholeRupees(Math.round((epsWagesPaise * EPS_PERCENT) / 100)));
    rows.push({
      uan,
      memberName: e.employeeName.replace(/#~#|[\r\n]/g, " ").trim(),
      grossWages: wholeRupees(toPaise(e.gross)),
      epfWages: wholeRupees(epfWagesPaise),
      epsWages: wholeRupees(epsWagesPaise),
      edliWages: wholeRupees(epsWagesPaise),
      epfContribution: wholeRupees(eePaise),
      epsContribution: epsRupees,
      epfEpsDifference: erRupees - epsRupees,
      ncpDays: Math.round(Number(e.ncpDays ?? 0)),
      refundOfAdvances: 0,
    });
  }

  const columns = [
    "uan",
    "memberName",
    "grossWages",
    "epfWages",
    "epsWages",
    "edliWages",
    "epfContribution",
    "epsContribution",
    "epfEpsDifference",
    "ncpDays",
    "refundOfAdvances",
  ];
  const notes = [
    "EPFO ECR 2.0 text: one line per member, fields joined by #~#, whole rupees. Upload on the EPFO unified portal yourself.",
    `EPF wages are derived from the employee share at ${opts.bundle.pf.employeePercent}%; EPS and EDLI wages are capped at ₹${opts.bundle.pf.monthlyWageCeiling}; EPS is ${EPS_PERCENT}% of EPS wages.`,
    "Refund of advances is always 0.",
  ];
  if (missing.length > 0)
    notes.push(`${missing.length} member(s) excluded because no UAN is captured: ${missing.map((m) => m.split(":")[0]).join(", ")}.`);

  return {
    ...baseMeta("PF_ECR_TXT", opts.periodMonth, opts.runId, opts.bundle, notes),
    format: "txt",
    columns,
    rows,
    rowCount: rows.length,
    totals: {
      epfContribution: sumField(rows, "epfContribution"),
      epsContribution: sumField(rows, "epsContribution"),
      epfEpsDifference: sumField(rows, "epfEpsDifference"),
    },
    missingIdentifiers: missing,
    csv: rows.map((r) => columns.map((c) => String(r[c])).join("#~#")).join("\n"),
  };
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
    if (!e.employeeNumber) missing.push(`${e.subjectKey}:employeeNumber`);
    if (!e.esiIpNumber) missing.push(`${e.subjectKey}:esiIpNumber`);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId ?? e.subjectKey,
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
      userId: e.userId ?? e.subjectKey,
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
      userId: e.userId ?? e.subjectKey,
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
    if (!e.pan) missing.push(`${e.subjectKey}:pan`);
    rows.push({
      employeeNumber: e.employeeNumber ?? "",
      employeeName: e.employeeName,
      userId: e.userId ?? e.subjectKey,
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
      userId: e.userId ?? e.subjectKey,
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
      `${opts.bundle.tds.formLabels.annualCertificate}: period-summary PDF available per employee (not official Part A/B).`,
      "CSV + pilot PDF support external preparation only. TRACES XML and legal Form 16 certificates are not generated.",
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
    case "PF_ECR_TXT":
      return buildPfEcrTxtExport(employees, opts);
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
      return assertNever(filingType);
    }
  }
}
