import { Body, Controller, Headers, HttpCode, Post, type RawBodyRequest, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { BlogInvalidationService } from "./blog-invalidation.service";
import { invalidationBodySchema, type InvalidationBody } from "./dto/blog.schemas";
import { blogInvalidationAckSchema } from "./dto/blog-response.schemas";

/**
 * Service-to-service entry for the standalone blog admin. No user session exists here; the caller
 * is authenticated by an HMAC over timestamp, event id and the exact raw body, checked before the
 * body is trusted. The event id is the idempotency key: a redelivery is acknowledged, not re-applied.
 */
@Public()
@Controller("blog/internal")
export class BlogInternalController {
  constructor(private readonly invalidation: BlogInvalidationService) {}

  @Post("invalidate")
  @HttpCode(200)
  @UseRateLimit("blog:invalidate")
  @Validate({ body: invalidationBodySchema })
  @ResponseSchema(blogInvalidationAckSchema)
  invalidate(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: InvalidationBody,
    @Headers("x-blog-event-id") eventId: string | undefined,
    @Headers("x-blog-timestamp") timestamp: string | undefined,
    @Headers("x-blog-signature") signature: string | undefined,
  ) {
    this.invalidation.verify({ eventId, timestamp, signature }, req.rawBody?.toString("utf8") ?? "");
    return this.invalidation.receive(eventId ?? "", body);
  }
}
