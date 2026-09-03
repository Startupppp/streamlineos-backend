import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { assertCronSecret } from "./cron-secret";
import { CronLeaseService } from "./cron-lease.service";
import { CalendarReminderSweepService } from "../calendar/calendar-reminder-sweep.service";
import { CalendarProviderSyncSweepService } from "../calendar/calendar-provider-sync-sweep.service";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { calendarProviderSyncSweepResponseSchema } from "../calendar/dto/provider-sync.schemas";

/**
 * The calendar module's background sweeps, alongside `CronBillingController`,
 * `CronHrController` and the rest of the per-domain cron controllers.
 *
 * They were on `CronPlatformController` — the leftover bucket — which the second of them
 * pushed over the 500-line ceiling `check:file-sizes` enforces. Route paths are unchanged
 * (`@Controller("cron")` either way), so this is a move, not a new surface.
 */
@Public()
@Controller("cron")
export class CronCalendarController {
  constructor(
    private readonly calendarReminderSweep: CalendarReminderSweepService,
    private readonly calendarProviderSyncSweep: CalendarProviderSyncSweepService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("calendar-reminder-sweep")
  getCalendarReminderSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarReminderSweep(authorization);
  }

  @Post("calendar-reminder-sweep")
  @BodylessAction()
  @HttpCode(200)
  postCalendarReminderSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarReminderSweep(authorization);
  }

  @Get("calendar-provider-sync-sweep")
  @ResponseSchema(calendarProviderSyncSweepResponseSchema)
  getCalendarProviderSyncSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarProviderSyncSweep(authorization);
  }

  @Post("calendar-provider-sync-sweep")
  @ResponseSchema(calendarProviderSyncSweepResponseSchema)
  @BodylessAction()
  @HttpCode(200)
  postCalendarProviderSyncSweep(@Headers("authorization") authorization?: string) {
    return this.runCalendarProviderSyncSweep(authorization);
  }

  private async runCalendarReminderSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("calendar-reminder-sweep", 120, () =>
        this.calendarReminderSweep.run(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "calendar-reminder-sweep already running" };
      return { success: true, ...outcome.result };
    } catch (error) {
      logger.error("Calendar reminder sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  /**
   * The only production caller of `CalendarProviderSyncSweepService.run()`. Without it
   * `calendar_provider_sync_queue` has no drain, so a create/update/delete intent
   * committed alongside the event never reaches Google or Outlook. Rationale and the
   * reachability net: `calendar/calendar-provider-sync-drain-reachability.spec.ts`.
   */
  private async runCalendarProviderSyncSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("calendar-provider-sync-sweep", 120, () =>
        this.calendarProviderSyncSweep.run(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "calendar-provider-sync-sweep already running" };
      const result = outcome.result;
      const message =
        `Calendar provider sync: ${result.claimed} claimed, ${result.processed} processed, ` +
        `${result.retried} retried, ${result.failed} failed`;
      return { success: true, message, ...result };
    } catch (error) {
      logger.error("Calendar provider sync sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
