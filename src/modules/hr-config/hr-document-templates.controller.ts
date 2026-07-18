import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrDocumentTemplatesService } from "./hr-document-templates.service";
import {
  createTemplateSchema,
  setDefaultTemplateSchema,
  templateListQuerySchema,
  updateTemplateSchema,
  type CreateTemplateInput,
  type SetDefaultTemplateInput,
  type TemplateListQuery,
  type UpdateTemplateInput,
} from "./dto/document-templates.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/documents/templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrDocumentTemplatesController {
  constructor(private readonly templates: HrDocumentTemplatesService) {}

  @Get()
  @RequirePermission("hr:documents:view")
  list(
    @Query(new ZodValidationPipe(templateListQuerySchema)) query: TemplateListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("hr:documents:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTemplateSchema)) body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.create(u.orgId, u.userId, body);
  }

  @Get(":templateId")
  @RequirePermission("hr:documents:view")
  async getOne(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const template = await this.templates.getById(u.orgId, templateId);
    if (!template) throw new NotFoundException("Template not found");
    return template;
  }

  @Get(":templateId/preview")
  @RequirePermission("hr:documents:view")
  async preview(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const template = await this.templates.getById(u.orgId, templateId);
    if (!template) throw new NotFoundException("Template not found");
    return this.templates.buildPreview(template);
  }

  @Get(":templateId/versions")
  @RequirePermission("hr:documents:view")
  async versions(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const template = await this.templates.getById(u.orgId, templateId);
    if (!template) throw new NotFoundException("Template not found");
    return this.templates.listVersions(u.orgId, templateId);
  }

  @Patch(":templateId")
  @RequirePermission("hr:documents:manage")
  async setDefault(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(setDefaultTemplateSchema)) body: SetDefaultTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.templates.getById(u.orgId, templateId);
    if (!existing) throw new NotFoundException("Template not found");
    return this.templates.setDefault(existing, body.isDefault);
  }

  @Put(":templateId")
  @RequirePermission("hr:documents:manage")
  async update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.templates.getById(u.orgId, templateId);
    if (!existing) throw new NotFoundException("Template not found");
    return this.templates.updateVersion(u.userId, existing, body);
  }

  @Delete(":templateId")
  @HttpCode(204)
  @RequirePermission("hr:documents:manage")
  async remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.templates.getById(u.orgId, templateId);
    if (!existing) throw new NotFoundException("Template not found");
    return this.templates.softDelete(u.orgId, templateId);
  }
}
