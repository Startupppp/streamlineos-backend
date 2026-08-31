import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import { crmAutomationRules, crmAutomationRuns } from "../../../db/schema";
import { crmAutomationEvents, crmAutomationActions } from "../../../db/schema/crm/metadata";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "./dto/automation-rules.schemas";
import { CrmAutomationRunnerService } from "../automation-studio/crm-automation-runner.service";
import type { TestAutomationRuleInput } from "../automation-studio/dto/automation-studio.schemas";
import type { CrmAutomationCondition } from "../../../db/schema/crm/automation-rules";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import {
  resolveWindowedTotal,
  totalOverWindow,
  withoutTotal,
} from "../../../common/pagination/window-count";

@Injectable()
export class CrmAutomationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly runner: CrmAutomationRunnerService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async list(orgId: string) {
    const rules = await this.db
      .select()
      .from(crmAutomationRules)
      .where(and(eq(crmAutomationRules.orgId, orgId), isNull(crmAutomationRules.deletedAt)))
      .orderBy(desc(crmAutomationRules.createdAt))
      .limit(100);
    return { rules };
  }

  async create(orgId: string, input: CreateAutomationRuleInput) {
    await this.planLimits.assertWithinLimit(orgId, "automations");

    const [rule] = await this.db
      .insert(crmAutomationRules)
      .values({
        orgId,
        name: input.name,
        trigger: input.trigger,
        conditions: input.conditions,
        actions: input.actions,
        isActive: input.isActive,
        graph: input.graph ?? null,
        isDraft: input.isDraft ?? false,
        cooldownMinutes: input.cooldownMinutes ?? 0,
      })
      .returning();
    return { rule };
  }

  async update(orgId: string, id: number, input: UpdateAutomationRuleInput) {
    const [rule] = await this.db
      .update(crmAutomationRules)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(
          eq(crmAutomationRules.id, id),
          eq(crmAutomationRules.orgId, orgId),
          isNull(crmAutomationRules.deletedAt),
        ),
      )
      .returning();
    return rule ? { rule } : null;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .update(crmAutomationRules)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(crmAutomationRules.id, id),
          eq(crmAutomationRules.orgId, orgId),
          isNull(crmAutomationRules.deletedAt),
        ),
      )
      .returning({ id: crmAutomationRules.id });
    if (!deleted) throw new NotFoundException("Automation rule not found");
    return { success: true as const };
  }

  async listEvents(orgId: string) {
    const events = await this.db
      .select()
      .from(crmAutomationEvents)
      .where(and(eq(crmAutomationEvents.orgId, orgId), eq(crmAutomationEvents.isActive, true)));
    return { events };
  }

  async listActions(orgId: string) {
    const actions = await this.db
      .select()
      .from(crmAutomationActions)
      .where(and(eq(crmAutomationActions.orgId, orgId), eq(crmAutomationActions.isActive, true)));
    return { actions };
  }

  async enable(orgId: string, ruleId: number) {
    const [rule] = await this.db
      .update(crmAutomationRules)
      .set({ isActive: true, updatedAt: new Date() })
      .where(and(eq(crmAutomationRules.id, ruleId), eq(crmAutomationRules.orgId, orgId), isNull(crmAutomationRules.deletedAt)))
      .returning();
    if (!rule) throw new NotFoundException("Automation rule not found");
    return { rule };
  }

  async disable(orgId: string, ruleId: number) {
    const [rule] = await this.db
      .update(crmAutomationRules)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(crmAutomationRules.id, ruleId), eq(crmAutomationRules.orgId, orgId), isNull(crmAutomationRules.deletedAt)))
      .returning();
    if (!rule) throw new NotFoundException("Automation rule not found");
    return { rule };
  }

  async testRule(orgId: string, ruleId: number, input: TestAutomationRuleInput) {
    const [rule] = await this.db
      .select()
      .from(crmAutomationRules)
      .where(and(eq(crmAutomationRules.id, ruleId), eq(crmAutomationRules.orgId, orgId), isNull(crmAutomationRules.deletedAt)))
      .limit(1);
    if (!rule) throw new NotFoundException("Automation rule not found");
    return this.runner.dryRunConditions(
      (rule.conditions ?? []) as CrmAutomationCondition[],
      input.samplePayload,
    );
  }

  async getRuns(orgId: string, ruleId: number, page: number) {
    const [rule] = await this.db
      .select({ id: crmAutomationRules.id })
      .from(crmAutomationRules)
      .where(and(eq(crmAutomationRules.id, ruleId), eq(crmAutomationRules.orgId, orgId)))
      .limit(1);
    if (!rule) throw new NotFoundException("Automation rule not found");

    const limit = 20;
    const offset = (page - 1) * limit;
    const where = and(eq(crmAutomationRuns.orgId, orgId), eq(crmAutomationRuns.ruleId, ruleId));
    const rows = await this.db
      .select({ ...getTableColumns(crmAutomationRuns), total: totalOverWindow })
      .from(crmAutomationRuns)
      .where(where)
      .orderBy(desc(crmAutomationRuns.startedAt))
      .limit(limit)
      .offset(offset);

    const total = await resolveWindowedTotal(rows, offset, async () => {
      const fallback = await this.db.select({ c: count() }).from(crmAutomationRuns).where(where);
      return Number(fallback[0]?.c ?? 0);
    });

    return { runs: withoutTotal(rows), total };
  }
}
