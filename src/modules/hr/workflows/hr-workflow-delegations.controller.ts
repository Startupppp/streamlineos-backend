import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrWorkflowDelegationsService } from "./hr-workflow-delegations.service";
import {
  CreateDelegationSchema,
  UpdateDelegationSchema,
  type CreateDelegationDto,
  type UpdateDelegationDto,
} from "./dto/workflow.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const delegationIdParams = z.object({ delegationId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/workflows/delegations")
export class HrWorkflowDelegationsController {
  constructor(private readonly delegationsService: HrWorkflowDelegationsService) {}

  @Get("mine")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  myDelegations(@CurrentUser() u: CurrentUserContext) {
    return this.delegationsService.myDelegations(u);
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
  @Validate({ body: CreateDelegationSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateDelegationDto,
  ) {
    return this.delegationsService.create(u, body);
  }

  @Patch(":delegationId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @Validate({ params: delegationIdParams, body: UpdateDelegationSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("delegationId", ParseIntPipe) delegationId: number,
    @Body() body: UpdateDelegationDto,
  ) {
    return this.delegationsService.update(u.orgId, u.userId, delegationId, body);
  }

  @Delete(":delegationId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @HttpCode(204)
  @Validate({ params: delegationIdParams })
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("delegationId", ParseIntPipe) delegationId: number,
  ) {
    return this.delegationsService.remove(u.orgId, u.userId, delegationId);
  }
}
