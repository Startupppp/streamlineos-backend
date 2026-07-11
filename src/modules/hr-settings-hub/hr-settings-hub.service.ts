import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrPolicies, hrTemplates, hrWorkflowDefinitions } from "../../db/schema";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";
import { HR_POLICY_TYPES } from "./hr-settings-hub.constants";
import type { PolicyType } from "../hr-policies/hr-policy-types";

@Injectable()
export class HrSettingsHubService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly evaluation: HrPolicyEvaluationService,
  ) {}

  async getEffectiveRules(orgId: string, employeeId: string, date: string) {
    const results = await Promise.allSettled(
      HR_POLICY_TYPES.map(async (policyType) => {
        const result = await this.evaluation.evaluatePolicy(orgId, employeeId, policyType, date);
        return { policyType, result };
      }),
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<{
          policyType: PolicyType;
          result: NonNullable<Awaited<ReturnType<HrPolicyEvaluationService["evaluatePolicy"]>>>;
        }> => r.status === "fulfilled" && r.value.result !== null,
      )
      .map((r) => ({
        policyType: r.value.policyType,
        matchedPolicy: r.value.result.policy,
        rules: r.value.result.rules,
        trace: r.value.result.trace,
      }));
  }

  async getVersions(orgId: string, entity: "policy" | "template" | "workflow", id: string) {
    if (entity === "policy") {
      return this.getPolicyVersionLineage(orgId, Number(id));
    }
    if (entity === "template") {
      return this.getTemplateVersionLineage(orgId, Number(id));
    }
    return this.getWorkflowVersions(orgId, Number(id));
  }

  private async getPolicyVersionLineage(orgId: string, policyId: number) {
    const root = await this.db.query.hrPolicies.findFirst({
      where: and(
        eq(hrPolicies.id, policyId),
        eq(hrPolicies.orgId, orgId),
        isNull(hrPolicies.deletedAt),
      ),
    });
    if (!root) throw new NotFoundException("Policy not found");

    const name = root.name;
    const policyType = root.policyType;

    const all = await this.db
      .select({
        id: hrPolicies.id,
        name: hrPolicies.name,
        version: hrPolicies.version,
        status: hrPolicies.status,
        effectiveFrom: hrPolicies.effectiveFrom,
        effectiveTo: hrPolicies.effectiveTo,
        priority: hrPolicies.priority,
        parentPolicyId: hrPolicies.parentPolicyId,
        createdAt: hrPolicies.createdAt,
        updatedAt: hrPolicies.updatedAt,
      })
      .from(hrPolicies)
      .where(
        and(
          eq(hrPolicies.orgId, orgId),
          eq(hrPolicies.name, name),
          eq(hrPolicies.policyType, policyType),
          isNull(hrPolicies.deletedAt),
        ),
      )
      .orderBy(desc(hrPolicies.version));

    return { entity: "policy", name, items: all };
  }

  private async getTemplateVersionLineage(orgId: string, templateId: number) {
    const root = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.id, templateId),
        eq(hrTemplates.orgId, orgId),
        isNull(hrTemplates.deletedAt),
      ),
    });
    if (!root) throw new NotFoundException("Template not found");

    const name = root.name;
    const kind = root.kind;

    const all = await this.db
      .select({
        id: hrTemplates.id,
        name: hrTemplates.name,
        version: hrTemplates.version,
        status: hrTemplates.status,
        kind: hrTemplates.kind,
        description: hrTemplates.description,
        parentTemplateId: hrTemplates.parentTemplateId,
        createdAt: hrTemplates.createdAt,
        updatedAt: hrTemplates.updatedAt,
      })
      .from(hrTemplates)
      .where(
        and(
          eq(hrTemplates.orgId, orgId),
          eq(hrTemplates.name, name),
          eq(hrTemplates.kind, kind),
          isNull(hrTemplates.deletedAt),
        ),
      )
      .orderBy(desc(hrTemplates.version));

    return { entity: "template", name, items: all };
  }

  private async getWorkflowVersions(orgId: string, workflowId: number) {
    const root = await this.db.query.hrWorkflowDefinitions.findFirst({
      where: and(
        eq(hrWorkflowDefinitions.id, workflowId),
        eq(hrWorkflowDefinitions.orgId, orgId),
      ),
    });
    if (!root) throw new NotFoundException("Workflow not found");

    const all = await this.db
      .select({
        id: hrWorkflowDefinitions.id,
        name: hrWorkflowDefinitions.name,
        version: hrWorkflowDefinitions.version,
        status: hrWorkflowDefinitions.status,
        objectType: hrWorkflowDefinitions.objectType,
        createdAt: hrWorkflowDefinitions.createdAt,
        updatedAt: hrWorkflowDefinitions.updatedAt,
      })
      .from(hrWorkflowDefinitions)
      .where(
        and(
          eq(hrWorkflowDefinitions.orgId, orgId),
          eq(hrWorkflowDefinitions.name, root.name),
          eq(hrWorkflowDefinitions.objectType, root.objectType),
        ),
      )
      .orderBy(desc(hrWorkflowDefinitions.version));

    return { entity: "workflow", name: root.name, items: all };
  }
}
