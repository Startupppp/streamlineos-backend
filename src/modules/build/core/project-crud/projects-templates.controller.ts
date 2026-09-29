import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTemplatesService } from "./projects-templates.service";
import {
  applyTemplateSchema,
  createTemplateSchema,
  type ApplyTemplateInput,
  type CreateTemplateInput,
} from "../dto/projects.schemas";
import {
  listTemplatesQuerySchema,
  type ListTemplatesQuery,
} from "../dto/template.schemas";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { templateListSchema, templateRowSchema, applyTemplateResultSchema } from "../dto/build-roadmap-response.schemas";
import { buildRestoreResultSchema } from "../dto/build-core-response.schemas";
import { ProjectsRestoreService } from "./projects-restore.service";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTemplatesController {
  constructor(
    private readonly templates: ProjectsTemplatesService,
    private readonly projectsRestore: ProjectsRestoreService,
  ) {}

  @Get("templates")
  @RequirePermission("build:view")
  @ResponseSchema(templateListSchema)
  @Validate({ query: listTemplatesQuerySchema })
  listTemplates(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListTemplatesQuery,
  ) {
    return this.templates.listTemplates(u.orgId, query);
  }

  @Post("templates")
  @HttpCode(201)
  @RequirePermission("build:manage")
  @ResponseSchema(templateRowSchema)
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
  @NoContentResponse()
  @Validate({ params: templateIdParams })
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.deleteTemplate(u, templateId);
  }

  @Post("templates/:templateId/restore")
  @BodylessAction()
  @RequirePermission("build:restore")
  @HttpCode(200)
  @ResponseSchema(buildRestoreResultSchema)
  @Validate({ params: templateIdParams })
  restoreTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsRestore.restoreTemplate(u, templateId);
  }

  @Post("templates/:templateId/apply")
  @HttpCode(201)
  @RequirePermission("build:manage")
  @ResponseSchema(applyTemplateResultSchema)
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
