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
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { NotificationTemplatesService } from "./notification-templates.service";
import {
  createTemplateSchema,
  updateTemplateSchema,
  previewTemplateSchema,
  testSendTemplateSchema,
  listTemplatesSchema,
  setTemplateApprovalSchema,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type PreviewTemplateInput,
  type TestSendTemplateInput,
  type ListTemplatesInput,
  type SetTemplateApprovalInput,
} from "./dto/template.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@Controller("notification-templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  @RequirePermission("notifications:templates:view")
  @Validate({ query: listTemplatesSchema })
  list(
    @Query() filters: ListTemplatesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.list(u.orgId, filters);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("notifications:templates:manage")
  @Validate({ body: createTemplateSchema })
  create(
    @Body() dto: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.create(u.orgId, u.userId, dto);
  }

  @Patch(":templateId")
  @RequirePermission("notifications:templates:manage")
  @Validate({ params: templateIdParams, body: updateTemplateSchema })
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() dto: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.update(u.orgId, templateId, u.userId, dto);
  }

  @Patch(":templateId/approval")
  @RequirePermission("notifications:templates:manage")
  @Validate({ params: templateIdParams, body: setTemplateApprovalSchema })
  setApproval(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() dto: SetTemplateApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.setApproval(u.orgId, templateId, dto);
  }

  @Delete(":templateId")
  @RequirePermission("notifications:templates:manage")
  @Validate({ params: templateIdParams })
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.remove(u.orgId, templateId);
  }

  @Post(":templateId/preview")
  @HttpCode(200)
  @RequirePermission("notifications:templates:view")
  @Validate({ params: templateIdParams, body: previewTemplateSchema })
  preview(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() dto: PreviewTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.preview(u.orgId, templateId, dto);
  }

  @Post(":templateId/test")
  @Idempotent("notifications.template.test-send")
  @HttpCode(200)
  @RequirePermission("notifications:templates:manage")
  @Validate({ params: templateIdParams, body: testSendTemplateSchema })
  testSend(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() dto: TestSendTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.templates.testSend(u.orgId, u.userId, templateId, dto);
  }
}
