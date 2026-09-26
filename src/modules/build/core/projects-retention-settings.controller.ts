import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ParseResourceIdPipe } from "../../../common/pipes/parse-resource-id.pipe";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ProjectsRetentionSettingsService } from "./projects-retention-settings.service";
import {
  projectRetentionSettingsResponseSchema,
  updateRetentionPolicySchema,
  setLegalHoldSchema,
  type UpdateRetentionPolicyInput,
  type SetLegalHoldInput,
} from "./dto/project-retention-settings.schemas";
import { projectIdParams } from "./dto/build-params.schemas";

@RequireModule("build")
@Controller("build/:projectId/settings/retention")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsRetentionSettingsController {
  constructor(
    private readonly retentionSettings: ProjectsRetentionSettingsService,
  ) {}

  @Get()
  @RequirePermission("build:view")
  @ResponseSchema(projectRetentionSettingsResponseSchema)
  @Validate({ params: projectIdParams })
  getSettings(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.retentionSettings.getSettings(u, projectId);
  }

  @Patch()
  @RequirePermission("build:update")
  @ResponseSchema(projectRetentionSettingsResponseSchema)
  @Validate({ params: projectIdParams, body: updateRetentionPolicySchema })
  updatePolicy(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @Body() body: UpdateRetentionPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.retentionSettings.updatePolicy(u, projectId, body);
  }

  @Patch("legal-hold")
  @RequirePermission("build:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdParams, body: setLegalHoldSchema })
  setLegalHold(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @Body() body: SetLegalHoldInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.retentionSettings.setLegalHold(u, projectId, body);
  }
}
