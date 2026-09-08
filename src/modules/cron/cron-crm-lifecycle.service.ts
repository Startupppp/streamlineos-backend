import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { LifecycleTriggersService } from "../lifecycle/lifecycle-triggers.service";
import { forEachOrg } from "../../common/tenant";

/**
 * How many contracts one organisation may be asked about per tick.
 *
 * The route's own default. Deliberately modest, and for the same reason it is
 * modest there: every candidate that turns out to be due costs a provider call,
 * so this is a bill as much as a page size. A tenant with a bigger renewal book
 * gets more ticks rather than one larger sweep, and because candidates come back
 * in renewal-date order, the contracts a truncated pass leaves behind are the
 * ones with the most time left.
 */
const PER_ORG_LIMIT = 50;

/**
 * The renewal and churn-risk sweep, on the schedule the rest of the platform uses.
 *
 * `LifecycleTriggersService` carried a comment saying nothing scheduled it —
 * that the sweep was reachable only through `POST /crm/lifecycle-triggers/sweep`,
 * because this repository has no `@nestjs/schedule` and inventing one inside a
 * wiring ticket would be a second piece of infrastructure. That reasoning was
 * right, and this does not overturn it: there is still no in-process scheduler.
 * What there is, and has been all along, is a cron surface — 47 endpoints behind
 * `assertCronSecret`, driven by whatever the deployment points at them. Billing,
 * HR, notifications, support and Build all reach their sweeps that way. The
 * renewal loop simply was not on it.
 *
 * That comment also asked that whatever eventually runs on a timer call the
 * service rather than grow its own copy of the decision. This calls the service.
 * Every judgement about what is due, what has already been offered, and whether
 * to open a conversation stays in one place; this file only decides which
 * organisations to ask and how many contracts to ask about.
 *
 * One organisation's failure must not stop the rest — `forEachOrg` isolates each
 * in its own transaction and logs the ones that fail, so a single tenant with a
 * bad contract row cannot silence the whole book.
 */
@Injectable()
export class CronCrmLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly triggers: LifecycleTriggersService,
  ) {}

  async sweepLifecycleTriggers(): Promise<{
    organizations: number;
    failed: number;
    considered: number;
    opened: number;
    reoffered: number;
    held: number;
  }> {
    let considered = 0;
    let opened = 0;
    let reoffered = 0;
    let held = 0;

    /**
     * `sweep` reads `this.db`, not the `tx` handed in here, and that is correct:
     * `forEachOrg` establishes the tenant *context* as well as the transaction,
     * so the proxied handle every nested service holds resolves to this
     * organisation's transaction. Passing `tx` down would bypass the seam the
     * service was written against.
     */
    const result = await forEachOrg(this.db, "crm-lifecycle-triggers", async (_tx, orgId) => {
      const report = await this.triggers.sweep(orgId, { limit: PER_ORG_LIMIT });
      considered += report.considered;
      opened += report.opened;
      reoffered += report.reoffered;
      held += report.held;
    });

    return {
      organizations: result.succeeded,
      failed: result.failed,
      considered,
      opened,
      reoffered,
      held,
    };
  }
}
