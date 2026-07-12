import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { JournalApprovalsService } from "./journal-approvals.service";
import { approvalDecisionSchema, type ApprovalDecisionInput } from "./dto/journal-approvals.schemas";

@RequireModule("accounting")
@Controller("accounting/journal")
@UseGuards(JwtAuthGuard)
export class JournalApprovalsController {
  constructor(private readonly approvals: JournalApprovalsService) {}

  @Post(":entryId/submit-approval")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:create")
  @HttpCode(200)
  submitForApproval(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.submitForApproval(u.orgId, u.userId, entryId);
  }

  @Post(":entryId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:approve")
  @HttpCode(200)
  approveJournal(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(approvalDecisionSchema)) body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.approveJournal(u.orgId, u.userId, entryId, body);
  }

  @Post(":entryId/reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:approve")
  @HttpCode(200)
  rejectJournal(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(approvalDecisionSchema)) body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.rejectJournal(u.orgId, u.userId, entryId, body);
  }
}
