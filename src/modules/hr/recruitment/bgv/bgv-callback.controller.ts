import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Public } from "../../../../common/auth/public.decorator";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { BgvCallbackService } from "./bgv-callback.service";
import { BGV_STATUSES } from "./bgv-status";

const bgvCallbackResponseSchema = z.object({
  replay: z.boolean(),
  status: z.enum(BGV_STATUSES),
});

/**
 * Where a verification agency pushes its verdict.
 *
 * Public because an agency holds no session, and therefore rate-limited and
 * HMAC-verified over the raw bytes. `@BodylessAction()` keeps the global Zod
 * interceptor off the body: validating it would mean re-serialising before the
 * signature is checked, which verifies something the agency never sent. The
 * payload is parsed in the service, after the signature holds.
 *
 * This is the only path that can write an agency `CLEARED`. The recruiter-facing
 * route fixes `source` to MANUAL, so a clearance that an offer policy trusts
 * cannot be produced by anybody without the agency's signing secret.
 */
@Public()
@Controller("public/bgv-callback")
export class BgvCallbackController {
  constructor(private readonly callbacks: BgvCallbackService) {}

  @Post(":orgSlug")
  @BodylessAction()
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:bgv-callback")
  @ResponseSchema(bgvCallbackResponseSchema)
  receive(
    @Param("orgSlug") orgSlug: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-streamline-signature") signature: string | undefined,
  ) {
    return this.callbacks.receive(orgSlug, request.rawBody ?? "", signature);
  }
}
