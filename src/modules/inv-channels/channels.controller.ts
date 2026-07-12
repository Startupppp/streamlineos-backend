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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
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

@RequireModule("inventory")
@Controller("inventory/channels")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ChannelsController {
  constructor(private readonly svc: ChannelsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.svc.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  create(
    @Body(new ZodValidationPipe(createChannelSchema)) body: CreateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":channelId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  update(
    @Param("channelId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateChannelSchema)) body: UpdateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }

  @Post(":channelId/sync-stock")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  syncStock(
    @Param("channelId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.syncStock(u.orgId, u.userId, id);
  }

  @Get(":channelId/publications")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  listPublications(
    @Param("channelId", ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(listPublicationsQuerySchema)) q: ListPublicationsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPublications(u.orgId, id, q);
  }

  @Post(":channelId/publications/retry")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:channels:manage")
  retryPublications(
    @Param("channelId", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(retryPublicationsSchema)) body: RetryPublicationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.retryPublications(u.orgId, u.userId, id, body);
  }
}
