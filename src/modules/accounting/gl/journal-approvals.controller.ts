import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JournalApprovalsService } from "./journal-approvals.service";
import { approvalDecisionSchema, type ApprovalDecisionInput } from "./dto/journal-approvals.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/journal")
@UseGuards(JwtAuthGuard)
export class JournalApprovalsController {
  constructor(private readonly approvals: JournalApprovalsService) {}

  @Post(":entryId/submit-approval")
  @BodylessAction()
  @Idempotent("accounting.journal.submit-approval")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:create")
  @HttpCode(200)
  @Validate({ params: entryIdParams })
  submitForApproval(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.submitForApproval(u.orgId, u.userId, entryId);
  }

  @Post(":entryId/approve")
  @Idempotent("accounting.journal.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:approve")
  @HttpCode(200)
  @Validate({ params: entryIdParams, body: approvalDecisionSchema })
  approveJournal(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.approveJournal(u.orgId, u.userId, entryId, body);
  }

  @Post(":entryId/reject")
  @Idempotent("accounting.journal.reject")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:approve")
  @HttpCode(200)
  @Validate({ params: entryIdParams, body: approvalDecisionSchema })
  rejectJournal(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: ApprovalDecisionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.rejectJournal(u.orgId, u.userId, entryId, body);
  }
}
