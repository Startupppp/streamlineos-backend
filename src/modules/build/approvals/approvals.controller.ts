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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { ApprovalsService } from "./approvals.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import {
  createApprovalSchema,
  decideApprovalSchema,
  listApprovalsQuerySchema,
  updateApprovalSchema,
  type CreateApprovalInput,
  type DecideApprovalInput,
  type ListApprovalsQuery,
  type UpdateApprovalInput,
} from "./dto/approvals.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectAndApprovalIdParams = z.object({ projectId: z.coerce.number().int().positive(), approvalId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalsInboxController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get("inbox")
  @RequirePermission("build:approvals:view")
  getInbox(@CurrentUser() u: CurrentUserContext) {
    const mid = actingMembershipId(u.principal);
    if (mid === null) return Promise.resolve([]);
    return this.svc.getInbox(u.orgId, mid);
  }
}

@RequireModule("build")
@Controller("build/:projectId/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BuildApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  @RequirePermission("build:approvals:view")
  @Validate({ params: projectIdParams, query: listApprovalsQuerySchema })
  listApprovals(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListApprovalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listApprovals(u.orgId, projectId, query);
  }

  @Get(":approvalId")
  @RequirePermission("build:approvals:view")
  @Validate({ params: projectAndApprovalIdParams })
  getApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getApproval(u.orgId, projectId, approvalId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:approvals:request")
  @Idempotent("build.approval.create")
  @Validate({ params: projectIdParams, body: createApprovalSchema })
  createApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createApproval(u.orgId, u.userId, projectId, body);
  }

  @Patch(":approvalId/decide")
  @RequirePermission("build:approvals:decide")
  @Idempotent("build.approval.decide")
  @Validate({ params: projectAndApprovalIdParams, body: decideApprovalSchema })
  decideApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body() body: DecideApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.decideApproval(u, projectId, approvalId, body);
  }

  @Patch(":approvalId")
  @RequirePermission("build:approvals:manage")
  @Validate({ params: projectAndApprovalIdParams, body: updateApprovalSchema })
  updateApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body() body: UpdateApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateApproval(u.orgId, u.userId, projectId, approvalId, body);
  }

  @Delete(":approvalId")
  @RequirePermission("build:approvals:manage")
  @HttpCode(204)
  @Validate({ params: projectAndApprovalIdParams })
  softDeleteApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteApproval(u.orgId, projectId, approvalId);
  }
}
