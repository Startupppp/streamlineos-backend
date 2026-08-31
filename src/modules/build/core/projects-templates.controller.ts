import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsTemplatesService } from "./projects-templates.service";
import {
  applyTemplateSchema,
  createTemplateSchema,
  type ApplyTemplateInput,
  type CreateTemplateInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTemplatesController {
  constructor(private readonly templates: ProjectsTemplatesService) {}

  @Get("templates")
  @RequirePermission("build:view")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.templates.listTemplates(u.orgId);
  }

  @Post("templates")
  @HttpCode(201)
  @RequirePermission("build:manage")
  @Validate({ body: createTemplateSchema })
  createTemplate(
    @Body() body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.createTemplate(u.orgId, u.userId, body);
  }

  @Delete("templates/:templateId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: templateIdParams })
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.deleteTemplate(u.orgId, templateId);
  }

  @Post("templates/:templateId/apply")
  @HttpCode(201)
  @RequirePermission("build:manage")
  @Idempotent("build.template.apply")
  @Validate({ params: templateIdParams, body: applyTemplateSchema })
  applyTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: ApplyTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.applyTemplate(u.orgId, u.userId, templateId, body);
  }
}
