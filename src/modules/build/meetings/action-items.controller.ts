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
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { actionItemRowSchema, convertToTaskResultSchema } from "./dto/meetings-response.schemas";

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
  @ResponseSchema(actionItemRowSchema)
  @Validate({ params: projectAndMeetingIdParams, body: createActionItemSchema })
  createItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Body() body: CreateActionItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createItem(u, projectId, meetingId, body);
  }

  @Patch(":itemId")
  @RequirePermission("build:meetings:manage")
  @ResponseSchema(actionItemRowSchema)
  @Validate({ params: projectMeetingAndItemIdParams, body: updateActionItemSchema })
  updateItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: UpdateActionItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateItem(u, projectId, meetingId, itemId, body);
  }

  @Delete(":itemId")
  @RequirePermission("build:meetings:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectMeetingAndItemIdParams })
  deleteItem(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteItem(u, projectId, meetingId, itemId);
  }

  @Post(":itemId/convert-to-task")
  @BodylessAction()
  @HttpCode(201)
  @RequirePermission("build:meetings:manage")
  @ResponseSchema(convertToTaskResultSchema)
  @Validate({ params: projectMeetingAndItemIdParams })
  convertToTask(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("meetingId", ParseIntPipe) meetingId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.convertToTask(u, projectId, meetingId, itemId);
  }
}
