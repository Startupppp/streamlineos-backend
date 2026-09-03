import {
  PolicyQueryService,
  POLICY_PREVIEW_COMPONENT_WIRE_KEYS,
  POLICY_PREVIEW_WIRE_KEYS,
} from "../policy-query.service";
import { computeTemplatePreview } from "../lib/template-preview";
import { INDIAN_STANDARD_SEED } from "../template-seeds/indian-standard-seeds";
import type { Db } from "../../../../db/drizzle.module";
import type { PayrollTemplatesService } from "../templates.service";

/**
 * The policy preview payload, asserted on what the read path RETURNS.
 *
 * `hooks/api/payroll/policies.ts` read this route through `apiClient.post<PolicyPreviewResult>`,
 * a cast. The client declared `components: PreviewLine[]` and
 * `features/payroll/setup/steps/step-review.tsx:130` rendered `formatMoney(line.monthlyAmount)`.
 * The service has never emitted `monthlyAmount` on this route and cannot: `policyPreviewSchema`
 * is `.strict()` and carries no `annualCtc`, and `SetupDraft` never collects one. Both repos
 * typechecked clean with the two shapes in open disagreement and every amount on the review step
 * rendered as an em dash.
 *
 * Nothing here relies on a typecheck. Every assertion drives the real `preview` with a database
 * double and reads the object it hands back.
 */

const ORG = "org-1";

function makeDb(payDay: number | null = 28): Db {
  return {
    query: {
      payrollPolicies: {
        findFirst: jest.fn().mockResolvedValue(payDay === null ? undefined : { payDay }),
      },
    },
  } as unknown as Db;
}

function makeTemplatesService(defaultComponents: unknown): PayrollTemplatesService {
  return {
    getById: jest.fn().mockResolvedValue({
      id: 9,
      key: null,
      name: "Custom",
      defaultComponents,
      defaultToggles: {},
    }),
  } as unknown as PayrollTemplatesService;
}

function build(db: Db, templates: PayrollTemplatesService = makeTemplatesService([])) {
  return new PolicyQueryService(db, templates);
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

/** `features/payroll/shared/payroll-format.ts` — the renderer the review step used. */
function formatMoney(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

interface BasisView {
  calcMethod: string;
  amount: string | null;
  percent: string | null;
  formula: string | null;
}

/** `describeComponentBasis` — the renderer that replaced it, over the fields that DO arrive. */
function describeBasis(line: BasisView): string {
  switch (line.calcMethod) {
    case "FIXED":
      return line.amount === null ? "Fixed amount" : `${formatMoney(line.amount)}/mo`;
    case "PERCENT_OF_BASIC":
      return line.percent === null ? "% of Basic" : `${line.percent}% of Basic`;
    case "PERCENT_OF_GROSS":
      return line.percent === null ? "% of Gross" : `${line.percent}% of Gross`;
    case "FORMULA":
      return line.formula ?? "Custom formula";
    case "ATTENDANCE_BASED":
      return "Attendance-linked";
    case "TIMESHEET_BASED":
      return line.formula ?? "Timesheet-linked";
    default:
      return "Entered per run";
  }
}

describe("payroll policy preview — one declared component shape", () => {
  it("emits exactly the declared top-level keys", async () => {
    const result = await build(makeDb()).preview(ORG, {
      templateKey: "INDIAN_STANDARD",
      startMonth: "2026-09",
    });

    expect(sortedKeys(result)).toEqual([...POLICY_PREVIEW_WIRE_KEYS]);
  });

  it("emits exactly the declared component keys, with the optionals present as null", async () => {
    const result = await build(makeDb()).preview(ORG, {
      templateKey: "INDIAN_STANDARD",
      startMonth: "2026-09",
    });

    expect(result.components.length).toBeGreaterThan(0);
    for (const component of result.components)
      expect(sortedKeys(component)).toEqual([...POLICY_PREVIEW_COMPONENT_WIRE_KEYS]);

    const hra = result.components.find((c) => c.code === "HRA");
    expect(hra?.percent).toBe("50");
    expect(hra?.amount).toBeNull();
    expect(hra?.formula).toBeNull();
    expect(hra?.statutoryKey).toBeNull();
  });

  it("carries NO monthlyAmount — the field the review step rendered", async () => {
    const result = await build(makeDb()).preview(ORG, {
      templateKey: "INDIAN_STANDARD",
      startMonth: "2026-09",
    });

    expect(POLICY_PREVIEW_COMPONENT_WIRE_KEYS).not.toContain("monthlyAmount");
    for (const component of result.components)
      expect(component).not.toHaveProperty("monthlyAmount");
  });

  it("carries the calculation basis instead, on every component", async () => {
    const result = await build(makeDb()).preview(ORG, {
      templateKey: "INDIAN_STANDARD",
      startMonth: "2026-09",
    });

    const basic = result.components.find((c) => c.code === "BASIC");
    expect(basic?.calcMethod).toBe("FORMULA");
    expect(basic?.formula).toBe("ctc * 0.40");

    for (const component of result.components) {
      const basis = component.amount ?? component.percent ?? component.formula;
      const derived =
        component.calcMethod === "ATTENDANCE_BASED" ||
        component.calcMethod === "MANUAL" ||
        component.calcMethod === "TIMESHEET_BASED";
      expect(basis !== null || derived).toBe(true);
    }
  });

  it("totalises a stored template whose jsonb is missing every optional field", async () => {
    const templates = makeTemplatesService([
      { code: "BONUS", name: "Bonus", type: "EARNING", calcMethod: "MANUAL" },
    ]);
    const result = await build(makeDb(), templates).preview(ORG, {
      templateId: 9,
      startMonth: "2026-09",
    });

    expect(result.components).toHaveLength(1);
    const component = result.components[0];
    expect(sortedKeys(component)).toEqual([...POLICY_PREVIEW_COMPONENT_WIRE_KEYS]);
    expect(component.taxable).toBe(false);
    expect(component.showOnPayslip).toBe(false);
    expect(component.sortOrder).toBe(0);
  });
});

describe("payroll policy preview — the review step's renderer against the real payload", () => {
  it("BITE: the pre-fix renderer prints an em dash for every salary component", async () => {
    const result = await build(makeDb()).preview(ORG, {
      templateKey: "INDIAN_STANDARD",
      startMonth: "2026-09",
    });

    const rendered = result.components.map((line) =>
      formatMoney((line as unknown as { monthlyAmount?: string }).monthlyAmount),
    );

    expect(rendered.length).toBeGreaterThan(5);
    expect(new Set(rendered)).toEqual(new Set(["—"]));
  });

  it("BITE: computing it here anyway would have printed a fabricated salary, not a real one", () => {
    const zeroBasis = computeTemplatePreview(INDIAN_STANDARD_SEED.defaultComponents, 0);
    const earnings = zeroBasis.components.filter((l) => l.type === "EARNING");

    expect(earnings.length).toBeGreaterThan(0);
    expect(new Set(earnings.map((l) => l.monthlyAmount))).toEqual(new Set(["0.00"]));
    expect(zeroBasis.totals.grossEarnings).toBe("0.00");
    expect(zeroBasis.totals.netTakeHome).toBe("-200.00");
  });

  it("the shipped renderer prints the real basis for every component", async () => {
    const result = await build(makeDb()).preview(ORG, {
      templateKey: "INDIAN_STANDARD",
      startMonth: "2026-09",
    });

    const byCode = new Map(result.components.map((c) => [c.code, describeBasis(c)]));

    expect(byCode.get("BASIC")).toBe("ctc * 0.40");
    expect(byCode.get("HRA")).toBe("50% of Basic");
    for (const rendered of byCode.values()) expect(rendered).not.toBe("—");
  });
});
