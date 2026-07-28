import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollPolicies,
  payrollPolicyVersions,
  payrollTemplateActivations,
  salaryComponents,
  payrollCalendarEvents,
} from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollTemplatesService } from "./templates.service";
import { PAYROLL_TEMPLATE_SEEDS } from "./payroll-template-seeds";
import type {
  CreatePolicyInput,
  UpdatePolicyInput,
  ActivatePolicyInput,
  CreatePolicyVersionInput,
} from "./dto/setup.schemas";
import type {
  PayrollToggles,
  PayrollPolicyConfig,
  TemplateComponentDef,
  PayrollToggleKey,
} from "../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
import {
  buildDefaultConfig,
  calendarEventsForMonth,
  RISKY_TOGGLES,
  assertBelongsToOrg,
} from "./lib/policy-builders";
import { buildActivationChecklist } from "./lib/policy-checklist";

@Injectable()
export class PolicyMutationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly templatesService: PayrollTemplatesService,
    private readonly audit: AuditService,
  ) {}

  async create(u: CurrentUserContext, input: CreatePolicyInput) {
    const existing = await this.db.query.payrollPolicies.findFirst({
      where: eq(payrollPolicies.orgId, u.orgId),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        "This organisation already has a payroll policy. Use PATCH to update it.",
      );
    }

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

  async update(u: CurrentUserContext, policyId: number, input: UpdatePolicyInput) {
    const policy = await assertBelongsToOrg(this.db, u.orgId, policyId);
    if (policy.status !== "DRAFT" && !u.isOrgOwner && !u.isPlatformAdmin) {
      throw new BadRequestException(
        "Only the org owner can update an active policy profile",
      );
    }

    const values: Partial<typeof payrollPolicies.$inferInsert> = {};
    if (input.country !== undefined) values.country = input.country;
    if (input.state !== undefined) values.state = input.state ?? null;
    if (input.legalEntityName !== undefined) values.legalEntityName = input.legalEntityName ?? null;
    if (input.currency !== undefined) values.currency = input.currency;
    if (input.payFrequency !== undefined) values.payFrequency = input.payFrequency;
    if (input.payDay !== undefined) values.payDay = input.payDay;
    if (input.startMonth !== undefined) values.startMonth = input.startMonth;

    if (input.fxRates !== undefined && policy.activeVersionId) {
      const activeVersionId = policy.activeVersionId;
      const fxRatesInput = input.fxRates;
      await this.db.transaction(async (tx) => {
        const activeVersion = await tx.query.payrollPolicyVersions.findFirst({
          where: eq(payrollPolicyVersions.id, activeVersionId),
          columns: { config: true },
        });
        const rawCurrentConfig = activeVersion?.config;
        const currentConfig: PayrollPolicyConfig =
          rawCurrentConfig && typeof rawCurrentConfig === "object"
            ? (rawCurrentConfig as PayrollPolicyConfig)
            : ({} as PayrollPolicyConfig);
        const fxRates = Object.fromEntries(
          Object.entries(fxRatesInput).map(([code, rate]) => [code, String(rate)]),
        );
        const nextConfig = { ...currentConfig, fxRates };
        await tx
          .update(payrollPolicyVersions)
          .set({ config: nextConfig })
          .where(eq(payrollPolicyVersions.id, activeVersionId));
      });
    }

    if (Object.keys(values).length === 0) return policy;

    const [updated] = await this.db
      .update(payrollPolicies)
      .set(values)
      .where(and(eq(payrollPolicies.id, policyId), eq(payrollPolicies.orgId, u.orgId)))
      .returning();
    return updated;
  }

  async activate(u: CurrentUserContext, policyId: number, input: ActivatePolicyInput) {
    const policy = await assertBelongsToOrg(this.db, u.orgId, policyId);

    let components: TemplateComponentDef[] = [];
    let baseToggles: PayrollToggles = { ...DEFAULT_PAYROLL_TOGGLES };
    let templateKey: string | null = null;
    let templateSnapshot: object = {};

    if (input.templateKey) {
      const seed = PAYROLL_TEMPLATE_SEEDS.find((s) => s.key === input.templateKey);
      if (seed) {
        components = seed.defaultComponents;
        baseToggles = seed.defaultToggles;
        templateKey = seed.key;
        templateSnapshot = seed;
      }
    } else if (input.templateId) {
      const tpl = await this.templatesService.getById(u.orgId, input.templateId);
      const rawActivateComponents = tpl.defaultComponents;
      components = Array.isArray(rawActivateComponents)
        ? (rawActivateComponents as TemplateComponentDef[])
        : [];
      const rawActivateToggles = tpl.defaultToggles;
      baseToggles =
        rawActivateToggles && typeof rawActivateToggles === "object"
          ? { ...DEFAULT_PAYROLL_TOGGLES, ...(rawActivateToggles as Partial<PayrollToggles>) }
          : { ...DEFAULT_PAYROLL_TOGGLES };
      templateKey = tpl.key ?? `custom-${tpl.id}`;
      templateSnapshot = tpl;
    }

    const toggles: PayrollToggles = { ...baseToggles, ...(input.toggleOverrides ?? {}) };
    const config = buildDefaultConfig(input, components, toggles, policy.country ?? "IN");

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
          toggles,
          config,
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
      metadata: { policyId, versionId: result.policyVersion?.id, templateKey },
    });

    const checklist = buildActivationChecklist(toggles);
    return { ...result, checklist };
  }

  async createVersion(u: CurrentUserContext, policyId: number, input: CreatePolicyVersionInput) {
    const policy = await assertBelongsToOrg(this.db, u.orgId, policyId);
    if (policy.status !== "ACTIVE") {
      throw new BadRequestException("Policy must be ACTIVE before creating a new version");
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
    if (rawActiveConfig && typeof rawActiveConfig === "object") {
      baseConfig = rawActiveConfig as PayrollPolicyConfig;
    } else {
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
    }

    const newConfig: PayrollPolicyConfig = { ...baseConfig, ...(input.config ?? {}) };

    const hasRiskyChange = input.toggleOverrides
      ? Object.keys(input.toggleOverrides).some((k) => RISKY_TOGGLES.has(k as PayrollToggleKey))
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
}
