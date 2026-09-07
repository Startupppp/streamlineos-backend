import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollPolicies,
  payrollPolicyVersions,
  employeeSalaryProfiles,
} from "../../../db/schema";
import { PayrollTemplatesService } from "./templates.service";
import { PAYROLL_TEMPLATE_SEEDS } from "./payroll-template-seeds";
import type { PolicyPreviewInput, ToggleImpactInput } from "./dto/setup.schemas";
import type {
  PayrollToggles,
  PayrollPolicyConfig,
  TemplateComponentDef,
} from "../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES, normalizePayrollToggles, toPayrollPolicyConfig, toTemplateComponentDefs } from "../payroll.types";
import { getStatutoryPack } from "../runs/lib/statutory-packs";
import { DEFAULT_PAYROLL_CALENDAR as DEFAULT_CALENDAR } from "./payroll-policy-defaults.constants";
import { format } from "date-fns";
import {
  buildApprovalChain,
  calendarEventsForMonth,
  buildPackConfig,
  TOGGLE_STATUTORY_CODES,
  assertBelongsToOrg,
} from "./lib/policy-builders";

/**
 * Every key the policy preview puts on the wire, and nothing else.
 *
 * This endpoint has NO salary basis: `policyPreviewSchema` is `.strict()` and carries no
 * `annualCtc`, and the setup wizard's draft never collects one. So it cannot answer a
 * `monthlyAmount` the way `computeTemplatePreview` does for the template preview sheet, which
 * takes a CTC from the user. It answers what a component IS, not what it pays — and it now says
 * so in a shape that is declared here rather than whatever the seed literal or the template
 * jsonb happens to hold.
 */
export const POLICY_PREVIEW_WIRE_KEYS = [
  "approvalChain",
  "calendarPlan",
  "components",
  "essOptions",
  "statutoryPack",
  "toggles",
] as const;

/** Every key a previewed salary component carries. Always present, `null` when unset. */
export const POLICY_PREVIEW_COMPONENT_WIRE_KEYS = [
  "amount",
  "calcMethod",
  "code",
  "formula",
  "includeInCtc",
  "isStatutory",
  "name",
  "percent",
  "showOnPayslip",
  "sortOrder",
  "statutoryKey",
  "taxable",
  "type",
] as const;

export interface PolicyPreviewComponent {
  code: string;
  name: string;
  type: TemplateComponentDef["type"];
  calcMethod: TemplateComponentDef["calcMethod"];
  amount: string | null;
  percent: string | null;
  formula: string | null;
  taxable: boolean;
  showOnPayslip: boolean;
  includeInCtc: boolean;
  isStatutory: boolean;
  statutoryKey: string | null;
  sortOrder: number;
}

/**
 * A total projection. Both sources reach here through an unchecked `as TemplateComponentDef[]`
 * — the seed literals are typed, the stored `defaultComponents` jsonb is not — so an absent
 * optional becomes an explicit `null` and an absent flag becomes `false` rather than a key that
 * `JSON.stringify` drops on the floor.
 */
function toPreviewComponent(component: TemplateComponentDef): PolicyPreviewComponent {
  return {
    code: component.code,
    name: component.name,
    type: component.type,
    calcMethod: component.calcMethod,
    amount: component.amount ?? null,
    percent: component.percent ?? null,
    formula: component.formula ?? null,
    taxable: component.taxable === true,
    showOnPayslip: component.showOnPayslip === true,
    includeInCtc: component.includeInCtc === true,
    isStatutory: component.isStatutory === true,
    statutoryKey: component.statutoryKey ?? null,
    sortOrder: Number.isFinite(component.sortOrder) ? component.sortOrder : 0,
  };
}

@Injectable()
export class PolicyQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly templatesService: PayrollTemplatesService,
  ) {}

  async getCurrent(orgId: string) {
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, orgId),
    });
    if (!policy) return { policy: null };

    const pack = getStatutoryPack(policy.country ?? "IN");
    const taxRegimeApplicable = pack.taxRegimeApplicable;

    if (!policy.activeVersionId) {
      return { policy, activeVersion: null, taxRegimeApplicable };
    }

    const activeVersion = await this.db.query.payrollPolicyVersions.findFirst({
      where: and(
        eq(payrollPolicyVersions.id, policy.activeVersionId),
        eq(payrollPolicyVersions.orgId, orgId),
      ),
    });

    const config = toPayrollPolicyConfig(activeVersion?.config);

    let packData: {
      country: string;
      items: {
        key: string;
        enabled: boolean;
        percentOverride?: string;
        label: string;
        kind: string | null;
      }[];
      complianceChecklist: { key: string; label: string; detail: string }[];
    } | null = null;

    if (config?.statutoryPack) {
      const packCountry = config.statutoryPack.country;
      const packDef = getStatutoryPack(packCountry);
      packData = {
        country: packCountry,
        items: config.statutoryPack.items.map((item) => {
          const def = packDef.items.find((d) => d.key === item.key);
          return {
            ...item,
            label: def?.label ?? item.key,
            kind: def?.kind ?? null,
          };
        }),
        complianceChecklist: packDef.complianceChecklist,
      };
    }

    return {
      policy,
      activeVersion: activeVersion ?? null,
      taxRegimeApplicable,
      statutoryPack: packData,
    };
  }

  async preview(orgId: string, input: PolicyPreviewInput) {
    let components: TemplateComponentDef[] = [];
    let baseToggles: PayrollToggles = { ...DEFAULT_PAYROLL_TOGGLES };

    if (input.templateKey) {
      const seed = PAYROLL_TEMPLATE_SEEDS.find((s) => s.key === input.templateKey);
      if (seed) {
        components = seed.defaultComponents;
        baseToggles = seed.defaultToggles;
      }
    } else if (input.templateId) {
      const tpl = await this.templatesService.getById(orgId, input.templateId);
      components = toTemplateComponentDefs(tpl.defaultComponents);
      baseToggles = normalizePayrollToggles(tpl.defaultToggles);
    }

    const toggles: PayrollToggles = { ...baseToggles, ...(input.toggleOverrides ?? {}) };
    const approvalChain = buildApprovalChain(toggles);

    const startMonth = input.startMonth ?? format(new Date(), "yyyy-MM");
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, orgId),
      columns: { payDay: true },
    });
    const payDay = input.payDay ?? policy?.payDay ?? 28;
    const calendarPlan = calendarEventsForMonth(-1, orgId, startMonth, DEFAULT_CALENDAR, payDay);

    const essOptions = {
      showSalaryStructure: toggles.essShowSalaryStructure,
      allowBankUpdate: toggles.essAllowBankUpdate,
      allowLoanRequests: toggles.essAllowLoanRequests,
      allowTaxDeclarations: toggles.essAllowTaxDeclarations,
      allowReimbursements: toggles.essAllowReimbursements,
    };

    const previewCountry = input.country ?? "IN";
    const pack = getStatutoryPack(previewCountry);
    const packConfig = buildPackConfig(previewCountry);
    const statutoryPack = {
      country: pack.country,
      countryName: pack.countryName,
      currency: pack.currency,
      taxRegimeApplicable: pack.taxRegimeApplicable,
      items: pack.items.map((item) => {
        const cfg = packConfig.items.find((c) => c.key === item.key);
        return {
          key: item.key,
          label: item.label,
          kind: item.kind,
          componentCode: item.componentCode,
          enabled: cfg?.enabled ?? item.enabledByDefault,
          calc: item.calc,
          note: item.note,
        };
      }),
      complianceChecklist: pack.complianceChecklist,
    };

    return {
      toggles,
      components: components.map(toPreviewComponent),
      approvalChain,
      calendarPlan,
      essOptions,
      statutoryPack,
    };
  }

  async listVersions(orgId: string, policyId: number) {
    await assertBelongsToOrg(this.db, orgId, policyId);
    return this.db.query.payrollPolicyVersions.findMany({
      where: and(
        eq(payrollPolicyVersions.policyId, policyId),
        eq(payrollPolicyVersions.orgId, orgId),
      ),
      orderBy: (t, { desc }) => [desc(t.version)],
      limit: 100,
    });
  }

  async toggleImpact(orgId: string, input: ToggleImpactInput) {
    const [row] = await this.db
      .select({ affectedCount: count() })
      .from(employeeSalaryProfiles)
      .where(
        and(
          eq(employeeSalaryProfiles.orgId, orgId),
          eq(employeeSalaryProfiles.status, "ACTIVE"),
        ),
      );

    const affectedCount = row?.affectedCount ?? 0;
    const affectedCodes = TOGGLE_STATUTORY_CODES[input.toggle] ?? [];

    return {
      toggle: input.toggle,
      affectedEmployeeCount: affectedCount,
      affectedStatutoryCodes: affectedCodes,
    };
  }
}
