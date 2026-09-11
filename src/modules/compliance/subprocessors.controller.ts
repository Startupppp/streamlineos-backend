import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { SubprocessorsService } from "./subprocessors.service";
import {
  listSubprocessorsQuerySchema,
  subscribeSchema,
  type ListSubprocessorsQuery,
  type SubscribeInput,
} from "./dto/subprocessor.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  listSubprocessorsResponseSchema,
  subscribeResponseSchema,
  unsubscribeResponseSchema,
} from "./dto/compliance-response.schemas";

/**
 * The subprocessor register, publicly.
 *
 * Public on purpose. The people who read it are a prospect's counsel and a
 * customer's compliance officer, and requiring a login means the review that
 * decides whether we can be bought happens somewhere we cannot help with. There
 * is nothing here that is not already on a page we would hand them.
 */
@Controller("compliance/subprocessors")
/*
  The decorator alone is inert. All three routes here are @Public and declare
  a tier, but nothing mounted the guard that reads it, so three unauthenticated
  limits counted nothing. RateLimitModule is @Global and exports the guard, so
  no wiring is needed beyond this.
*/
@UseGuards(RateLimitGuard)
export class SubprocessorsController {
  constructor(private readonly subprocessors: SubprocessorsService) {}

  @Get()
  @Public()
  @UseRateLimit("compliance:subprocessors")
  @Validate({ query: listSubprocessorsQuerySchema })
  @ResponseSchema(listSubprocessorsResponseSchema)
  async list(@Query() query: ListSubprocessorsQuery) {
    return { data: await this.subprocessors.list({ includeRetired: query.includeRetired }) };
  }

  /**
   * Rate-limited because it is an unauthenticated write that takes an email
   * address, which is the shape of every mailing-list abuse there is.
   */
  @Post("subscribe")
  @Public()
  @UseRateLimit("compliance:subscribe")
  @Validate({ body: subscribeSchema })
  @ResponseSchema(subscribeResponseSchema)
  async subscribe(@Body() body: SubscribeInput) {
    return this.subprocessors.subscribe(body.email);
  }

  @Post("unsubscribe")
  @Public()
  @UseRateLimit("compliance:subscribe")
  @Validate({ body: subscribeSchema })
  @ResponseSchema(unsubscribeResponseSchema)
  async unsubscribe(@Body() body: SubscribeInput) {
    return this.subprocessors.unsubscribe(body.email);
  }
}
