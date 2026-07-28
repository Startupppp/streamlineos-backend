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
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
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

    const rawPolicyConfig = activeVersion?.config;
    const config: PayrollPolicyConfig | null =
      rawPolicyConfig && typeof rawPolicyConfig === "object"
        ? (rawPolicyConfig as PayrollPolicyConfig)
        : null;

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
      const rawComponents = tpl.defaultComponents;
      components = Array.isArray(rawComponents)
        ? (rawComponents as TemplateComponentDef[])
        : [];
      const rawToggles = tpl.defaultToggles;
      baseToggles =
        rawToggles && typeof rawToggles === "object"
          ? { ...DEFAULT_PAYROLL_TOGGLES, ...(rawToggles as Partial<PayrollToggles>) }
          : { ...DEFAULT_PAYROLL_TOGGLES };
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

    return { toggles, components, approvalChain, calendarPlan, essOptions, statutoryPack };
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
