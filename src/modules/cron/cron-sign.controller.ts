import { Controller, Get, Headers, HttpCode, Post } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { SignEnvelopeSweepsService } from "../e-sign/sign-envelope-sweeps.service";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";

/**
 * The scheduler entry point SignOS never had.
 *
 * `runReminderSweep` and `runExpirationSweep` have existed since SignOS
 * shipped, complete with reminder intervals, maximum counts and expiry
 * handling — reachable only from an admin button that somebody had to press.
 * Every envelope's "we will remind them in 3 days" was therefore a promise
 * nothing kept.
 *
 * A 600s lease, matching the other org-walking sweeps: a second copy starting
 * underneath the first would send every reminder twice, and a reminder is an
 * email to a customer.
 */
@Public()
@Controller("cron")
export class CronSignController {
  constructor(
    private readonly sweeps: SignEnvelopeSweepsService,
    private readonly lease: CronLeaseService,
  ) {}

  @Get("sign-reminder-sweep")
  reminderGet(@Headers("authorization") authorization?: string) {
    return this.run("reminder", authorization);
  }

  @Post("sign-reminder-sweep")
  @HttpCode(200)
  reminderPost(@Headers("authorization") authorization?: string) {
    return this.run("reminder", authorization);
  }

  @Get("sign-expiration-sweep")
  expirationGet(@Headers("authorization") authorization?: string) {
    return this.run("expiration", authorization);
  }

  @Post("sign-expiration-sweep")
  @HttpCode(200)
  expirationPost(@Headers("authorization") authorization?: string) {
    return this.run("expiration", authorization);
  }

  private async run(sweep: "reminder" | "expiration", authorization?: string) {
    assertCronSecret(authorization);

    const jobKey = `sign-${sweep}-sweep`;
    const outcome = await this.lease.withLease(jobKey, 600, () =>
      this.sweeps.runSweepAllOrgs(sweep),
    );
    if (!outcome.ran) {
      return { success: true, skipped: true, message: `${jobKey} already running` };
    }

    const result = outcome.result;
    return {
      success: true,
      message:
        `Sign ${sweep} sweep: ${result.succeeded}/${result.organizations} orgs, ` +
        `${result.affected} affected` +
        (result.failed > 0 ? `, ${result.failed} org(s) failed` : ""),
      ...result,
    };
  }
}
