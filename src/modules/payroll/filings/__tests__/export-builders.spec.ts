import {
  buildFilingExport,
  buildPfEcrExport,
  buildEsiExport,
  buildForm16SummaryExport,
  type EmployeeStatutorySourceRow,
} from "../export-builders";
import { IN_STATUTORY_2025_04 } from "../../runs/lib/statutory-registry";

const bundle = IN_STATUTORY_2025_04;

const employees: EmployeeStatutorySourceRow[] = [
  {
    subjectKey: "u1",
    userId: "u1",
    workerId: null,
    employeeNumber: "E001",
    employeeName: "Ada Lovelace",
    email: "ada@example.com",
    gross: "50000.00",
    net: "42000.00",
    uan: "100123456789",
    esiIpNumber: null,
    pan: "ABCDE1234F",
    lines: {
      EPF_EMPLOYEE: "1800.00",
      EPF_EMPLOYER: "1800.00",
      ESI_EMPLOYEE: "0",
      PROFESSIONAL_TAX: "200.00",
      LWF_EMPLOYEE: "25.00",
      LWF_EMPLOYER: "25.00",
      TDS: "2500.00",
    },
  },
  {
    subjectKey: "u2",
    userId: "u2",
    workerId: null,
    employeeNumber: null,
    employeeName: "No Number",
    email: null,
    gross: "18000.00",
    net: "16500.00",
    uan: null,
    esiIpNumber: "IP-9911",
    pan: null,
    lines: {
      ESI_EMPLOYEE: "135.00",
      ESI_EMPLOYER: "585.00",
      EPF_EMPLOYEE: "1800.00",
      EPF_EMPLOYER: "1800.00",
    },
  },
];

describe("statutory export builders", () => {
  it("builds PF ECR with honesty + rule version + totals", () => {
    const art = buildPfEcrExport(employees, {
      periodMonth: "2026-07",
      runId: 9,
      bundle,
    });
    expect(art.mode).toBe("export_only");
    expect(art.automaticFiling).toBe(false);
    expect(art.honestyLabel).toMatch(/external filing/i);
    expect(art.ruleBundleVersion).toBe("IN-2025.04");
    expect(art.rowCount).toBe(2);
    expect(art.totals.employeeContribution).toBe("3600.00");
    expect(art.totals.employerContribution).toBe("3600.00");
    expect(art.csv).toContain("Ada Lovelace");
    expect(art.csv).toContain("100123456789");
    expect(art.missingIdentifiers.some((m) => m.includes("u2:uan"))).toBe(true);
  });

  it("builds ESI only for employees with ESI lines and includes IP", () => {
    const art = buildEsiExport(employees, {
      periodMonth: "2026-07",
      runId: 9,
      bundle,
    });
    expect(art.rowCount).toBe(1);
    expect(art.rows[0]?.userId).toBe("u2");
    expect(art.rows[0]?.ipNumber).toBe("IP-9911");
    expect(art.totals.totalContribution).toBe("720.00");
  });

  it("FORM16 is period summary with an explicit not-official disclosure", () => {
    const art = buildForm16SummaryExport(employees, {
      periodMonth: "2026-07",
      runId: 9,
      bundle,
    });
    expect(art.filingType).toBe("FORM16");
    const notes = art.notes.join(" ");
    expect(notes).toMatch(/not official/i);
    expect(notes).toMatch(/not generated/i);
    expect(art.rowCount).toBe(2);
  });

  it("paise accumulation is exact for multi-employee contribution totals", () => {
    const manyEmployees: EmployeeStatutorySourceRow[] = Array.from({ length: 5 }, (_, i) => ({
      subjectKey: `p${i}`,
      userId: `p${i}`,
      workerId: null,
      employeeNumber: `P00${i}`,
      employeeName: `Payee ${i}`,
      email: null,
      gross: "30000.00",
      net: "26000.00",
      uan: `10098765432${i}`,
      esiIpNumber: null,
      pan: null,
      lines: { EPF_EMPLOYEE: "1800.00", EPF_EMPLOYER: "1800.00" },
    }));
    const art = buildPfEcrExport(manyEmployees, { periodMonth: "2026-07", runId: 2, bundle });
    expect(art.totals.employeeContribution).toBe("9000.00");
    expect(art.totals.employerContribution).toBe("9000.00");
    expect(5 * 180000).toBe(900000);
  });

  it("dispatches all supported filing types", () => {
    for (const t of ["PF_ECR", "ESI", "PT", "TDS_24Q", "FORM16", "LWF"] as const) {
      const art = buildFilingExport(t, employees, {
        periodMonth: "2026-07",
        runId: 1,
        bundle,
      });
      expect(art.filingType).toBe(t);
      expect(art.automaticRemittance).toBe(false);
      expect(art.csv.length).toBeGreaterThan(0);
    }
  });
});
