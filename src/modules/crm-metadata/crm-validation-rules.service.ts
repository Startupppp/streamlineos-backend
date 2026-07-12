import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { crmValidationRules, auditLogs } from "../../db/schema";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  CreateValidationRuleInput,
  UpdateValidationRuleInput,
  TestValidationInput,
} from "./dto/validation-rules.schemas";
import { CrmValidationService, type ValidationContext } from "./crm-validation.service";

@Injectable()
export class CrmValidationRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly validator: CrmValidationService,
  ) {}

  async list(orgId: string) {
    return this.db.select().from(crmValidationRules).where(eq(crmValidationRules.orgId, orgId)).orderBy(crmValidationRules.sortOrder);
  }

  async create(u: CurrentUserContext, input: CreateValidationRuleInput) {
    const [row] = await this.db.insert(crmValidationRules).values({
      orgId: u.orgId,
      ...input,
      config: input.config ?? {},
    }).returning();
    void this.auditLog(u, "crm_validation_rule.created", row!.id, { entityType: input.entityType, field: input.field, ruleType: input.ruleType });
    return row;
  }

  async update(u: CurrentUserContext, ruleId: string, input: UpdateValidationRuleInput) {
    await this.assertOwner(u.orgId, ruleId);
    const [row] = await this.db.update(crmValidationRules).set({ ...input, updatedAt: new Date() }).where(and(eq(crmValidationRules.id, ruleId), eq(crmValidationRules.orgId, u.orgId))).returning();
    if (!row) throw new NotFoundException("Validation rule not found");
    void this.auditLog(u, "crm_validation_rule.updated", ruleId, input as Record<string, unknown>);
    return row;
  }

  async delete(u: CurrentUserContext, ruleId: string) {
    await this.assertOwner(u.orgId, ruleId);
    await this.db.update(crmValidationRules).set({ isActive: false, updatedAt: new Date() }).where(and(eq(crmValidationRules.id, ruleId), eq(crmValidationRules.orgId, u.orgId)));
    void this.auditLog(u, "crm_validation_rule.deleted", ruleId, {});
    return { success: true };
  }

  async testValidation(u: CurrentUserContext, input: TestValidationInput) {
    const ctx: ValidationContext = {
      pipelineId: input.pipelineId,
      stageKey: input.stageKey,
      sourceKey: input.sourceKey,
      existingRecordId: input.existingRecordId !== undefined ? String(input.existingRecordId) : undefined,
    };
    return this.validator.evaluate(u.orgId, input.entityType, input.record, ctx);
  }

  private async assertOwner(orgId: string, ruleId: string) {
    const [r] = await this.db.select({ id: crmValidationRules.id }).from(crmValidationRules).where(and(eq(crmValidationRules.id, ruleId), eq(crmValidationRules.orgId, orgId))).limit(1);
    if (!r) throw new NotFoundException("Validation rule not found");
    return r;
  }

  private auditLog(u: CurrentUserContext, action: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    return this.db.insert(auditLogs).values({
      action,
      userId: u.userId,
      orgId: u.orgId,
      targetId,
      targetType: "crm_validation_rule",
      metadata,
    }).then(() => undefined);
  }
}
