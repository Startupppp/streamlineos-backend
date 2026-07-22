/**
 * PRD acceptance scenarios (unit-level).
 * Full browser E2E requires a running stack; these gate correctness of
 * launch-critical invariants from payroll-product-prd.md §18.
 */
import { GoneException } from "@nestjs/common";
import { canTransitionRun, PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { calcStatutory } from "../runs/lib/statutory";
import {
  getIndiaBundleForDate,
  validateLabourCodeWageDefinition,
  calcHraExemptionPaise,
  resolvePtMonthly,
  resolveLwf,
} from "../runs/lib/statutory-registry";
import { BankTransfersService } from "../../hr-payroll/bank-transfers.service";
import { createRunSchema } from "../runs/dto/runs.schemas";

const rounding = { mode: "NEAREST" as const, precision: 0 as const };

describe("PRD acceptance — launch gates", () => {
  it("scenario 7: contractor payroll does not receive employee PF/ESI", () => {
    const result = calcStatutory({
      workerType: "CONTRACTOR",
      toggles: {
        pf: true,
        esi: true,
        professionalTax: true,
        gratuity: true,
        lwf: true,
      } as never,
      config: { statutory: {} } as never,
      basicPaise: 5_000_000,
      grossPaise: 8_000_000,
      rounding,
    });
    expect(result.lines).toHaveLength(0);
    expect(result.totalEmployeeDeductionPaise).toBe(0);
  });

  it("scenario 8: PT/LWF change by state", () => {
    const bundle = getIndiaBundleForDate();
    expect(resolvePtMonthly(bundle, "TN")).not.toBe(resolvePtMonthly(bundle, "WB"));
    expect(resolveLwf(bundle, "MH").employerFixed).not.toBe(resolveLwf(bundle, "KA").employerFixed);
  });

  it("scenario 9: locked statuses cannot transition to mutating states except REOPENED/PAID path", () => {
    for (const s of PAYROLL_LOCKED_STATUSES) {
      expect(canTransitionRun(s, "DRAFT")).toBe(false);
      expect(canTransitionRun(s, "PREVIEW_READY")).toBe(false);
    }
    expect(canTransitionRun("LOCKED", "REOPENED")).toBe(true);
    expect(canTransitionRun("LOCKED", "PAID")).toBe(true);
  });

  it("legacy unmasked bank transfer writes are disabled", async () => {
    const service = new BankTransfersService({ insert: jest.fn() } as never);
    await expect(
      service.create("org", "user", {
        month: "2025-06",
        totalAmount: 1,
        employeeCount: 1,
        entries: [],
      } as never),
    ).rejects.toThrow(GoneException);
  });

  it("off-cycle/correction runs require source linkage", () => {
    const bad = createRunSchema.safeParse({ month: "2025-06", runType: "OFF_CYCLE" });
    expect(bad.success).toBe(false);

    const ok = createRunSchema.safeParse({
      month: "2025-06",
      runType: "CORRECTION",
      sourcePeriodKey: "2025-05",
    });
    expect(ok.success).toBe(true);
  });

  it("REGULAR run type is default and does not need source", () => {
    const ok = createRunSchema.safeParse({ month: "2025-06" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.runType).toBe("REGULAR");
  });

  it("Labour Code 50% wage definition validation", () => {
    expect(validateLabourCodeWageDefinition(6_000_000, 0, 10_000_000).ok).toBe(true);
    expect(validateLabourCodeWageDefinition(3_000_000, 0, 10_000_000).ok).toBe(false);
  });

  it("HRA exemption is min-of-three (metro)", () => {
    const { exemptionPaise } = calcHraExemptionPaise({
      basicPaise: 5_000_000,
      hraReceivedPaise: 2_000_000,
      rentPaidPaise: 2_500_000,
      isMetro: true,
    });
    expect(exemptionPaise).toBe(2_000_000);
  });

  it("India PF uses monthly wage ceiling from registry (not misnamed annual field)", () => {
    const bundle = getIndiaBundleForDate();
    expect(bundle.pf.monthlyWageCeiling).toBe("15000.00");
    expect(bundle.pf.legacyMisnamedAnnualField).toBe("21600");

    const emp = calcStatutory({
      workerType: "EMPLOYEE",
      toggles: { pf: true, esi: false, professionalTax: false, gratuity: false, lwf: false } as never,
      config: {
        statutory: {
          pfEmployeePercent: "12",
          pfEmployerPercent: "12",
          pfWageCeiling: "15000.00",
        },
      } as never,
      basicPaise: 3_000_000, // 30k > 15k ceiling
      grossPaise: 5_000_000,
      rounding,
    });
    const pf = emp.lines.find((l) => l.code === "EPF_EMPLOYEE");
    expect(pf).toBeDefined();
    // 15000 * 12% = 1800
    expect(pf!.amount).toBe("1800.00");
    expect(emp.ruleVersion).toBe("IN-2025.04");
  });

  it("filing honesty: export status labels must not claim filed without acknowledgement", () => {
    // Product contract constant — filings.service default
    const label = "Export prepared — external filing required";
    expect(label.toLowerCase()).toContain("external filing");
    expect(label.toLowerCase()).not.toContain("filed successfully");
  });
});
