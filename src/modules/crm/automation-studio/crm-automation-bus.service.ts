import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
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
    @Inject("CrmAutomationRunnerService")
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

    /**
     * Everything this method reads, in one short transaction of its own.
     *
     * Callers fire this detached — `void this.bus.emit(...)` in
     * `deals.service` — so by the time it runs, the request's tenant
     * transaction has committed and closed. `crm_automation_events`,
     * `crm_automation_rules` and `crm_automation_runs` are all behind
     * `tenant_isolation`, whose read predicate RAISES with no tenant context
     * rather than returning nothing. So these reads did not find zero rules,
     * they threw — into a `.catch` on the caller's side — and every automation
     * rule in the product was dead while the studio listed them as active.
     *
     * Read-only and closed before any rule executes, because rule actions send
     * email and make HTTP calls and must not be made with a connection held.
     */
    const due = await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const validEvent = await tx
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

      if (validEvent.length === 0) return [];

      const rules = await tx
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

      const eligible: typeof rules = [];
      for (const rule of rules) {
        if (rule.cooldownMinutes > 0) {
          const cooldownSince = new Date(Date.now() - rule.cooldownMinutes * 60 * 1000);
          const recentRuns = await tx
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

          if (recentRuns.length > 0) continue;
        }
        eligible.push(rule);
      }

      return eligible;
    });

    for (const rule of due) {
      /**
       * The rule's own transaction, for the same reason.
       *
       * The runner touches the database in a dozen places — the run row, the
       * step log, the task or field write each action makes — and every one of
       * them reaches `this.db`, which the tenant proxy routes into whatever
       * transaction is ambient. Without one here they fail exactly as the reads
       * above did.
       *
       * This does hold a connection across the `fetch` and the email send that
       * a `send_webhook` or `send_email` action performs, which is the cost of
       * making the feature work at all in one change. The shape that removes
       * it is a transaction per database touch inside the runner with the
       * external effects on the outbox — worth doing, and a larger change to a
       * different file than this one.
       */
      void runInNewTenantTransaction(this.db, orgId, () =>
        this.runner.executeRule(orgId, rule, eventKey, payload),
      ).catch(async (err) => {
        const msg = err instanceof Error ? err.message : "Bus dispatch error";
        logger.error("crm-automation-bus: fire-and-forget failed", { orgId, ruleId: rule.id, error: err });
        await runInNewTenantTransaction(this.db, orgId, (tx) =>
          tx
            .update(crmAutomationRules)
            .set({ lastError: msg })
            .where(and(eq(crmAutomationRules.id, rule.id), eq(crmAutomationRules.orgId, orgId))),
        ).catch(logSideEffectFailure("crm-automation-bus: last-error persist", { orgId, ruleId: rule.id }));
      });
    }
  }
}
