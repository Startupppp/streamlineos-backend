import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Public } from "../../../../common/auth/public.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { assertCronSecret } from "../../../cron/cron-secret";
import { ChannelSyncService } from "./channel-sync.service";
import {
  channelIdParamsSchema,
  confirmShipmentSchema,
  jobIdParamsSchema,
  listChannelFailuresSchema,
  pullOrdersSchema,
  type ConfirmShipmentInput,
  type ListChannelFailuresInput,
  type PullOrdersInput,
} from "./dto/channel-sync.schemas";
import {
  channelSyncDrainResponseSchema,
  enqueueOrderPullResponseSchema,
  enqueueShipConfirmResponseSchema,
  enqueueStockSyncResponseSchema,
  listChannelFailuresResponseSchema,
  retryChannelJobResponseSchema,
} from "./dto/channel-sync-response.schemas";

/**
 * INV-27 — the operator's surface over a channel integration.
 *
 * ## Three keys, not one
 *
 * Administering a marketplace connection is `inventory:channels:manage`, and
 * that is what queues a stock sync and what reads the dead-letter list. The
 * other two are deliberately different, on the same reasoning
 * `ChannelSnapshotController` gives for accepting a difference:
 *
 *  - **importing orders** creates `inv_sales_orders` rows, so it takes
 *    `inventory:sales-orders:create`. Whoever administers a channel connection
 *    is not automatically somebody who may raise orders in this organisation.
 *  - **confirming a shipment** tells a customer their parcel is on its way, so
 *    it takes `inventory:sales-orders:ship` — the key that already means "may
 *    declare that goods left".
 *
 * Retrying a dead letter takes the key of the thing it will do, and the honest
 * answer there is that a retry can be any of the five kinds — so it takes the
 * strongest of them, `inventory:sales-orders:create`, rather than letting the
 * channel key become a way around the other two.
 *
 * ## Why the enqueue routes are `@Idempotent`
 *
 * They are POSTs a person presses, and a retried request must not queue a second
 * push. The database's unique natural key already absorbs a duplicate — that is
 * what `alreadyQueued` reports — so this is the second fence rather than the
 * only one, and it is the one that answers the *same* response to a retry
 * instead of a differently-shaped one.
 */
@RequireModule("inventory")
@Controller("inventory/channels")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ChannelSyncController {
  constructor(private readonly sync: ChannelSyncService) {}

  /**
   * Declared before the `:channelId/...` routes so `sync` is never parsed as a
   * channel id. Nest matches in declaration order.
   */
  @Post("sync/failures/:jobId/retry")
  @BodylessAction()
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:create")
  @ResponseSchema(retryChannelJobResponseSchema)
  @Idempotent("inventory.channels.sync.retry")
  @Validate({ params: jobIdParamsSchema })
  retry(@Param("jobId", ParseIntPipe) jobId: number, @CurrentUser() u: CurrentUserContext) {
    return this.sync.retry(u.orgId, jobId);
  }

  @Post(":channelId/sync/stock")
  @BodylessAction()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @ResponseSchema(enqueueStockSyncResponseSchema)
  @Idempotent("inventory.channels.sync.stock")
  @Validate({ params: channelIdParamsSchema })
  syncStock(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sync.enqueueStockSync(u.orgId, u.userId, channelId);
  }

  @Post(":channelId/sync/orders")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:create")
  @ResponseSchema(enqueueOrderPullResponseSchema)
  @Idempotent("inventory.channels.sync.orders")
  @Validate({ params: channelIdParamsSchema, body: pullOrdersSchema })
  pullOrders(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: PullOrdersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sync.enqueueOrderPull(u.orgId, u.userId, channelId, body.since);
  }

  @Post(":channelId/sync/shipments")
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:sales-orders:ship")
  @ResponseSchema(enqueueShipConfirmResponseSchema)
  @Idempotent("inventory.channels.sync.ship")
  @Validate({ params: channelIdParamsSchema, body: confirmShipmentSchema })
  confirmShipment(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: ConfirmShipmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sync.enqueueShipConfirm(u.orgId, u.userId, channelId, body);
  }

  /**
   * The dead-letter list. INV-27's acceptance, as a route: every failed and
   * dead-lettered channel job for this channel, with the reason, the error code
   * and the attempt count, newest first.
   */
  @Get(":channelId/sync/failures")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @ResponseSchema(listChannelFailuresResponseSchema)
  @Validate({ params: channelIdParamsSchema, query: listChannelFailuresSchema })
  listFailures(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query() query: ListChannelFailuresInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sync.listFailures(u.orgId, channelId, query);
  }
}

/**
 * INV-27 — the scheduler entry point for the channel-sync drain.
 *
 * Beside the service rather than in `modules/cron/`, for the reason
 * `ChannelSnapshotCronController` gives: the route is part of this module's
 * contract, and putting it in the cron module would make `CronModule` import the
 * whole of inventory to reach one method. `assertCronSecret` is the gate — the
 * route is `@Public()` because the caller is a scheduler with no session, not
 * because it is unauthenticated.
 *
 * Both verbs, because platform schedulers differ on which they issue and a
 * worker that only answers POST is a worker that silently never runs.
 */
@Public()
@Controller("cron")
export class ChannelSyncCronController {
  constructor(private readonly sync: ChannelSyncService) {}

  @Get("inventory-channel-sync")
  @ResponseSchema(channelSyncDrainResponseSchema)
  runGet(@Headers("authorization") authorization?: string) {
    return this.run(authorization);
  }

  @Post("inventory-channel-sync")
  @ResponseSchema(channelSyncDrainResponseSchema)
  @BodylessAction()
  @HttpCode(HttpStatus.OK)
  runPost(@Headers("authorization") authorization?: string) {
    return this.run(authorization);
  }

  private run(authorization?: string) {
    assertCronSecret(authorization);
    return this.sync.drain();
  }
}
