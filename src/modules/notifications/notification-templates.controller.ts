import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotificationTemplatesService } from "./notification-templates.service";
import {
  createTemplateSchema,
  updateTemplateSchema,
  previewTemplateSchema,
  testSendTemplateSchema,
  listTemplatesSchema,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type PreviewTemplateInput,
  type TestSendTemplateInput,
  type ListTemplatesInput,
} from "./dto/template.schemas";

@Controller("notification-templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  @RequirePermission("notifications:templates:view")
  list(
    @Query(new ZodValidationPipe(listTemplatesSchema)) filters: ListTemplatesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("notifications:templates:manage")
  create(
    @Body(new ZodValidationPipe(createTemplateSchema)) dto: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.create(u.orgId, u.userId, dto);
  }

  @Patch(":templateId")
  @RequirePermission("notifications:templates:manage")
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateTemplateSchema)) dto: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, u.userId, templateId, dto);
  }

  @Delete(":templateId")
  @RequirePermission("notifications:templates:manage")
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.remove(u.orgId, templateId);
  }

  @Post(":templateId/preview")
  @RequirePermission("notifications:templates:view")
  preview(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(previewTemplateSchema)) dto: PreviewTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.preview(u.orgId, templateId, dto);
  }

  @Post(":templateId/test")
  @RequirePermission("notifications:templates:manage")
  testSend(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(testSendTemplateSchema)) dto: TestSendTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.testSend(u.orgId, u.userId, templateId, dto);
  }
}
