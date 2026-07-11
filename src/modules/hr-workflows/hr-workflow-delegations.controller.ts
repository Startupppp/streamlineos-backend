import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrWorkflowDelegationsService } from "./hr-workflow-delegations.service";
import {
  CreateDelegationSchema,
  UpdateDelegationSchema,
  type CreateDelegationDto,
  type UpdateDelegationDto,
} from "./dto/workflow.schemas";

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/workflows/delegations")
export class HrWorkflowDelegationsController {
  constructor(private readonly delegationsService: HrWorkflowDelegationsService) {}

  @Get("mine")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  myDelegations(@CurrentUser() u: CurrentUserContext) {
    return this.delegationsService.myDelegations(u.orgId, u.userId);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  orgDelegations(@CurrentUser() u: CurrentUserContext) {
    return this.delegationsService.orgDelegations(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(CreateDelegationSchema)) body: CreateDelegationDto,
  ) {
    return this.delegationsService.create(u.orgId, u.userId, body);
  }

  @Patch(":delegationId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("delegationId", ParseIntPipe) delegationId: number,
    @Body(new ZodValidationPipe(UpdateDelegationSchema)) body: UpdateDelegationDto,
  ) {
    return this.delegationsService.update(u.orgId, u.userId, delegationId, body);
  }

  @Delete(":delegationId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @HttpCode(204)
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("delegationId", ParseIntPipe) delegationId: number,
  ) {
    return this.delegationsService.remove(u.orgId, u.userId, delegationId);
  }
}
