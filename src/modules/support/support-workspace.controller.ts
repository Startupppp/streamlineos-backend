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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SupportWorkspaceService } from "./support-workspace.service";
import {
  createQueueSchema,
  createSavedViewSchema,
  createTagSchema,
  updateQueueSchema,
  updateSavedViewSchema,
  type CreateQueueInput,
  type CreateSavedViewInput,
  type CreateTagInput,
  type UpdateQueueInput,
  type UpdateSavedViewInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportWorkspaceController {
  constructor(private readonly workspace: SupportWorkspaceService) {}

  @Get("queues")
  @RequirePermission("support:tickets:view")
  listQueues(@CurrentUser() u: CurrentUserContext) {
    return this.workspace.listQueues(u.orgId);
  }

  @Post("queues")
  @RequirePermission("support:queues:manage")
  @HttpCode(201)
  createQueue(
    @Body(new ZodValidationPipe(createQueueSchema)) body: CreateQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.createQueue(u.orgId, u.userId, body);
  }

  @Patch("queues/:queueId")
  @RequirePermission("support:queues:manage")
  updateQueue(
    @Param("queueId", ParseIntPipe) queueId: number,
    @Body(new ZodValidationPipe(updateQueueSchema)) body: UpdateQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.updateQueue(u.orgId, queueId, body);
  }

  @Delete("queues/:queueId")
  @RequirePermission("support:queues:manage")
  deleteQueue(@Param("queueId", ParseIntPipe) queueId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.deleteQueue(u.orgId, queueId);
  }

  @Get("views")
  @RequirePermission("support:tickets:view")
  listSavedViews(@CurrentUser() u: CurrentUserContext) {
    return this.workspace.listSavedViews(u.orgId, u.userId);
  }

  @Post("views")
  @RequirePermission("support:tickets:view")
  @HttpCode(201)
  createSavedView(
    @Body(new ZodValidationPipe(createSavedViewSchema)) body: CreateSavedViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.createSavedView(u.orgId, u.userId, body);
  }

  @Patch("views/:viewId")
  @RequirePermission("support:tickets:view")
  updateSavedView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body(new ZodValidationPipe(updateSavedViewSchema)) body: UpdateSavedViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.updateSavedView(u.orgId, u.userId, viewId, body);
  }

  @Delete("views/:viewId")
  @RequirePermission("support:tickets:view")
  deleteSavedView(@Param("viewId", ParseIntPipe) viewId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.deleteSavedView(u.orgId, u.userId, viewId);
  }

  @Get("tags")
  @RequirePermission("support:tickets:view")
  listTags(@CurrentUser() u: CurrentUserContext) {
    return this.workspace.listTags(u.orgId);
  }

  @Post("tags")
  @RequirePermission("support:tags:manage")
  @HttpCode(201)
  createTag(
    @Body(new ZodValidationPipe(createTagSchema)) body: CreateTagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.createTag(u.orgId, body);
  }

  @Get(":supportTicketId/tags")
  @RequirePermission("support:tickets:view")
  listTicketTags(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.listTicketTags(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/tags/:tagId")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  attachTag(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("tagId", ParseIntPipe) tagId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.attachTag(u.orgId, supportTicketId, tagId);
  }

  @Delete(":supportTicketId/tags/:tagId")
  @RequirePermission("support:tickets:manage")
  detachTag(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("tagId", ParseIntPipe) tagId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.detachTag(u.orgId, supportTicketId, tagId);
  }

  @Get(":supportTicketId/watchers")
  @RequirePermission("support:tickets:view")
  listWatchers(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.listWatchers(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/follow")
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  follow(@Param("supportTicketId", ParseIntPipe) supportTicketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.follow(u.orgId, supportTicketId, u.userId);
  }

  @Delete(":supportTicketId/follow")
  @RequirePermission("support:tickets:view")
  unfollow(@Param("supportTicketId", ParseIntPipe) supportTicketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.unfollow(u.orgId, supportTicketId, u.userId);
  }
}
