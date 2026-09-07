import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { WorkspaceOnboardingService } from "./workspace-onboarding.service";
import { generateSchema, type GenerateInput } from "./dto/workspace-onboarding.schemas";
import {
  generateWorkspaceResponseSchema,
  completeOnboardingResponseSchema,
} from "../setup/dto/org-setup-response.schemas";

@Controller("workspace-onboarding")
@UseGuards(JwtAuthGuard)
export class WorkspaceOnboardingController {
  constructor(private readonly service: WorkspaceOnboardingService) {}

  @ResponseSchema(generateWorkspaceResponseSchema)
  @Post("generate")
  @HttpCode(200)
  @Idempotent("organization.workspaceOnboarding.generate")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ body: generateSchema })
  generateWorkspace(
    @Body() body: GenerateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.generateWorkspace(u.orgId, body.industry, body.enabledModules);
  }

  @ResponseSchema(completeOnboardingResponseSchema)
  @Post("complete")
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  completeOnboarding(@CurrentUser() u: CurrentUserContext) {
    return this.service.completeOnboarding(u.orgId);
  }
}
