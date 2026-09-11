import { Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { Inject } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { SignEnvelopesService } from "../e-sign/sign-envelopes.service";
import { forEachOrg } from "../../common/tenant";

export interface SignSweepReport {
  organizations: number;
  failed: number;
  reminded: number;
  expired: number;
}

/**
 * The envelope reminder and expiration sweeps, on a schedule.
 *
 * `sign_envelopes` carries `reminder_enabled`, `reminder_first_after_days`,
 * `reminder_repeat_days`, `reminder_max_count` and `expires_at`, and the
 * envelope composer offers all five as product settings — so a tenant
 * configuring "remind after 3 days, then every 2, up to 4 times" was being told
 * the platform would do that. Nothing ran it. The sweeps existed only behind
 * `POST /sign/admin/run-reminder-sweep`, an authenticated admin route gated on
 * `sign:admin:manage` with no button in the product and no scheduler calling
 * it, so in practice no reminder was ever sent automatically and no envelope
 * ever expired on its own — an envelope past `expires_at` stayed signable.
 *
 * There is still no in-process scheduler and this does not add one. What the
 * platform has, and has had all along, is the cron surface: 47 endpoints behind
 * `assertCronSecret`, driven by whatever the deployment points at them. Billing,
 * HR, notifications, support, Build, CRM and Timesheets all reach their sweeps
 * that way. E-sign simply was not on it.
 *
 * `forEachOrg` rather than one pass over the table, and that distinction is
 * load-bearing here rather than stylistic. Walking organisations gives each one
 * its own transaction, its own tenant GUC and its own scoped call, so a tenant
 * whose envelope has a bad recipient row cannot fail — or silently touch —
 * anybody else's.
 *
 * This used to justify itself with "no `sign_*` table is under RLS". That was
 * measured and true once and is false now: a cold-built schema at head has 867
 * tables under RLS and every `sign_*` table is one of them, swept in by
 * `0378_rls_remaining_tenant_tables`, an unfiltered catalog pass that names no
 * table — which is why no grep for `sign_` in the migrations turns it up. The
 * per-org walk is still the right shape, for the transaction and failure
 * isolation above rather than for being the only tenant boundary there is.
 */
@Injectable()
export class CronSignService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly envelopes: SignEnvelopesService,
  ) {}

  async sweepEnvelopes(): Promise<SignSweepReport> {
    let reminded = 0;
    let expired = 0;

    const result = await forEachOrg(this.db, "sign-envelope-sweeps", async (_tx, orgId) => {
      /*
       * Expiration first. An envelope that is already past its expiry should
       * not be reminded about — the reminder re-issues a signing token, so
       * running the sweeps the other way round emails a fresh link for an
       * envelope this same tick is about to close.
       */
      expired += await this.envelopes.runExpirationSweep(orgId);
      reminded += await this.envelopes.runReminderSweep(orgId);
    });

    return {
      organizations: result.succeeded,
      failed: result.failed,
      reminded,
      expired,
    };
  }
}
