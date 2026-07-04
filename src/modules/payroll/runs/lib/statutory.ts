import type {
  PayrollPolicyConfig,
  PayrollToggles,
  PayrollWorkerType,
  CalculationSnapshotLine,
} from "../../payroll.types";
import { toPaise, fromPaise, pctOf, applyRounding } from "./money";
import type { RoundingConfig } from "./money";

interface StatutoryInput {
  workerType: PayrollWorkerType;
  toggles: PayrollToggles;
  config: PayrollPolicyConfig;
  basicPaise: number;
  grossPaise: number;
  rounding: RoundingConfig;
}

interface StatutoryResult {
  lines: CalculationSnapshotLine[];
  totalEmployeeDeductionPaise: number;
  totalEmployerContributionPaise: number;
}

const LWF_EMPLOYEE_PAISE = 2500;
const LWF_EMPLOYER_PAISE = 2500;
const GRATUITY_PERCENT = "4.81";
const SORT_BASE = 900;

export function calcStatutory(input: StatutoryInput): StatutoryResult {
  const { workerType, toggles, config, basicPaise, grossPaise, rounding } = input;

  if (workerType === "CONTRACTOR" || workerType === "CONSULTANT") {
    return { lines: [], totalEmployeeDeductionPaise: 0, totalEmployerContributionPaise: 0 };
  }

  const lines: CalculationSnapshotLine[] = [];
  let totalEmployeeDeductionPaise = 0;
  let totalEmployerContributionPaise = 0;

  if (toggles.pf) {
    const { pfEmployeePercent, pfEmployerPercent, pfWageCeiling } = config.statutory;
    const ceilingPaise = pfWageCeiling != null ? toPaise(pfWageCeiling) : Infinity;
    const pfBasePaise = Math.min(basicPaise, ceilingPaise);
    const pfEmpPaise = applyRounding(pctOf(pfBasePaise, pfEmployeePercent), rounding);
    const pfErPaise = applyRounding(pctOf(pfBasePaise, pfEmployerPercent), rounding);

    lines.push({
      code: "EPF_EMPLOYEE",
      name: "EPF Employee",
      category: "DEDUCTION",
      amount: fromPaise(pfEmpPaise),
      calcMethod: "PERCENT_OF_BASIC",
      taxable: false,
      sortOrder: SORT_BASE + 1,
      explain: {
        method: "PERCENT_OF_BASIC",
        inputs: { basic: basicPaise / 100, pfWageCeiling: pfBasePaise / 100, pfEmployeePercent: parseFloat(pfEmployeePercent) },
        steps: [
          `PF base = min(Basic ₹${(basicPaise / 100).toFixed(2)}, ceiling ₹${pfBasePaise === Infinity ? "∞" : (pfBasePaise / 100).toFixed(2)}) = ₹${(pfBasePaise / 100).toFixed(2)}`,
          `EPF Employee = ₹${(pfBasePaise / 100).toFixed(2)} × ${pfEmployeePercent}% = ₹${(pfEmpPaise / 100).toFixed(2)}`,
        ],
      },
    });

    lines.push({
      code: "EPF_EMPLOYER",
      name: "EPF Employer",
      category: "EMPLOYER_CONTRIBUTION",
      amount: fromPaise(pfErPaise),
      calcMethod: "PERCENT_OF_BASIC",
      taxable: false,
      sortOrder: SORT_BASE + 2,
      explain: {
        method: "PERCENT_OF_BASIC",
        inputs: { basic: basicPaise / 100, pfWageCeiling: pfBasePaise / 100, pfEmployerPercent: parseFloat(pfEmployerPercent) },
        steps: [
          `PF base = min(Basic ₹${(basicPaise / 100).toFixed(2)}, ceiling ₹${pfBasePaise === Infinity ? "∞" : (pfBasePaise / 100).toFixed(2)}) = ₹${(pfBasePaise / 100).toFixed(2)}`,
          `EPF Employer = ₹${(pfBasePaise / 100).toFixed(2)} × ${pfEmployerPercent}% = ₹${(pfErPaise / 100).toFixed(2)}`,
        ],
      },
    });

    totalEmployeeDeductionPaise += pfEmpPaise;
    totalEmployerContributionPaise += pfErPaise;
  }

  if (toggles.esi) {
    const { esiEmployeePercent, esiEmployerPercent, esiWageCeiling } = config.statutory;
    const esiCeilingPaise = esiWageCeiling != null ? toPaise(esiWageCeiling) : 999999999;
    if (grossPaise <= esiCeilingPaise) {
      const esiEmpPaise = applyRounding(pctOf(grossPaise, esiEmployeePercent), rounding);
      const esiErPaise = applyRounding(pctOf(grossPaise, esiEmployerPercent), rounding);

      lines.push({
        code: "ESI_EMPLOYEE",
        name: "ESI Employee",
        category: "DEDUCTION",
        amount: fromPaise(esiEmpPaise),
        calcMethod: "PERCENT_OF_GROSS",
        taxable: false,
        sortOrder: SORT_BASE + 3,
        explain: {
          method: "PERCENT_OF_GROSS",
          inputs: { gross: grossPaise / 100, esiWageCeiling: esiCeilingPaise / 100, esiEmployeePercent: parseFloat(esiEmployeePercent) },
          steps: [
            `Gross ₹${(grossPaise / 100).toFixed(2)} ≤ ESI ceiling ₹${(esiCeilingPaise / 100).toFixed(2)}`,
            `ESI Employee = ₹${(grossPaise / 100).toFixed(2)} × ${esiEmployeePercent}% = ₹${(esiEmpPaise / 100).toFixed(2)}`,
          ],
        },
      });

      lines.push({
        code: "ESI_EMPLOYER",
        name: "ESI Employer",
        category: "EMPLOYER_CONTRIBUTION",
        amount: fromPaise(esiErPaise),
        calcMethod: "PERCENT_OF_GROSS",
        taxable: false,
        sortOrder: SORT_BASE + 4,
        explain: {
          method: "PERCENT_OF_GROSS",
          inputs: { gross: grossPaise / 100, esiEmployerPercent: parseFloat(esiEmployerPercent) },
          steps: [
            `ESI Employer = ₹${(grossPaise / 100).toFixed(2)} × ${esiEmployerPercent}% = ₹${(esiErPaise / 100).toFixed(2)}`,
          ],
        },
      });

      totalEmployeeDeductionPaise += esiEmpPaise;
      totalEmployerContributionPaise += esiErPaise;
    }
  }

  if (toggles.professionalTax) {
    const ptPaise = toPaise(config.statutory.professionalTaxMonthly);
    const ptRounded = applyRounding(ptPaise, rounding);
    lines.push({
      code: "PROFESSIONAL_TAX",
      name: "Professional Tax",
      category: "DEDUCTION",
      amount: fromPaise(ptRounded),
      calcMethod: "FIXED",
      taxable: false,
      sortOrder: SORT_BASE + 5,
      explain: {
        method: "FIXED",
        inputs: { professionalTaxMonthly: ptRounded / 100 },
        steps: [`Professional Tax = ₹${(ptRounded / 100).toFixed(2)} (fixed monthly)`],
      },
    });
    totalEmployeeDeductionPaise += ptRounded;
  }

  if (toggles.gratuity) {
    const gratuityPaise = applyRounding(pctOf(basicPaise, GRATUITY_PERCENT), rounding);
    lines.push({
      code: "GRATUITY",
      name: "Gratuity",
      category: "EMPLOYER_CONTRIBUTION",
      amount: fromPaise(gratuityPaise),
      calcMethod: "PERCENT_OF_BASIC",
      taxable: false,
      sortOrder: SORT_BASE + 6,
      explain: {
        method: "PERCENT_OF_BASIC",
        inputs: { basic: basicPaise / 100, gratuityPercent: parseFloat(GRATUITY_PERCENT) },
        steps: [`Gratuity = Basic ₹${(basicPaise / 100).toFixed(2)} × 4.81% = ₹${(gratuityPaise / 100).toFixed(2)}`],
      },
    });
    totalEmployerContributionPaise += gratuityPaise;
  }

  if (toggles.lwf) {
    const lwfEmpRounded = applyRounding(LWF_EMPLOYEE_PAISE, rounding);
    const lwfErRounded = applyRounding(LWF_EMPLOYER_PAISE, rounding);

    lines.push({
      code: "LWF_EMPLOYEE",
      name: "LWF Employee",
      category: "DEDUCTION",
      amount: fromPaise(lwfEmpRounded),
      calcMethod: "FIXED",
      taxable: false,
      sortOrder: SORT_BASE + 7,
      explain: {
        method: "FIXED",
        inputs: { lwfEmployee: lwfEmpRounded / 100 },
        steps: [`LWF Employee = ₹${(lwfEmpRounded / 100).toFixed(2)} (fixed)`],
      },
    });

    lines.push({
      code: "LWF_EMPLOYER",
      name: "LWF Employer",
      category: "EMPLOYER_CONTRIBUTION",
      amount: fromPaise(lwfErRounded),
      calcMethod: "FIXED",
      taxable: false,
      sortOrder: SORT_BASE + 8,
      explain: {
        method: "FIXED",
        inputs: { lwfEmployer: lwfErRounded / 100 },
        steps: [`LWF Employer = ₹${(lwfErRounded / 100).toFixed(2)} (fixed)`],
      },
    });

    totalEmployeeDeductionPaise += lwfEmpRounded;
    totalEmployerContributionPaise += lwfErRounded;
  }

  return { lines, totalEmployeeDeductionPaise, totalEmployerContributionPaise };
}
