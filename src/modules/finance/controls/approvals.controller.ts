import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import {
  listApprovalsSchema,
  approvalDecisionSchema,
  type ListApprovalsQuery,
  type ApprovalDecisionInput,
} from "./dto/finance-controls.schemas";

@RequireModule("accounting")
@Controller("accounting/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  @RequirePermission("accounting:approvals:read")
  list(
    @Query(new ZodValidationPipe(listApprovalsSchema)) query: ListApprovalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get("counts")
  @RequirePermission("accounting:approvals:read")
  counts(@CurrentUser() u: CurrentUserContext) {
    return this.svc.counts(u.orgId);
  }

  @Post(":requestId/approve")
  @HttpCode(200)
  @RequirePermission("accounting:approvals:decide")
  approve(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(approvalDecisionSchema)) body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.approve(u.orgId, u.userId, requestId, body);
  }

  @Post(":requestId/reject")
  @HttpCode(200)
  @RequirePermission("accounting:approvals:decide")
  reject(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body(new ZodValidationPipe(approvalDecisionSchema)) body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reject(u.orgId, u.userId, requestId, body);
  }
}
