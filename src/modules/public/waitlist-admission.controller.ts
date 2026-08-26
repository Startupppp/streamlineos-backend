import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { PlatformOperatorGuard } from "./platform-operator.guard";
import { WaitlistAdmissionService } from "./waitlist-admission.service";
import {
  waitlistAdmitSchema,
  waitlistClaimSchema,
  type WaitlistAdmitInput,
  type WaitlistClaimInput,
} from "./dto/public.schemas";

/**
 * The two ends of admission, which have opposite authorisation and therefore
 * live on one controller where that contrast is visible.
 *
 * Admitting is the most privileged thing in the product -- it creates
 * organisations for strangers -- and is restricted to platform operators.
 * Claiming is unauthenticated by necessity, because the person has no account
 * yet, and is defended by the token instead.
 */
@Controller("waitlist")
export class WaitlistAdmissionController {
  constructor(private readonly admission: WaitlistAdmissionService) {}

  @Get("entries")
  @UseGuards(JwtAuthGuard, PlatformOperatorGuard)
  list(@Query("status") status?: string) {
    return this.admission.list(status);
  }

  @Post("admit")
  @UseGuards(JwtAuthGuard, PlatformOperatorGuard)
  async admit(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(waitlistAdmitSchema)) body: WaitlistAdmitInput,
  ) {
    const result = await this.admission.admit(body.entryId, user.userId);

    /**
     * The raw token is returned to the operator, once.
     *
     * There is no email template for admission yet, and inventing one that
     * silently fails to send would be worse than handing the link to the person
     * doing the admitting -- they can see it went out. When a template exists
     * this becomes the send and stops returning the token.
     */
    return {
      reference: result.reference,
      email: result.email,
      expiresAt: result.expiresAt,
      claimPath: `/waitlist/claim/${result.token}`,
    };
  }

  @Post("claim")
  @Public()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:waitlist-claim")
  claim(@Body(new ZodValidationPipe(waitlistClaimSchema)) body: WaitlistClaimInput) {
    return this.admission.claim(body);
  }
}
