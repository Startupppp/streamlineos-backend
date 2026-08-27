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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  vapidPublicKey() {
    return this.push.getVapidPublicKey();
  }

  @Post("subscribe")
  @Universal()
  subscribe(
    @Body(new ZodValidationPipe(subscribeSchema)) body: SubscribeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.push.subscribe(u.orgId, u.userId, body);
  }

  @Delete("subscribe")
  @Universal()
  unsubscribe(
    @Query(new ZodValidationPipe(unsubscribeSchema)) query: UnsubscribeInput,
  ) {
    return this.push.unsubscribe(query.endpoint);
  }
}
