import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Universal } from "../../common/auth/universal.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { ApprovalAuthorityService } from "./approval-authority.service";
import type { ApprovalRequestKind } from "./approval-authority.types";
import { approvalRouteKindParamsSchema, approvalRouteSchema } from "./dto/approval-route.schemas";

@Controller("me/approvers")
@UseGuards(JwtAuthGuard)
export class ApprovalAuthorityController {
  constructor(private readonly approvals: ApprovalAuthorityService) {}

  @Get(":kind")
  @Universal()
  @ResponseSchema(approvalRouteSchema)
  @Validate({ params: approvalRouteKindParamsSchema })
  myApprover(@Param("kind") kind: ApprovalRequestKind, @CurrentUser() user: CurrentUserContext) {
    return this.approvals.resolve(user.orgId, user.userId, kind);
  }
}
