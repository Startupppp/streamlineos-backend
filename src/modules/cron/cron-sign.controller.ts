import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { SignEnvelopeSweepsService } from "../e-sign/sign-envelope-sweeps.service";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";
import { signSweepTickResponseSchema } from "./dto/cron-sign-response.schemas";
import { signSweepTickQuerySchema, type SignSweepTickQuery } from "./dto/cron-sign.schemas";
import { Validate } from "../../common/validation/validate.decorator";

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
  @ResponseSchema(signSweepTickResponseSchema)
  @Validate({ query: signSweepTickQuerySchema })
  reminderGet(@Query() query: SignSweepTickQuery, @Headers("authorization") authorization?: string) {
    return this.run("reminder", authorization, query.dryRun);
  }

  @Post("sign-reminder-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(signSweepTickResponseSchema)
  @Validate({ query: signSweepTickQuerySchema })
  reminderPost(@Query() query: SignSweepTickQuery, @Headers("authorization") authorization?: string) {
    return this.run("reminder", authorization, query.dryRun);
  }

  @Get("sign-expiration-sweep")
  @ResponseSchema(signSweepTickResponseSchema)
  @Validate({ query: signSweepTickQuerySchema })
  expirationGet(@Query() query: SignSweepTickQuery, @Headers("authorization") authorization?: string) {
    return this.run("expiration", authorization, query.dryRun);
  }

  @Post("sign-expiration-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(signSweepTickResponseSchema)
  @Validate({ query: signSweepTickQuerySchema })
  expirationPost(@Query() query: SignSweepTickQuery, @Headers("authorization") authorization?: string) {
    return this.run("expiration", authorization, query.dryRun);
  }

  /**
   * `?dryRun=true` reports what the sweep would do and touches nothing — the
   * rehearsal a staging environment needs before a scheduler is pointed at real
   * signers' inboxes.
   *
   * Only the exact string `true` enables it. Anything else is a live run,
   * because the failure that matters is a dry run that silently was not one,
   * and `Boolean("false")` is how that happens.
   */
  private async run(
    sweep: "reminder" | "expiration",
    authorization?: string,
    dryRun?: string,
  ) {
    assertCronSecret(authorization);

    const isDryRun = dryRun === "true";
    const jobKey = `sign-${sweep}-sweep`;
    /**
     * A dry run still takes the lease. It reads the same rows the live sweep
     * would and there is no value in two of them racing, but more to the point
     * a rehearsal that behaves differently from the thing it rehearses is not
     * a rehearsal.
     */
    const outcome = await this.lease.withLease(jobKey, 600, () =>
      this.sweeps.runSweepAllOrgs(sweep, { dryRun: isDryRun }),
    );
    if (!outcome.ran) {
      return { success: true, skipped: true, message: `${jobKey} already running` };
    }

    const result = outcome.result;
    return {
      success: true,
      message:
        `Sign ${sweep} sweep${result.dryRun ? " (dry run, nothing sent)" : ""}: ` +
        `${result.succeeded}/${result.organizations} orgs, ` +
        `${result.affected} ${result.dryRun ? "would be affected" : "affected"}` +
        (result.failed > 0 ? `, ${result.failed} org(s) failed` : ""),
      ...result,
    };
  }
}
