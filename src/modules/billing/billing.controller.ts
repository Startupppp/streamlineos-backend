import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BillingService } from "./billing.service";
import {
  createOrderSchema,
  verifyPaymentSchema,
  type CreateOrderInput,
  type VerifyPaymentInput,
} from "./dto/billing.schemas";

@Controller("billing")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  getSubscription(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSubscription(u.orgId);
  }

  @Post("razorpay")
  @HttpCode(200)
  @CheckAbility("manage", "settings")
  createOrder(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createOrder(u.orgId, u.userId, body.plan);
  }

  @Patch("razorpay")
  @CheckAbility("manage", "settings")
  verifyPayment(
    @Body(new ZodValidationPipe(verifyPaymentSchema)) body: VerifyPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.verifyAndActivate(u.orgId, u.userId, body);
  }
}
