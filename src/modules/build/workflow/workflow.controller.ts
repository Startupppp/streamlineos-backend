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
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  workflowTransitionSchema,
  projectStatusSchema,
} from "./dto/workflow-response.schemas";

export const transitionIdParams = z.object({ projectId: z.coerce.number().int().positive(), transitionId: z.coerce.number().int().positive() }).strict();
export const fromStatusIdParams = z.object({ projectId: z.coerce.number().int().positive(), fromStatusId: z.coerce.number().int().positive() }).strict();
export const statusIdParams = z.object({ projectId: z.coerce.number().int().positive(), statusId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/workflow")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  @Get("transitions")
  @RequirePermission("build:workflow:view")
  @ResponseSchema(z.array(workflowTransitionSchema))
  listTransitions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listTransitions(u, projectId);
  }

  @Post("transitions")
  @HttpCode(201)
  @RequirePermission("build:workflow:manage")
  @ResponseSchema(workflowTransitionSchema)
  @Validate({ body: createTransitionSchema })
  createTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createTransition(u, projectId, body);
  }

  @Patch("transitions/:transitionId")
  @RequirePermission("build:workflow:manage")
  @ResponseSchema(workflowTransitionSchema)
  @Validate({ params: transitionIdParams, body: updateTransitionSchema })
  updateTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @Body() body: UpdateTransitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateTransition(u, projectId, transitionId, body);
  }

  @Delete("transitions/:transitionId")
  @RequirePermission("build:workflow:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: transitionIdParams })
  deleteTransition(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("transitionId", ParseIntPipe) transitionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteTransition(u, projectId, transitionId);
  }

  @Get("allowed/:fromStatusId")
  @RequirePermission("build:workflow:view")
  @ResponseSchema(z.array(workflowTransitionSchema))
  @Validate({ params: fromStatusIdParams })
  getAllowedTransitions(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("fromStatusId", ParseIntPipe) fromStatusId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getAllowedTransitions(u, projectId, fromStatusId);
  }

  @Patch("statuses/:statusId/wip")
  @RequirePermission("build:workflow:manage")
  @ResponseSchema(projectStatusSchema)
  @Validate({ params: statusIdParams, body: wipLimitSchema })
  updateWipLimit(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("statusId", ParseIntPipe) statusId: number,
    @Body() body: WipLimitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateWipLimit(u, projectId, statusId, body);
  }
}
