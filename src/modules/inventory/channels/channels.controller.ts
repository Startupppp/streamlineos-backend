import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ChannelsService } from "./channels.service";
import {
  createChannelSchema,
  updateChannelSchema,
  listPublicationsQuerySchema,
  retryPublicationsSchema,
} from "./dto/channels.schemas";
import type {
  CreateChannelInput,
  UpdateChannelInput,
  ListPublicationsQueryInput,
  RetryPublicationsInput,
} from "./dto/channels.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  listChannelsResponseSchema,
  invChannelSchema,
  syncStockResponseSchema,
  listPublicationsResponseSchema,
  retryPublicationsResponseSchema,
} from "./dto/channels-response.schemas";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/channels")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ChannelsController {
  constructor(private readonly svc: ChannelsService) {}

  @Get()
  @ResponseSchema(listChannelsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.list(u.orgId);
  }

  @Post()
  @ResponseSchema(invChannelSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @Idempotent("inventory.channel.create")
  @Validate({ body: createChannelSchema })
  create(
    @Body() body: CreateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":channelId")
  @ResponseSchema(invChannelSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @Validate({ params: channelIdParams, body: updateChannelSchema })
  update(
    @Param("channelId", ParseIntPipe) id: number,
    @Body() body: UpdateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }

  @Post(":channelId/sync-stock")
  @BodylessAction()
  @ResponseSchema(syncStockResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @Validate({ params: channelIdParams })
  syncStock(
    @Param("channelId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.syncStock(u.orgId, u.userId, id);
  }

  @Get(":channelId/publications")
  @ResponseSchema(listPublicationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @Validate({ params: channelIdParams, query: listPublicationsQuerySchema })
  listPublications(
    @Param("channelId", ParseIntPipe) id: number,
    @Query() q: ListPublicationsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPublications(u.orgId, id, q);
  }

  @Post(":channelId/publications/retry")
  @ResponseSchema(retryPublicationsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  @Validate({ params: channelIdParams, body: retryPublicationsSchema })
  retryPublications(
    @Param("channelId", ParseIntPipe) id: number,
    @Body() body: RetryPublicationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.retryPublications(u.orgId, u.userId, id, body);
  }
}
