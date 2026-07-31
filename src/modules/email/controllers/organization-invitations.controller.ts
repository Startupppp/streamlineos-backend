import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { InvitationsService } from "../../organization/core/invitations.service";
import { resendInvitationSchema, type ResendInvitationInput } from "../dto/email.schemas";

@Controller("organization/invitations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrganizationInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post("resend")
  @HttpCode(200)
  @RequirePermission("settings:manage")
  resend(
    @Body(new ZodValidationPipe(resendInvitationSchema)) body: ResendInvitationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitations.resend(u.orgId, body.invitationId, u.userId);
  }
}
