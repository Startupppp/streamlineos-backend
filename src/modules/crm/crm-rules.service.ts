import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { leadAssignmentRules, leadScoringRules, crmEmailTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  AssignmentRuleCreateInput,
  AssignmentRuleUpdateInput,
  EmailTemplateCreateInput,
  EmailTemplateUpdateInput,
  ScoringRuleCreateInput,
  ScoringRuleUpdateInput,
} from "./dto/rules.schemas";

@Injectable()
export class CrmRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listAssignmentRules(orgId: string) {
    return this.db
      .select()
      .from(leadAssignmentRules)
      .where(eq(leadAssignmentRules.orgId, orgId))
      .orderBy(desc(leadAssignmentRules.priority))
      .limit(100);
  }

  async createAssignmentRule(orgId: string, input: AssignmentRuleCreateInput) {
    const [rule] = await this.db
      .insert(leadAssignmentRules)
      .values({
        orgId,
        name: input.name,
        assignmentType: input.assignmentType,
        assignToUserId: input.assignToUserId ?? null,
        roundRobinUserIds: input.roundRobinUserIds ?? [],
        conditions: input.conditions ?? [],
        priority: input.priority,
        isActive: input.isActive,
      })
      .returning();
    return rule;
  }

  updateAssignmentRule(orgId: string, id: number, input: AssignmentRuleUpdateInput) {
    return this.db
      .update(leadAssignmentRules)
      .set(input)
      .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deleteAssignmentRule(orgId: string, id: number) {
    await this.db
      .delete(leadAssignmentRules)
      .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId)));
    return { success: true };
  }

  async reorderAssignmentRules(orgId: string, ruleIds: number[]) {
    await Promise.all(
      ruleIds.map((id, index) =>
        this.db
          .update(leadAssignmentRules)
          .set({ priority: ruleIds.length - index })
          .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId))),
      ),
    );
    return { success: true };
  }

  listScoringRules(orgId: string) {
    return this.cache.cached(
      `crm:scoring-rules:${orgId}`,
      () =>
        this.db
          .select({
            id: leadScoringRules.id,
            field: leadScoringRules.field,
            operator: leadScoringRules.operator,
            value: leadScoringRules.value,
            points: leadScoringRules.points,
            createdAt: leadScoringRules.createdAt,
          })
          .from(leadScoringRules)
          .where(eq(leadScoringRules.orgId, orgId))
          .orderBy(desc(leadScoringRules.createdAt))
          .limit(100),
      CACHE_TTL.LONG,
    );
  }

  async createScoringRule(orgId: string, input: ScoringRuleCreateInput) {
    const [rule] = await this.db
      .insert(leadScoringRules)
      .values({
        orgId,
        field: input.field,
        operator: input.operator,
        value: input.value,
        points: input.points,
      })
      .returning();
    await this.cache.invalidatePattern(`crm:scoring-rules:${orgId}*`);
    return rule;
  }

  updateScoringRule(orgId: string, id: number, input: ScoringRuleUpdateInput) {
    return this.db
      .update(leadScoringRules)
      .set(input)
      .where(and(eq(leadScoringRules.id, id), eq(leadScoringRules.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deleteScoringRule(orgId: string, id: number) {
    await this.db
      .delete(leadScoringRules)
      .where(and(eq(leadScoringRules.id, id), eq(leadScoringRules.orgId, orgId)));
    return { success: true };
  }

  listEmailTemplates(orgId: string) {
    return this.db
      .select()
      .from(crmEmailTemplates)
      .where(eq(crmEmailTemplates.orgId, orgId))
      .orderBy(desc(crmEmailTemplates.createdAt))
      .limit(100);
  }

  async createEmailTemplate(orgId: string, userId: string, input: EmailTemplateCreateInput) {
    const [template] = await this.db
      .insert(crmEmailTemplates)
      .values({
        orgId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        createdBy: userId,
      })
      .returning();
    return template;
  }

  updateEmailTemplate(orgId: string, id: number, input: EmailTemplateUpdateInput) {
    return this.db
      .update(crmEmailTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(crmEmailTemplates.id, id), eq(crmEmailTemplates.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
  }

  async deleteEmailTemplate(orgId: string, id: number) {
    await this.db
      .delete(crmEmailTemplates)
      .where(and(eq(crmEmailTemplates.id, id), eq(crmEmailTemplates.orgId, orgId)));
    return { success: true };
  }
}
