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

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsTemplatesController {
  constructor(private readonly templates: ProjectsTemplatesService) {}

  @Get("templates")
  listTemplates(@CurrentUser() u: CurrentUserContext) {
    return this.templates.listTemplates(u.orgId);
  }

  @Post("templates")
  @HttpCode(201)
  createTemplate(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.createTemplate(u.orgId, u.userId, body);
  }

  @Delete("templates/:templateId")
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.deleteTemplate(u.orgId, templateId);
  }

  @Post("templates/:templateId/apply")
  @HttpCode(201)
  applyTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(applyTemplateSchema)) body: ApplyTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.applyTemplate(u.orgId, u.userId, templateId, body);
  }
}
