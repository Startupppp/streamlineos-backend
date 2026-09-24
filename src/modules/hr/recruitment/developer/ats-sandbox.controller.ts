import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { AtsSandboxService } from "./ats-sandbox.service";
import { directorySyncState } from "./directory-sync";
import {
  catalogueSchema,
  deliveryParams,
  directorySyncSchema,
  recentDeliveriesQuery,
  recentDeliveryListSchema,
  replayBodySchema,
  replayResultSchema,
  signatureViewSchema,
  subscriptionIdParams,
  type RecentDeliveriesQuery,
  type ReplayBodyInput,
} from "./ats-sandbox.schemas";

/**
 * The ATS developer sandbox: the five hiring events, a way to fire one, and the
 * signature a receiver should have seen.
 *
 * Gated on `hr:integrations:manage`, the same key that owns webhook
 * subscriptions — replaying an event sends a real HTTP request from this
 * deployment to a URL the tenant chose, so it is an integration-administration
 * act and not a recruiter's.
 */
@RequireModule("hr")
@Controller("hr/recruitment/developer")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AtsSandboxController {
  constructor(private readonly sandbox: AtsSandboxService) {}

  @Get("events")
  @ResponseSchema(catalogueSchema)
  @RequirePermission("hr:integrations:manage")
  catalogue() {
    return this.sandbox.catalogue();
  }

  /**
   * What enterprise sign-on and directory sync actually do here.
   *
   * A read rather than a doc page, because the honest answer is a product
   * state: an admin asking "do you support SSO" should get it from the same
   * place they would configure it, not from a marketing sentence elsewhere.
   */
  @Get("directory-sync")
  @ResponseSchema(directorySyncSchema)
  @RequirePermission("hr:integrations:manage")
  directorySync() {
    return directorySyncState();
  }

  @Get("deliveries")
  @ResponseSchema(recentDeliveryListSchema)
  @RequirePermission("hr:integrations:manage")
  @Validate({ query: recentDeliveriesQuery })
  recentDeliveries(@Query() query: RecentDeliveriesQuery, @CurrentUser() u: CurrentUserContext) {
    return this.sandbox.recentDeliveries(u.orgId, query.limit);
  }

  @Post("subscriptions/:subscriptionId/replay")
  @ResponseSchema(replayResultSchema)
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: subscriptionIdParams, body: replayBodySchema })
  replay(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @Body() body: ReplayBodyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sandbox.replay(u.orgId, u.userId, subscriptionId, body.event);
  }

  @Get("subscriptions/:subscriptionId/deliveries/:deliveryId/signature")
  @ResponseSchema(signatureViewSchema)
  @RequirePermission("hr:integrations:manage")
  @Validate({ params: deliveryParams })
  signature(
    @Param("subscriptionId", ParseIntPipe) subscriptionId: number,
    @Param("deliveryId", ParseIntPipe) deliveryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sandbox.signatureFor(u.orgId, subscriptionId, deliveryId);
  }
}
