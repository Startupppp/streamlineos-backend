import {
  Body,
  Controller,
  Delete,
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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ActionItemsService } from "./action-items.service";
import {
  createActionItemSchema,
  updateActionItemSchema,
  type CreateActionItemInput,
  type UpdateActionItemInput,
} from "./dto/meetings.schemas";

@RequireModule("projects")
@Controller("projects/:projectId/meetings/:meetingId/action-items")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ActionItemsController {
  constructor(private readonly svc: ActionItemsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:meetings:manage")
  createItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body(new ZodValidationPipe(createActionItemSchema)) body: CreateActionItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createItem(u.orgId, u.userId, projectId, meetingId, body);
  }

  @Patch(":itemId")
  @RequirePermission("projects:meetings:manage")
  updateItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(updateActionItemSchema)) body: UpdateActionItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateItem(u.orgId, u.userId, projectId, meetingId, itemId, body);
  }

  @Delete(":itemId")
  @RequirePermission("projects:meetings:manage")
  deleteItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteItem(u.orgId, u.userId, projectId, meetingId, itemId);
  }

  @Post(":itemId/convert-to-task")
  @HttpCode(201)
  @RequirePermission("projects:meetings:manage")
  convertToTask(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.convertToTask(u.orgId, u.userId, projectId, meetingId, itemId);
  }
}
