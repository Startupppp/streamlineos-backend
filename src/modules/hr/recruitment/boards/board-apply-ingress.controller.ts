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
import { BoardApplyIngressService } from "./board-apply-ingress.service";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";

export const boardApplyResponseSchema = z.object({
  platform: z.string(),
  /** True when this delivery was a retry of one already recorded. */
  replay: z.boolean(),
  duplicate: z.boolean(),
  resumeStored: z.boolean(),
  resumeReason: z.string().nullable(),
});

/**
 * The inbound door for applications made on a job board.
 *
 * Public by necessity — a board holds no session — and therefore rate-limited
 * and HMAC-verified. It is deliberately NOT under `/public/careers`: that path
 * is the careers site a human uses, and giving a machine callback its own route
 * keeps the rate-limit tier, the signature requirement and the audit action
 * separate from the human one.
 *
 * `@BodylessAction()` because the body is read raw: the signature covers the
 * exact bytes the board sent, and validating through the global Zod interceptor
 * would mean re-serialising before checking, which signs something the board
 * never wrote. The payload is parsed inside the service, after the signature
 * has been checked.
 */
@Public()
@Controller("public/board-apply")
export class BoardApplyIngressController {
  constructor(private readonly ingress: BoardApplyIngressService) {}

  @Post(":orgSlug/:platform")
  @BodylessAction()
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("public:board-apply")
  @ResponseSchema(boardApplyResponseSchema)
  async receive(
    @Param("orgSlug", new ZodValidationPipe(z.string().min(1).max(128))) orgSlug: string,
    @Param("platform", new ZodValidationPipe(z.string().min(1).max(64))) platform: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-streamline-signature") signature: string | undefined,
  ) {
    const result = await this.ingress.receive(
      orgSlug,
      platform,
      req.rawBody ?? Buffer.alloc(0),
      signature,
    );
    /**
     * The tracking token is deliberately not returned. A board is not the
     * candidate, and the token is the candidate's own link to their
     * application — handing it to a third party would make it a way to read
     * someone else's status page.
     */
    return {
      platform: result.platform,
      replay: result.replay,
      duplicate: result.duplicate,
      resumeStored: result.resumeStored,
      resumeReason: result.resumeReason,
    };
  }
}
