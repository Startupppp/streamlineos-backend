import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant/for-each-org";
import { logger } from "../../common/logger/logger.service";
import { CustomerLifecycleService } from "../customer-lifecycle/customer-lifecycle.service";
import { RenewalTriggerService } from "../customer-lifecycle/renewal-trigger.service";

/**
 * The sweep that keeps lifecycle records and renewal triggers current.
 *
 * Phase 5, tickets 07 and 09. Both services are per-organisation and neither
 * had a caller, which is the difference between a feature that exists and one
 * that runs: a closed-won deal produces a lifecycle record only if something
 * notices the deal closed.
 *
 * Order matters and is not arbitrary. Lifecycles are opened first, then
 * triggers are evaluated, because a deal that closed since the last sweep must
 * become a lifecycle before a renewal can be read off it — running them the
 * other way round delays every new customer's first renewal trigger by a full
 * cycle, which for a monthly sweep is the whole point of the ticket.
 *
 * `forEachOrg` rather than a cross-tenant query, so each organisation's work
 * happens inside its own tenant context and a failure in one does not stop the
 * rest. It already skips organisations that are deleted, inactive or awaiting
 * purge.
 */
@Injectable()
export class CronCrmLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly lifecycles: CustomerLifecycleService,
    private readonly triggers: RenewalTriggerService,
  ) {}

  async sweep(now: Date = new Date()): Promise<{
    organizations: number;
    failed: number;
    lifecyclesOpened: number;
    triggersFired: number;
  }> {
    let lifecyclesOpened = 0;
    let triggersFired = 0;

    const result = await forEachOrg(this.db, "crm-lifecycle", async (_tx, orgId) => {
      lifecyclesOpened += await this.lifecycles.openFromClosedWonDeals(orgId, now);
      const triggered = await this.triggers.sweep(orgId, now);
      triggersFired += triggered.opened;
    });

    logger.info("crm-lifecycle sweep", {
      organizations: result.succeeded,
      failed: result.failed,
      lifecyclesOpened,
      triggersFired,
    });

    return {
      organizations: result.succeeded,
      failed: result.failed,
      lifecyclesOpened,
      triggersFired,
    };
  }
}
