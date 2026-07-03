import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { WorkspaceOnboardingService } from "./workspace-onboarding.service";
import { generateSchema, type GenerateInput } from "./dto/workspace-onboarding.schemas";

@Controller("workspace-onboarding")
@UseGuards(JwtAuthGuard)
export class WorkspaceOnboardingController {
  constructor(private readonly service: WorkspaceOnboardingService) {}

  @Post("generate")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  generateWorkspace(
    @Body(new ZodValidationPipe(generateSchema)) body: GenerateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.generateWorkspace(u.orgId, body.industry, body.enabledModules);
  }

  @Post("complete")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  completeOnboarding(@CurrentUser() u: CurrentUserContext) {
    return this.service.completeOnboarding(u.orgId);
  }
}
