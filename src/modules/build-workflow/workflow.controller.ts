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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { WorkflowService } from "./workflow.service";
import {
  createTransitionSchema,
  updateTransitionSchema,
  wipLimitSchema,
  type CreateTransitionInput,
  type UpdateTransitionInput,
  type WipLimitInput,
} from "./dto/workflow.schemas";

@RequireModule("build")
@Controller("build/:projectId/workflow")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  @Get("transitions")
  @RequirePermission("build:workflow:view")
  listTransitions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listTransitions(u.orgId, projectId);
  }

  @Post("transitions")
  @HttpCode(201)
  @RequirePermission("build:workflow:manage")
  createTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createTransitionSchema)) body: CreateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createTransition(u.orgId, u.userId, projectId, body);
  }

  @Patch("transitions/:transitionId")
  @RequirePermission("build:workflow:manage")
  updateTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @Body(new ZodValidationPipe(updateTransitionSchema)) body: UpdateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateTransition(u.orgId, u.userId, projectId, transitionId, body);
  }

  @Delete("transitions/:transitionId")
  @RequirePermission("build:workflow:manage")
  @HttpCode(204)
  deleteTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteTransition(u.orgId, u.userId, projectId, transitionId);
  }

  @Get("allowed/:fromStatusId")
  @RequirePermission("build:workflow:view")
  getAllowedTransitions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fromStatusId", ParseIntPipe) fromStatusId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getAllowedTransitions(u.orgId, projectId, fromStatusId);
  }

  @Patch("statuses/:statusId/wip")
  @RequirePermission("build:workflow:manage")
  updateWipLimit(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("statusId", ParseIntPipe) statusId: number,
    @Body(new ZodValidationPipe(wipLimitSchema)) body: WipLimitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateWipLimit(u.orgId, u.userId, projectId, statusId, body);
  }
}
