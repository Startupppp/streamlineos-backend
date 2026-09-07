import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { surveyAutomationEvents, surveyForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { createAutomationSchema } from "./dto/survey-automation.schemas";
import type { CreateAutomationInput, PatchAutomationInput } from "./dto/survey-automation.schemas";

export interface AutomationRule extends CreateAutomationInput {
  id: string;
}

const automationRuleSchema = createAutomationSchema.extend({ id: z.string() });

@Injectable()
export class SurveyAutomationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhooksDispatch: WebhooksDispatchService,
  ) {}

  async record(orgId: string, surveyId: number, sessionId: number | null, eventType: string, payload: Record<string, unknown>) {
    const [event] = await this.db
      .insert(surveyAutomationEvents)
      .values({ orgId, surveyId, sessionId, eventType, payload, status: "processed", processedAt: new Date() })
      .returning();

    this.webhooksDispatch.dispatch(orgId, eventType, { surveyId, sessionId, ...payload });
    return event;
  }

  listEvents(orgId: string, surveyId: number) {
    return this.db.query.surveyAutomationEvents.findMany({
      where: and(eq(surveyAutomationEvents.orgId, orgId), eq(surveyAutomationEvents.surveyId, surveyId)),
      orderBy: [desc(surveyAutomationEvents.createdAt)],
      limit: 100,
    });
  }

  private async getSurvey(orgId: string, surveyId: number) {
    const survey = await this.db.query.surveyForms.findFirst({ where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)) });
    if (!survey) throw new NotFoundException("Survey not found");
    return survey;
  }

  private getRules(survey: typeof surveyForms.$inferSelect): AutomationRule[] {
    const automations = survey.settings?.["automations"];
    if (!Array.isArray(automations)) return [];
    return automations
      .map((item) => automationRuleSchema.safeParse(item))
      .filter((result): result is { success: true; data: AutomationRule } => result.success)
      .map((result) => result.data);
  }

  async list(orgId: string, surveyId: number) {
    const survey = await this.getSurvey(orgId, surveyId);
    return this.getRules(survey);
  }

  async getRulesForEvent(orgId: string, surveyId: number, eventType: string) {
    const survey = await this.getSurvey(orgId, surveyId);
    return this.getRules(survey).filter((rule) => rule.eventType === eventType);
  }

  async create(orgId: string, surveyId: number, input: CreateAutomationInput) {
    const survey = await this.getSurvey(orgId, surveyId);
    const rules = this.getRules(survey);
    const rule: AutomationRule = { id: randomUUID(), ...input };
    rules.push(rule);
    await this.saveRules(orgId, surveyId, survey, rules);
    return rule;
  }

  async patch(orgId: string, surveyId: number, automationId: string, input: PatchAutomationInput) {
    const survey = await this.getSurvey(orgId, surveyId);
    const rules = this.getRules(survey);
    const index = rules.findIndex((r) => r.id === automationId);
    if (index === -1) throw new NotFoundException("Automation not found");
    rules[index] = { ...rules[index], ...input };
    await this.saveRules(orgId, surveyId, survey, rules);
    return rules[index];
  }

  async remove(orgId: string, surveyId: number, automationId: string) {
    const survey = await this.getSurvey(orgId, surveyId);
    const rules = this.getRules(survey).filter((r) => r.id !== automationId);
    await this.saveRules(orgId, surveyId, survey, rules);
    return { success: true };
  }

  private async saveRules(orgId: string, surveyId: number, survey: typeof surveyForms.$inferSelect, rules: AutomationRule[]) {
    const settings = { ...(survey.settings ?? {}), automations: rules };
    await this.db.update(surveyForms).set({ settings, updatedAt: new Date() }).where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)));
  }
}
