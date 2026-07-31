import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { HrWebhooksService } from "./hr-webhooks.service";
import {
  createHrWebhookSchema,
  updateHrWebhookSchema,
  listDeliveriesSchema,
  type CreateHrWebhookInput,
  type UpdateHrWebhookInput,
  type ListDeliveriesInput,
} from "./dto/hr-webhook.schemas";

@RequireModule("hr")
@Controller("hr/webhooks")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrWebhooksController {
  constructor(private readonly webhooks: HrWebhooksService) {}

  @Get("events")
  @RequirePermission("hr:integrations:manage")
  getEvents() {
    return this.webhooks.getEvents();
  }

  @Get()
  @RequirePermission("hr:integrations:manage")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "50", 10) || 50));
    return this.webhooks.listSubscriptions(u.orgId, pageNum, limitNum);
  }

  @Get(":subscriptionId")
  @RequirePermission("hr:integrations:manage")
  getOne(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.getSubscription(u.orgId, subscriptionId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:integrations:manage")
  create(
    @Body(new ZodValidationPipe(createHrWebhookSchema)) body: CreateHrWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.createSubscription(u.orgId, u.userId, body);
  }

  @Patch(":subscriptionId")
  @RequirePermission("hr:integrations:manage")
  update(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @Body(new ZodValidationPipe(updateHrWebhookSchema)) body: UpdateHrWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.updateSubscription(u.orgId, subscriptionId, body);
  }

  @Delete(":subscriptionId")
  @HttpCode(204)
  @RequirePermission("hr:integrations:manage")
  async remove(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.webhooks.deleteSubscription(u.orgId, subscriptionId);
  }

  @Post(":subscriptionId/test")
  @HttpCode(200)
  @RequirePermission("hr:integrations:manage")
  test(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.testSubscription(u.orgId, subscriptionId);
  }

  @Get(":subscriptionId/deliveries")
  @RequirePermission("hr:integrations:manage")
  listDeliveries(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listDeliveriesSchema)) query: ListDeliveriesInput,
  ) {
    return this.webhooks.listDeliveries(u.orgId, subscriptionId, query);
  }

  @Post(":subscriptionId/deliveries/:deliveryId/redeliver")
  @HttpCode(200)
  @RequirePermission("hr:integrations:manage")
  redeliver(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @Param("deliveryId", ParseIntPipe) deliveryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.redeliver(u.orgId, subscriptionId, deliveryId);
  }
}
