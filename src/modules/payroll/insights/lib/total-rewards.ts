import { toPaise } from "../../runs/lib/money";

export interface TotalRewardsCashInput {
  annualCtc: number | null;
  ytdGross: number;
  ytdNet: number;
  activeLoanBalance: number;
}

export interface TotalRewardsBenefitLine {
  planName: string;
  category: string;
  premiumCents: number | null;
  employerContributionPct: number;
  status: string;
}

export interface TotalRewardsEquityLine {
  grantType: string;
  units: number;
  strikePriceCents: number | null;
  status: string;
  grantDate: string;
}

export interface TotalRewardsLeaveLine {
  leaveType: string;
  balance: number;
}

export interface TotalRewardsStatement {
  mode: "illustrative_statement";
  honestyNote: string;
  asOf: string;
  financialYear: string;
  cash: {
    annualCtc: string | null;
    ytdGross: string;
    ytdNet: string;
    activeLoanBalance: string;
  };
  benefits: {
    lines: {
      planName: string;
      category: string;
      status: string;
      estimatedEmployerMonthly: string | null;
      note: string;
    }[];
    estimatedEmployerAnnual: string | null;
  };
  equity: {
    lines: {
      grantType: string;
      units: number;
      status: string;
      grantDate: string;
      strikePrice: string | null;
      note: string;
    }[];
    totalUnits: number;
    valued: false;
  };
  leave: {
    lines: { leaveType: string; balanceDays: string }[];
    note: string;
  };
  summary: {
    cashAnnualCtc: string | null;
    benefitsEmployerAnnualEstimate: string | null;
    equityUnits: number;
    completeness: "partial" | "rich";
    missing: string[];
  };
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function estimateEmployerMonthlyBenefit(
  premiumCents: number | null,
  employerContributionPct: number,
): number | null {
  if (premiumCents == null || premiumCents <= 0) return null;
  return (premiumCents / 100) * (employerContributionPct / 100);
}

/**
 * Build total rewards statement from domain slices (unit-testable).
 */
export function buildTotalRewardsStatement(input: {
  asOf?: Date;
  cash: TotalRewardsCashInput;
  benefits: TotalRewardsBenefitLine[];
  equity: TotalRewardsEquityLine[];
  leave: TotalRewardsLeaveLine[];
}): TotalRewardsStatement {
  const asOf = input.asOf ?? new Date();
  const yr = asOf.getFullYear();
  const mo = asOf.getMonth() + 1;
  const fyStart = mo >= 4 ? yr : yr - 1;
  const financialYear = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

  const benefitLines = input.benefits.map((b) => {
    const monthly = estimateEmployerMonthlyBenefit(b.premiumCents, b.employerContributionPct);
    return {
      planName: b.planName,
      category: b.category,
      status: b.status,
      estimatedEmployerMonthly: monthly != null ? money(monthly) : null,
      note:
        monthly != null
          ? `Employer ~${b.employerContributionPct}% of plan premium`
          : "Premium not configured — employer cost unknown",
    };
  });

  let employerAnnualPaise: number | null = 0;
  let anyBenefitEstimate = false;
  for (const line of benefitLines) {
    if (line.estimatedEmployerMonthly != null) {
      anyBenefitEstimate = true;
      employerAnnualPaise += toPaise(line.estimatedEmployerMonthly) * 12;
    }
  }
  if (!anyBenefitEstimate) employerAnnualPaise = null;
  const employerAnnual = employerAnnualPaise != null ? employerAnnualPaise / 100 : null;

  const equityLines = input.equity.map((e) => ({
    grantType: e.grantType,
    units: e.units,
    status: e.status,
    grantDate: e.grantDate,
    strikePrice:
      e.strikePriceCents != null ? money(e.strikePriceCents / 100) : null,
    note: "Units only — fair market value is not computed (no live valuation)",
  }));

  const totalUnits = equityLines.reduce((s, e) => s + e.units, 0);

  const missing: string[] = [];
  if (input.cash.annualCtc == null) missing.push("active_salary_profile");
  if (input.cash.ytdGross <= 0) missing.push("published_ytd_payslips");
  if (input.benefits.length === 0) missing.push("benefit_enrollments");
  if (input.equity.length === 0) missing.push("equity_grants");
  if (input.leave.length === 0) missing.push("leave_balances");

  const completeness =
    missing.length <= 2 && input.cash.annualCtc != null ? "rich" : "partial";

  return {
    mode: "illustrative_statement",
    honestyNote:
      "Total rewards is an illustrative composition of salary, YTD payslips, benefit enrollments, equity units, and leave balances. It is not a legally certified compensation statement and does not mark equity to market.",
    asOf: asOf.toISOString().slice(0, 10),
    financialYear,
    cash: {
      annualCtc: input.cash.annualCtc != null ? money(input.cash.annualCtc) : null,
      ytdGross: money(input.cash.ytdGross),
      ytdNet: money(input.cash.ytdNet),
      activeLoanBalance: money(input.cash.activeLoanBalance),
    },
    benefits: {
      lines: benefitLines,
      estimatedEmployerAnnual:
        employerAnnual != null ? money(employerAnnual) : null,
    },
    equity: {
      lines: equityLines,
      totalUnits,
      valued: false,
    },
    leave: {
      lines: input.leave.map((l) => ({
        leaveType: l.leaveType,
        balanceDays: String(l.balance),
      })),
      note: "Leave is non-cash; balance days are not converted to rupees",
    },
    summary: {
      cashAnnualCtc:
        input.cash.annualCtc != null ? money(input.cash.annualCtc) : null,
      benefitsEmployerAnnualEstimate:
        employerAnnual != null ? money(employerAnnual) : null,
      equityUnits: totalUnits,
      completeness,
      missing,
    },
  };
}
