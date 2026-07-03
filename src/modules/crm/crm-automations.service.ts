import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { crmAutomationRules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateAutomationRuleInput, UpdateAutomationRuleInput } from "./dto/automation-rules.schemas";

@Injectable()
export class CrmAutomationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
    const [rule] = await this.db
      .insert(crmAutomationRules)
      .values({
        orgId,
        name: input.name,
        trigger: input.trigger,
        conditions: input.conditions,
        actions: input.actions,
        isActive: input.isActive,
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
}
