import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { ProjectsSettingsIterationsService } from "./projects-settings-iterations.service";
import {
  iterationSettingsResponseSchema,
  updateIterationSettingsSchema,
  type UpdateIterationSettingsInput,
} from "../dto/iterations-settings.schemas";

const projectIdParams = z
  .object({ projectId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsSettingsIterationsController {
  constructor(private readonly service: ProjectsSettingsIterationsService) {}

  @Get(":projectId/settings/iterations")
  @RequirePermission("build:view")
  @ResponseSchema(iterationSettingsResponseSchema)
  @Validate({ params: projectIdParams })
  getSettings(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getSettings(u, projectId);
  }

  @Patch(":projectId/settings/iterations")
  @RequirePermission("build:update")
  @ResponseSchema(iterationSettingsResponseSchema)
  @Validate({ params: projectIdParams, body: updateIterationSettingsSchema })
  updateSettings(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: UpdateIterationSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateSettings(u, projectId, body);
  }
}
