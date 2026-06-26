import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq, and, desc, lt, isNotNull, sql, count } from "drizzle-orm";
import {
  territories,
  crmSla,
  leadScoringRules,
  leadAssignmentRules,
  crmEmailTemplates,
  webLeadForms,
  leads,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  TerritoryCreateInput,
  TerritoryUpdateInput,
  SlaCreateInput,
  SlaUpdateInput,
  ScoringRuleCreateInput,
  ScoringRuleUpdateInput,
  AssignmentRuleCreateInput,
  AssignmentRuleUpdateInput,
  EmailTemplateCreateInput,
  EmailTemplateUpdateInput,
  WebFormCreateInput,
  WebFormUpdateInput,
} from "./dto/crm.schemas";

@Injectable()
export class CrmConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listTerritories(orgId: string, limit: number) {
    const key = `crm:territories:${orgId}:${limit}`;
    return this.cache.cached(
      key,
      () =>
        this.db
          .select({
            id: territories.id,
            name: territories.name,
            states: territories.states,
            cities: territories.cities,
            assignedReps: territories.assignedReps,
            description: territories.description,
            isActive: territories.isActive,
            createdAt: territories.createdAt,
          })
          .from(territories)
          .where(eq(territories.orgId, orgId))
          .orderBy(territories.name)
          .limit(limit),
      CACHE_TTL.MEDIUM,
    );
  }

  async createTerritory(orgId: string, createdBy: string, input: TerritoryCreateInput) {
    const [created] = await this.db
      .insert(territories)
      .values({
        orgId,
        name: input.name,
        states: input.states,
        cities: input.cities,
        assignedReps: input.assignedReps,
        description: input.description ?? null,
        isActive: input.isActive,
        createdBy,
      })
      .returning();

    await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
    return created;
  }

  async getTerritory(orgId: string, id: number) {
    const [row] = await this.db
      .select()
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)));
    return row ?? null;
  }

  async updateTerritory(orgId: string, id: number, input: TerritoryUpdateInput) {
    const [existing] = await this.db
      .select({ id: territories.id })
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)));

    if (!existing) return null;

    const [updated] = await this.db
      .update(territories)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)))
      .returning();

    await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
    return updated;
  }

  async removeTerritory(orgId: string, id: number) {
    const [existing] = await this.db
      .select({ id: territories.id })
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)));

    if (!existing) return null;

    await this.db.delete(territories).where(and(eq(territories.id, id), eq(territories.orgId, orgId)));
    await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
    return { success: true };
  }

  listSlaPolicies(orgId: string) {
    const key = `crm:sla-policies:${orgId}`;
    return this.cache.cached(
      key,
      () =>
        this.db
          .select({
            id: crmSla.id,
            name: crmSla.name,
            appliesTo: crmSla.appliesTo,
            priority: crmSla.priority,
            firstResponseHours: crmSla.firstResponseHours,
            resolutionHours: crmSla.resolutionHours,
            createdAt: crmSla.createdAt,
          })
          .from(crmSla)
          .where(eq(crmSla.orgId, orgId))
          .orderBy(desc(crmSla.createdAt))
          .limit(100),
      CACHE_TTL.LONG,
    );
  }

  async createSlaPolicy(orgId: string, input: SlaCreateInput) {
    const [policy] = await this.db
      .insert(crmSla)
      .values({
        orgId,
        name: input.name,
        appliesTo: input.appliesTo,
        priority: input.priority,
        firstResponseHours: input.firstResponseHours,
        resolutionHours: input.resolutionHours,
      })
      .returning();
    await this.cache.invalidatePattern(`crm:sla-policies:${orgId}*`);
    return policy;
  }

  async updateSlaPolicy(orgId: string, id: number, input: SlaUpdateInput) {
    const [updated] = await this.db
      .update(crmSla)
      .set(input)
      .where(and(eq(crmSla.id, id), eq(crmSla.orgId, orgId)))
      .returning();
    if (!updated) return null;
    await this.cache.invalidatePattern(`crm:sla-policies:${orgId}*`);
    return updated;
  }

  async removeSlaPolicy(orgId: string, id: number) {
    await this.db.delete(crmSla).where(and(eq(crmSla.id, id), eq(crmSla.orgId, orgId)));
    await this.cache.invalidatePattern(`crm:sla-policies:${orgId}*`);
    return { success: true };
  }

  getBreachedSla(orgId: string) {
    const now = new Date();
    return this.db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        status: leads.status,
        priority: leads.priority,
        slaDeadline: leads.slaDeadline,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          isNotNull(leads.slaDeadline),
          lt(leads.slaDeadline, now),
          sql`${leads.status} NOT IN ('CONVERTED', 'LOST')`,
        ),
      )
      .limit(100);
  }

  async getSlaReport(orgId: string) {
    const now = new Date();

    const [totals] = await this.db
      .select({ total: count() })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNotNull(leads.slaDeadline)));

    const [breached] = await this.db
      .select({ count: count() })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          isNotNull(leads.slaDeadline),
          sql`${leads.slaDeadline} < ${now.toISOString()}`,
          sql`${leads.status} NOT IN ('CONVERTED', 'LOST')`,
        ),
      );

    const total = totals?.total ?? 0;
    const breachedCount = breached?.count ?? 0;
    const compliant = total - breachedCount;
    const complianceRate = total > 0 ? Math.round((compliant / total) * 100) : 100;

    return { total, compliant, breached: breachedCount, complianceRate };
  }

  listScoringRules(orgId: string) {
    const key = `crm:scoring-rules:${orgId}`;
    return this.cache.cached(
      key,
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
      .values({ orgId, field: input.field, operator: input.operator, value: input.value, points: input.points })
      .returning();
    await this.cache.invalidatePattern(`crm:scoring-rules:${orgId}*`);
    return rule;
  }

  async updateScoringRule(orgId: string, id: number, input: ScoringRuleUpdateInput) {
    const [updated] = await this.db
      .update(leadScoringRules)
      .set(input)
      .where(and(eq(leadScoringRules.id, id), eq(leadScoringRules.orgId, orgId)))
      .returning();
    if (!updated) return null;
    return updated;
  }

  async removeScoringRule(orgId: string, id: number) {
    await this.db.delete(leadScoringRules).where(and(eq(leadScoringRules.id, id), eq(leadScoringRules.orgId, orgId)));
    return { success: true };
  }

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

  async updateAssignmentRule(orgId: string, id: number, input: AssignmentRuleUpdateInput) {
    const [updated] = await this.db
      .update(leadAssignmentRules)
      .set(input)
      .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId)))
      .returning();
    if (!updated) return null;
    return updated;
  }

  async removeAssignmentRule(orgId: string, id: number) {
    await this.db.delete(leadAssignmentRules).where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId)));
    return { success: true };
  }

  async reorderAssignmentRules(orgId: string, ruleIds: number[]) {
    await this.db.transaction(async (tx) => {
      await Promise.all(
        ruleIds.map((id, index) =>
          tx
            .update(leadAssignmentRules)
            .set({ priority: ruleIds.length - index })
            .where(and(eq(leadAssignmentRules.id, id), eq(leadAssignmentRules.orgId, orgId))),
        ),
      );
    });
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

  async createEmailTemplate(orgId: string, createdBy: string, input: EmailTemplateCreateInput) {
    const [template] = await this.db
      .insert(crmEmailTemplates)
      .values({ orgId, name: input.name, subject: input.subject, body: input.body, createdBy })
      .returning();
    return template;
  }

  async updateEmailTemplate(orgId: string, id: number, input: EmailTemplateUpdateInput) {
    const [updated] = await this.db
      .update(crmEmailTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(crmEmailTemplates.id, id), eq(crmEmailTemplates.orgId, orgId)))
      .returning();
    if (!updated) return null;
    return updated;
  }

  async removeEmailTemplate(orgId: string, id: number) {
    await this.db.delete(crmEmailTemplates).where(and(eq(crmEmailTemplates.id, id), eq(crmEmailTemplates.orgId, orgId)));
    return { success: true };
  }

  listWebForms(orgId: string) {
    return this.db.select().from(webLeadForms).where(eq(webLeadForms.orgId, orgId)).orderBy(webLeadForms.createdAt);
  }

  async createWebForm(orgId: string, createdBy: string, input: WebFormCreateInput) {
    const publicToken = randomUUID().replace(/-/g, "").slice(0, 16);

    const [created] = await this.db
      .insert(webLeadForms)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        fields: input.fields,
        publicToken,
        isActive: input.isActive,
        submitMessage: input.submitMessage ?? "Thank you! We'll be in touch soon.",
        redirectUrl: input.redirectUrl || null,
        createdBy,
      })
      .returning();

    return created;
  }

  async getWebForm(orgId: string, id: number) {
    const [form] = await this.db
      .select()
      .from(webLeadForms)
      .where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)));
    return form ?? null;
  }

  async updateWebForm(orgId: string, id: number, input: WebFormUpdateInput) {
    const [existing] = await this.db
      .select({ id: webLeadForms.id })
      .from(webLeadForms)
      .where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)));

    if (!existing) return null;

    const [updated] = await this.db
      .update(webLeadForms)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)))
      .returning();

    return updated;
  }

  async removeWebForm(orgId: string, id: number) {
    const [existing] = await this.db
      .select({ id: webLeadForms.id })
      .from(webLeadForms)
      .where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)));

    if (!existing) return null;

    await this.db.delete(webLeadForms).where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)));
    return { success: true };
  }
}
