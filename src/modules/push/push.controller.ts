import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  vapidPublicKeyResponseSchema,
  pushSubscribeResponseSchema,
  pushUnsubscribeResponseSchema,
} from "./dto/push-response.schemas";
import { PushService } from "./push.service";
import {
  subscribeSchema,
  unsubscribeSchema,
  type SubscribeInput,
  type UnsubscribeInput,
} from "./dto/push.schemas";

@Controller("push")
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  @Public()
  @Get("vapid-public-key")
  @ResponseSchema(vapidPublicKeyResponseSchema)
  vapidPublicKey() {
    return this.push.getVapidPublicKey();
  }

  @Post("subscribe")
  @Universal()
  @ResponseSchema(pushSubscribeResponseSchema)
  @Validate({ body: subscribeSchema })
  subscribe(
    @Body() body: SubscribeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.push.subscribe(u.orgId, u.userId, body);
  }

  @Delete("subscribe")
  @Universal()
  @ResponseSchema(pushUnsubscribeResponseSchema)
  @Validate({ query: unsubscribeSchema })
  unsubscribe(
    @Query() query: UnsubscribeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.push.unsubscribe(query.endpoint, u.userId);
  }
}
