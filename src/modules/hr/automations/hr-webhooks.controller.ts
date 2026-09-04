import {
  Body,
  Header,
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
import { NO_COMPRESSION_HEADER } from "../../../common/http/compression.config";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { HrWebhooksService } from "./hr-webhooks.service";
import {
  createHrWebhookSchema,
  updateHrWebhookSchema,
  listDeliveriesSchema,
  listHrWebhooksSchema,
  type CreateHrWebhookInput,
  type UpdateHrWebhookInput,
  type ListDeliveriesInput,
  type ListHrWebhooksInput,
} from "./dto/hr-webhook.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const subscriptionIdParams = z.object({ subscriptionId: z.coerce.number().int().positive() }).strict();
const subscriptionIddeliveryIdParams = z.object({ subscriptionId: z.coerce.number().int().positive(), deliveryId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listHrWebhooksSchema })
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListHrWebhooksInput,
  ) {
    return this.webhooks.listSubscriptions(u.orgId, query.page, query.limit);
  }

  @Get(":subscriptionId")
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIdParams })
  getOne(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.getSubscription(u.orgId, subscriptionId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:integrations:manage")
  @Validate({ body: createHrWebhookSchema })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  create(
    @Body() body: CreateHrWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.createSubscription(u.orgId, u.userId, body);
  }

  @Patch(":subscriptionId")
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIdParams, body: updateHrWebhookSchema })
  update(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @Body() body: UpdateHrWebhookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.updateSubscription(u.orgId, subscriptionId, body);
  }

  @Delete(":subscriptionId")
  @HttpCode(204)
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIdParams })
  async remove(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.webhooks.deleteSubscription(u.orgId, subscriptionId);
  }

  @Post(":subscriptionId/test")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIdParams })
  test(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.testSubscription(u.orgId, subscriptionId);
  }

  @Get(":subscriptionId/deliveries")
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIdParams, query: listDeliveriesSchema })
  listDeliveries(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListDeliveriesInput,
  ) {
    return this.webhooks.listDeliveries(u.orgId, subscriptionId, query);
  }

  @Post(":subscriptionId/deliveries/:deliveryId/redeliver")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIddeliveryIdParams })
  redeliver(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @Param("deliveryId", ParseIntPipe) deliveryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.webhooks.redeliver(u.orgId, subscriptionId, deliveryId);
  }
}
