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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { WorkflowService } from "./workflow.service";
import {
  createTransitionSchema,
  updateTransitionSchema,
  wipLimitSchema,
  type CreateTransitionInput,
  type UpdateTransitionInput,
  type WipLimitInput,
} from "./dto/workflow.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const transitionIdParams = z.object({ transitionId: z.coerce.number().int().positive() }).strict();
const fromStatusIdParams = z.object({ fromStatusId: z.coerce.number().int().positive() }).strict();
const statusIdParams = z.object({ statusId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ body: createTransitionSchema })
  createTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createTransition(u.orgId, u.userId, projectId, body);
  }

  @Patch("transitions/:transitionId")
  @RequirePermission("build:workflow:manage")
  @Validate({ params: transitionIdParams, body: updateTransitionSchema })
  updateTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @Body() body: UpdateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateTransition(u.orgId, u.userId, projectId, transitionId, body);
  }

  @Delete("transitions/:transitionId")
  @RequirePermission("build:workflow:manage")
  @HttpCode(204)
  @Validate({ params: transitionIdParams })
  deleteTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteTransition(u.orgId, u.userId, projectId, transitionId);
  }

  @Get("allowed/:fromStatusId")
  @RequirePermission("build:workflow:view")
  @Validate({ params: fromStatusIdParams })
  getAllowedTransitions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fromStatusId", ParseIntPipe) fromStatusId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getAllowedTransitions(u.orgId, projectId, fromStatusId);
  }

  @Patch("statuses/:statusId/wip")
  @RequirePermission("build:workflow:manage")
  @Validate({ params: statusIdParams, body: wipLimitSchema })
  updateWipLimit(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("statusId", ParseIntPipe) statusId: number,
    @Body() body: WipLimitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateWipLimit(u.orgId, u.userId, projectId, statusId, body);
  }
}
