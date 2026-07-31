import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { and, eq, gte, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { crmAutomationRules, crmAutomationRuns } from "../../../db/schema";
import { crmAutomationEvents } from "../../../db/schema/crm/metadata";
import { logger } from "../../../common/logger/logger.service";
import type { CrmAutomationRunnerService } from "./crm-automation-runner.service";
import type { StudioEventPayload } from "./types";

@Injectable()
export class CrmAutomationBusService {
  private static readonly MAX_CHAIN_DEPTH = 3;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(forwardRef(() => "CrmAutomationRunnerService"))
    private readonly runner: CrmAutomationRunnerService,
  ) {}

  async emit(
    orgId: string,
    eventKey: string,
    payload: StudioEventPayload,
  ): Promise<void> {
    const depth = payload.depth ?? 0;
    if (depth >= CrmAutomationBusService.MAX_CHAIN_DEPTH) {
      logger.warn("crm-automation-bus: chain depth limit reached", { orgId, eventKey, depth });
      return;
    }

    const validEvent = await this.db
      .select({ key: crmAutomationEvents.key })
      .from(crmAutomationEvents)
      .where(
        and(
          eq(crmAutomationEvents.orgId, orgId),
          eq(crmAutomationEvents.key, eventKey),
          eq(crmAutomationEvents.isActive, true),
        ),
      )
      .limit(1);

    if (validEvent.length === 0) {
      return;
    }

    const rules = await this.db
      .select()
      .from(crmAutomationRules)
      .where(
        and(
          eq(crmAutomationRules.orgId, orgId),
          eq(crmAutomationRules.trigger, eventKey),
          eq(crmAutomationRules.isActive, true),
          isNull(crmAutomationRules.deletedAt),
        ),
      );

    for (const rule of rules) {
      if (rule.cooldownMinutes > 0) {
        const cooldownSince = new Date(Date.now() - rule.cooldownMinutes * 60 * 1000);
        const recentRuns = await this.db
          .select({ id: crmAutomationRuns.id })
          .from(crmAutomationRuns)
          .where(
            and(
              eq(crmAutomationRuns.orgId, orgId),
              eq(crmAutomationRuns.ruleId, rule.id),
              eq(crmAutomationRuns.entityId, payload.entityId),
              gte(crmAutomationRuns.startedAt, cooldownSince),
            ),
          )
          .limit(1);

        if (recentRuns.length > 0) {
          continue;
        }
      }

      this.runner.executeRule(orgId, rule, eventKey, payload).catch(async (err) => {
        const msg = err instanceof Error ? err.message : "Bus dispatch error";
        logger.error("crm-automation-bus: fire-and-forget failed", { orgId, ruleId: rule.id, error: err });
        await this.db
          .update(crmAutomationRules)
          .set({ lastError: msg })
          .where(and(eq(crmAutomationRules.id, rule.id), eq(crmAutomationRules.orgId, orgId)))
          .catch(() => {});
      });
    }
  }
}
