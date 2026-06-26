import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../../common/rbac/ability.guard";
import { CheckAbility } from "../../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { EmailRoutesService } from "../email-routes.service";
import { resendInvitationSchema, type ResendInvitationInput } from "../dto/email.schemas";

@Controller("organization/invitations")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class OrganizationInvitationsController {
  constructor(private readonly routes: EmailRoutesService) {}

  @Post("resend")
  @HttpCode(200)
  @CheckAbility("manage", "settings")
  resend(
    @Body(new ZodValidationPipe(resendInvitationSchema)) body: ResendInvitationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.routes.resendInvitation(u.orgId, u.userId, body.invitationId);
  }
}
