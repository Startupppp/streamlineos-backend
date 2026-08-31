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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ActionItemsService } from "./action-items.service";
import {
  createActionItemSchema,
  updateActionItemSchema,
  type CreateActionItemInput,
  type UpdateActionItemInput,
} from "./dto/meetings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const projectAndMeetingIdParams = z.object({ projectId: z.coerce.number().int().positive(), meetingId: z.coerce.number().int().positive() }).strict();
const projectMeetingAndItemIdParams = z.object({ projectId: z.coerce.number().int().positive(), meetingId: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/meetings/:meetingId/action-items")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ActionItemsController {
  constructor(private readonly svc: ActionItemsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("build:meetings:manage")
  @Validate({ params: projectAndMeetingIdParams, body: createActionItemSchema })
  createItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: CreateActionItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createItem(u.orgId, u.userId, projectId, meetingId, body);
  }

  @Patch(":itemId")
  @RequirePermission("build:meetings:manage")
  @Validate({ params: projectMeetingAndItemIdParams, body: updateActionItemSchema })
  updateItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: UpdateActionItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateItem(u.orgId, u.userId, projectId, meetingId, itemId, body);
  }

  @Delete(":itemId")
  @RequirePermission("build:meetings:manage")
  @HttpCode(204)
  @Validate({ params: projectMeetingAndItemIdParams })
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
  @RequirePermission("build:meetings:manage")
  @Validate({ params: projectMeetingAndItemIdParams })
  @BodylessAction()
  convertToTask(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.convertToTask(u.orgId, u.userId, projectId, meetingId, itemId);
  }
}
