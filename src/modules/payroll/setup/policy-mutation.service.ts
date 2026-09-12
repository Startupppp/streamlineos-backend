import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
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
} from "../payroll.types";
import { DEFAULT_PAYROLL_TOGGLES } from "../payroll.types";
import {
  normalizePayrollToggles,
  toPayrollPolicyConfig,
  toTemplateComponentDefs,
} from "../dto/payroll.schemas";
import { DEFAULT_PAYROLL_POLICY_CONFIG } from "./payroll-policy-defaults.constants";
import {
  buildDefaultConfig,
  calendarEventsForMonth,
  assertBelongsToOrg,
} from "./lib/policy-builders";
import { buildActivationChecklist } from "./lib/policy-checklist";
import { buildPolicyVersion } from "./policy-version-builder";

/**
 * `components` comes from a tenant-owned template's `defaultComponents` JSON, so
 * its length is caller-controlled. One INSERT per chunk keeps the statement
 * payload bounded while the whole activation stays in one transaction.
 */
const SALARY_COMPONENT_INSERT_CHUNK = 200;

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
    if (policy.status !== "DRAFT" && !u.isOrgOwner) {
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
        const currentConfig = toPayrollPolicyConfig(activeVersion?.config) ?? DEFAULT_PAYROLL_POLICY_CONFIG;
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
      components = toTemplateComponentDefs(tpl.defaultComponents);
      baseToggles = normalizePayrollToggles(tpl.defaultToggles);
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
      if (!newVersion) throw new InternalServerErrorException("Failed to create payroll policy version");

      if (templateKey) {
        await tx.insert(payrollTemplateActivations).values({
          orgId: u.orgId,
          policyVersionId: newVersion.id,
          templateKey,
          snapshot: templateSnapshot,
          activatedBy: u.userId,
        });
      }

      const componentRows = components.map((comp) => ({
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
      }));
      for (let i = 0; i < componentRows.length; i += SALARY_COMPONENT_INSERT_CHUNK)
        await tx
          .insert(salaryComponents)
          .values(componentRows.slice(i, i + SALARY_COMPONENT_INSERT_CHUNK))
          .onConflictDoNothing({
            target: [salaryComponents.orgId, salaryComponents.code],
          });

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
        .set({ status: "ACTIVE", activeVersionId: newVersion.id })
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
    return buildPolicyVersion(this.db, u, policyId, input);
  }
}
