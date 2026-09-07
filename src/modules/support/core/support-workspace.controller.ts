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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  supportQueueListSchema,
  supportQueueRowSchema,
  supportSavedViewListSchema,
  supportSavedViewRowSchema,
  supportTagListSchema,
  supportTagRowSchema,
  supportWatcherListSchema,
  successSchema,
} from "./dto/support-workspace-response.schemas";

const queueIdParams = z.object({ queueId: z.coerce.number().int().positive() }).strict();
const viewIdParams = z.object({ viewId: z.coerce.number().int().positive() }).strict();
const ticketIdParams = z.object({ supportTicketId: z.coerce.number().int().positive() }).strict();
const ticketAndTagIdParams = z.object({ supportTicketId: z.coerce.number().int().positive(), tagId: z.coerce.number().int().positive() }).strict();

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportWorkspaceController {
  constructor(private readonly workspace: SupportWorkspaceService) {}

  @Get("queues")
  @RequirePermission("support:tickets:view")
  @ResponseSchema(supportQueueListSchema)
  listQueues(@CurrentUser() u: CurrentUserContext) {
    return this.workspace.listQueues(u.orgId);
  }

  @Post("queues")
  @RequirePermission("support:queues:manage")
  @HttpCode(201)
  @Validate({ body: createQueueSchema })
  @ResponseSchema(supportQueueRowSchema)
  createQueue(
    @Body() body: CreateQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.createQueue(u.orgId, u.userId, body);
  }

  @Patch("queues/:queueId")
  @RequirePermission("support:queues:manage")
  @Validate({ params: queueIdParams, body: updateQueueSchema })
  @ResponseSchema(supportQueueRowSchema)
  updateQueue(
    @Param("queueId", ParseIntPipe) queueId: number,
    @Body() body: UpdateQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.updateQueue(u.orgId, queueId, body);
  }

  @Delete("queues/:queueId")
  @RequirePermission("support:queues:manage")
  @Validate({ params: queueIdParams })
  @ResponseSchema(successSchema)
  deleteQueue(@Param("queueId", ParseIntPipe) queueId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.deleteQueue(u.orgId, queueId);
  }

  @Get("views")
  @RequirePermission("support:tickets:view")
  @ResponseSchema(supportSavedViewListSchema)
  listSavedViews(@CurrentUser() u: CurrentUserContext) {
    return this.workspace.listSavedViews(u.orgId, u.userId, actingMembershipId(u.principal));
  }

  @Post("views")
  @RequirePermission("support:tickets:view")
  @HttpCode(201)
  @Validate({ body: createSavedViewSchema })
  @ResponseSchema(supportSavedViewRowSchema)
  createSavedView(
    @Body() body: CreateSavedViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.createSavedView(u.orgId, u.userId, actingMembershipId(u.principal), body);
  }

  @Patch("views/:viewId")
  @RequirePermission("support:tickets:view")
  @Validate({ params: viewIdParams, body: updateSavedViewSchema })
  @ResponseSchema(supportSavedViewRowSchema)
  updateSavedView(
    @Param("viewId", ParseIntPipe) viewId: number,
    @Body() body: UpdateSavedViewInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.updateSavedView(u.orgId, u.userId, actingMembershipId(u.principal), viewId, body);
  }

  @Delete("views/:viewId")
  @RequirePermission("support:tickets:view")
  @Validate({ params: viewIdParams })
  @ResponseSchema(successSchema)
  deleteSavedView(@Param("viewId", ParseIntPipe) viewId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.deleteSavedView(u.orgId, u.userId, actingMembershipId(u.principal), viewId);
  }

  @Get("tags")
  @RequirePermission("support:tickets:view")
  @ResponseSchema(supportTagListSchema)
  listTags(@CurrentUser() u: CurrentUserContext) {
    return this.workspace.listTags(u.orgId);
  }

  @Post("tags")
  @RequirePermission("support:tags:manage")
  @HttpCode(201)
  @Validate({ body: createTagSchema })
  @ResponseSchema(supportTagRowSchema)
  createTag(
    @Body() body: CreateTagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.createTag(u.orgId, body);
  }

  @Get(":supportTicketId/tags")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  @ResponseSchema(supportTagListSchema)
  listTicketTags(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.listTicketTags(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/tags/:tagId")
  @BodylessAction()
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: ticketAndTagIdParams })
  @ResponseSchema(successSchema)
  attachTag(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("tagId", ParseIntPipe) tagId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.attachTag(u.orgId, supportTicketId, tagId);
  }

  @Delete(":supportTicketId/tags/:tagId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: ticketAndTagIdParams })
  @ResponseSchema(successSchema)
  detachTag(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("tagId", ParseIntPipe) tagId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.detachTag(u.orgId, supportTicketId, tagId);
  }

  @Get(":supportTicketId/watchers")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  @ResponseSchema(supportWatcherListSchema)
  listWatchers(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workspace.listWatchers(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/follow")
  @BodylessAction()
  @RequirePermission("support:tickets:view")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  @ResponseSchema(successSchema)
  follow(@Param("supportTicketId", ParseIntPipe) supportTicketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.follow(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal));
  }

  @Delete(":supportTicketId/follow")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  @ResponseSchema(successSchema)
  unfollow(@Param("supportTicketId", ParseIntPipe) supportTicketId: number, @CurrentUser() u: CurrentUserContext) {
    return this.workspace.unfollow(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal));
  }
}
