import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { IdempotencyKey } from "../../../../common/idempotency/idempotency-key.decorator";
import { ChannelPoolService } from "../../stock-engine/channel-pool.service";
import {
  allocateChannelPoolSchema,
  channelPoolAvailabilityQuerySchema,
  variantChannelPoolsQuerySchema,
} from "./dto/channel-pools.schemas";
import type {
  AllocateChannelPoolInput,
  ChannelPoolAvailabilityQuery,
  VariantChannelPoolsQuery,
} from "./dto/channel-pools.schemas";

/**
 * NEO-1 — the channel-pool surface.
 *
 * Reads are on `inventory:stock:read` rather than `inventory:channels:manage`:
 * "why does this SKU show 10 on hand and 4 available" is a stock question, and a
 * warehouse supervisor who cannot administer marketplace connections still has
 * to be able to answer it. Writing a claim is channel administration and keeps
 * the channel key.
 */
@RequireModule("inventory")
@Controller("inventory/channels/pools")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ChannelPoolsController {
  constructor(private readonly svc: ChannelPoolService) {}

  @Get("availability")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  availability(
    @Query(new ZodValidationPipe(channelPoolAvailabilityQuerySchema)) q: ChannelPoolAvailabilityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.availabilityFor(u.orgId, {
      productVariantId: q.productVariantId,
      warehouseId: q.warehouseId ?? null,
      forChannelId: q.forChannelId ?? null,
    });
  }

  @Get("by-variant")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  byVariant(
    @Query(new ZodValidationPipe(variantChannelPoolsQuerySchema)) q: VariantChannelPoolsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listForVariant(u.orgId, q.productVariantId, q.warehouseId ?? null);
  }

  @Get("channel/:channelId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  listForChannel(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listForChannel(u.orgId, u.userId, channelId);
  }

  @Post("allocate")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  allocate(
    @Body(new ZodValidationPipe(allocateChannelPoolSchema)) body: AllocateChannelPoolInput,
    // A3's decorator, not a hand-rolled header read: a command that can move a
    // claim needs a key, and a retry must not be able to claim the units twice.
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.allocate(u.orgId, u.userId, {
      channelId: body.channelId,
      productVariantId: body.productVariantId,
      warehouseId: body.warehouseId ?? null,
      deltaQty: body.deltaQty,
      idempotencyKey,
    });
  }
}
