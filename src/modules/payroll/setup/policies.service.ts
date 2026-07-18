import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../../../common/audit/audit.service";
import { and, count, eq, sql } from "drizzle-orm";
import {
  payrollPolicies,
  payrollPolicyVersions,
  payrollTemplateActivations,
  salaryComponents,
  payrollCalendarEvents,
  employeeSalaryProfiles,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollTemplatesService } from "./templates.service";
import { PAYROLL_TEMPLATE_SEEDS } from "./payroll-template-seeds";
import type {
  CreatePolicyInput,
  UpdatePolicyInput,
  PolicyPreviewInput,
  ActivatePolicyInput,
  CreatePolicyVersionInput,
  ToggleImpactInput,
} from "./dto/setup.schemas";
import type {
  PayrollToggles,
  PayrollPolicyConfig,
  TemplateComponentDef,
  PayrollApprovalStageDef,
  PayrollToggleKey,
  StatutoryPackConfig,
} from "../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
import { getStatutoryPack } from "../runs/lib/statutory-packs";
import { addDays, format } from "date-fns";

const RISKY_TOGGLES = new Set<PayrollToggleKey>([
  "pf",
  "esi",
  "professionalTax",
  "tds",
  "gratuity",
  "lwf",
  "approvalWorkflow",
  "lockAfterApproval",
]);

const TOGGLE_STATUTORY_CODES: Partial<Record<PayrollToggleKey, string[]>> = {
  pf: ["PF_EMP", "PF_ER"],
  esi: ["ESI_EMP", "ESI_ER"],
  professionalTax: ["PT"],
  tds: ["TDS"],
  gratuity: ["GRATUITY_ER"],
  lwf: ["LWF"],
};

function buildApprovalChain(
  toggles: PayrollToggles,
): PayrollApprovalStageDef[] {
  if (!toggles.approvalWorkflow) return [];
  const chain: PayrollApprovalStageDef[] = [];
  let stage = 1;
  if (toggles.managerApproval) {
    chain.push({
      stage,
      stageName: "Manager Review",
      requiredPermission: "payroll:runs:approve",
    });
    stage += 1;
  }
  chain.push({
    stage,
    stageName: "Payroll Admin Approval",
    requiredPermission: "payroll:runs:approve",
  });
  stage += 1;
  if (toggles.financeApproval) {
    chain.push({
      stage,
      stageName: "Finance Approval",
      requiredPermission: "payroll:runs:approve",
    });
  }
  return chain;
}

function calendarEventsForMonth(
  policyId: number,
  orgId: string,
  startMonth: string,
  calendar: PayrollPolicyConfig["calendar"],
  payDay: number,
): Array<typeof payrollCalendarEvents.$inferInsert> {
  const [year, month] = startMonth.split("-").map(Number);
  const base = new Date(year!, month! - 1, 1);
  const nextMonthBase = new Date(year!, month!, 1);

  function dayOfMonth(day: number, ref: Date): Date {
    const d = new Date(ref);
    d.setDate(day);
    return d;
  }

  const events: Array<typeof payrollCalendarEvents.$inferInsert> = [
    {
      orgId,
      policyId,
      month: startMonth,
      type: "ATTENDANCE_CUTOFF",
      date: format(
        dayOfMonth(calendar.attendanceCutoffDay, base),
        "yyyy-MM-dd",
      ),
      title: "Attendance Cutoff",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "REIMBURSEMENT_CUTOFF",
      date: format(
        dayOfMonth(calendar.reimbursementCutoffDay, base),
        "yyyy-MM-dd",
      ),
      title: "Reimbursement Cutoff",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "DECLARATION_CUTOFF",
      date: format(
        dayOfMonth(calendar.declarationCutoffDay, base),
        "yyyy-MM-dd",
      ),
      title: "Tax Declaration Cutoff",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "PREVIEW_DUE",
      date: format(dayOfMonth(calendar.previewDay, base), "yyyy-MM-dd"),
      title: "Payroll Preview Due",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "APPROVAL_DEADLINE",
      date: format(
        dayOfMonth(calendar.approvalDeadlineDay, base),
        "yyyy-MM-dd",
      ),
      title: "Approval Deadline",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "PAY_DATE",
      date: format(dayOfMonth(payDay, nextMonthBase), "yyyy-MM-dd"),
      title: "Pay Date",
    },
    {
      orgId,
      policyId,
      month: startMonth,
      type: "PUBLISH_DATE",
      date: format(
        addDays(dayOfMonth(payDay, nextMonthBase), calendar.publishOffsetDays),
        "yyyy-MM-dd",
      ),
      title: "Payslip Publish Date",
    },
  ];

  return events;
}

const DEFAULT_CALENDAR = {
  attendanceCutoffDay: 20,
  reimbursementCutoffDay: 20,
  declarationCutoffDay: 15,
  previewDay: 22,
  approvalDeadlineDay: 25,
  publishOffsetDays: 1,
} as const;

const DEFAULT_STATUTORY = {
  pfEmployeePercent: "12",
  pfEmployerPercent: "12",
  pfWageCeiling: "15000.00" as string | null,
  esiEmployeePercent: "0.75",
  esiEmployerPercent: "3.25",
  esiWageCeiling: "21000.00" as string | null,
  professionalTaxMonthly: "200.00",
  tdsMode: "DECLARATION" as const,
  tdsFlatPercent: null as string | null,
};

function buildPackConfig(country: string): StatutoryPackConfig {
  const pack = getStatutoryPack(country);
  return {
    country,
    items: pack.items.map((item) => ({
      key: item.key,
      enabled: item.enabledByDefault,
    })),
  };
}

function buildDefaultConfig(
  input: ActivatePolicyInput,
  components: TemplateComponentDef[],
  toggles: PayrollToggles,
  country: string,
): PayrollPolicyConfig {
  const approvalChain = buildApprovalChain(toggles);
  const calendar = input.calendar ?? DEFAULT_CALENDAR;
  const statutory = input.statutory ?? DEFAULT_STATUTORY;
  const cfg: PayrollPolicyConfig = {
    components,
    rounding: { mode: "NEAREST", precision: 2 },
    approvalChain,
    payslipLayout: input.payslipLayout,
    calendar: {
      attendanceCutoffDay:
        calendar.attendanceCutoffDay ?? DEFAULT_CALENDAR.attendanceCutoffDay,
      reimbursementCutoffDay:
        calendar.reimbursementCutoffDay ??
        DEFAULT_CALENDAR.reimbursementCutoffDay,
      declarationCutoffDay:
        calendar.declarationCutoffDay ?? DEFAULT_CALENDAR.declarationCutoffDay,
      previewDay: calendar.previewDay ?? DEFAULT_CALENDAR.previewDay,
      approvalDeadlineDay:
        calendar.approvalDeadlineDay ?? DEFAULT_CALENDAR.approvalDeadlineDay,
      publishOffsetDays:
        calendar.publishOffsetDays ?? DEFAULT_CALENDAR.publishOffsetDays,
    },
    statutory: {
      pfEmployeePercent:
        statutory.pfEmployeePercent ?? DEFAULT_STATUTORY.pfEmployeePercent,
      pfEmployerPercent:
        statutory.pfEmployerPercent ?? DEFAULT_STATUTORY.pfEmployerPercent,
      pfWageCeiling: statutory.pfWageCeiling ?? DEFAULT_STATUTORY.pfWageCeiling,
      esiEmployeePercent:
        statutory.esiEmployeePercent ?? DEFAULT_STATUTORY.esiEmployeePercent,
      esiEmployerPercent:
        statutory.esiEmployerPercent ?? DEFAULT_STATUTORY.esiEmployerPercent,
      esiWageCeiling:
        statutory.esiWageCeiling ?? DEFAULT_STATUTORY.esiWageCeiling,
      professionalTaxMonthly:
        statutory.professionalTaxMonthly ??
        DEFAULT_STATUTORY.professionalTaxMonthly,
      tdsMode: statutory.tdsMode ?? DEFAULT_STATUTORY.tdsMode,
      tdsFlatPercent: statutory.tdsFlatPercent ?? null,
    },
    overtime: { multiplier: "1.50", basis: "BASIC" },
    varianceThresholdPercent: 20,
  };
  if (country !== "IN") {
    cfg.statutoryPack = buildPackConfig(country);
  }
  return cfg;
}

@Injectable()
export class PayrollPoliciesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly templatesService: PayrollTemplatesService,
    private readonly audit: AuditService,
  ) {}

  async getCurrent(orgId: string) {
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, orgId),
    });
    if (!policy) return { policy: null };

    const pack = getStatutoryPack(policy.country ?? "IN");
    const taxRegimeApplicable = pack.taxRegimeApplicable;

    if (!policy.activeVersionId)
      return { policy, activeVersion: null, taxRegimeApplicable };

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

  async create(u: CurrentUserContext, input: CreatePolicyInput) {
    const existing = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, u.orgId),
      columns: { id: true },
    });
    if (existing)
      throw new ConflictException(
        "This organisation already has a payroll policy. Use PATCH to update it.",
      );

    const [policy] = await this.db
      .insert(payrollPolicies)
      .values({
        orgId: u.orgId,
        status: "DRAFT",
        country: input.country,
        state: input.state ?? null,
        legalEntityName: input.legalEntityName ?? null,
        currency: input.currency,
        payFrequency: input.payFrequency,
        payDay: input.payDay,
        employeeCount: input.employeeCount ?? null,
        startMonth: input.startMonth,
        createdBy: u.userId,
      })
      .returning();
    return policy;
  }

  async update(
    u: CurrentUserContext,
    policyId: number,
    input: UpdatePolicyInput,
  ) {
    const policy = await this.assertBelongsToOrg(u.orgId, policyId);
    if (policy.status !== "DRAFT" && !u.isOrgOwner && !u.isPlatformAdmin) {
      throw new BadRequestException(
        "Only the org owner can update an active policy profile",
      );
    }

    const values: Partial<typeof payrollPolicies.$inferInsert> = {};
    if (input.country !== undefined) values.country = input.country;
    if (input.state !== undefined) values.state = input.state ?? null;
    if (input.legalEntityName !== undefined)
      values.legalEntityName = input.legalEntityName ?? null;
    if (input.currency !== undefined) values.currency = input.currency;
    if (input.payFrequency !== undefined)
      values.payFrequency = input.payFrequency;
    if (input.payDay !== undefined) values.payDay = input.payDay;
    if (input.startMonth !== undefined) values.startMonth = input.startMonth;

    if (input.fxRates !== undefined && policy.activeVersionId) {
      const activeVersion = await this.db.query.payrollPolicyVersions.findFirst(
        {
          where: eq(payrollPolicyVersions.id, policy.activeVersionId),
          columns: { config: true },
        },
      );
      const rawCurrentConfig = activeVersion?.config;
      const currentConfig: PayrollPolicyConfig =
        rawCurrentConfig && typeof rawCurrentConfig === "object"
          ? (rawCurrentConfig as PayrollPolicyConfig)
          : ({} as PayrollPolicyConfig);
      const fxRates = Object.fromEntries(
        Object.entries(input.fxRates).map(([code, rate]) => [
          code,
          String(rate),
        ]),
      );
      const nextConfig = { ...currentConfig, fxRates };
      await this.db
        .update(payrollPolicyVersions)
        .set({ config: nextConfig })
        .where(eq(payrollPolicyVersions.id, policy.activeVersionId));
    }

    if (Object.keys(values).length === 0) return policy;

    const [updated] = await this.db
      .update(payrollPolicies)
      .set(values)
      .where(
        and(
          eq(payrollPolicies.id, policyId),
          eq(payrollPolicies.orgId, u.orgId),
        ),
      )
      .returning();
    return updated;
  }

  async preview(orgId: string, input: PolicyPreviewInput) {
    let components: TemplateComponentDef[] = [];
    let baseToggles: PayrollToggles = { ...DEFAULT_PAYROLL_TOGGLES };

    if (input.templateKey) {
      const seed = PAYROLL_TEMPLATE_SEEDS.find(
        (s) => s.key === input.templateKey,
      );
      if (seed) {
        components = seed.defaultComponents;
        baseToggles = seed.defaultToggles;
      }
    } else if (input.templateId) {
      const tpl = await this.templatesService.getById(orgId, input.templateId);
      const rawPreviewComponents = tpl.defaultComponents;
      components = Array.isArray(rawPreviewComponents)
        ? (rawPreviewComponents as TemplateComponentDef[])
        : [];
      const rawPreviewToggles = tpl.defaultToggles;
      baseToggles =
        rawPreviewToggles && typeof rawPreviewToggles === "object"
          ? {
              ...DEFAULT_PAYROLL_TOGGLES,
              ...(rawPreviewToggles as Partial<PayrollToggles>),
            }
          : { ...DEFAULT_PAYROLL_TOGGLES };
    }

    const toggles: PayrollToggles = {
      ...baseToggles,
      ...(input.toggleOverrides ?? {}),
    };
    const approvalChain = buildApprovalChain(toggles);

    const calendarDefaults = DEFAULT_CALENDAR;

    const startMonth = input.startMonth ?? format(new Date(), "yyyy-MM");
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, orgId),
      columns: { payDay: true },
    });
    const payDay = input.payDay ?? policy?.payDay ?? 28;
    const calendarPlan = calendarEventsForMonth(
      -1,
      orgId,
      startMonth,
      calendarDefaults,
      payDay,
    );

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
      components,
      approvalChain,
      calendarPlan,
      essOptions,
      statutoryPack,
    };
  }

  async activate(
    u: CurrentUserContext,
    policyId: number,
    input: ActivatePolicyInput,
  ) {
    const policy = await this.assertBelongsToOrg(u.orgId, policyId);

    let components: TemplateComponentDef[] = [];
    let baseToggles: PayrollToggles = { ...DEFAULT_PAYROLL_TOGGLES };
    let templateKey: string | null = null;
    let templateSnapshot: object = {};

    if (input.templateKey) {
      const seed = PAYROLL_TEMPLATE_SEEDS.find(
        (s) => s.key === input.templateKey,
      );
      if (seed) {
        components = seed.defaultComponents;
        baseToggles = seed.defaultToggles;
        templateKey = seed.key;
        templateSnapshot = seed;
      }
    } else if (input.templateId) {
      const tpl = await this.templatesService.getById(
        u.orgId,
        input.templateId,
      );
      const rawActivateComponents = tpl.defaultComponents;
      components = Array.isArray(rawActivateComponents)
        ? (rawActivateComponents as TemplateComponentDef[])
        : [];
      const rawActivateToggles = tpl.defaultToggles;
      baseToggles =
        rawActivateToggles && typeof rawActivateToggles === "object"
          ? {
              ...DEFAULT_PAYROLL_TOGGLES,
              ...(rawActivateToggles as Partial<PayrollToggles>),
            }
          : { ...DEFAULT_PAYROLL_TOGGLES };
      templateKey = tpl.key ?? `custom-${tpl.id}`;
      templateSnapshot = tpl;
    }

    const toggles: PayrollToggles = {
      ...baseToggles,
      ...(input.toggleOverrides ?? {}),
    };
    const config = buildDefaultConfig(
      input,
      components,
      toggles,
      policy.country ?? "IN",
    );

    const result = await this.db.transaction(async (tx) => {
      const versionsResult = await tx
        .select({
          maxVersion: sql<number>`COALESCE(MAX(${payrollPolicyVersions.version}), 0)`,
        })
        .from(payrollPolicyVersions)
        .where(eq(payrollPolicyVersions.policyId, policyId));

      const nextVersion = (versionsResult[0]?.maxVersion ?? 0) + 1;
      const effectiveFrom = policy.startMonth + "-01";

      const [newVersion] = await tx
        .insert(payrollPolicyVersions)
        .values({
          orgId: u.orgId,
          policyId,
          version: nextVersion,
          templateKey: templateKey ?? undefined,
          toggles: toggles,
          config: config,
          status: "ACTIVE",
          effectiveFrom,
          reason: input.reason ?? "Initial activation",
          createdBy: u.userId,
        })
        .returning();

      if (templateKey) {
        await tx.insert(payrollTemplateActivations).values({
          orgId: u.orgId,
          policyVersionId: newVersion!.id,
          templateKey,
          snapshot: templateSnapshot,
          activatedBy: u.userId,
        });
      }

      for (const comp of components) {
        await tx
          .insert(salaryComponents)
          .values({
            orgId: u.orgId,
            code: comp.code,
            name: comp.name,
            type: comp.type,
            calcMethod: comp.calcMethod,
            amount: comp.amount ?? null,
            percent: comp.percent ?? null,
            formula: comp.formula ?? null,
            taxable: comp.taxable,
            showOnPayslip: comp.showOnPayslip,
            includeInCtc: comp.includeInCtc,
            isStatutory: comp.isStatutory,
            statutoryKey: comp.statutoryKey ?? null,
            sortOrder: comp.sortOrder,
            isActive: true,
          })
          .onConflictDoNothing({
            target: [salaryComponents.orgId, salaryComponents.code],
          });
      }

      const calendarInserts = calendarEventsForMonth(
        policyId,
        u.orgId,
        policy.startMonth,
        config.calendar,
        policy.payDay,
      );
      await tx.insert(payrollCalendarEvents).values(calendarInserts);

      await tx
        .update(payrollPolicies)
        .set({ status: "ACTIVE", activeVersionId: newVersion!.id })
        .where(eq(payrollPolicies.id, policyId));

      return { policyVersion: newVersion, componentCount: components.length };
    });

    this.audit.log({
      action: "payroll.template_activated",
      userId: u.userId,
      orgId: u.orgId,
      metadata: {
        policyId,
        versionId: result.policyVersion?.id,
        templateKey,
      },
    });

    const checklist: Array<{
      key: string;
      label: string;
      done: boolean;
      href: string;
      detail: string | null;
    }> = [
      {
        key: "employees_verified",
        label: "Verify employee profiles",
        done: false,
        href: "/payroll/employees",
        detail: null,
      },
      {
        key: "invite_employees_configured",
        label: "Invite employees & configure self-service",
        done: false,
        href: "/settings/roles",
        detail: "Configure employee self-service options and invite your team",
      },
      {
        key: "attendance_imported",
        label: "Import attendance data",
        done: false,
        href: "/payroll/attendance",
        detail: null,
      },
      {
        key: "reimbursements_approved",
        label: "Approve reimbursements",
        done: !toggles.reimbursements,
        href: "/payroll/reimbursements",
        detail: null,
      },
      {
        key: "variable_pay_approved",
        label: "Approve variable pay",
        done: !toggles.salesIncentives && !toggles.bonuses,
        href: "/payroll/variable",
        detail: null,
      },
      {
        key: "loans_applied",
        label: "Apply loan deductions",
        done: !toggles.loans,
        href: "/payroll/loans",
        detail: null,
      },
      {
        key: "tax_declarations_locked",
        label: "Lock tax declarations",
        done: !toggles.tds,
        href: "/payroll/tax",
        detail: null,
      },
      {
        key: "preview_generated",
        label: "Generate payroll preview",
        done: false,
        href: "/payroll/runs",
        detail: null,
      },
      {
        key: "exceptions_resolved",
        label: "Resolve exceptions",
        done: false,
        href: "/payroll/runs",
        detail: null,
      },
      {
        key: "payroll_approved",
        label: "Approve payroll run",
        done: !toggles.approvalWorkflow,
        href: "/payroll/runs",
        detail: null,
      },
      {
        key: "bank_file_generated",
        label: "Generate bank payout file",
        done: !toggles.bankPayoutFile,
        href: "/payroll/payout",
        detail: null,
      },
      {
        key: "payslips_published",
        label: "Publish payslips",
        done: !toggles.payslipPublishing,
        href: "/payroll/payslips",
        detail: null,
      },
    ];

    return { ...result, checklist };
  }

  async createVersion(
    u: CurrentUserContext,
    policyId: number,
    input: CreatePolicyVersionInput,
  ) {
    const policy = await this.assertBelongsToOrg(u.orgId, policyId);
    if (policy.status !== "ACTIVE") {
      throw new BadRequestException(
        "Policy must be ACTIVE before creating a new version",
      );
    }

    const activeVersion = policy.activeVersionId
      ? await this.db.query.payrollPolicyVersions.findFirst({
          where: and(
            eq(payrollPolicyVersions.id, policy.activeVersionId),
            eq(payrollPolicyVersions.orgId, u.orgId),
          ),
        })
      : null;

    const rawActiveToggles = activeVersion?.toggles;
    const rawActiveConfig = activeVersion?.config;
    const newToggles: PayrollToggles = {
      ...(rawActiveToggles && typeof rawActiveToggles === "object"
        ? (rawActiveToggles as PayrollToggles)
        : DEFAULT_PAYROLL_TOGGLES),
      ...(input.toggleOverrides ?? {}),
    };
    let baseConfig: PayrollPolicyConfig;
    if (rawActiveConfig && typeof rawActiveConfig === "object")
      baseConfig = rawActiveConfig as PayrollPolicyConfig;
    else
      baseConfig = {
        components: [],
        rounding: { mode: "NEAREST", precision: 2 },
        approvalChain: [],
        payslipLayout: "CLASSIC",
        calendar: {
          attendanceCutoffDay: 20,
          reimbursementCutoffDay: 20,
          declarationCutoffDay: 15,
          previewDay: 22,
          approvalDeadlineDay: 25,
          publishOffsetDays: 1,
        },
        statutory: {
          pfEmployeePercent: "12",
          pfEmployerPercent: "12",
          pfWageCeiling: null,
          esiEmployeePercent: "0.75",
          esiEmployerPercent: "3.25",
          esiWageCeiling: null,
          professionalTaxMonthly: "200.00",
          tdsMode: "DECLARATION",
          tdsFlatPercent: null,
        },
        overtime: { multiplier: "1.50", basis: "BASIC" },
        varianceThresholdPercent: 20,
      };

    const newConfig: PayrollPolicyConfig = {
      ...baseConfig,
      ...(input.config ?? {}),
    };

    const changedRiskyToggles = RISKY_TOGGLES;
    const hasRiskyChange = input.toggleOverrides
      ? Object.keys(input.toggleOverrides).some((k) =>
          changedRiskyToggles.has(k as PayrollToggleKey),
        )
      : false;

    if (hasRiskyChange && !input.reason) {
      throw new BadRequestException(
        "A reason is required when changing statutory or workflow toggles",
      );
    }

    const versionsResult = await this.db
      .select({
        maxVersion: sql<number>`COALESCE(MAX(${payrollPolicyVersions.version}), 0)`,
      })
      .from(payrollPolicyVersions)
      .where(eq(payrollPolicyVersions.policyId, policyId));

    const nextVersion = (versionsResult[0]?.maxVersion ?? 0) + 1;

    const [newVersion] = await this.db
      .insert(payrollPolicyVersions)
      .values({
        orgId: u.orgId,
        policyId,
        version: nextVersion,
        templateKey: activeVersion?.templateKey ?? undefined,
        toggles: newToggles,
        config: newConfig,
        status: "DRAFT",
        effectiveFrom: input.effectiveFrom,
        reason: input.reason,
        createdBy: u.userId,
      })
      .returning();

    return newVersion;
  }

  async listVersions(orgId: string, policyId: number) {
    await this.assertBelongsToOrg(orgId, policyId);
    return this.db.query.payrollPolicyVersions.findMany({
      where: and(
        eq(payrollPolicyVersions.policyId, policyId),
        eq(payrollPolicyVersions.orgId, orgId),
      ),
      orderBy: (t, { desc }) => [desc(t.version)],
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

  private async assertBelongsToOrg(orgId: string, policyId: number) {
    const policy = await this.db.query.payrollPolicies.findFirst({
      where: and(
        eq(payrollPolicies.id, policyId),
        eq(payrollPolicies.orgId, orgId),
      ),
    });
    if (!policy) throw new NotFoundException("Payroll policy not found");
    return policy;
  }
}
