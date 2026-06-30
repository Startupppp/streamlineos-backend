import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
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
@UseGuards(JwtAuthGuard)
export class NotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listTemplatesSchema)) filters: ListTemplatesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.list(u.orgId, filters);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createTemplateSchema)) dto: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.create(u.orgId, u.userId, dto);
  }

  @Patch(":templateId")
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateTemplateSchema)) dto: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, u.userId, templateId, dto);
  }

  @Delete(":templateId")
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.remove(u.orgId, templateId);
  }

  @Post(":templateId/preview")
  preview(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(previewTemplateSchema)) dto: PreviewTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.preview(u.orgId, templateId, dto);
  }

  @Post(":templateId/test")
  testSend(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(testSendTemplateSchema)) dto: TestSendTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.testSend(u.orgId, u.userId, templateId, dto);
  }
}
