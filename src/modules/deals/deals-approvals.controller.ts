import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DealsApprovalsService } from "./deals-approvals.service";
import {
  approvalsListSchema,
  createApprovalRuleSchema,
  type ApprovalsListInput,
  type CreateApprovalRuleInput,
} from "./dto/deals.schemas";

@Controller("deals")
@UseGuards(JwtAuthGuard)
export class DealsApprovalsController {
  constructor(private readonly approvals: DealsApprovalsService) {}

  @Get("approval-rules")
  listRules(@CurrentUser() u: CurrentUserContext) {
    return this.approvals.listRules(u.orgId);
  }

  @Post("approval-rules")
  @HttpCode(201)
  createRule(
    @Body(new ZodValidationPipe(createApprovalRuleSchema)) body: CreateApprovalRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const ability = defineAbilityFor(u);
    if (!ability.can("manage", "settings")) {
      throw new ForbiddenException("Only admins can create approval rules");
    }
    return this.approvals.createRule(u.orgId, body);
  }

  @Get("approvals")
  listApprovals(
    @Query(new ZodValidationPipe(approvalsListSchema)) query: ApprovalsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u.orgId, query);
  }
}
