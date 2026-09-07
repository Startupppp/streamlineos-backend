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
import { ApprovalsService } from "./approvals.service";
import {
  listApprovalsSchema,
  approvalDecisionSchema,
  type ListApprovalsQuery,
  type ApprovalDecisionInput,
} from "./dto/finance-controls.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  approvalListResponseSchema,
  approvalCountsResponseSchema,
  approvalDecisionResponseSchema,
} from "./dto/controls-response.schemas";

const requestIdParams = z.object({ requestId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FinanceApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  @ResponseSchema(approvalListResponseSchema)
  @RequirePermission("accounting:approvals:read")
  @Validate({ query: listApprovalsSchema })
  list(
    @Query() query: ListApprovalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Get("counts")
  @ResponseSchema(approvalCountsResponseSchema)
  @RequirePermission("accounting:approvals:read")
  counts(@CurrentUser() u: CurrentUserContext) {
    return this.svc.counts(u.orgId);
  }

  @Post(":requestId/approve")
  @ResponseSchema(approvalDecisionResponseSchema)
  @HttpCode(200)
  @RequirePermission("accounting:approvals:decide")
  @Validate({ params: requestIdParams, body: approvalDecisionSchema })
  approve(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.approve(u.orgId, u.userId, requestId, body);
  }

  @Post(":requestId/reject")
  @ResponseSchema(approvalDecisionResponseSchema)
  @HttpCode(200)
  @RequirePermission("accounting:approvals:decide")
  @Validate({ params: requestIdParams, body: approvalDecisionSchema })
  reject(
    @Param("requestId", ParseIntPipe) requestId: number,
    @Body() body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.reject(u.orgId, u.userId, requestId, body);
  }
}
