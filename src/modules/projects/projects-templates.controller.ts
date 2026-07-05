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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProjectsTemplatesService } from "./projects-templates.service";
import {
  applyTemplateSchema,
  createTemplateSchema,
  type ApplyTemplateInput,
  type CreateTemplateInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTemplatesController {
  constructor(private readonly templates: ProjectsTemplatesService) {}

  @Get("templates")
  @RequirePermission("projects:view")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.templates.listTemplates(u.orgId);
  }

  @Post("templates")
  @HttpCode(201)
  @RequirePermission("projects:manage")
  createTemplate(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.createTemplate(u.orgId, u.userId, body);
  }

  @Delete("templates/:templateId")
  @RequirePermission("projects:manage")
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.deleteTemplate(u.orgId, templateId);
  }

  @Post("templates/:templateId/apply")
  @HttpCode(201)
  @RequirePermission("projects:manage")
  applyTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(applyTemplateSchema)) body: ApplyTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.applyTemplate(u.orgId, u.userId, templateId, body);
  }
}
