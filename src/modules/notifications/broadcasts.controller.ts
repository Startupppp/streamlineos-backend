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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BroadcastsService } from "./broadcasts.service";
import {
  createBroadcastSchema,
  updateBroadcastSchema,
  listBroadcastsSchema,
  type CreateBroadcastInput,
  type UpdateBroadcastInput,
  type ListBroadcastsInput,
} from "./dto/broadcast.schemas";

@Controller("broadcasts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BroadcastsController {
  constructor(private readonly broadcastsService: BroadcastsService) {}

  @Get()
  @RequirePermission("notifications:broadcasts:view")
  list(
    @Query(new ZodValidationPipe(listBroadcastsSchema)) filters: ListBroadcastsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("notifications:broadcasts:manage")
  create(
    @Body(new ZodValidationPipe(createBroadcastSchema)) dto: CreateBroadcastInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.create(u.orgId, u.userId, dto);
  }

  @Patch(":broadcastId")
  @RequirePermission("notifications:broadcasts:manage")
  update(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @Body(new ZodValidationPipe(updateBroadcastSchema)) dto: UpdateBroadcastInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.update(u.orgId, u.userId, broadcastId, dto);
  }

  @Post(":broadcastId/publish")
  @HttpCode(200)
  @RequirePermission("notifications:broadcasts:manage")
  publish(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.publish(u.orgId, u.userId, broadcastId);
  }

  @Post(":broadcastId/cancel")
  @HttpCode(200)
  @RequirePermission("notifications:broadcasts:manage")
  cancel(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.cancel(u.orgId, u.userId, broadcastId);
  }

  @Delete(":broadcastId")
  @RequirePermission("notifications:broadcasts:manage")
  remove(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.remove(u.orgId, u.userId, broadcastId);
  }
}
