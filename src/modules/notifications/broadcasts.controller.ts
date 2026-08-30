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
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { BroadcastsService } from "./broadcasts.service";
import {
  createBroadcastSchema,
  updateBroadcastSchema,
  listBroadcastsSchema,
  listBroadcastInboxSchema,
  type CreateBroadcastInput,
  type UpdateBroadcastInput,
  type ListBroadcastsInput,
  type ListBroadcastInboxInput,
} from "./dto/broadcast.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const broadcastIdParams = z.object({ broadcastId: z.coerce.number().int().positive() }).strict();

/**
 * C21-02: PermissionGuard is on the admin methods only, not the class.
 * /inbox and /:id/dismiss are universal — every authenticated member may
 * call them. PermissionGuard denies a route it covers that carries no
 * @RequirePermission, so it must not appear at the class level here.
 */
@Controller("broadcasts")
@UseGuards(JwtAuthGuard)
export class BroadcastsController {
  constructor(private readonly broadcastsService: BroadcastsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:view")
  @Validate({ query: listBroadcastsSchema })
  list(
    @Query() filters: ListBroadcastsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.list(u.orgId, filters);
  }

  /**
   * C21-02. Fan-out-on-read inbox: SENT broadcasts this member is in the
   * audience for and has not yet dismissed. No permission gate — every
   * active member reads their own inbox.
   */
  @Get("inbox")
  @Universal()
  @Validate({ query: listBroadcastInboxSchema })
  listInbox(
    @Query() query: ListBroadcastInboxInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.listInbox(u.orgId, u.userId, query.limit);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:manage")
  @Validate({ body: createBroadcastSchema })
  create(
    @Body() dto: CreateBroadcastInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.create(u.orgId, u.userId, dto);
  }

  @Patch(":broadcastId")
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:manage")
  @Validate({ params: broadcastIdParams, body: updateBroadcastSchema })
  update(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @Body() dto: UpdateBroadcastInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.update(u.orgId, broadcastId, u.userId, dto);
  }

  @Post(":broadcastId/publish")
  @Idempotent("notifications.broadcast.publish")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:manage")
  @Validate({ params: broadcastIdParams })
  publish(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.publish(u.orgId, u.userId, broadcastId);
  }

  /**
   * C21-02. Records the calling user's dismissal of a broadcast. Idempotent:
   * calling it a second time returns success without writing a duplicate row.
   * No permission gate — every authenticated member dismisses their own inbox.
   */
  @Post(":broadcastId/dismiss")
  @Universal()
  @HttpCode(200)
  @Validate({ params: broadcastIdParams })
  dismiss(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.dismiss(u.orgId, u.userId, broadcastId);
  }

  @Post(":broadcastId/cancel")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:manage")
  @Validate({ params: broadcastIdParams })
  cancel(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.cancel(u.orgId, broadcastId, u.userId);
  }

  /**
   * C21-02. How many members have dismissed (seen) this broadcast.
   * Admin-only: requires the same view permission as the broadcast list.
   */
  @Get(":broadcastId/receipts/count")
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:view")
  @Validate({ params: broadcastIdParams })
  viewerCount(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.viewerCount(u.orgId, broadcastId);
  }

  @Delete(":broadcastId")
  @UseGuards(PermissionGuard)
  @RequirePermission("notifications:broadcasts:manage")
  @Validate({ params: broadcastIdParams })
  remove(
    @Param("broadcastId", ParseIntPipe) broadcastId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.broadcastsService.remove(u.orgId, broadcastId, u.userId);
  }
}
