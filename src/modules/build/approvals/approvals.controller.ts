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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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

const approvalIdParams = z.object({ projectId: z.coerce.number().int().positive(), approvalId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalsInboxController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get("inbox")
  @RequirePermission("build:approvals:view")
  getInbox(@CurrentUser() u: CurrentUserContext) {
    return this.svc.getInbox(u.orgId, u.userId);
  }
}

@RequireModule("build")
@Controller("build/:projectId/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  @RequirePermission("build:approvals:view")
  listApprovals(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(listApprovalsQuerySchema)) query: ListApprovalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listApprovals(u.orgId, projectId, query);
  }

  @Get(":approvalId")
  @RequirePermission("build:approvals:view")
  @Validate({ params: approvalIdParams })
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
  createApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createApprovalSchema)) body: CreateApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createApproval(u.orgId, u.userId, projectId, body);
  }

  @Patch(":approvalId/decide")
  @RequirePermission("build:approvals:decide")
  @Idempotent("build.approval.decide")
  @Validate({ params: approvalIdParams })
  decideApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body(new ZodValidationPipe(decideApprovalSchema)) body: DecideApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.decideApproval(u, projectId, approvalId, body);
  }

  @Patch(":approvalId")
  @RequirePermission("build:approvals:manage")
  @Validate({ params: approvalIdParams })
  updateApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body(new ZodValidationPipe(updateApprovalSchema)) body: UpdateApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateApproval(u.orgId, u.userId, projectId, approvalId, body);
  }

  @Delete(":approvalId")
  @RequirePermission("build:approvals:manage")
  @HttpCode(204)
  @Validate({ params: approvalIdParams })
  softDeleteApproval(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.softDeleteApproval(u.orgId, projectId, approvalId);
  }
}
