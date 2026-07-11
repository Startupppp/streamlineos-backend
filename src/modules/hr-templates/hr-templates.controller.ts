import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrTemplatesService } from "./hr-templates.service";
import {
  createTemplateSchema,
  renderTemplateSchema,
  templateListQuerySchema,
  transitionTemplateSchema,
  updateTemplateSchema,
  type CreateTemplateInput,
  type RenderTemplateInput,
  type TemplateListQuery,
  type TransitionTemplateInput,
  type UpdateTemplateInput,
} from "./dto/hr-templates.schemas";

@RequireModule("hr")
@Controller("hr/templates")
@UseGuards(JwtAuthGuard)
export class HrTemplatesController {
  constructor(private readonly service: HrTemplatesService) {}

  @Get("variables")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:view")
  listVariables() {
    return this.service.listVariables();
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:view")
  list(
    @Query(new ZodValidationPipe(templateListQuerySchema)) query: TemplateListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Post("seed-defaults")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:manage")
  @HttpCode(200)
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.service.seedDefaults(u.orgId, u.userId);
  }

  @Get(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:view")
  getOne(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getById(u.orgId, templateId);
  }

  @Patch(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:manage")
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, u.userId, templateId, body);
  }

  @Post(":templateId/transition")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:manage")
  @HttpCode(200)
  transition(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(transitionTemplateSchema)) body: TransitionTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.transition(u.orgId, u.userId, templateId, body.to);
  }

  @Post(":templateId/versions")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:manage")
  @HttpCode(201)
  newVersion(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createNewVersion(u.orgId, u.userId, templateId);
  }

  @Post(":templateId/render")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:view")
  @HttpCode(200)
  render(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(renderTemplateSchema)) body: RenderTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.includeSensitive && !u.permissions.includes("hr:sensitive:view")) {
      throw new ForbiddenException("hr:sensitive:view permission required to include sensitive fields");
    }
    return this.service.render(u.orgId, u.userId, templateId, body);
  }

  @Get(":templateId/renders")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:templates:view")
  listRenders(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRenders(u.orgId, templateId);
  }
}
