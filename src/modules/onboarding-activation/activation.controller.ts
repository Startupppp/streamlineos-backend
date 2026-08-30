import { Controller, Get, UseGuards } from "@nestjs/common";
import { Universal } from "../../common/auth/universal.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ActivationService, type ActivationReport } from "./activation.service";

/**
 * How far this workspace is from first value.
 *
 * Deliberately **not** permission-gated beyond being signed in. Every member of
 * the workspace can see how set up their own workspace is; the alternative is
 * that the person best placed to finish setting it up -- often not the owner --
 * is the one who cannot see what is left.
 *
 * It also exposes nothing a member could not already see by looking around: the
 * counts are of their own workspace's records, and the steps are prompts.
 */
@Controller("onboarding/activation")
@UseGuards(JwtAuthGuard)
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  /**
   * Onboarding progress for the caller's own workspace: platform core, and the
   * surface a member sees before they hold anything else.
   */
  @Universal()
  @Get()
  report(@CurrentUser() user: CurrentUserContext): Promise<ActivationReport> {
    return this.activation.report(user.orgId);
  }
}
