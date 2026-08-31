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
import { CronInvitationExpiryService } from "./cron-invitation-expiry.service";
import { CronLeaseService } from "./cron-lease.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronInvitationExpiryController {
  constructor(
    private readonly invitationExpiry: CronInvitationExpiryService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("invitation-expiry-sweep")
  getInvitationExpirySweep(@Headers("authorization") authorization?: string) {
    return this.runSweep(authorization);
  }

  @Post("invitation-expiry-sweep")
  @BodylessAction()
  @HttpCode(200)
  postInvitationExpirySweep(@Headers("authorization") authorization?: string) {
    return this.runSweep(authorization);
  }

  private async runSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("invitation-expiry-sweep", 300, () =>
        this.invitationExpiry.sweepExpiredInvitations(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "invitation-expiry-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Expired ${result.expired} invitations`,
        ...result,
      };
    } catch (error) {
      logger.error("Invitation expiry sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
