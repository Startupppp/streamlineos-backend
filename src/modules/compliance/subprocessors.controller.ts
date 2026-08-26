import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { SubprocessorsService } from "./subprocessors.service";
import {
  listSubprocessorsQuerySchema,
  subscribeSchema,
  type ListSubprocessorsQuery,
  type SubscribeInput,
} from "./dto/subprocessor.schemas";

/**
 * The subprocessor register, publicly.
 *
 * Public on purpose. The people who read it are a prospect's counsel and a
 * customer's compliance officer, and requiring a login means the review that
 * decides whether we can be bought happens somewhere we cannot help with. There
 * is nothing here that is not already on a page we would hand them.
 */
@Controller("compliance/subprocessors")
export class SubprocessorsController {
  constructor(private readonly subprocessors: SubprocessorsService) {}

  @Get()
  @Public()
  @UseRateLimit("compliance:subprocessors")
  @Validate({ query: listSubprocessorsQuerySchema })
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
  async subscribe(@Body() body: SubscribeInput) {
    return this.subprocessors.subscribe(body.email);
  }

  @Post("unsubscribe")
  @Public()
  @UseRateLimit("compliance:subscribe")
  @Validate({ body: subscribeSchema })
  async unsubscribe(@Body() body: SubscribeInput) {
    return this.subprocessors.unsubscribe(body.email);
  }
}
